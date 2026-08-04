#!/usr/bin/env tsx
/**
 * gateway-token-watch.ts — CLAUDE.md Rule #279 (staged actions need deterministic triggers).
 *
 * v2 (2026-07-30, Kevin directive): **GitHub issues instead of Slack.** An open issue IS the
 * alert state — the monitor opens one when a condition appears and auto-closes it (with a
 * comment) when the condition clears, so the tracker never accumulates stale alerts. This
 * replaces both the Slack posts AND the committed dedup-state file of v1: an open issue for
 * an active condition is the dedup (Rules #292/#358 by construction), and closing it is the
 * recovery notice. Issues land in studio-b-ai/ops-pipeline under the `token-watch` label.
 * NOTE (#165 amendment, flagged at rigby): monitor alerts route to GitHub issues by Kevin's
 * 2026-07-30 directive, superseding the Slack-channel default for this monitor class.
 * Credential/token remediation stays HUMAN work — these issues are deliberately NOT in the
 * bug-squasher CCR fence (Rules #65/#97: no auto-agent touches credential plumbing).
 *
 * Watch design (unchanged from v1): the 2026-07-30 per-consumer gateway-token rollout left
 * legacy tokens VALID as tripwires. Data source (Rule #413): the gateway's tenant-context
 * middleware stamps `acumatica_tenant_tokens.last_used_at` on every authenticated request,
 * so the watch is one SQL read — no log scraping.
 *   - allowlisted (EXPECTED_ACTIVE) → modern fleet, never alerted on
 *   - legacy, last_used_at ≥ CUTOVER → STRAGGLER → open issue naming the token
 *   - all legacy quiet ≥ QUIET_DAYS past cutover → one-time "revocation gate GREEN" issue —
 *     the APPROVAL surface (close it = acknowledged; execution stays human-gated via
 *     gateway-revoke-token.ts in studio-b-ai/studiob, Rule #97).
 *
 * Duplicate token names are REAL in this table — issue titles carry created_at to disambiguate.
 *
 * Secrets: GATEWAY_DATABASE_URL (public proxy; ⚠️ Rule #99 dual-store with studiob-api's
 * DATABASE_URL — rotate together when the DB moves off the proxy). GitHub access = the
 * workflow's own GITHUB_TOKEN via GH_TOKEN (issues: write). Locally, `gh` keyring auth.
 *
 * SECURITY (Rules #259/#282/#363): GATEWAY_DATABASE_URL is never logged, never put in issue
 * text. Token NAMES are metadata, not secrets; raw sk_acu_* values never appear anywhere here.
 */

import pg from "pg";
import { requireEnv } from "./lib/config.js";
import { classifyLegacyToken, revocationGate } from "./lib/gateway-token-classify.js";
import { reconcileCondition, reconcileGate, gateCloseComment } from "./lib/gateway-token-reconcile.js";
import { ensureLabel as ensureLabelShared, listIssuesByLabel, openIssue as openIssueShared, closeIssue as closeIssueShared, type IssueRef } from "./lib/github-issues.js";

const REPO = "studio-b-ai/ops-pipeline";
const LABEL = "token-watch";

const CUTOVER_ISO = "2026-07-30T00:52:00Z"; // padded past the pre-swap containers' ~00:49Z tail
const QUIET_DAYS = 3;

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

const GATE_TITLE = "[token-watch] revocation gate GREEN — approve legacy-token revocation";
const BLIND_TITLE = "[token-watch] MONITOR BLIND — token table unreadable";

interface TokenRow {
  name: string;
  tenant_id: string;
  created_at: Date;
  last_used_at: Date | null;
}

function stragglerTitle(t: TokenRow): string {
  return `[token-watch] straggler: ${t.name} (minted ${t.created_at.toISOString().slice(0, 10)})`;
}

// ───────────────────────────── gh helpers (shared seam: lib/github-issues.ts) ─────────────────────────────

function listWatchIssues(): IssueRef[] {
  // "all": this monitor's revocation-gate reconcile needs BOTH open issues (openByTitle) AND the
  // set of EVER-CLOSED gate titles (closedTitles, reconcileGate's `everClosed`) — see
  // lib/github-issues.ts's listIssuesByLabel doc comment for why every other monitor passes "open".
  return listIssuesByLabel(REPO, LABEL, "all");
}

function ensureLabel(): void {
  ensureLabelShared(REPO, LABEL, "gateway-token-watch alert state (open = condition active)", "D93F0B");
}

function openIssue(title: string, body: string): void {
  openIssueShared(REPO, LABEL, title, body);
}

function closeIssue(num: number, comment: string): void {
  closeIssueShared(REPO, num, comment);
}

// ───────────────────────────── issue bodies ─────────────────────────────

function stragglerBody(t: TokenRow): string {
  const lastUsed = t.last_used_at ? t.last_used_at.toISOString() : "never";
  return [
    `Legacy gateway token \`${t.name}\` (tenant \`${t.tenant_id}\`, minted ${t.created_at.toISOString()}) authenticated at **${lastUsed}** — AFTER the 2026-07-30 per-consumer cutover (${CUTOVER_ISO}). An unmigrated consumer exists.`,
    "",
    "**Runbook** (human/controller work — deliberately not bug-squasher eligible, Rules #65/#97):",
    `1. Find the consumer: grep studiob-api gateway logs for \`[${t.name}]\` and match the route pattern to a service.`,
    "2. Mint its own token: `railway run --service studiob-api -- node packages/api/dist/scripts/gateway-issue-token.js heritage <consumer>-prod-v1` (capture to env, never print — Rule #429).",
    "3. Pipe into the consumer's env store(s) — check BOTH Railway and GH Actions secrets (Rule #99), and any name-referencing config like `ACUMATICA_SOAP_SUBMIT_TOKEN_SCOPES` (the 2026-07-30 DRP outage class).",
    "4. Add the new name to `EXPECTED_ACTIVE` in `scripts/gateway-token-watch.ts`.",
    "",
    "This issue auto-closes when the token goes quiet again. The revocation gate stays CLOSED while it is open.",
  ].join("\n");
}

