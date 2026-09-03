/**
 * train-liveness-lib.ts — pure classify/render logic for the Heritage restart train's
 * CRON-LIVENESS leg (ops-pipeline, Mechanic seat). Read this header first; no I/O, no `gh`
 * calls, no `new Date()` / `Date.now()` lives here — mirrors backlog-staleness-lib.ts /
 * dead-cron-classify.ts's split (worker = I/O glue, this file = the decision).
 *
 * Why this exists: the incident (2026-08-30/31 overnight) — `heritage-restart-train.yml`'s
 * every-5-minute cron (schedule "star slash 5 star star star star" — written out here, not
 * literally, so this block comment doesn't self-terminate) did not run 23:55Z–00:30Z while a
 * `train:ready` ticket sat queued, and
 * nobody was told until a human noticed and dispatched it by hand. The train's OWN machinery
 * (Rule #165 issues on ops-pipeline, `restart-train` label) alerts on FAILED/anomalous
 * observe outcomes — it has no leg watching whether the cron ITSELF is still ticking. This
 * leg is that watch: it answers exactly one question, "is the train silent while work is
 * queued for it," and nothing else — it never inspects merge readiness, window state, or CI
 * (that is all `restart-train.ts` / `restart-train-fire.ts`'s job).
 *
 * ── Verdicts (exactly four) ──
 *   - `disabled` — `HERITAGE_TRAIN_ENABLED` is not `'true'`. The train is DELIBERATELY off
 *     (heritage-restart-train.yml's own job-level `if:` gate) — silence is expected and
 *     correct; never alert on it. Checked FIRST, ahead of everything else.
 *   - `idle`     — zero `train:ready` tickets queued. A quiet cron with nothing to do is not
 *     a failure (Rule #448's SLA has nothing to be measured against) — checked second, ahead
 *     of the staleness check, so a queue-empty repo never falsely alerts no matter how long
 *     the cron has been silent.
 *   - `stale`    — ≥1 ticket queued AND (the train has never once completed a run, OR the
 *     last completed run is more than `windowMinutes` STRICTLY older than `now`). This is the
 *     ONLY verdict that opens an alert.
 *   - `ok`       — ≥1 ticket queued, train enabled, and the last completed run is within
 *     `windowMinutes` of `now`.
 *
 * `windowMinutes` defaults to `TRAIN_LIVENESS_STALE_MINUTES` (30, not 20): GitHub Actions cron
 * jitter at the `:00`/`:30` peaks routinely exceeds 20 minutes even on a healthy scheduler
 * (Rule #425 precision — a threshold this tight would false-positive on ordinary jitter, not
 * just real outages); 30 is sized to tonight's actual failure window (23:55Z→00:30Z is 35
 * minutes silent, comfortably past 30). The comparison at the boundary is STRICTLY
 * greater-than (mirrors backlog-staleness-lib.ts's `p0p1-stale`/`p2-stale`: "untouched > Nd",
 * not "≥ Nd") — exactly-at-30-minutes reads `ok`, not `stale`.
 *
 * `silentMinutes` is computed from the RAW (unfloored) millisecond difference for the
 * threshold comparison, then floored only for display/formatting — the same technique
 * backlog-staleness-lib.ts's `daysBetween`/`Math.floor(idle)` split uses, so a value like
 * 30.9 minutes can never be softened by flooring into a false `ok` at the boundary.
 *
 * Rule #292 (transition-only): this file has no notion of "already alerted" — that dedup
 * lives entirely in the WORKER via `listIssuesByLabel` (an open `train-liveness` issue IS the
 * alert state). `evaluateTrainLiveness` is called once per tick and always returns the CURRENT
 * verdict; the worker decides open/close/leave-alone by comparing this verdict against
 * whether an issue is already open — never by comparing this tick's verdict to the last one.
 */

// ───────────────────────────── constants ─────────────────────────────

/** GitHub label this leg's own auto-reconciled issue carries (Rule #165: the open-issue set IS the dedup state). */
export const TRAIN_LIVENESS_LABEL = "train-liveness";

/**
 * Staleness threshold in minutes. 30, not 20 — see the file header: GitHub cron jitter at the
 * `:00`/`:30` peaks routinely exceeds 20 minutes on a healthy scheduler, and 30 is the size of
 * tonight's actual failure (23:55Z→00:30Z, 35 minutes silent).
 */
