#!/usr/bin/env tsx
/**
 * cloudflare-token-rotation.ts — CLAUDE.md Rules #99 / #302.
 *
 * Rolls the Cloudflare umbrella token (`studiob-cloudflare-dns-umbrella`) atomically:
 *   CF roll → 1P update → Railway consumer update(s) → /zones verify with new token
 *
 * GATING (two independent guards — BOTH required for any live mutation):
 *   1. The `cloudflare-cf-token-mgmt` 1P item must resolve (Kevin mints this — it holds a CF
 *      management token with `User → API Tokens → Edit` scope, which the zone-scoped umbrella
 *      token cannot grant itself).  If the item is absent, the script exits 0 with an
 *      "awaiting Kevin's mint" message — NOT a failure.
 *   2. The `--rotate` CLI flag must be explicitly passed.  Default = DRY-RUN: the script
 *      describes what it would do without touching any live system.
 *
 * SECURITY (Rules #259/#282):
 *   - Credential VALUES are read directly into variables and NEVER logged, never included in
 *     error text, never written to Slack.  Only success/failure status flows out.
 *   - `railway variables --kv | grep` uses EXACT key anchoring per Rule #282.
 *   - The new token value is never echoed (Rule #259).
 *
 * CF API NOTES:
 *   - CF does NOT allow tokens to be CREATED via API — only an existing token's VALUE can
 *     be rolled: `PUT /client/v4/user/tokens/{id}/value` (requires User:API Tokens:Edit).
 *   - Liveness verification uses /zones (NOT /user/tokens/verify — zone-scoped tokens cannot
 *     pass the verify endpoint; see studiob-cloudflare-api-tokens.md §"Verifying token validity").
 */

import { execFileSync } from "node:child_process";

// ── constants ──────────────────────────────────────────────────────────────────────────────────────

/** Name of the umbrella token IN the Cloudflare dashboard (used to find its CF id). */
const CF_UMBRELLA_TOKEN_NAME = "studiob-cloudflare-dns-umbrella";

/** 1P item holding the umbrella token value (in "Studio B Infrastructure" vault). */
const CF_UMBRELLA_OP_ITEM = "cloudflare-api-token-studiob-umbrella";

/** 1P item holding the management token (Kevin mints this; gates all live mutation). */
const CF_MGMT_OP_ITEM = "cloudflare-cf-token-mgmt";

/** 1P vault that holds both items. */
const OP_VAULT = "Studio B Infrastructure";

/**
 * Railway consumers of CF_API_TOKEN.  Discovery note: at the time this script was authored,
 * the umbrella token is not injected into any Railway service as CF_API_TOKEN (it is read
 * from 1P at operator/script time); this list is maintained manually — add a Railway service
 * slug here when onboarding a new consumer (Rule #99: atomic cross-store rotation).
 *
 * To discover: `railway variables --service <svc> --kv | cut -d= -f1 | grep -x CF_API_TOKEN`
 */
const RAILWAY_CF_TOKEN_CONSUMERS: string[] = [
  // e.g. "my-service" — none currently; kept for when Railway consumers are added
];

const CF_BASE = "https://api.cloudflare.com/client/v4";
const PROBE_TIMEOUT_MS = 15_000;
const SLACK_BOT_TOKEN = process.env.STUDIOB_SLACK_BOT_TOKEN;
const CH_ESCALATIONS = "C0ATMSL2CR2"; // #agent-escalations (studiob-ai workspace — Rule #165)
const CH_NOTIFICATIONS = "C0B4B3F62H2"; // #agent-notifications

// ── 1P helpers ────────────────────────────────────────────────────────────────────────────────────

function opServiceAccountToken(): string {
  const t = process.env.OP_SERVICE_ACCOUNT_INFRA;
  if (!t) throw new Error("OP_SERVICE_ACCOUNT_INFRA env var is required");
  return t;
}

/**
 * Read a value from 1P.  Returns null if the item does not exist (instead of throwing),
 * so callers can gate cleanly when an item hasn't been provisioned yet.
 */
