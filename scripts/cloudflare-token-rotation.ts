#!/usr/bin/env tsx
/**
 * cloudflare-token-rotation.ts — CLAUDE.md Rules #99 / #302.
 *
 * Rolls the Cloudflare umbrella token (`studiob-cloudflare-dns-umbrella`) atomically:
 *   CF roll → 1P update → Railway consumer update(s) → /zones verify with new token
 *
 * GATING (two independent guards — BOTH required for any live mutation):
 *   1. The `cloudflare-cf-token-mgmt` 1P item must resolve (Kevin mints this — it holds a CF
 *      management token with `User → API Tokens → Edit` (to roll the token value) +
 *      `Zone → Zone → Read` (so the monitor's /zones probe also passes) scope.  If the item
 *      is absent, the script exits 0 with an
 *      "awaiting Kevin's mint" message — NOT a failure.
 *   2. The `--rotate` CLI flag must be explicitly passed.  Default = DRY-RUN: the script
 *      describes what it would do without touching any live system.
 *
 * v2 (2026-07-31, Kevin directive): this is a ROTATION JOB, not a continuous watch, so only its
 * FAILURE/attention Slack posts convert to GitHub issues (label `cred-rotation`) — success posts
 * become console.log only (no issue, no Slack). Each fatal step (CF token listing failed, token
 * not found, roll failed, 1P update failed, verification failed) opens its own fixed-title issue
 * on failure and closes it the next time that SAME step is reached and passes (Rules #292/#358 —
 * an issue that's already open for an unresolved condition isn't reopened). The non-fatal
 * per-Railway-consumer failure (step 4) gets its own issue per service, same open/close
 * treatment. There is no single "close everything on success" sweep — each condition closes at
 * the point in the control flow where THIS run proves it, which is also correct for a run that
 * fails at an earlier step (the issues for steps already passed this run get closed; issues for
 * unreached steps are left alone, since this run says nothing about their current truth). The
 * monthly dry-run health beacon (success-class, not failure/attention) also becomes console.log
 * only. (Codex review, fixed pre-merge: step 1's CF API call itself — as opposed to a successful
 * call returning no matching token — is now also wrapped so an API-level failure there opens its
 * own issue instead of throwing past all issue bookkeeping.)
 *
 * SECURITY (Rules #259/#282):
 *   - Credential VALUES are read directly into variables and NEVER logged, never included in
 *     error text, never written to an issue.  Only success/failure status flows out.
 *   - `railway variables --kv | grep` uses EXACT key anchoring per Rule #282.
 *   - The new token value is never echoed (Rule #259).
 *
 * CF API NOTES:
 *   - CF does NOT allow tokens to be CREATED via API — only an existing token's VALUE can
 *     be rolled: `PUT /client/v4/user/tokens/{id}/value` (requires User:API Tokens:Edit).
 *   - Liveness verification uses /zones (NOT /user/tokens/verify — zone-scoped tokens cannot
 *     pass the verify endpoint; see studiob-cloudflare-api-tokens.md §"Verifying token validity").
 */

import { execFileSync, spawnSync } from "node:child_process";
import { reconcileCondition } from "./lib/gateway-token-reconcile.js";
import { listIssuesByLabel, ensureLabel, openIssue, closeIssue, type IssueRef } from "./lib/github-issues.js";

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

// ── issue-alert constants (v2, Kevin directive 2026-07-31) ──────────────────────────────────────────
const REPO = "studio-b-ai/ops-pipeline";
const LABEL = "cred-rotation";
const LABEL_DESCRIPTION = "cloudflare-token-rotation alert state (open = a rotation step failed)";

// TITLE_TOKEN_LOOKUP_FAILED (the CF API call itself errored — network/auth/scope) is distinct
// from TITLE_TOKEN_NOT_FOUND (the call succeeded but returned no token by that name) — codex
// review finding (P2, fixed pre-merge): the original step 1 only opened an issue for the latter,
// so a `cfGet` throw (expired/under-scoped management token, CF API error) skipped issue creation
// entirely, leaving a live-rotation failure invisible to the new issue-based alert state.
const TITLE_TOKEN_LOOKUP_FAILED = "[cred-rotation] CF token listing failed";
const TITLE_TOKEN_NOT_FOUND = "[cred-rotation] umbrella token not found";
const TITLE_ROLL_FAILED = "[cred-rotation] token roll failed";
const TITLE_1P_UPDATE_FAILED = "[cred-rotation] 1Password update failed (partial rotation — CF rolled, 1P stale)";
const TITLE_VERIFICATION_FAILED = "[cred-rotation] new token failed verification";