export const TRAIN_LIVENESS_STALE_MINUTES = 30;

export const TRAIN_LIVENESS_VERDICTS = ["ok", "stale", "disabled", "idle"] as const;

export type TrainLivenessVerdict = (typeof TRAIN_LIVENESS_VERDICTS)[number];

// ───────────────────────────── evaluate ─────────────────────────────

export interface EvaluateTrainLivenessInput {
  /** ISO 8601 — the worker's clock (real or `--now`/`--force-stale-minutes`-overridden), passed in so this stays pure (Rule #256). */
  nowIso: string;
  /** ISO 8601 completion timestamp of the most recent COMPLETED run of heritage-restart-train.yml, or `null` if the workflow has never completed one. */
  lastCompletedRunIso: string | null;
  /** Count of open PRs carrying `TRAIN_READY_LABEL` across the train's ticket repos. */
  queuedTickets: number;
  /** `HERITAGE_TRAIN_ENABLED` repo variable === 'true' (a missing variable is `false` — see the worker). */
  trainEnabled: boolean;
  /** Overrides `TRAIN_LIVENESS_STALE_MINUTES` — exposed for tests and for the `--force-stale-minutes` plant ladder, never for a caller to loosen the real threshold in production. */
  windowMinutes?: number;
}

export interface TrainLivenessResult {
  verdict: TrainLivenessVerdict;
  /** Whole minutes since the last completed run, floored (Rule #425 precision — computed from the raw diff for the threshold check, floored only for display); `null` when there has never been a completed run. */
  silentMinutes: number | null;
  /** Human-readable justification — echoed into the issue body/log line verbatim (Rule #412: an alert's prose is a claim, so it must actually state what was checked). */
  reason: string;
}

/** Raw (unfloored) minute difference `toIso - fromIso` — never itself reads the clock; both timestamps are caller-supplied. */
function minutesBetweenRaw(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  return (to - from) / 60_000;
}

export function evaluateTrainLiveness(input: EvaluateTrainLivenessInput): TrainLivenessResult {
  const { nowIso, lastCompletedRunIso, queuedTickets, trainEnabled, windowMinutes = TRAIN_LIVENESS_STALE_MINUTES } = input;

  const rawMinutes = lastCompletedRunIso === null ? null : minutesBetweenRaw(lastCompletedRunIso, nowIso);
  const silentMinutes = rawMinutes === null ? null : Math.floor(rawMinutes);

  // 1. disabled — checked FIRST: a deliberately-off train (job-level `if:` gate in
  // heritage-restart-train.yml) is expected to be silent no matter how long or how many
  // tickets pile up; alerting on it would be exactly the false-positive Rule #295/#297 warn
  // against (a probe/gate firing on a condition its remediation was never meant to cover).
  if (!trainEnabled) {
    return {
      verdict: "disabled",
      silentMinutes,
      reason: `HERITAGE_TRAIN_ENABLED is not 'true' — the train is deliberately off; silence is expected and this is not a failure.`,
    };
  }

  // 2. idle — checked SECOND, ahead of staleness: zero queued tickets means there is nothing
  // for the SLA to be measured against (Rule #448 — a monitor's cadence/SLA is decorative if
  // it fires on a condition with no work behind it).
  if (queuedTickets === 0) {
    return {
      verdict: "idle",
      silentMinutes,
      reason: `0 train:ready ticket(s) queued — silence with nothing queued is not a failure${
        silentMinutes === null ? " (no completed run recorded, informational only)" : ` (informational: ${silentMinutes} min since the last completed run)`
      }.`,
    };
  }

  // 3. stale — ≥1 ticket queued AND either the train has NEVER completed a run, or the last
  // completed run is strictly older than the window.
  if (lastCompletedRunIso === null) {
    return {
      verdict: "stale",
      silentMinutes: null,
      reason: `${queuedTickets} train:ready ticket(s) queued but heritage-restart-train.yml has never completed a run — liveness cannot be confirmed.`,
    };
  }

  if (rawMinutes !== null && rawMinutes > windowMinutes) {
    return {
      verdict: "stale",
      silentMinutes,
      reason: `${queuedTickets} train:ready ticket(s) queued and the train's last completed run was ${silentMinutes} min ago (> ${windowMinutes} min threshold).`,
    };
  }

  // 4. ok — ≥1 ticket queued, train enabled, last completed run within the window.
  return {
    verdict: "ok",
    silentMinutes,
    reason: `${queuedTickets} train:ready ticket(s) queued; last completed run ${silentMinutes} min ago (within the ${windowMinutes} min threshold).`,
  };
}