function gateBody(legacy: TokenRow[]): string {
  const list = legacy
    .map((t) => `- \`${t.name}\` (minted ${t.created_at.toISOString().slice(0, 10)}, last used ${t.last_used_at ? t.last_used_at.toISOString() : "never"})`)
    .join("\n");
  return [
    `Every legacy gateway token has been quiet for ≥${QUIET_DAYS} days since the 2026-07-30 cutover. Safe to revoke:`,
    "",
    list,
    "",
    "**Execution is human-gated (Rule #97):** run `gateway-revoke-token.ts` in studio-b-ai/studiob per token, then close this issue as the acknowledgment. Closing without revoking is also fine — the monitor will not nag (it never reopens a human-closed gate issue unless the gate cycles CLOSED→GREEN again).",
  ].join("\n");
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

  const issues = listWatchIssues();
  const openByTitle = new Map(issues.filter((i) => i.state === "OPEN").map((i) => [i.title, i]));
  const closedTitles = new Set(issues.filter((i) => i.state === "CLOSED").map((i) => i.title));

  const planned: Array<{ action: "open" | "close"; title: string; num?: number; body?: string; comment?: string }> = [];

  if (rows.length === 0) {
    // Fail-loud: empty token table = wrong DB or schema drift — the watch is blind, which is
    // itself an alert-worthy condition, expressed as an issue like everything else.
    const blindOpen = openByTitle.get(BLIND_TITLE);
    if (!blindOpen) {
      planned.push({ action: "open", title: BLIND_TITLE, body: "`acumatica_tenant_tokens` returned ZERO non-revoked rows — wrong DB or schema drift. The token watch is blind until this is fixed." });
    }
    executePlan(planned, dryRun);
    console.error("gateway-token-watch: token table empty — monitor blind (issue ensured).");
    process.exitCode = 1;
    return;
  }
  const blindOpen = openByTitle.get(BLIND_TITLE);
  if (blindOpen) planned.push({ action: "close", title: BLIND_TITLE, num: blindOpen.number, comment: "Token table readable again — monitor healthy." });

  const legacy = rows.filter((t) => !EXPECTED_ACTIVE.has(t.name));
  const stragglers: TokenRow[] = [];

  for (const t of legacy) {
    const status = classifyLegacyToken(t.last_used_at, cutover);
    if (status === "STRAGGLER") stragglers.push(t);
    const title = stragglerTitle(t);
    const open = openByTitle.get(title);
    const action = reconcileCondition(status === "STRAGGLER", Boolean(open));
    if (action === "open") planned.push({ action, title, body: stragglerBody(t) });
    if (action === "close" && open) planned.push({ action, title, num: open.number, comment: `\`${t.name}\` has no use since the cutover boundary — condition cleared, auto-closed by the token watch.` });
  }

  const gateGreen = revocationGate(stragglers.length, cutover, QUIET_DAYS, new Date()) === "GREEN";
  const gateOpen = openByTitle.get(GATE_TITLE);
  const gate = reconcileGate(gateGreen, legacy.length, Boolean(gateOpen), closedTitles.has(GATE_TITLE));
  if (gate.action === "open") planned.push({ action: "open", title: GATE_TITLE, body: gateBody(legacy) });
  // The close comment NAMES the cause and carries the counts (ops-pipeline#32). The single
  // disjunctive comment this replaces covered two opposite meanings — "the revocation is
  // done" and "something regressed" — and a reader picked the wrong one on 2026-08-04.
  if (gate.action === "close" && gateOpen && gate.reason) {
    planned.push({
      action: "close",
      title: GATE_TITLE,
      num: gateOpen.number,
      comment: gateCloseComment(gate.reason, legacy.length, stragglers.length),
    });
  }

  if (dryRun) {
    console.log("=== gateway-token-watch --dry-run (real DB + issue list, NO mutations) ===");
    for (const t of legacy) {
      const lastUsed = t.last_used_at ? t.last_used_at.toISOString() : "never";
      console.log(`  ${t.name.padEnd(36)} ${(stragglers.includes(t) ? "STRAGGLER" : "QUIET").padEnd(10)} last_used=${lastUsed}`);
    }
    console.log(`  gate: ${gateGreen ? "GREEN" : "CLOSED"} | open watch issues: ${openByTitle.size}`);
    console.log(`[would perform ${planned.length} issue action(s)]`);
    for (const p of planned) console.log(`  • ${p.action.toUpperCase()} ${p.title}`);
    return;
  }

  if (!dryRun) ensureLabel();
  executePlan(planned, dryRun);
  console.log(
    `Checked ${rows.length} token(s) (${legacy.length} legacy, ${stragglers.length} straggler(s)); issue actions: ${planned.length} (${planned.map((p) => p.action).join(",") || "none"}). Gate: ${gateGreen ? "GREEN" : "CLOSED"}.`,
  );
}

function executePlan(planned: Array<{ action: "open" | "close"; title: string; num?: number; body?: string; comment?: string }>, dryRun: boolean): void {
  if (dryRun) return;
  for (const p of planned) {
    if (p.action === "open") openIssue(p.title, p.body ?? "");
    if (p.action === "close" && p.num !== undefined) closeIssue(p.num, p.comment ?? "auto-closed by the token watch");
  }
}

main().catch((err) => {
  console.error(`gateway-token-watch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
