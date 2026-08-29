/**
 * restart-train-fire.ts — PURE fire/observe logic for the Heritage restart train's rung 3
 * (ops-pipeline#172; Kevin GO "done;go", sitting 2026-08-28 §8.4).
 *
 * Rung 3 turns the rung-2 CLICK DUE page into a real sha-pinned squash-merge plus a cross-tick
 * OBSERVE state machine: after the merge, the worker applies `train:in-flight` to the merged PR
 * and every subsequent tick classifies the restart that merge triggered until it reaches END
 * (restart completed — the anchor self-advances off the same machine facts) or END · FAILED
 * (train locks behind a machinery issue a HUMAN closes, Rule #161).
 *
 * This module is deliberately I/O-free (same split as restart-train-lib.ts): the worker
 * (scripts/restart-train.ts) fetches Railway deployments / Actions runs / PR state and hands the
 * raw shapes here for classification. Every decision about "what does this deployment/run state
 * MEAN for the train" lives in this file so it is unit-testable with #322 both-directions
 * controls; the worker stays glue.
 *
 * Observation legs (design locked pre-build, 2026-08-29 sitting follow-through):
 *
 *   studiob — merging to main triggers a studiob-api Railway deploy (two overlapping triggers
 *   exist: deploy-api.yml + Railway's own GitHub webhook, so a single merge may create TWO
 *   deployments). Classification waits for every post-merge deployment to leave in-flight
 *   status, then: any SUCCESS → deployed (worker then probes /health per Rule #208 — Railway
 *   SUCCESS already implies its healthcheck passed; the probe is belt+suspenders and is the
 *   spec's own wording, "`/health` 200 on the NEW deployment"); else any FAILED/CRASHED →
 *   failed; else (only SKIPPED/REMOVED) → keep waiting (a skipped deploy is NOT a restart — the
 *   timeout ladder below eventually escalates rather than ever fabricating an END). A
 *   deployment that reached SUCCESS and later crashed shows its CURRENT status (CRASHED), so
 *   the any-SUCCESS check cannot be fooled by a deploy that didn't stay up.
 *
 *   client-asthetik — merging to main triggers acuops-build.yml (workflow 262954027) on the
 *   MERGE COMMIT sha. The deploy job is found by its qualified name "deploy / Deploy to
 *   production"; the bare name "deploy" appears when the deploy stage was SKIPPED (no inner
 *   reusable-workflow job exists — live-verified 2026-08-19 on run 32297034397), so both names
 *   are recognized and a missing job in a completed run fails CLOSED. A run failing
 *   specifically at the after-hours gate step is WINDOW_BLOCKED, detected by the STEP NAME
 *   (never by wall-clock proximity to the window edge — Rule #425: a real failure near 06:00 ET
 *   would misclassify under a time heuristic and a re-dispatch loop would republish a broken
 *   deploy forever). WINDOW_BLOCKED keeps the train in-flight with escalation suspended (a
 *   known, intentional state); the worker re-dispatches the workflow once the window law clears
 *   — after first proving main still points at the merge commit (dispatching runs MAIN, so if
 *   main moved past our merge, a re-dispatch would publish someone ELSE's code → END · FAILED
 *   instead).
 *
 * Timeout ladder (#269/#448 — the observe loop needs its own staleness law): each leg has an
 * expected-completion window (studiob 20 min — Railway build+deploy is minutes; client-asthetik
 * 60 min — a full Customization publish can run long, #16 budgets 8+ min for the publish phase
 * alone). Within window → quiet. 1×–2× → overdue (log-only; no issue spam). ≥2× → escalate:
 * the worker opens ONE deduped machinery issue and the train STAYS LOCKED (an unobservable
 * restart is never assumed complete — Rule #4; a human closes the issue to release).
 */

import type { DeploymentRecord } from "./railway-deployment-probes.js";
import type { RepoClass } from "./restart-train-lib.js";

// ───────────────────────────── constants ─────────────────────────────

export const TRAIN_READY_LABEL = "train:ready";
export const TRAIN_IN_FLIGHT_LABEL = "train:in-flight";
// NO train:failed label — Kevin's 2026-08-29 label consolidation ("if my only label is
// train:ready then I want it to be that way in github"): a failed observe is recorded by the
// END · FAILED ledger line + the machinery issue (which alone locks the train); a marker label
// would duplicate that state and widen the label surface humans have to understand.

/**
 * Expected observe-completion windows per repo class (ms). ≥2× these values escalates (see the
 * file header's timeout ladder). "other" never legitimately carries `train:in-flight` — the
 * worker only ever labels PRs in the two ticket repos — so `observeTimeoutVerdict` fails an
 * unknown class straight to "escalate".
 */
export const OBSERVE_WINDOW_MS: Record<"studiob" | "client-asthetik", number> = {
  studiob: 20 * 60_000,
  "client-asthetik": 60 * 60_000,
};

