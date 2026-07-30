#!/usr/bin/env tsx
/**
 * gateway-token-watch.ts — CLAUDE.md Rule #279 (staged actions need deterministic triggers).
 *
 * Origin (2026-07-30, Kevin-authorized "let's go"): the per-consumer gateway-token rollout
 * (bolt-wms-prod-v1 / webhook-router-prod-v3 / acudev-prod-v2 / quarterbook-v2 / bolt-ci-v1 /
 * kevin-cli-v1, cut over ~00:48–01:07Z) left legacy tokens VALID as tripwires: any consumer
 * still authenticating with one is an unmigrated straggler (shuttle/support-agent class).
 * Revoking the legacy set is gated on a multi-day zero-use window — and "check again in a few
 * days" as a memory-promise is exactly the anti-pattern Rule #279 forbids. This monitor IS the
 * deterministic trigger.
 *
 * Data source (Rule #413 — durable table over volatile logs): the gateway's tenant-context
 * middleware stamps `acumatica_tenant_tokens.last_used_at` on every authenticated request, so
 * the entire watch is one SQL read — no Railway log scraping, no retention window.
 *
 * Daily (GH Actions cron): read every non-revoked token's last_used_at and classify:
 *   - allowlisted (EXPECTED_ACTIVE) → modern fleet, never alerted on
 *   - legacy, last_used_at ≥ CUTOVER → STRAGGLER (a live consumer still uses it)
 *   - legacy, quiet since CUTOVER    → QUIET
 * Alerts to #agent-escalations ONLY on a state TRANSITION (Rules #292/#358), same
 * dedup-state-file idiom as railway-volume-monitor.ts / credential-expiry-monitor.ts.
 * When EVERY legacy token has stayed quiet for ≥ QUIET_DAYS past cutover, post the one-time
 * "revocation gate GREEN" escalation — the revocation itself stays HUMAN-gated (Rules #97/#279:
 * alert, never auto-revoke; the executor is packages/api/src/scripts/gateway-revoke-token.ts in
 * studio-b-ai/studiob).
 *
 * Duplicate token names are REAL in this table (two rows named `webhook-router-prod`,
 * two `cli-kevin-sandbox-canary`) — every dedup/state key therefore includes created_at.
 *
 * Kevin-gated secret this workflow needs:
 *   GATEWAY_DATABASE_URL   The studiob-api gateway Postgres URL (currently the PUBLIC proxy —
 *                          mainline.proxy.rlwy.net — because GHA cannot reach railway-internal
 *                          hosts). ⚠️ Dual-store note (Rule #99): the same URL lives in the
 *                          studiob-api Railway env as DATABASE_URL; when the "DB off public
 *                          proxy" migration lands, BOTH must rotate together or this monitor
 *                          goes blind while looking healthy.
 *   STUDIOB_SLACK_BOT_TOKEN already present in this repo.
 *
 * SECURITY (Rules #259/#282/#363): GATEWAY_DATABASE_URL is read into the pg client and never
 * logged, never put in alert text, never written to the state file.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { requireEnv } from "./lib/config.js";
import { classifyLegacyToken, revocationGate } from "./lib/gateway-token-classify.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, "gateway-token-watch-state.json");

const CH_ESCALATIONS = "C0ATMSL2CR2"; // #agent-escalations (Rule #165)
const CH_NOTIFICATIONS = "C0B4B3F62H2"; // #agent-notifications

/** Cutover moment for the 2026-07-30 per-consumer rollout, padded past the last pre-swap
 * container's dying calls (old webhook-router/bolt containers last touched legacy tokens at
 * ~00:49Z; the padded boundary keeps those from reading as post-cutover stragglers). */
const CUTOVER_ISO = "2026-07-30T00:52:00Z";
/** Legacy tokens must stay quiet this many days past cutover before the gate goes GREEN. */
const QUIET_DAYS = 3;

/**
 * The modern per-consumer fleet — tokens that are SUPPOSED to carry traffic. Everything else
 * non-revoked is legacy-watch material. Names only (never values); duplicates impossible here
 * because these six were minted 2026-07-30 with unique names, and the pre-existing four were
 * verified single-row on 2026-07-30.
 */
const EXPECTED_ACTIVE = new Set([
  // minted + delivered 2026-07-30
  "bolt-wms-prod-v1",
  "webhook-router-prod-v3",
  "acudev-prod-v2",
  "quarterbook-v2",
  "bolt-ci-v1",
  "kevin-cli-v1",
  // already per-consumer before the rollout (verified via last_used_at 2026-07-30)
  "business-dashboard-prod-v2",
  "aesthetik-portal-atp-20260612",
  "studiob-api-mcp-prod",
  "deploy-smoke",
]);

interface TokenRow {
  name: string;
  tenant_id: string;
  created_at: Date;
  last_used_at: Date | null;
}

// ───────────────────────────── alert state (dedup by transition) ─────────────────────────────

type AlertState = Record<string, string>;

/** Names duplicate in this table — created_at disambiguates (see file header). */
function tokenKey(t: TokenRow): string {
  return `${t.name}@${t.created_at.toISOString()}`;
}

function loadAlertState(): AlertState {
  if (!existsSync(STATE_FILE)) return {};
  try {
    const obj = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as unknown;
    return obj && typeof obj === "object" ? (obj as AlertState) : {};
  } catch {
    return {};
  }
}

function saveAlertState(state: AlertState): void {
  const sorted: AlertState = {};
  for (const k of Object.keys(state).sort()) sorted[k] = state[k];
  writeFileSync(STATE_FILE, JSON.stringify(sorted, null, 2) + "\n");
}

