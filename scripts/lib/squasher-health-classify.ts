/**
 * Pure classification for squasher-health.ts (Project 2) — extracted for
 * negative-control tests (Rule #322), mirroring the sibling lib/ modules.
 *
 * The monitor exists because the auto-merge gate spent a MONTH structurally
 * inert with nothing red anywhere (ops-pipeline #19 → #23 → #29): fail-closed
 * defects camouflage as "no eligible PRs". A health monitor over the gate is
 * what keeps the 2026-08-04 fix from silently rotting (#464's standing half).
 *
 * Three conditions per caller repo, each an auto-reconciled issue (open =
 * condition active, #292/#358 by construction):
 *
 *   dead-sweep      — no COMPLETED sweep run inside the SLA window. A run stuck
 *                     in_progress forever counts as dead: completion is the signal.
 *   runs-failing    — the latest completed sweep run did not conclude success
 *                     (the #19 crash class: the gate ERRORING, not declining).
 *   crash-receipts  — gate receipts with leg=other in recent logs. Post-#26,
 *                     `other` is the crash-only bucket; any appearance means the
 *                     gate threw somewhere no named leg covers.
 */

export interface SweepRun {
  databaseId: number;
  status: string; // completed | in_progress | queued | ...
  conclusion: string | null; // success | failure | cancelled | startup_failure | ...
  createdAt: string; // ISO
}

export interface Receipt {
  repo: string;
  pr: number;
  cls: string;
  verdict: string;
  leg: string | null;
}

/** `[gate-receipt] repo=... pr=... class=... verdict=... (leg=...)?` lines from run logs. */
const RECEIPT_RE = /\[gate-receipt\] repo=(\S+) pr=(\d+) class=(\S+) verdict=(\S+)(?: leg=(\S+))?/g;

export function parseReceipts(logText: string): Receipt[] {
  const out: Receipt[] = [];
  for (const m of logText.matchAll(RECEIPT_RE)) {
    out.push({ repo: m[1], pr: Number(m[2]), cls: m[3], verdict: m[4], leg: m[5] ?? null });
  }
  return out;
}

export interface HealthCondition {
  key: "dead-sweep" | "runs-failing" | "crash-receipts";
  detail: string;
}

/**
 * Evaluate the three conditions. `now` injected for testability (Rule #256's
 * spirit — never let the authoring clock leak into logic).
 */
export function classifyHealth(
  runs: SweepRun[],
  receipts: Receipt[],
  slaHours: number,
  now: Date,
): HealthCondition[] {
  const conditions: HealthCondition[] = [];

  const completed = runs.filter((r) => r.status === "completed");
  const windowMs = slaHours * 3600 * 1000;
  const inWindow = completed.filter((r) => now.getTime() - Date.parse(r.createdAt) <= windowMs);
  if (inWindow.length === 0) {
    const latest = completed[0];
    conditions.push({
      key: "dead-sweep",
      detail: latest
        ? `No completed sweep run in the last ${slaHours}h — latest completed was ${latest.createdAt} (run ${latest.databaseId}). A dead sweep means the auto-merge gate is INERT: qualified PRs silently wait forever, which reads identical to "no eligible PRs" (the #19/#23/#29 camouflage).`
        : `No completed sweep run found AT ALL in the lookback window (${slaHours}h SLA). Either the schedule never fired or every run is stuck — both are the inert-gate class.`,
    });
  }

  // Latest completed run's verdict — evaluated independently of the SLA window so a
  // repo can be BOTH dead and failing (each condition is its own issue).
  const latest = completed[0];
  if (latest && latest.conclusion !== "success") {
    conditions.push({
      key: "runs-failing",
      detail: `Latest completed sweep run ${latest.databaseId} (${latest.createdAt}) concluded '${latest.conclusion}'. The gate is ERRORING, not declining — the ops-pipeline#19 class. Read that run's log; the failure is in the gate machinery, not the PRs.`,
    });
  }

  const crashes = receipts.filter((r) => r.leg === "other");
  if (crashes.length > 0) {
    const prs = [...new Set(crashes.map((c) => `#${c.pr}`))].join(", ");
    conditions.push({
      key: "crash-receipts",
      detail: `${crashes.length} gate receipt(s) with leg=other in recent sweep logs (PRs: ${prs}). Post-#26, 'other' is the CRASH-ONLY bucket — the gate threw somewhere no named leg covers. Every one is a bug in the gate itself.`,
    });
  }

  return conditions;
}

/** Stable per-condition issue title — the title IS the reconcile identity. */
export function conditionTitle(repo: string, key: HealthCondition["key"]): string {
  return `[squasher-health] ${repo}: ${key}`;
}