function railwayUpdateFailedTitle(service: string): string {
  return `[cred-rotation] Railway update failed — ${service}`;
}

/** Open `title` (with `body`) iff it isn't already open — an already-open issue for an unresolved failure is the dedup (Rules #292/#358). */
function openFailureIssue(openByTitle: Map<string, IssueRef>, title: string, body: string): void {
  if (reconcileCondition(true, openByTitle.has(title)) === "open") {
    ensureLabel(REPO, LABEL, LABEL_DESCRIPTION, "B60205");
    openIssue(REPO, LABEL, title, body);
  }
}

/** Close `title` (with `comment`) iff it's currently open — no-op otherwise. */
function closeIfOpen(openByTitle: Map<string, IssueRef>, title: string, comment: string): void {
  const ref = openByTitle.get(title);
  if (ref && reconcileCondition(false, true) === "close") {
    closeIssue(REPO, ref.number, comment);
  }
}

// ── 1P helpers ────────────────────────────────────────────────────────────────────────────────────

function opServiceAccountToken(): string {
  const t = process.env.OP_SERVICE_ACCOUNT_INFRA;
  if (!t) throw new Error("OP_SERVICE_ACCOUNT_INFRA env var is required");
  return t;
}

/**
 * Read a value from 1P.  Returns null ONLY when the item does not exist ("not found" /
 * "isn't an item" in the stderr), so callers can gate on "not yet provisioned".
 * Any other error (bad SA token, missing `op` binary, transient CLI failure) THROWS —
 * the gate should NOT silently swallow infrastructure failures during a live rotation.
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
        stdio: ["ignore", "pipe", "pipe"], // capture stderr so we can inspect it
      },
    ).trim();
  } catch (err) {
    // Distinguish "item does not exist" from infrastructure failures.
    // `op read` exits non-zero with stderr containing these patterns when the item is genuinely
    // absent from the vault — these are the ONLY cases where we want to return null (gate: "not
    // yet provisioned").  All other failures (ENOENT from missing `op` binary, auth errors, SA
    // token problems, network timeouts) THROW so the caller cannot silently pass a broken runner.
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === "ENOENT") {
      // `op` binary is not installed — this is an infrastructure failure, not a missing item.
      throw new Error(`'op' (1Password CLI) is not installed or not on PATH — cannot read 1P item "${item}"`);
    }
    const stderr = e?.stderr?.toString() ?? "";
    const isItemNotFound = /isn't an item|doesn't contain|Item not found/i.test(stderr);
    if (isItemNotFound) return null;
    // Auth/env/network failure — surface it.
    throw err;
  }
}

/**
 * Write a credential value to 1P — the token value NEVER appears in argv.
 *
 * 1Password CLI v2 supports "secret references" in field assignment args via the
 * `field=env:ENV_VAR_NAME` syntax: the ARG carries only the env-var NAME (not the value),
 * and `op item edit` reads the real value from the environment itself.  This is the
 * 1P-recommended pattern for injecting secrets without embedding them in process argv.
 *
 * So: argv contains `"credential[password]=env:OP_FIELD_VALUE"` (safe to log)
 *     env[OP_FIELD_VALUE] = <the actual new token> (never visible in argv or process listings)
 *
 * The write-capable SA token must be in OP_SERVICE_ACCOUNT_WRITE; the read-only
 * OP_SERVICE_ACCOUNT_INFRA is insufficient.
 */