// ───────────────────────────── render ─────────────────────────────

export interface LivenessQueuedTicket {
  repo: string;
  number: number;
}

/**
 * Title for the auto-reconciled issue this leg opens. Only ever computed on the `open` action
 * (Rule #292 transition-only — no retitle-on-every-tick like backlog-staleness's per-manager
 * aggregate; this leg's issue is a simple on/off alert, not a running table).
 *
 * `planted`, when true, appends ` (PLANTED CONTROL)` — the Rule #471 plant-ladder marker for a
 * `--force-stale-minutes` firing, so a live-verification issue can never be mistaken for a real
 * cron outage by a reader skimming titles.
 */
export function formatLivenessIssueTitle(silentMinutes: number | null, queuedTickets: number, planted = false): string {
  const silentPart = silentMinutes === null ? "silent since inception (no completed run ever recorded)" : `silent ${silentMinutes} min`;
  const suffix = planted ? " (PLANTED CONTROL)" : "";
  return `[${TRAIN_LIVENESS_LABEL}] restart train ${silentPart} with ${queuedTickets} ticket(s) queued${suffix}`;
}

export interface FormatLivenessIssueBodyInput {
  /** ISO 8601 — echoed verbatim (Rule #412: the body states exactly what run produced it). */
  nowIso: string;
  silentMinutes: number | null;
  queuedTickets: LivenessQueuedTicket[];
  /** `html_url` of the last completed heritage-restart-train.yml run, or `null` if none exists. */
  lastRunUrl: string | null;
  windowMinutes: number;
  /** Rule #471 plant-ladder marker — see `formatLivenessIssueTitle`. */
  planted?: boolean;
}

/**
 * Body for the auto-reconciled issue. Names: the last completed run (or its absence), how long
 * the train has been silent, every queued ticket (`repo#n`), the threshold, and the exact
 * recovery command (a manual live-fire dispatch) — everything a human needs to act without
 * reading this file's source.
 */
export function formatLivenessIssueBody(input: FormatLivenessIssueBodyInput): string {
  const { nowIso, silentMinutes, queuedTickets, lastRunUrl, windowMinutes, planted = false } = input;
  const lines: string[] = [];

  if (planted) {
    lines.push(
      "**PLANTED CONTROL (Rule #471)** — this issue was opened by an operator-supplied `--force-stale-minutes` override to prove the alert path fires end to end. It does NOT by itself mean the cron is really down (queued-ticket count is real, only the last-run age was fabricated) — verify against the real `gh run list` output before treating it as a live incident, then close it once confirmed.",
    );
    lines.push("");
  }

  lines.push(
    "The Heritage restart train's `*/5 * * * *` cron (`.github/workflows/heritage-restart-train.yml`) has gone silent while ticket(s) sat queued in `train:ready`.",
  );
  lines.push("");
  lines.push(`- Last completed run: ${lastRunUrl ?? "none recorded"}`);
  lines.push(
    `- Silent for: ${silentMinutes === null ? "unknown (no completed run ever recorded)" : `${silentMinutes} min`} (threshold: ${windowMinutes} min)`,
  );
  lines.push(`- Queued ticket(s) (${queuedTickets.length}):`);
  if (queuedTickets.length === 0) {
    lines.push(`  - (none — unexpected on a \`stale\` verdict; investigate the worker before trusting this issue)`);
  } else {
    for (const t of queuedTickets) lines.push(`  - ${t.repo}#${t.number}`);
  }
  lines.push("");
  lines.push("Recovery: `gh workflow run heritage-restart-train.yml --repo studio-b-ai/ops-pipeline -f dry_run=false`");
  lines.push("");
  lines.push(
    `Run ${nowIso} · auto-reconciled machinery alert (Rule #165) — this closes itself (with a comment) the next time the train ticks again. Transition-only (Rule #292): it will not re-comment while it stays open.`,
  );

  return lines.join("\n");
}