function opReadOrNull(item: string): string | null {
  try {
    return execFileSync(
      "op",
      ["read", `op://${OP_VAULT}/${item}/credential`],
      {
        env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: opServiceAccountToken() },
        encoding: "utf-8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return null;
  }
}

function opWrite(item: string, value: string): void {
  // Value flows directly into the arg array — never touches a shell or echo (Rule #259).
  execFileSync(
    "op",
    ["item", "edit", item, `--vault=${OP_VAULT}`, `credential=${value}`],
    {
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: opServiceAccountToken() },
      timeout: 30_000,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

// ── CF API helpers ────────────────────────────────────────────────────────────────────────────────

interface CfTokenListItem {
  id: string;
  name: string;
  status?: string;
}

async function cfGet<T>(path: string, mgmtToken: string): Promise<T> {
  const resp = await fetch(`${CF_BASE}${path}`, {
    headers: { Authorization: `Bearer ${mgmtToken}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const json = (await resp.json()) as { success?: boolean; result?: T; errors?: unknown[] };
  if (!json.success) throw new Error(`CF API GET ${path} failed: ${JSON.stringify(json.errors)}`);
  return json.result as T;
}

async function cfRoll(tokenId: string, mgmtToken: string): Promise<string> {
  // PUT /user/tokens/{id}/value — rolls the secret; returns the new value.
  const resp = await fetch(`${CF_BASE}/user/tokens/${tokenId}/value`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${mgmtToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const json = (await resp.json()) as { success?: boolean; result?: string; errors?: unknown[] };
  if (!json.success || !json.result) {
    throw new Error(`CF token roll failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

/**
 * Verify a CF token via /zones (NOT /user/tokens/verify — see module JSDoc).
 * Returns true iff the token is accepted by the CF API.
 */
async function cfVerifyViaZones(token: string): Promise<boolean> {
  try {
    const resp = await fetch(`${CF_BASE}/zones?per_page=1`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) return false;
    const json = (await resp.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

// ── Railway helpers ───────────────────────────────────────────────────────────────────────────────

function railwayUpdateToken(service: string, value: string): void {
  // Value is written via stdin through printf (Rule #62 — never railway variable set --set KEY=VALUE).
  // We use execFileSync with a spawned printf+pipe because execFileSync doesn't support piping;
  // the value is passed as argument to printf, never through shell interpolation.
  const spawnSync = (await import("node:child_process")).spawnSync;
  const result = spawnSync(
    "sh",
    ["-c", "printf '%s' \"$CF_NEW_VALUE\" | railway variable set --skip-deploys --stdin CF_API_TOKEN"],
    {
      env: { ...process.env, CF_NEW_VALUE: value },
      cwd: process.cwd(),
      timeout: 60_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(`railway variable set for service ${service} failed (exit ${result.status})`);
  }
  // Now redeploy to pick up the new env (Rule #135).
  execFileSync("railway", ["redeploy", "--service", service, "--yes"], {
    timeout: 60_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// ── Slack helpers ─────────────────────────────────────────────────────────────────────────────────

async function postSlack(channel: string, text: string): Promise<void> {
  if (!SLACK_BOT_TOKEN) {
    console.log(`[Slack would post to ${channel}]: ${text}`);
    return;
  }
  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await resp.json()) as { ok: boolean; error?: string };
    if (!json.ok) console.error(`Slack post failed: ${json.error}`);
  } catch (err) {
    console.error(`Slack post error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const doRotate = process.argv.includes("--rotate");
  const dryRun = !doRotate;

  console.log(`cloudflare-token-rotation ${dryRun ? "(DRY-RUN — pass --rotate to execute)" : "(LIVE ROTATION)"}`);

  // ── GATE 1: management token must exist ─────────────────────────────────────────────────────────
  let mgmtToken: string | null = null;
  if (!dryRun) {
    mgmtToken = opReadOrNull(CF_MGMT_OP_ITEM);
    if (!mgmtToken) {
      console.log(
        `management token not provisioned — rotation build complete, awaiting Kevin's mint.\n` +
        `Create "${CF_MGMT_OP_ITEM}" in the "${OP_VAULT}" 1Password vault with a CF token that has` +
        ` User → API Tokens → Edit scope, then re-run with --rotate.`,
      );
      process.exit(0);
    }
  }

  // ── DRY-RUN path ────────────────────────────────────────────────────────────────────────────────
  if (dryRun) {
    console.log("Would perform the following steps:");
    console.log(`  1. Read mgmt token from 1P item "${CF_MGMT_OP_ITEM}" in "${OP_VAULT}" vault`);
    console.log(`  2. GET ${CF_BASE}/user/tokens (auth: mgmt token) → find "${CF_UMBRELLA_TOKEN_NAME}" by name`);
    console.log(`  3. PUT ${CF_BASE}/user/tokens/<id>/value → roll the umbrella token value`);
    console.log(`  4. Write new value to 1P item "${CF_UMBRELLA_OP_ITEM}" in "${OP_VAULT}" vault`);
    if (RAILWAY_CF_TOKEN_CONSUMERS.length > 0) {
      for (const svc of RAILWAY_CF_TOKEN_CONSUMERS) {
        console.log(`  5. Update Railway service "${svc}" CF_API_TOKEN (stdin, --skip-deploys) → redeploy`);
      }
    } else {
      console.log(`  5. No Railway CF_API_TOKEN consumers configured (1P-only consumer; no Railway update needed)`);
    }
    console.log(`  6. Verify new token via GET ${CF_BASE}/zones?per_page=1 → must return success:true`);
    console.log(`  7. Post success beacon → #agent-notifications`);
    console.log(`  (on any failure: post alert → #agent-escalations, exit non-zero)`);
    return;
  }

  // ── LIVE ROTATION ───────────────────────────────────────────────────────────────────────────────

  // Step 1: Find the umbrella token's CF id
  console.log(`Step 1: listing CF tokens to find "${CF_UMBRELLA_TOKEN_NAME}"...`);
  const tokens = await cfGet<CfTokenListItem[]>("/user/tokens", mgmtToken!);
  const umbrella = tokens.find((t) => t.name === CF_UMBRELLA_TOKEN_NAME);
  if (!umbrella) {
    const msg = `CF token named "${CF_UMBRELLA_TOKEN_NAME}" not found — check the management token's scope.`;
    await postSlack(CH_ESCALATIONS, `:red_circle: *CF rotation failed* — ${msg}`);
    throw new Error(msg);
  }
  console.log(`  Found token id: ${umbrella.id}`);

  // Step 2: Roll the token value
  console.log("Step 2: rolling the token value (PUT /user/tokens/<id>/value)...");
  let newValue: string;
  try {
    newValue = await cfRoll(umbrella.id, mgmtToken!);
  } catch (err) {
    const msg = `CF token roll failed: ${err instanceof Error ? err.message : String(err)}`;
    await postSlack(CH_ESCALATIONS, `:red_circle: *CF rotation failed at roll step* — ${msg}`);
    throw new Error(msg);
  }
  console.log("  Token rolled successfully.");

  // Step 3: Atomic store update — 1P first (Rule #99)
  console.log(`Step 3: updating 1P item "${CF_UMBRELLA_OP_ITEM}"...`);
  try {
    opWrite(CF_UMBRELLA_OP_ITEM, newValue);
  } catch (err) {
    // The new token value is live in CF but not yet in 1P — alert immediately.
    const msg = `CF token rolled but 1P update failed: ${err instanceof Error ? err.message : String(err)}. Update manually: op item edit "${CF_UMBRELLA_OP_ITEM}" --vault "${OP_VAULT}" credential=<new-value>`;
    await postSlack(CH_ESCALATIONS, `:red_circle: *CF rotation PARTIAL — 1P update failed* — ${msg}`);
    throw new Error(msg);
  }
  console.log("  1P item updated.");

  // Step 4: Railway consumer updates
  if (RAILWAY_CF_TOKEN_CONSUMERS.length > 0) {
    for (const svc of RAILWAY_CF_TOKEN_CONSUMERS) {
      console.log(`Step 4: updating Railway service "${svc}"...`);
      try {
        railwayUpdateToken(svc, newValue);
        console.log(`  "${svc}" updated and redeployed.`);
      } catch (err) {
        const msg = `Railway update for service "${svc}" failed: ${err instanceof Error ? err.message : String(err)}`;
        await postSlack(CH_ESCALATIONS, `:warning: *CF rotation partial — Railway update failed for ${svc}* — ${msg}`);
        // Non-fatal for the rotation itself; continue and verify.
        console.error(`  Warning: ${msg}`);
      }
    }
  } else {
    console.log("Step 4: no Railway consumers configured — skipping (1P-only consumer).");
  }

  // Step 5: Verify with the NEW token
  console.log("Step 5: verifying new token via GET /zones...");
  const valid = await cfVerifyViaZones(newValue);
  if (!valid) {
    const msg = "New CF token failed /zones verification after rotation — investigate immediately. OLD token may no longer be valid.";
    await postSlack(CH_ESCALATIONS, `:red_circle: *CF rotation FAILED VERIFICATION* — ${msg}`);
    process.exit(1);
  }
  console.log("  Verified: /zones returned success:true with the new token.");

  // Step 6: Success beacon
  const beacon =
    `:white_check_mark: *Cloudflare umbrella token rotated successfully* — ` +
    `token \`${CF_UMBRELLA_TOKEN_NAME}\` rolled, 1P updated` +
    (RAILWAY_CF_TOKEN_CONSUMERS.length > 0 ? `, Railway consumers updated` : "") +
    `, /zones probe: OK.`;
  await postSlack(CH_NOTIFICATIONS, beacon);
  console.log("Rotation complete.");
}

main().catch((err) => {
  console.error(`cloudflare-token-rotation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
