/**
 * canary-liveness-lib.ts — pure classify/render logic for the surface-canary CRON-LIVENESS
 * leg (ops-pipeline, Mechanic seat, stint #465 "Watch the watcher"). Read this header first;
 * no I/O, no `gh` calls, no `new Date()` lives here — the worker is the I/O glue, this file
 * is the decision.
 *
 * Why this exists: Kevin 9/16: "all of this should be automated. get us there." The surface
 * canary program watches public surfaces (b.studio, bibelhausen.com, lmmi.b.studio,
 * amplify.b.studio, switchboard.b.studio + the sweep's heartbeat). The canary's OWN machinery
 * alerts on surface DEGRADATION — it has no leg watching whether the scheduler itself is still
 * ticking at all. This leg is that watch, and answers exactly one question every 15 minutes
 * (Rule #448 — the check cadence must beat the 30-minute SLA it measures against, not merely
 * match it).
 *
 * ── Verdicts (exactly three) ──
 *   - `disabled` — `SURFACE_CANARY_ENABLED` is not `'true'`. The canary is DELIBERATELY off
 *     (the workflow's own job-level `if:` gate) — silence is expected and correct; never
 *     alert on it. Checked FIRST, ahead of everything else.
 *   - `stale`  — the surface-canary sweep has never once completed a schedule-triggered run,
 *     OR the last completed schedule-triggered run is more than `windowMinutes` STRICTLY
 *     older than `now`. The canary is silent and MUST be on. This is the ONLY verdict that
 *     opens an alert (Rule #292 transition-only — the open-issue set IS the dedup state).
 *   - `ok`     — enabled AND the last completed schedule-triggered run is within
 *     `windowMinutes` of `now`.
 *
 * No `idle` verdict: unlike the restart train (which can be legitimately idle when zero box
 * PRs are queued), the surface canary's job IS to run — it checks surfaces every 5 minutes
 * regardless of external state. A silent canary is never OK when enabled.
 *
 * `windowMinutes` defaults to `CANARY_LIVENESS_STALE_MINUTES` (30). The canary sweep runs
 * every 5 minutes; 30 minutes of silence = 6+ missed ticks. The comparison at the boundary is
 * STRICTLY greater-than (`rawMinutes > windowMinutes`, not `≥`): exactly-at-30 reads `ok`,
 * not `stale` — mirrors train-liveness-lib.ts's boundary contract.
 *
 * `silentMinutes` is computed from the RAW (unfloored) millisecond difference for the
 * threshold comparison, then floored only for display/formatting — the same technique
 * train-liveness-lib.ts uses, so a value like 30.1 minutes can never be softened by flooring
 * into a false `ok` at the boundary.
 *
 * Rule #292 (transition-only): this file has no notion of "already alerted" — that dedup lives
 * entirely in the WORKER via `listIssuesByLabel`. `evaluateCanaryLiveness` is called once per
 * tick and always returns the CURRENT verdict; the worker decides open/close/leave-alone by
 * comparing this verdict against whether an issue is already open.
 */

// ───────────────────────────── constants ─────────────────────────────

/** GitHub label this leg's own auto-reconciled issue carries (Rule #165: the open-issue set IS the dedup state). */
export const CANARY_LIVENESS_LABEL = "canary-liveness";

/**
 * Staleness threshold in minutes. 30: the surface-canary sweep runs every 5 minutes, so
 * 30 minutes of silence = 6+ missed ticks — firmly into "the scheduler is dead" territory
 * without being so tight it false-positives on ordinary GitHub Actions cron jitter at the
 * `:00`/`:30` peaks (Rule #425 — sizing is from the train-liveness incident's own 30-min
 * threshold, tightened 10 min vs that leg because the surface canary's 5-min cadence is
 * 6× more frequent than the restart train's).
 */
export const CANARY_LIVENESS_STALE_MINUTES = 30;

export const CANARY_LIVENESS_VERDICTS = ["ok", "stale", "disabled"] as const;

export type CanaryLivenessVerdict = (typeof CANARY_LIVENESS_VERDICTS)[number];

// ───────────────────────────── evaluate ─────────────────────────────

export interface EvaluateCanaryLivenessInput {
  /** ISO 8601 — the worker's clock (real or `--now`-overridden), passed in so this stays pure (Rule #256). */
  nowIso: string;
  /** ISO 8601 completion timestamp of the most recent COMPLETED, SCHEDULE-TRIGGERED run of surface-canary.yml, or `null` if the workflow has never completed one. */
  lastCompletedRunIso: string | null;
  /** `SURFACE_CANARY_ENABLED` repo variable === 'true' (a missing variable is `false` — see the worker). */
  canaryEnabled: boolean;
  /** Overrides `CANARY_LIVENESS_STALE_MINUTES` — exposed for tests and for the `--force-stale-minutes` plant ladder, never for a caller to loosen the real threshold in production. */
  windowMinutes?: number;
}