// ───────────────────────────── Slack (same idiom as railway-volume-monitor) ─────────────────────────────

async function postSlack(channel: string, text: string): Promise<void> {
  const token = requireEnv("STUDIOB_SLACK_BOT_TOKEN");
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await resp.json()) as { ok: boolean; error?: string };
  if (!json.ok) throw new Error(`Slack post to ${channel} failed: ${json.error}`);
}

/** Best-effort post used only AFTER state is saved — a Slack outage must not break dedup durability. */
async function tryPostSlack(channel: string, text: string): Promise<void> {
  try {
    await postSlack(channel, text);
  } catch (err) {
    console.error(
      `gateway-token-watch: a Slack post failed (state already saved, so this won't re-fire next run): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || process.env.GATEWAY_TOKEN_WATCH_DRY_RUN === "true";
  const databaseUrl = requireEnv("GATEWAY_DATABASE_URL");
  const cutover = new Date(CUTOVER_ISO);

  const client = new pg.Client({ connectionString: databaseUrl, statement_timeout: 20_000, connectionTimeoutMillis: 15_000 });
  let rows: TokenRow[];
  try {
    await client.connect();
    const res = await client.query<TokenRow>(
      `SELECT name, tenant_id, created_at, last_used_at
         FROM acumatica_tenant_tokens
        WHERE revoked_at IS NULL
        ORDER BY created_at`,
    );
    rows = res.rows;
  } finally {
    await client.end().catch(() => {});
  }

  if (rows.length === 0) {
    // Fail-loud (Rule #302 family): an empty token table means the query hit the wrong DB or the
    // schema moved — the monitor is blind, which is itself alert-worthy.
    const msg = "acumatica_tenant_tokens returned ZERO non-revoked rows — wrong DB or schema drift; the watch is blind.";
    console.error(`gateway-token-watch: ${msg}`);
    if (!dryRun) await tryPostSlack(CH_ESCALATIONS, `:red_circle: *Gateway token watch DOWN* — ${msg}`);
    process.exitCode = 1;
    return;
  }

  const prevState = dryRun ? {} : loadAlertState();
  const nextState: AlertState = { ...prevState };

  const legacy = rows.filter((t) => !EXPECTED_ACTIVE.has(t.name));
  const stragglers: TokenRow[] = [];
  const toPost: string[] = [];
  const lines: string[] = [];

  for (const t of legacy) {
    const status = classifyLegacyToken(t.last_used_at, cutover);
    if (status === "STRAGGLER") stragglers.push(t);

    const key = tokenKey(t);
    const prev = prevState[key] ?? "QUIET"; // unseen = quiet baseline: first run alerts only on real post-cutover use
    nextState[key] = status;

    const lastUsed = t.last_used_at ? t.last_used_at.toISOString() : "never";
    lines.push(`  ${t.name.padEnd(36)} ${status.padEnd(10)} last_used=${lastUsed}`);

    if (prev !== status) {
      if (status === "STRAGGLER") {
        toPost.push(
          `:rotating_light: *Gateway legacy token STILL IN USE* — \`${t.name}\` (tenant ${t.tenant_id}) authenticated at ${lastUsed}, AFTER the 2026-07-30 per-consumer cutover. An unmigrated consumer exists — find it in the gateway logs by \`[${t.name}]\` and repoint it (mint via gateway-issue-token.ts). Revocation gate stays CLOSED until this clears.`,
        );
      } else {
        toPost.push(`:large_green_circle: *Gateway legacy token went quiet again* — \`${t.name}\` has no use since the cutover boundary.`);
      }
    }
  }

  // One-time revocation-gate GREEN alert: every legacy token quiet AND the quiet window has fully elapsed.
  const gateKey = "revocation-gate";
  const gateStatus = revocationGate(stragglers.length, cutover, QUIET_DAYS, new Date());
  const gatePrev = prevState[gateKey] ?? "CLOSED";
  nextState[gateKey] = gateStatus;
  if (gatePrev !== gateStatus && gateStatus === "GREEN") {
    const list = legacy.map((t) => `\`${t.name}\``).join(", ");
    toPost.push(
      `:unlock: *Gateway token revocation gate GREEN* — every legacy token has been quiet for ≥${QUIET_DAYS} days since the 2026-07-30 cutover. Safe to revoke (HUMAN-gated, Rule #97): ${list}. Executor: \`gateway-revoke-token.ts\` in studio-b-ai/studiob.`,
    );
  }

  const beacon = `:key: Gateway token watch — ${rows.length} non-revoked token(s): ${EXPECTED_ACTIVE.size} allowlisted-modern, ${legacy.length} legacy (${stragglers.length} straggler(s)). Revocation gate: ${gateStatus}.`;

  if (dryRun) {
    console.log("=== gateway-token-watch --dry-run (real query, NO Slack post, NO state commit) ===");
    for (const l of lines) console.log(l);
    console.log(`\n[beacon → #agent-notifications] ${beacon}`);
    console.log(`[would post ${toPost.length} alert(s) → #agent-escalations]`);
    for (const t of toPost) console.log(`  • ${t}`);
    return;
  }

  // State BEFORE Slack (same rationale as railway-volume-monitor step 4).
  saveAlertState(nextState);
  for (const text of toPost) await tryPostSlack(CH_ESCALATIONS, text);
  await tryPostSlack(CH_NOTIFICATIONS, beacon);
  console.log(`Checked ${rows.length} token(s) (${legacy.length} legacy, ${stragglers.length} straggler(s)); posted ${toPost.length} alert(s) + 1 beacon. Gate: ${gateStatus}.`);
}

main().catch((err) => {
  console.error(`gateway-token-watch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
