#!/usr/bin/env tsx
/**
 * railway-incident-ledger.ts — Railway incident ledger worker (ops-pipeline#167 leg 2).
 *
 * Every 6h (GH Actions cron) + workflow_dispatch: fetch status.railway.com, parse
 * activeIncidents + recentIncidents (scripts/lib/railway-status.ts), and reconcile ONE
 * standing ledger issue in studio-b-ai/ops-pipeline (label `railway-incident-ledger`) —
 * rows upserted by slug, existing rows kept when incidents age off the page's ~3-month
 * retention (see scripts/lib/railway-ledger.ts header).
 *
 * Cadence note (Rule #448 — cadence must beat the SLA): the ledger's completeness does
 * NOT depend on the cron, because recentIncidents backfills anything that started AND
 * resolved between polls; 6h affects only how quickly a row appears. The claimed SLA is
 * "ledger complete within 24h of an incident appearing on the page" — 6h < 24h. The
 * deploy GATE does its own live fetch at deploy time and does not depend on this worker.
 *
 * Mutations per run (at most): one issue create (first run), one body edit (only when
 * rows actually added/changed — an unchanged table is NOT re-edited, so the issue
 * timeline stays quiet on no-news runs, Rule #292 by construction), one delta comment
 * naming added/updated slugs.
 *
 * Fail-loud (Rule #456 — a quiet channel is unverified silence): fetch or PARSE_ERROR ->
 * exit 1 (red run) + a deduped `PROBE FAILED` comment on the ledger issue when one
 * exists (skipped when the most recent comment is already PROBE FAILED, Rule #292).
 *
 * --dry-run (workflow_dispatch dry_run=true): real fetch + real issue read, ZERO
 * mutations — prints the planned delta.
 *
 * Env: GH_TOKEN (issues:write on ops-pipeline — the default workflow GITHUB_TOKEN).
 * Optional RAILWAY_STATUS_FIXTURE=<path> for fixture-driven runs (tests/receipts).
 */

import { readFileSync } from "node:fs";
import { evaluateStatusHtml, fetchStatusHtml, type StatusIncident } from "./lib/railway-status.js";
import { buildLedgerBody, LEDGER_LABEL, LEDGER_TITLE } from "./lib/railway-ledger.js";
import {
  commentIssue,
  editIssueBody,
  ensureLabel,
  gh,
  listIssueComments,
  listIssuesByLabel,
  openIssue,
} from "./lib/github-issues.js";

const REPO = "studio-b-ai/ops-pipeline";
const PROBE_FAILED_MARKER = "**PROBE FAILED**";

function findLedgerIssue(): { number: number; body: string } | null {
  const issues = listIssuesByLabel(REPO, LEDGER_LABEL, "open");
  if (issues.length === 0) return null;
  // Oldest open issue with the label is canonical; duplicates would be a hand-error.
  const issue = issues.sort((a, b) => a.number - b.number)[0];
  const body = gh(["issue", "view", String(issue.number), "--repo", REPO, "--json", "body", "-q", ".body"]);
  return { number: issue.number, body };
}

function reportProbeFailure(reason: string, dryRun: boolean): void {
  console.log(`::error::railway-incident-ledger PROBE FAILED — ${reason}`);
  if (dryRun) return;
  const ledger = findLedgerIssue();
  if (!ledger) return;
  const comments = listIssueComments(REPO, ledger.number);
  const last = comments[comments.length - 1];
  if (last && last.body.startsWith(PROBE_FAILED_MARKER)) {
    console.log("PROBE FAILED comment already latest — not duplicating (#292).");
    return;
  }
  commentIssue(
    REPO,
    ledger.number,
    `${PROBE_FAILED_MARKER} ${new Date().toISOString()} — ${reason}\n\nThe ledger is NOT accumulating while this persists; recentIncidents backfill covers gaps up to ~3 months once the probe recovers.`,
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const fixture = process.env.RAILWAY_STATUS_FIXTURE;

  let html: string;
  try {
    html = fixture ? readFileSync(fixture, "utf-8") : await fetchStatusHtml();
  } catch (err) {
    reportProbeFailure(`status page fetch failed: ${String(err)}`, dryRun);
    process.exit(1);
  }

  const snap = evaluateStatusHtml(html);
  if (snap.verdict === "PARSE_ERROR") {
    reportProbeFailure(snap.reason, dryRun);
    process.exit(1);
  }

  // Merge active over recent, deduped by slug (active state wins).
  const bySlug = new Map<string, StatusIncident>();
  for (const inc of snap.recentIncidents) bySlug.set(inc.slug, inc);
  for (const inc of [...snap.activeGateRelevant, ...snap.activeIgnored]) bySlug.set(inc.slug, inc);
  const fresh = [...bySlug.values()];

  if (snap.activeGateRelevant.length > 0) {
    console.log(`::warning::ACTIVE deploy-path Railway incident(s): ${snap.activeGateRelevant.map((i) => i.slug).join(", ")} — the deploy gate will HOLD`);
  }

  const nowIso = new Date().toISOString();
  const ledger = findLedgerIssue();
  const result = buildLedgerBody(ledger?.body ?? "", fresh, snap.generatedAt, nowIso);
  const delta = result.addedSlugs.length + result.updatedSlugs.length;

  console.log(
    `parsed: ${fresh.length} incidents from page (${snap.activeGateRelevant.length} active deploy-path, ${snap.activeIgnored.length} active ignored); ` +
      `ledger rows after merge: ${result.totalRows}; added: ${result.addedSlugs.join(", ") || "none"}; updated: ${result.updatedSlugs.join(", ") || "none"}`,
  );

  if (dryRun) {
    console.log(`DRY-RUN — no mutations. Would ${ledger ? (delta > 0 ? `edit issue #${ledger.number}` : "leave issue unchanged") : "create the ledger issue"}.`);
    return;
  }

  if (!ledger) {
    ensureLabel(REPO, LEDGER_LABEL, "Auto-reconciled Railway platform incident ledger (ops#167)", "0e8a16");
    openIssue(REPO, LEDGER_LABEL, LEDGER_TITLE, result.body);
    console.log(`Created ledger issue with ${result.totalRows} rows.`);
    return;
  }

  if (delta === 0) {
    console.log(`No row changes — issue #${ledger.number} untouched.`);
    return;
  }

  editIssueBody(REPO, ledger.number, result.body);
  const parts: string[] = [];
  if (result.addedSlugs.length > 0) parts.push(`added: ${result.addedSlugs.map((s) => `\`${s}\``).join(", ")}`);
  if (result.updatedSlugs.length > 0) parts.push(`updated: ${result.updatedSlugs.map((s) => `\`${s}\``).join(", ")}`);
  commentIssue(REPO, ledger.number, `Reconciled ${nowIso} — ${parts.join("; ")} (${result.totalRows} rows total).`);
  console.log(`Edited issue #${ledger.number}: ${parts.join("; ")}.`);
}

main().catch((err) => {
  console.log(`::error::railway-incident-ledger internal error: ${String(err)}`);
  process.exit(1);
});