/** Qualified deploy-job name when the reusable workflow actually ran (see file header). */
export const CA_DEPLOY_JOB_QUALIFIED = "deploy / Deploy to production";
/** Bare caller-job name rendered when the deploy stage was skipped (no inner job exists). */
export const CA_DEPLOY_JOB_BARE = "deploy";
/**
 * The acuops-build.yml step whose FAILURE means "blocked by the business-hours window", not a
 * broken deploy. Detection is by exact step name only — never by time-of-day (Rule #425).
 */
export const CA_HOURS_GATE_STEP = "Enforce after-hours gate for prod/staging publishes";

// ───────────────────────────── fire guards ─────────────────────────────

/**
 * Never merge a revert PR unattended (standing constraint, carried from the automerge gate's
 * own law): a revert exists because something already went wrong — a human decides its timing.
 * Anchored match so mid-title "revert" ("fix: no longer revert X") does NOT trip it.
 */
export function isRevertTitle(title: string): boolean {
  return /^\s*revert\b/i.test(title);
}

// ───────────────────────────── studiob leg classification ─────────────────────────────

export type StudiobDeployClassification =
  | { kind: "waiting"; detail: string }
  | { kind: "deployed"; detail: string }
  | { kind: "failed"; detail: string };

/**
 * Classify the post-merge Railway deployment set for studiob-api. `mergedAtIso` scopes the set:
 * deployments created BEFORE the merge (including the previously-serving one) are invisible
 * here — a pre-merge FAILED can never fail the observe (#322 negative control in the tests).
 * Unparseable timestamps are treated as NOT post-merge (excluded), which biases toward waiting
 * → the timeout ladder, never toward a fabricated END.
 */
export function classifyStudiobDeployments(
  mergedAtIso: string,
  deployments: DeploymentRecord[],
  terminalStatuses: ReadonlySet<string>,
): StudiobDeployClassification {
  const mergedAtMs = Date.parse(mergedAtIso);
  if (Number.isNaN(mergedAtMs)) {
    return { kind: "waiting", detail: `unparseable mergedAt "${mergedAtIso}" — cannot scope deployments; will retry` };
  }
  const postMerge = deployments.filter((d) => {
    const created = Date.parse(d.createdAt);
    return !Number.isNaN(created) && created >= mergedAtMs;
  });
  if (postMerge.length === 0) {
    return { kind: "waiting", detail: "no post-merge Railway deployment yet" };
  }
  const inFlight = postMerge.filter((d) => !terminalStatuses.has(d.status));
  if (inFlight.length > 0) {
    const d = inFlight[0];
    return { kind: "waiting", detail: `deployment ${d.id.slice(0, 8)} still ${d.status}` };
  }
  const success = postMerge.find((d) => d.status === "SUCCESS");
  if (success) {
    return { kind: "deployed", detail: `Railway deployment ${success.id.slice(0, 8)} SUCCESS` };
  }
  const failed = postMerge.find((d) => d.status === "FAILED" || d.status === "CRASHED");
  if (failed) {
    return { kind: "failed", detail: `Railway deployment ${failed.id.slice(0, 8)} ${failed.status} with no successful sibling` };
  }
  // Only SKIPPED/REMOVED — terminal, but no restart happened and none is coming from this set.
  // Wait (a real deploy may still be triggered); the timeout ladder escalates if none arrives.
  return {
    kind: "waiting",
    detail: `all ${postMerge.length} post-merge deployment(s) SKIPPED/REMOVED — no restart observed yet`,
  };
}

// ───────────────────────────── client-asthetik leg classification ─────────────────────────────

export interface WorkflowRunLike {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
}

export interface WorkflowJobLike {
  name: string;
  conclusion: string | null;
  steps: Array<{ name: string; conclusion: string | null }>;
}

/**
 * Newest run by created_at (ISO string compare is safe — GitHub emits a fixed UTC format).
 * Latest-wins makes the WINDOW_BLOCKED re-dispatch idempotent across ticks: once the dispatched
 * run exists it IS the latest for the merge sha, so the blocked run stops being consulted.
 */
export function pickLatestRun(runs: WorkflowRunLike[]): WorkflowRunLike | null {
  if (runs.length === 0) return null;
  return runs.reduce((latest, r) => (r.created_at > latest.created_at ? r : latest));
}

/** Qualified name first (deploy actually ran), bare fallback (skipped variant) — see file header. */
export function pickDeployJob(jobs: WorkflowJobLike[]): WorkflowJobLike | null {
  return jobs.find((j) => j.name === CA_DEPLOY_JOB_QUALIFIED) ?? jobs.find((j) => j.name === CA_DEPLOY_JOB_BARE) ?? null;
}

export type CaRunClassification =
  | { kind: "waiting"; detail: string }
  | { kind: "success"; detail: string }
  | { kind: "skipped"; detail: string }
  | { kind: "window-blocked"; detail: string }
  | { kind: "failed"; detail: string };

