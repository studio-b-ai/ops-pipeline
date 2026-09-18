#!/usr/bin/env tsx
/**
 * canary-liveness-worker.ts — CRON-LIVENESS leg for the surface canary sweep. Thin I/O glue
 * around scripts/lib/canary-liveness-lib.ts — read THAT file's header first; no
 * classification/render decision lives here.
 *
 * Why this exists: the surface canary program (stint #465 "Watch the watcher"; Kevin 9/16:
 * "all of this should be automated. get us there") watches public surfaces. The canary's OWN
 * machinery alerts on surface DEGRADATION — it has no leg watching whether the scheduler
 * itself is still ticking at all. This worker is that watch, answering exactly one question
 * every 15 minutes: is the surface-canary sweep silent while it should be running?
 *
 * Per run (every 15 minutes, .github/workflows/canary-liveness.yml):
 *   1. `SURFACE_CANARY_ENABLED` repo variable on studio-b-ai/ops-pipeline — in Actions it
 *      arrives pre-read as `SURFACE_CANARY_ENABLED_VALUE` from the workflow's `vars` context;
 *      `gh variable get` is the LOCAL fallback. Classified via `parseCanaryEnabled`: a
 *      genuinely-absent variable is `disabled` (expected); any OTHER read failure (auth/scope/5xx)
 *      THROWS — a blind read must never be allowed to look like a confirmed "disabled" and
 *      CLOSE a live outage issue (Rule #322/#456).
 *   2. The most recent COMPLETED, SCHEDULE-TRIGGERED run of `surface-canary.yml` on this repo
 *      (`gh run list --event schedule --status completed --limit 1`, selected via
 *      `pickLastScheduledRun`) — ONLY schedule-triggered runs feed the verdict (a human
 *      `workflow_dispatch` tick proves nothing about whether the cron itself is alive).
 *      A separate informational read of the newest run of ANY event is surfaced in the issue
 *      body as "last manual tick" when it isn't itself a schedule run — it never influences
 *      the verdict.
 *   3. `evaluateCanaryLiveness()` turns the above into one of three verdicts; a malformed
 *      timestamp anywhere in the inputs throws rather than silently computing NaN.
 *   4. Reconcile via the Rule #165 auto-reconciled-issue pattern (github-issues.ts), Rule #292
 *      transition-only: `stale` with no open `canary-liveness` issue → open one; `stale` with
 *      one already open → do nothing (no per-run comment/retitle); anything else (`ok`/`disabled`)
 *      with an open issue → close it with a comment naming the run that proved the canary alive;
 *      anything else with no open issue → nothing to do.
 *
 * `--dry-run`: real reads throughout (Rule #376 — a dry run that reads nothing proves nothing),
 *   zero issue mutations. Standard flag-presence semantics used by every sibling worker in this
 *   repo: ABSENT = live, PRESENT = dry-run. The workflow passes this flag only when its
 *   `dry_run` workflow_dispatch input is true (defaults to `true` for safe manual dispatch) —
 *   scheduled ticks never pass it.
 * `--now <ISO>`: overrides the clock — omit for the real time.
 * `--force-stale-minutes <n>`: PLANTED KNOWN-BAD (Rule #471) — fabricates the last-scheduled-run
 *   timestamp as exactly `n` minutes before `--now`/the real clock, so the `stale` → open-issue
 *   path can be exercised live once without waiting for (or faking) a real cron outage. This
 *   overrides ONLY the last-run age; `SURFACE_CANARY_ENABLED` stays a real read. Every issue
 *   opened this way carries the `formatCanaryLivenessIssueTitle`/`formatCanaryLivenessIssueBody`
 *   PLANTED CONTROL marker so nobody mistakes it for a real outage.
 */

import { gh, ensureLabel, listIssuesByLabel, openIssue, closeIssue } from "./lib/github-issues.js";
import {
  evaluateCanaryLiveness,
  formatCanaryLivenessIssueTitle,
  formatCanaryLivenessIssueBody,
  pickLastScheduledRun,
  parseCanaryEnabled,
  CANARY_LIVENESS_LABEL,
  CANARY_LIVENESS_STALE_MINUTES,
  type RunLike,
} from "./lib/canary-liveness-lib.js";

const SELF_REPO = "studio-b-ai/ops-pipeline";
const CANARY_WORKFLOW_FILE = "surface-canary.yml";
const SURFACE_CANARY_ENABLED_VAR = "SURFACE_CANARY_ENABLED";

const CANARY_LIVENESS_LABEL_DESCRIPTION = "Surface canary cron-liveness watch (#448): open = surface-canary sweep silent while enabled";
const CANARY_LIVENESS_LABEL_COLOR = "D93F0B"; // warm red-orange — alarm, but distinct from the train's dark-red B60205
const MACHINERY_ALERT_LABEL = "machinery-alert"; // shared cross-cutting tag (backlog-managers.yaml's machinery_labels) — excludes this leg's issues from rule-17 ranking
const MACHINERY_ALERT_LABEL_DESCRIPTION = "Rule #165 monitor issue -- excluded from LANES rule 17 ranking (backlog-managers.yaml)";
const MACHINERY_ALERT_LABEL_COLOR = "5319E7";