export interface CanaryLivenessResult {
  verdict: CanaryLivenessVerdict;
  /** Whole minutes since the last completed schedule-triggered run, floored (Rule #425 precision — computed from the raw diff for the threshold check, floored only for display); `null` when there has never been a completed run. */
  silentMinutes: number | null;
  /** Human-readable justification — echoed into the issue body/log line verbatim (Rule #412: an alert's prose is a claim, so it must actually state what was checked). */
  reason: string;
}

/**
 * Parses an ISO 8601 timestamp to epoch milliseconds, THROWING (never returning `NaN`) on a
 * malformed value — same guard as train-liveness-lib.ts: an unvalidated `new Date(bad).getTime()`
 * is `NaN`, and `NaN > windowMinutes` is `false`, so a malformed timestamp would fall through
 * the staleness check as a silently-passing `ok` with `silentMinutes=NaN`. A watchdog that can
 * be fooled into "healthy" by bad input is worse than one that has no input at all.
 */
function parseIsoStrict(value: string): number {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new TypeError(`invalid ISO timestamp: ${value}`);
  return ms;
}

export function evaluateCanaryLiveness(input: EvaluateCanaryLivenessInput): CanaryLivenessResult {
  const { nowIso, lastCompletedRunIso, canaryEnabled, windowMinutes = CANARY_LIVENESS_STALE_MINUTES } = input;

  const nowMs = parseIsoStrict(nowIso);
  const lastMs = lastCompletedRunIso === null ? null : parseIsoStrict(lastCompletedRunIso);

  const rawMinutes = lastMs === null ? null : (nowMs - lastMs) / 60_000;
  const silentMinutes = rawMinutes === null ? null : Math.floor(rawMinutes);

  // 1. disabled — checked FIRST: a deliberately-off canary is expected to be silent no
  // matter how long; alerting on it would be the exact false-positive Rule #295/#297 warn
  // against (a probe firing on a condition its remediation was never meant to cover).
  if (!canaryEnabled) {
    return {
      verdict: "disabled",
      silentMinutes,
      reason: "SURFACE_CANARY_ENABLED is not 'true' — the surface canary is deliberately off; silence is expected and this is not a failure.",
    };
  }

  // 2. stale — enabled AND either the sweep has NEVER completed a schedule-triggered run,
  // or the last completed run is strictly older than the window.
  // No `idle` tier: the surface canary's job IS to run every 5 minutes regardless of
  // external state — a silent canary is never OK when it should be on.
  if (lastCompletedRunIso === null) {
    return {
      verdict: "stale",
      silentMinutes: null,
      reason: "SURFACE_CANARY_ENABLED is true but surface-canary.yml has never completed a schedule-triggered run — liveness cannot be confirmed.",
    };
  }

  if (rawMinutes !== null && rawMinutes > windowMinutes) {
    return {
      verdict: "stale",
      silentMinutes,
      reason: `surface-canary.yml's last completed schedule-triggered run was ${silentMinutes} min ago (> ${windowMinutes} min threshold).`,
    };
  }

  // 3. ok — enabled and the last completed run is within the window.
  return {
    verdict: "ok",
    silentMinutes,
    reason: `surface-canary.yml last completed schedule-triggered run ${silentMinutes} min ago (within the ${windowMinutes} min threshold).`,
  };
}

// ───────────────────────────── run selection ─────────────────────────────

export interface RunLike {
  /** GitHub's own trigger name — `'schedule'` for a cron tick, `'workflow_dispatch'` for a manual one, etc. */
  event: string;
  /** ISO 8601 completion timestamp. */
  updatedAt: string;
  createdAt: string;
  url: string;
  databaseId: number;
}

/**
 * Selects the most recently updated run whose `event` is EXACTLY `'schedule'` — the cron
 * actually ticking, never a manual `workflow_dispatch`. Mirrors train-liveness-lib.ts's
 * `pickLastScheduledRun`: a human dispatch can suppress/close the alert while the real cron
 * stays dead. Pure and defensive so it can be unit-tested without a live `gh` call.
 */
export function pickLastScheduledRun(runs: RunLike[]): RunLike | null {
  const scheduled = runs.filter((r) => r.event === "schedule");
  if (scheduled.length === 0) return null;
  return scheduled.reduce((latest, r) => (new Date(r.updatedAt).getTime() > new Date(latest.updatedAt).getTime() ? r : latest));
}

// ───────────────────────────── enabled-read classification ─────────────────────────────

export interface GhCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ParseCanaryEnabledResult = { enabled: boolean } | { error: string };

/**
 * Matches ONLY `gh`'s variable-specific not-found phrasings — `variable "X" was not found`
 * (the REST shape) and the GraphQL `Could not resolve to a Variable with the name 'X' …
 * not found`. A bare `HTTP 404` / `Not Found` is deliberately EXCLUDED (mirrors
 * train-liveness-lib.ts's `parseTrainEnabled`): GitHub answers 404 for authorization and
 * repo-visibility failures too, and those must fail loud, never read as "disabled".
 */