/**
 * Classify the latest acuops-build run for the merge commit. `run === null` means no run has
 * appeared for the sha yet (push-event runs appear within seconds; a dispatched run within
 * seconds of dispatch) → waiting. A COMPLETED run with no recognizable deploy job fails CLOSED
 * (#4 — "the run finished and we cannot see a deploy" is never treated as success). Conclusion
 * vocabulary beyond success/skipped/failure (cancelled, timed_out, stale, null) also fails
 * closed — a cancelled publish is not a completed restart.
 */
export function classifyCaRun(run: WorkflowRunLike | null, deployJob: WorkflowJobLike | null): CaRunClassification {
  if (!run) {
    return { kind: "waiting", detail: "no acuops-build run for the merge commit yet" };
  }
  if (run.status !== "completed") {
    return { kind: "waiting", detail: `run ${run.id} ${run.status}` };
  }
  if (!deployJob) {
    return { kind: "failed", detail: `run ${run.id} completed but no deploy job found — fail-closed (#4)` };
  }
  if (deployJob.conclusion === "success") {
    return { kind: "success", detail: `run ${run.id} job "${deployJob.name}" success` };
  }
  if (deployJob.conclusion === "skipped") {
    return {
      kind: "skipped",
      detail: `run ${run.id} deploy job skipped — no publish was triggered by this merge`,
    };
  }
  if (deployJob.conclusion === "failure") {
    const gateStep = deployJob.steps.find((s) => s.name === CA_HOURS_GATE_STEP && s.conclusion === "failure");
    if (gateStep) {
      return {
        kind: "window-blocked",
        detail: `run ${run.id} blocked by the after-hours gate step — deploy deferred to the publish window`,
      };
    }
    return { kind: "failed", detail: `run ${run.id} job "${deployJob.name}" failure (not the hours gate)` };
  }
  return {
    kind: "failed",
    detail: `run ${run.id} job "${deployJob.name}" conclusion ${JSON.stringify(deployJob.conclusion)} — fail-closed (#4)`,
  };
}

// ───────────────────────────── timeout ladder ─────────────────────────────

export type ObserveTimeoutVerdict = "within-window" | "overdue" | "escalate";

/**
 * Staleness law for a waiting observation (#448: the check cadence — every 5 min — beats both
 * windows). `startedIso` is the phase's own durable machine fact (#413): mergedAt until a run
 * exists; the run's created_at once one does (which also resets the clock after a
 * WINDOW_BLOCKED re-dispatch — an overnight window wait must not count against the NEW run).
 * Unparseable stamps or an unknown repo class escalate (fail-closed — an unmeasurable
 * observation is never quietly trusted, Rule #382).
 */
export function observeTimeoutVerdict(startedIso: string, nowIso: string, repoClass: RepoClass): ObserveTimeoutVerdict {
  if (repoClass !== "studiob" && repoClass !== "client-asthetik") return "escalate";
  const started = Date.parse(startedIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(started) || Number.isNaN(now)) return "escalate";
  const elapsed = now - started;
  const window = OBSERVE_WINDOW_MS[repoClass];
  if (elapsed < window) return "within-window";
  if (elapsed < 2 * window) return "overdue";
  return "escalate";
}

// ───────────────────────────── ledger lines + observe state keys ─────────────────────────────

/**
 * These lines post to `--target` (ops-pipeline#172) + the merged PR — NEVER the #280 calendar
 * (restart-train-args.ts refuses it as a target). The worker's anchor parsers
 * (parseEndComments/findDanglingPlan) read ONLY calendar comments, so nothing here can feed
 * back into anchor computation (verified against restart-train.ts main() before this build).
 */
export function formatStartLine(nowIso: string, repo: string, number: number, sha: string): string {
  return `START ${nowIso} · ${repo}#${number} @ ${sha.slice(0, 7)} squash-merged by restart-train (rung 3) — observing restart`;
}

export function formatEndLine(nowIso: string, repo: string, number: number, detail: string): string {
  return `END ${nowIso} · ${repo}#${number} restart observed complete — ${detail}`;
}

export function formatEndFailedLine(nowIso: string, repo: string, number: number, detail: string): string {
  return `END · FAILED ${nowIso} · ${repo}#${number} — ${detail}`;
}

export function formatObserveNote(nowIso: string, repo: string, number: number, detail: string): string {
  return `NOTE ${nowIso} · ${repo}#${number} ${detail}`;
}

/**
 * Dedup key for observe-phase receipts, following clickDueStateKey's shape: one receipt per
 * (PR, merge sha, phase) state — never per tick (#292). The worker hashes this to the
 * `<!-- restart-train:observe=<sha256-12> -->` marker on the PR's own thread.
 */
export function observeStateKey(repo: string, number: number, sha: string, phase: string): string {
  return `observe :: ${repo}#${number} @ ${sha} :: ${phase}`;
}