// ───────────────────────────── gh reads ─────────────────────────────

type GhRunRow = RunLike;

function runList(extraArgs: string[]): GhRunRow[] {
  const raw = gh([
    "run", "list",
    "--repo", SELF_REPO,
    "--workflow", CANARY_WORKFLOW_FILE,
    "--status", "completed",
    ...extraArgs,
    "--json", "databaseId,updatedAt,createdAt,url,event",
  ]);
  return JSON.parse(raw) as GhRunRow[];
}

/**
 * The most recent COMPLETED, SCHEDULE-TRIGGERED run — the ONLY thing that feeds the verdict.
 * Fetches server-side filtered to `--event schedule` AND re-filters/selects via the pure
 * `pickLastScheduledRun` (defense in depth — see that function's header).
 */
function fetchLastScheduledRun(): GhRunRow | null {
  const rows = runList(["--event", "schedule", "--limit", "1"]);
  return pickLastScheduledRun(rows);
}

/**
 * The single most recent completed run of ANY event — purely informational (the issue body's
 * "last manual tick" mention when it isn't itself a schedule run). NEVER feeds the verdict.
 */
function fetchLastAnyCompletedRun(): GhRunRow | null {
  const rows = runList(["--limit", "1"]);
  return rows[0] ?? null;
}

/**
 * `SURFACE_CANARY_ENABLED` repo variable, classified via `parseCanaryEnabled`: a genuinely-absent
 * variable is `{ enabled: false }` (expected); any OTHER gh failure (auth, scope, transient 5xx)
 * is `{ error }` — the caller MUST throw on that, never treat it as `disabled` (Rule #322/#456).
 */
function fetchCanaryEnabled(): { enabled: boolean } | { error: string } {
  const injected = process.env.SURFACE_CANARY_ENABLED_VALUE;
  if (injected !== undefined) {
    return parseCanaryEnabled({ stdout: injected, stderr: "", exitCode: 0 });
  }
  try {
    const stdout = gh(["variable", "get", SURFACE_CANARY_ENABLED_VAR, "--repo", SELF_REPO]);
    return parseCanaryEnabled({ stdout, stderr: "", exitCode: 0 });
  } catch (err) {
    const anyErr = err as NodeJS.ErrnoException & { stderr?: string; status?: number | null; stdout?: string };
    const stderr = anyErr.stderr ?? (err instanceof Error ? err.message : String(err));
    const exitCode = typeof anyErr.status === "number" ? anyErr.status : 1;
    return parseCanaryEnabled({ stdout: anyErr.stdout ?? "", stderr, exitCode });
  }
}

// ───────────────────────────── main ─────────────────────────────