function opWrite(item: string, value: string): void {
  // `credential[password]=env:OP_FIELD_VALUE` tells op to read the field value from the
  // OP_FIELD_VALUE env var — the value never appears in argv or shell arguments.
  const writeToken = process.env.OP_SERVICE_ACCOUNT_WRITE;
  if (!writeToken) {
    throw new Error(
      "OP_SERVICE_ACCOUNT_WRITE env var is required for 1P writes — " +
      "the read-only OP_SERVICE_ACCOUNT_INFRA cannot update vault items. " +
      "See KEVIN ACTION REQUIRED in the rotation script docs.",
    );
  }
  const result = spawnSync(
    "op",
    ["item", "edit", item, `--vault=${OP_VAULT}`, "credential[password]=env:OP_FIELD_VALUE"],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        OP_SERVICE_ACCOUNT_TOKEN: writeToken, // write-capable SA for the edit
        OP_FIELD_VALUE: value,                // value consumed by op via env-ref, never via argv
      },
      timeout: 30_000,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (result.status !== 0) {
    const rawErr = (result.stderr ?? "").trim();
    // Sanitize: strip any occurrence of the value before surfacing the error.
    const safeErr = rawErr.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[REDACTED]");
    throw new Error(`op item edit failed for "${item}": ${safeErr}`);
  }
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

/**
 * CF token-roll response.  The new secret is in `result.value` (NOT `result` itself).
 * Codex P1: earlier version typed `result` as `string` and returned it directly; CF wraps
 * it in an object: `{ "result": { "id": "...", "value": "<new-token-string>", ... } }`.
 */
interface CfRollResult {
  id?: string;
  value?: string;
}

async function cfRoll(tokenId: string, mgmtToken: string): Promise<string> {
  // PUT /user/tokens/{id}/value — rolls the secret; CF returns the new value under result.value.
  const resp = await fetch(`${CF_BASE}/user/tokens/${tokenId}/value`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${mgmtToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const json = (await resp.json()) as { success?: boolean; result?: CfRollResult; errors?: unknown[] };
  if (!json.success || !json.result?.value) {
    throw new Error(`CF token roll failed: ${JSON.stringify(json.errors)}`);
  }
  // Return only the new secret VALUE — never the id or any other fields.
  return json.result.value;
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
  // Value is written via stdin through printf (Rule #62 — never `railway variable set KEY=VALUE`).
  // spawnSync is imported at top level (not dynamic await, which is invalid in a sync function).
  // --service targets the specific consumer; without it railway targets the linked default service,
  // which could update the wrong project (codex P2 finding).
  const result = spawnSync(
    "sh",
    ["-c", "printf '%s' \"$CF_NEW_VALUE\" | railway variable set --service \"$RAILWAY_SVC\" --skip-deploys --stdin CF_API_TOKEN"],
    {
      env: { ...process.env, CF_NEW_VALUE: value, RAILWAY_SVC: service },
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
        `Create "${CF_MGMT_OP_ITEM}" in the "${OP_VAULT}" 1Password vault with a CF token that has\n` +
        `  Permissions: User → API Tokens → Edit  (to roll the umbrella token)\n` +
        `               Zone → Zone → Read         (so the monitor's /zones probe also passes)\n` +
        `Then re-run with --rotate.`,
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
    console.log(`  7. Log success (console.log only)`);
    console.log(`  (on any failure: open/update a cred-rotation issue, exit non-zero)`);

    // Health beacon so the monthly scheduled dry-run confirms the rotation path is reachable
    // (Rule #279 — deterministic trigger). Success-class → console.log only (v2, Kevin directive
    // 2026-07-31); this is NOT posted anywhere durable — the workflow's own run log is the record.
    console.log(
      `☁️ CF token rotation dry-run ✓ — rotation path ready; umbrella token not yet rolled. ` +
      `Trigger via workflow_dispatch with rotate=true when a rotation is needed.`,
    );
    return;
  }

  // ── LIVE ROTATION ───────────────────────────────────────────────────────────────────────────────

  // Real (read-only) issue-list snapshot for this run's open/close decisions — needs only the
  // workflow's ambient GITHUB_TOKEN, not a Kevin-gated secret. "open" only — this job never needs
  // closed-issue history.
  const openIssuesList = listIssuesByLabel(REPO, LABEL, "open").filter((i) => i.state === "OPEN");
  const openByTitle = new Map(openIssuesList.map((i) => [i.title, i]));

  // Step 1: Find the umbrella token's CF id
  console.log(`Step 1: listing CF tokens to find "${CF_UMBRELLA_TOKEN_NAME}"...`);
  let tokens: CfTokenListItem[];
  try {
    tokens = await cfGet<CfTokenListItem[]>("/user/tokens", mgmtToken!);
  } catch (err) {
    const msg = `CF token listing failed: ${err instanceof Error ? err.message : String(err)}`;
    openFailureIssue(openByTitle, TITLE_TOKEN_LOOKUP_FAILED, `${msg}\n\nAuto-closes on the next rotation run whose token listing succeeds.`);
    throw new Error(msg);
  }
  closeIfOpen(openByTitle, TITLE_TOKEN_LOOKUP_FAILED, "CF token listing succeeded — auto-closed by the rotation job.");
  const umbrella = tokens.find((t) => t.name === CF_UMBRELLA_TOKEN_NAME);
  if (!umbrella) {
    const msg = `CF token named "${CF_UMBRELLA_TOKEN_NAME}" not found — check the management token's scope.`;
    openFailureIssue(openByTitle, TITLE_TOKEN_NOT_FOUND, `${msg}\n\nAuto-closes on the next rotation run that finds the token.`);
    throw new Error(msg);
  }
  closeIfOpen(openByTitle, TITLE_TOKEN_NOT_FOUND, "Umbrella token found again — auto-closed by the rotation job.");
  console.log(`  Found token id: ${umbrella.id}`);

  // Step 2: Roll the token value
  console.log("Step 2: rolling the token value (PUT /user/tokens/<id>/value)...");
  let newValue: string;
  try {
    newValue = await cfRoll(umbrella.id, mgmtToken!);
  } catch (err) {
    const msg = `CF token roll failed: ${err instanceof Error ? err.message : String(err)}`;
    openFailureIssue(openByTitle, TITLE_ROLL_FAILED, `${msg}\n\nAuto-closes on the next rotation run that rolls successfully.`);
    throw new Error(msg);
  }
  closeIfOpen(openByTitle, TITLE_ROLL_FAILED, "Token roll succeeded — auto-closed by the rotation job.");
  console.log("  Token rolled successfully.");

  // Step 3: Atomic store update — 1P first (Rule #99)
  console.log(`Step 3: updating 1P item "${CF_UMBRELLA_OP_ITEM}"...`);
  try {
    opWrite(CF_UMBRELLA_OP_ITEM, newValue);
  } catch (err) {
    // The new token value is live in CF but not yet in 1P — alert immediately.
    const msg = `CF token rolled but 1P update failed: ${err instanceof Error ? err.message : String(err)}. Update manually: op item edit "${CF_UMBRELLA_OP_ITEM}" --vault "${OP_VAULT}" credential=<new-value>`;
    openFailureIssue(openByTitle, TITLE_1P_UPDATE_FAILED, `${msg}\n\nAuto-closes on the next rotation run whose 1Password update succeeds.`);
    throw new Error(msg);
  }
  closeIfOpen(openByTitle, TITLE_1P_UPDATE_FAILED, "1Password update succeeded — auto-closed by the rotation job.");
  console.log("  1P item updated.");

  // Step 4: Railway consumer updates
  if (RAILWAY_CF_TOKEN_CONSUMERS.length > 0) {
    for (const svc of RAILWAY_CF_TOKEN_CONSUMERS) {
      console.log(`Step 4: updating Railway service "${svc}"...`);
      const title = railwayUpdateFailedTitle(svc);
      try {
        railwayUpdateToken(svc, newValue);
        console.log(`  "${svc}" updated and redeployed.`);
        closeIfOpen(openByTitle, title, `Railway update for "${svc}" succeeded — auto-closed by the rotation job.`);
      } catch (err) {
        const msg = `Railway update for service "${svc}" failed: ${err instanceof Error ? err.message : String(err)}`;
        openFailureIssue(openByTitle, title, `${msg}\n\nAuto-closes on the next rotation run where this service's update succeeds.`);
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
    openFailureIssue(openByTitle, TITLE_VERIFICATION_FAILED, `${msg}\n\nAuto-closes on the next rotation run that verifies successfully.`);
    process.exit(1);
  }
  closeIfOpen(openByTitle, TITLE_VERIFICATION_FAILED, "New token verified successfully — auto-closed by the rotation job.");
  console.log("  Verified: /zones returned success:true with the new token.");

  // Step 6: success — console.log only (v2, Kevin directive 2026-07-31: success posts are
  // console.log, not an issue or Slack). Every failure-class issue reachable this run was already
  // closed above at the point each step passed.
  const beacon =
    `Cloudflare umbrella token rotated successfully — ` +
    `token "${CF_UMBRELLA_TOKEN_NAME}" rolled, 1P updated` +
    (RAILWAY_CF_TOKEN_CONSUMERS.length > 0 ? `, Railway consumers updated` : "") +
    `, /zones probe: OK.`;
  console.log(beacon);
  console.log("Rotation complete.");
}

main().catch((err) => {
  console.error(`cloudflare-token-rotation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