const VARIABLE_NOT_FOUND_PATTERN = /variable[^\n]{0,160}not found/i;

/**
 * Classifies a `gh variable get SURFACE_CANARY_ENABLED` invocation result. A genuinely-ABSENT
 * variable means "disabled" — the canary has never been turned on, and silence is expected.
 * But ANY OTHER failure (auth, scope, transient 5xx) must never be silently read as `disabled`
 * — that would let a blind/broken read CLOSE a live outage issue (Rule #322/#456: a watchdog
 * that cannot confirm a signal must never act as if it confirmed the SAFE one).
 */
export function parseCanaryEnabled(result: GhCommandResult): ParseCanaryEnabledResult {
  if (result.exitCode === 0) {
    return { enabled: result.stdout.trim() === "true" };
  }
  if (VARIABLE_NOT_FOUND_PATTERN.test(result.stderr)) {
    return { enabled: false };
  }
  return { error: `gh variable get failed (exit ${result.exitCode}): ${result.stderr.trim()}` };
}

// ───────────────────────────── render ─────────────────────────────

/**
 * Title for the auto-reconciled issue this leg opens. Only ever computed on the `open` action
 * (Rule #292 transition-only — no retitle-on-every-tick; this leg's issue is a simple on/off
 * alert, not a running table).
 *
 * `planted`, when true, appends ` (PLANTED CONTROL)` — the Rule #471 plant-ladder marker for a
 * `--force-stale-minutes` firing, so a live-verification issue can never be mistaken for a real
 * cron outage by a reader skimming titles.
 */
export function formatCanaryLivenessIssueTitle(silentMinutes: number | null, planted = false): string {
  const silentPart = silentMinutes === null ? "silent since inception (no completed schedule run ever recorded)" : `silent ${silentMinutes} min`;
  const suffix = planted ? " (PLANTED CONTROL)" : "";
  return `[${CANARY_LIVENESS_LABEL}] surface canary ${silentPart}${suffix}`;
}

export interface FormatCanaryLivenessIssueBodyInput {
  /** ISO 8601 — echoed verbatim (Rule #412: the body states exactly what run produced it). */
  nowIso: string;
  silentMinutes: number | null;
  /** `html_url` of the last completed SCHEDULE-triggered run (the one the verdict is anchored on), or `null` if none exists. */
  lastRunUrl: string | null;
  windowMinutes: number;
  /**
   * P1 codex fix — informational ONLY, never feeds the verdict: the newest completed run whose
   * event was NOT `'schedule'` (a human `workflow_dispatch`), when one exists.
   */
  lastManualTick?: { url: string; updatedAt: string } | null;
  /** Rule #471 plant-ladder marker — see `formatCanaryLivenessIssueTitle`. */
  planted?: boolean;
}

/**
 * Body for the auto-reconciled issue. Names: the last completed schedule run (or its absence),
 * how long the sweep has been silent, the threshold, and the exact recovery command — everything
 * a human needs to act without reading this file's source.
 */
export function formatCanaryLivenessIssueBody(input: FormatCanaryLivenessIssueBodyInput): string {
  const { nowIso, silentMinutes, lastRunUrl, windowMinutes, lastManualTick = null, planted = false } = input;
  const lines: string[] = [];

  if (planted) {
    lines.push(
      "**PLANTED CONTROL (Rule #471)** — this issue was opened by an operator-supplied `--force-stale-minutes` override to prove the alert path fires end to end. It does NOT by itself mean the cron is really down (only the last-run age was fabricated) — verify against the real `gh run list` output before treating it as a live incident, then close it once confirmed.",
    );
    lines.push("");
  }

  lines.push(
    "The surface canary sweep (`surface-canary.yml`, every 5 minutes) has gone silent while it should be running.",
  );
  lines.push("");
  lines.push(`- Last completed SCHEDULE-triggered run: ${lastRunUrl ?? "none recorded"}`);
  if (lastManualTick) {
    lines.push(
      `- Last manual tick (informational only, does NOT feed this verdict): ${lastManualTick.url} (${lastManualTick.updatedAt}) — a human dispatch does not prove the cron itself is alive.`,
    );
  }
  lines.push(
    `- Silent for: ${silentMinutes === null ? "unknown (no completed schedule run ever recorded)" : `${silentMinutes} min`} (threshold: ${windowMinutes} min)`,
  );
  lines.push("");
  lines.push("Recovery: `gh workflow run surface-canary.yml --repo studio-b-ai/ops-pipeline -f dry_run=false`");
  lines.push("");
  lines.push(
    `Run ${nowIso} · auto-reconciled machinery alert (Rule #165) — this closes itself (with a comment) the next time the surface canary ticks again. Transition-only (Rule #292): it will not re-comment while it stays open.`,
  );

  return lines.join("\n");
}