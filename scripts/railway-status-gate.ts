#!/usr/bin/env tsx
/**
 * railway-status-gate.ts — deploy-time vendor-status gate (ops-pipeline#167 leg 1).
 *
 * Run at the head of any Railway deploy workflow (first consumer:
 * studiob/.github/workflows/deploy-api.yml via the reusable workflow
 * .github/workflows/railway-status-gate.yml). Fetches status.railway.com live and:
 *
 *   HOLD        -> ::error:: + exit 1  (an ACTIVE incident touches a deploy-path
 *                  component in a relevant region — deploying into a degraded platform
 *                  is the 2026-08-18 23:19Z incident class: snapshots timed out, the
 *                  deploy stalled mid-flight)
 *   CLEAR       -> exit 0
 *   PARSE_ERROR -> ::warning:: + exit 0 (FAIL-OPEN, Rule #295: a dead/reshaped status
 *                  page is not evidence Railway is degraded; it must not block deploys —
 *                  but it is loud, because a silently-blind gate is worse than none,
 *                  Rule #464)
 *
 * Escape hatch (Kevin-authorized deploy-during-incident): RAILWAY_STATUS_GATE_SKIP=1
 * prints a loud notice and exits 0 without fetching. The reusable workflow exposes this
 * as a `skip` input on workflow_dispatch.
 *
 * Planted-verdict rung (Rules #464/#471 — plant the control for the verdict the guard
 * does NOT default to): RAILWAY_STATUS_FIXTURE=<path> evaluates a fixture file through
 * the FULL parse+verdict+exit-code path, gating only the fetch (Rule #376: the safe rung
 * produces the live rung's signal minus the mutation). Committed fixtures:
 *   scripts/lib/__tests__/fixtures/railway-status/synthetic-active-hold.txt    -> HOLD
 *   scripts/lib/__tests__/fixtures/railway-status/synthetic-active-ignored.txt -> CLEAR
 *   scripts/lib/__tests__/fixtures/railway-status/tail-clear.txt               -> CLEAR
 * (both synthetic-* files carry REAL captured incident records — only the placement as
 * "active" is synthetic.)
 */

import { readFileSync } from "node:fs";
import { evaluateStatusHtml, fetchStatusHtml } from "./lib/railway-status.js";

async function main(): Promise<void> {
  if (process.env.RAILWAY_STATUS_GATE_SKIP === "1") {
    console.log("::warning::railway-status-gate SKIPPED via RAILWAY_STATUS_GATE_SKIP=1 (deploy-during-incident override)");
    return;
  }

  const fixture = process.env.RAILWAY_STATUS_FIXTURE;
  let html: string;
  if (fixture) {
    console.log(`railway-status-gate: evaluating FIXTURE ${fixture} (planted-verdict rung, not live state)`);
    html = readFileSync(fixture, "utf-8");
  } else {
    try {
      html = await fetchStatusHtml();
    } catch (err) {
      // Fail OPEN: unreachable status page !== degraded Railway (Rule #295).
      console.log(`::warning::railway-status-gate could not fetch status.railway.com (${String(err)}) — FAIL-OPEN, deploy proceeds unverified`);
      return;
    }
  }

  const snap = evaluateStatusHtml(html);
  console.log(JSON.stringify({
    verdict: snap.verdict,
    reason: snap.reason,
    generatedAt: snap.generatedAt,
    staleHours: snap.staleHours === null ? null : Number(snap.staleHours.toFixed(2)),
    active: snap.activeGateRelevant.map((i) => i.slug),
    ignored: snap.activeIgnored.map((i) => i.slug),
    recentCount: snap.recentIncidents.length,
  }));

  if (snap.verdict === "HOLD") {
    console.log(`::error::railway-status-gate HOLD — ${snap.reason}`);
    console.log("Deploying into a degraded Railway is the 2026-08-18 incident class (stalled deploys, timed-out snapshots).");
    console.log("Wait for the incident to resolve (status.railway.com), or re-run with skip=true (workflow_dispatch) for a Kevin-authorized override.");
    process.exit(1);
  }
  if (snap.verdict === "PARSE_ERROR") {
    console.log(`::warning::railway-status-gate PARSE_ERROR — ${snap.reason} — FAIL-OPEN, deploy proceeds unverified`);
    return;
  }
  if (snap.staleHours !== null && snap.staleHours > 6) {
    console.log(`::warning::railway-status-gate: page generatedAt is ${snap.staleHours.toFixed(1)}h old — instrument may be stale (#453 class)`);
  }
  console.log(`railway-status-gate CLEAR — ${snap.reason}`);
}

main().catch((err) => {
  // Unexpected internal error: fail OPEN but loud (same #295 contract as fetch failure).
  console.log(`::warning::railway-status-gate internal error (${String(err)}) — FAIL-OPEN, deploy proceeds unverified`);
});
