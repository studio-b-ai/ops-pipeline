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

/**
 * Run conclusions that mean "the workflow never really executed" rather than
 * "the workflow ran and failed". Born 2026-08-06 from a live misfire: during a
 * GitHub Actions `major_outage`, sweeps across the fleet were CANCELLED at
 * `Set up job` with zero failed steps, and this classifier reported them as
 * `runs-failing` with the prose "the gate is ERRORING… the failure is in the
 * gate machinery". Both halves were false, and the log it pointed at was empty.
 *
 * `timed_out` is deliberately NOT here — a hang is a real machinery symptom.
 */
export const INFRASTRUCTURE_CONCLUSIONS = new Set([
  "cancelled",
  "startup_failure",
  "stale",
]);

export function isInfrastructureConclusion(conclusion: string | null): boolean {
  return conclusion !== null && INFRASTRUCTURE_CONCLUSIONS.has(conclusion);
}

/**
 * Job-level evidence for ONE run. Required because the run-level conclusion is not
 * sufficient (see `isInfrastructureRun`).
 */
export interface RunJobEvidence {
  /** Every job's conclusion, in the run's job order. */
  jobConclusions: (string | null)[];
  /** Count of steps across ALL jobs whose conclusion is 'failure'. */
  failedStepCount: number;
}

/**
 * Is this run infrastructure (never really executed) rather than machinery failure?
 *
 * Run-level conclusion ALONE is insufficient, and ops-pipeline#54 shipped believing
 * it was. Its first live firing (studiob 2026-08-06, runs 31121889185 + 31126256596)
 * falsified that: GitHub reported BOTH runs as run-conclusion **'failure'** while
 * every job was 'cancelled'/'skipped' with **zero failed steps**. #54's
 * INFRASTRUCTURE_CONCLUSIONS check keys on the run conclusion, so it did not fire,
 * and the monitor again told a reader "the gate is ERRORING... the failure is in the
 * gate machinery" and pointed at a log containing nothing — the exact #412 defect #54
 * was built to remove, in a shape #54 does not catch.
 *
 * The irony worth preserving: #54's own `runs-failing` prose already told a HUMAN to
 * go look at the job list ("If the job list shows only cancellations with no failed
 * steps, this is infrastructure instead"). The instruction was right; it just was
 * never given to the CODE. A guard that knows the correct check and does not perform
 * it is not a guard.
 *
 * Predicate: no job failed, no step failed, and at least one job was cancelled. The
 * cancelled-job requirement keeps this tight — a run that failed with genuinely zero
 * failed steps for some OTHER reason stays classified as machinery failure, because
 * fail-toward-machinery is the safer default for a monitor (a false 'infrastructure'
 * silences a real defect; a false 'runs-failing' merely over-reports).
 */
export function isInfrastructureRun(
  conclusion: string | null,
  jobs?: RunJobEvidence,
): boolean {
  if (isInfrastructureConclusion(conclusion)) return true;
  if (!jobs || jobs.jobConclusions.length === 0) return false;
  const anyJobFailed = jobs.jobConclusions.includes("failure");
  const anyJobCancelled = jobs.jobConclusions.includes("cancelled");
  return !anyJobFailed && jobs.failedStepCount === 0 && anyJobCancelled;
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
  key: "dead-sweep" | "runs-failing" | "crash-receipts" | "sweep-infrastructure";
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
  /** Job-level evidence for the LATEST COMPLETED run, when the caller fetched it. */
  latestRunJobs?: RunJobEvidence,
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
    if (isInfrastructureRun(latest.conclusion, latestRunJobs)) {
      // NOT a machinery failure. A cancelled or never-started run tells us
      // nothing about the gate — the gate did not execute. Saying "the gate is
      // ERRORING" here is a claim the signal cannot support (#412), and during
      // the 2026-08-06 GitHub Actions outage it fired on every repo and sent
      // readers to a log containing nothing.
      conditions.push({
        key: "sweep-infrastructure",
        detail:
          `Latest completed sweep run ${latest.databaseId} (${latest.createdAt}) concluded '${latest.conclusion}' — the run was killed or never started, so the gate did NOT execute. This is an INFRASTRUCTURE signal, not a gate defect: check https://www.githubstatus.com. Do not read this as the gate erroring, and do not read it as the gate being healthy either — it is simply unmeasured this cycle.` +
          (isInfrastructureConclusion(latest.conclusion)
            ? ""
            : `\n\nClassified from JOB-LEVEL evidence, not the run conclusion: jobs = [${latestRunJobs?.jobConclusions.map((c) => c ?? "null").join(", ")}] with ${latestRunJobs?.failedStepCount} failed step(s). GitHub reports a run whose jobs were cancelled mid-flight as run-conclusion '${latest.conclusion}', which is why the run conclusion alone cannot be trusted here (ops-pipeline#54's gap, caught by its own first live firing on studiob 2026-08-06).`),
      });
    } else {
      conditions.push({
        key: "runs-failing",
        detail: `Latest completed sweep run ${latest.databaseId} (${latest.createdAt}) concluded '${latest.conclusion}'. The gate ran and did not succeed — the ops-pipeline#19 class. Read that run's log: if a step failed, the failure is in the gate machinery, not the PRs. (If the job list shows only cancellations with no failed steps, this is infrastructure instead — see \`sweep-infrastructure\`.)`,
      });
    }
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