function parseArgs(argv: string[]): { dryRun: boolean; nowIso: string; forceStaleMinutes: number | null } {
  const dryRun = argv.includes("--dry-run");
  const nowIdx = argv.indexOf("--now");
  if (nowIdx !== -1 && !argv[nowIdx + 1]) throw new Error("--now requires an ISO timestamp");
  const nowIso = nowIdx !== -1 ? argv[nowIdx + 1] : new Date().toISOString();
  const forceIdx = argv.indexOf("--force-stale-minutes");
  let forceStaleMinutes: number | null = null;
  if (forceIdx !== -1) {
    const raw = argv[forceIdx + 1];
    if (!raw) throw new Error("--force-stale-minutes requires a number");
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--force-stale-minutes must be a non-negative number, got: ${raw}`);
    forceStaleMinutes = n;
  }
  return { dryRun, nowIso, forceStaleMinutes };
}

async function main(): Promise<void> {
  const { dryRun, nowIso, forceStaleMinutes } = parseArgs(process.argv.slice(2));
  console.log(
    `=== canary-liveness-worker${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""} now=${nowIso}${
      forceStaleMinutes !== null ? ` --force-stale-minutes ${forceStaleMinutes} (Rule #471 PLANTED CONTROL)` : ""
    } ===`,
  );

  const canaryEnabledResult = fetchCanaryEnabled();
  if ("error" in canaryEnabledResult) {
    const msg = `[canary-liveness] enabled-read FAILED: ${canaryEnabledResult.error}`;
    console.error(msg);
    throw new Error(msg);
  }
  const canaryEnabled = canaryEnabledResult.enabled;

  const lastScheduledRun = fetchLastScheduledRun();
  const lastAnyRun = fetchLastAnyCompletedRun();
  // Informational only (issue body "last manual tick") — present only when the newest run of
  // ANY event is NOT itself a schedule run.
  const lastManualRun = lastAnyRun && lastAnyRun.event !== "schedule" ? lastAnyRun : null;

  let lastCompletedRunIso: string | null = lastScheduledRun ? lastScheduledRun.updatedAt : null;
  if (forceStaleMinutes !== null) {
    // Rule #471 planted control: fabricate an old completion timestamp so the stale→open-issue
    // path can be exercised live once.
    lastCompletedRunIso = new Date(new Date(nowIso).getTime() - forceStaleMinutes * 60_000).toISOString();
    console.log(
      `[canary-liveness] PLANTED CONTROL: overriding lastCompletedRunIso to ${lastCompletedRunIso} (${forceStaleMinutes} min before now) — this does NOT itself mean the real cron is down.`,
    );
  }

  const result = evaluateCanaryLiveness({
    nowIso,
    lastCompletedRunIso,
    canaryEnabled,
    windowMinutes: CANARY_LIVENESS_STALE_MINUTES,
  });

  console.log(`[canary-liveness] reason: ${result.reason}`);
  console.log(
    `[canary-liveness] last SCHEDULE-triggered completed run: ${
      lastScheduledRun ? `${lastScheduledRun.url} (updatedAt=${lastScheduledRun.updatedAt})` : "none found"
    }`,
  );
  if (lastManualRun) {
    console.log(
      `[canary-liveness] last manual tick (informational, does NOT feed the verdict): ${lastManualRun.url} (event=${lastManualRun.event}, updatedAt=${lastManualRun.updatedAt})`,
    );
  }

  const openIssues = listIssuesByLabel(SELF_REPO, CANARY_LIVENESS_LABEL, "open");
  if (openIssues.length > 1) {
    console.warn(
      `[canary-liveness] WARNING: ${openIssues.length} open ${CANARY_LIVENESS_LABEL} issues found (expected <=1) — reconciling against #${openIssues[0].number} only; the rest need a human look.`,
    );
  }
  const existing = openIssues[0] ?? null;

  const issueAction: "opened" | "closed" | "unchanged" | "none" =
    result.verdict === "stale" ? (existing ? "unchanged" : "opened") : existing ? "closed" : "none";

  if (dryRun) {
    if (issueAction === "opened") {
      const planted = forceStaleMinutes !== null;
      const title = formatCanaryLivenessIssueTitle(result.silentMinutes, planted);
      const body = formatCanaryLivenessIssueBody({
        nowIso,
        silentMinutes: result.silentMinutes,
        lastRunUrl: lastScheduledRun ? lastScheduledRun.url : null,
        windowMinutes: CANARY_LIVENESS_STALE_MINUTES,
        lastManualTick: lastManualRun ? { url: lastManualRun.url, updatedAt: lastManualRun.updatedAt } : null,
        planted,
      });
      console.log(`\n--- [dry-run] would OPEN ---\n${title}\n\n${body}\n`);
    } else if (issueAction === "closed") {
      console.log(`\n--- [dry-run] would CLOSE #${existing!.number} ---\n`);
    } else {
      console.log(`[dry-run] no issue mutation this run (action=${issueAction}).`);
    }
  } else {
    if (issueAction === "opened") {
      const planted = forceStaleMinutes !== null;
      const title = formatCanaryLivenessIssueTitle(result.silentMinutes, planted);
      const body = formatCanaryLivenessIssueBody({
        nowIso,
        silentMinutes: result.silentMinutes,
        lastRunUrl: lastScheduledRun ? lastScheduledRun.url : null,
        windowMinutes: CANARY_LIVENESS_STALE_MINUTES,
        lastManualTick: lastManualRun ? { url: lastManualRun.url, updatedAt: lastManualRun.updatedAt } : null,
        planted,
      });
      ensureLabel(SELF_REPO, CANARY_LIVENESS_LABEL, CANARY_LIVENESS_LABEL_DESCRIPTION, CANARY_LIVENESS_LABEL_COLOR);
      ensureLabel(SELF_REPO, MACHINERY_ALERT_LABEL, MACHINERY_ALERT_LABEL_DESCRIPTION, MACHINERY_ALERT_LABEL_COLOR);
      openIssue(SELF_REPO, `${CANARY_LIVENESS_LABEL},${MACHINERY_ALERT_LABEL}`, title, body);
      console.log(`OPENED ${CANARY_LIVENESS_LABEL} issue: ${title}`);
    } else if (issueAction === "closed") {
      const comment = `Surface canary ticked again — verdict=${result.verdict} (${result.reason}). Last SCHEDULE-triggered completed run: ${
        lastScheduledRun ? lastScheduledRun.url : "none"
      }. Auto-closed by the canary-liveness worker.`;
      closeIssue(SELF_REPO, existing!.number, comment);
      console.log(`CLOSED ${CANARY_LIVENESS_LABEL} issue #${existing!.number}.`);
    }
  }

  console.log(
    `[canary-liveness] verdict=${result.verdict} silent=${result.silentMinutes} enabled=${canaryEnabled} issue=${issueAction} dryRun=${dryRun}`,
  );
}

main().catch((err) => {
  console.error(`canary-liveness-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});