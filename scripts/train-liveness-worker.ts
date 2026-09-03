#!/usr/bin/env tsx
/**
 * train-liveness-worker.ts — CRON-LIVENESS leg for the Heritage restart train. Thin I/O glue
 * around scripts/lib/train-liveness-lib.ts — read THAT file's header first; no
 * classification/render decision lives here.
 *
 * Why this exists: the incident this leg answers — heritage-restart-train.yml's every-5-minute
 * cron did not run 23:55Z–00:30Z (2026-08-30/31 overnight) while a `train:ready` ticket sat
 * queued, and nobody was told until a human noticed and dispatched it by hand. The train's OWN
 * machinery alerts (`restart-train` label, Rule #165) watch FAILED/anomalous restart OUTCOMES —
 * they have no leg watching whether the scheduler itself is still ticking at all. This worker
 * is that watch, and answers exactly one question every 15 minutes (Rule #448 — the check
 * cadence must beat the 30-minute SLA it measures against, not merely match it).
 *
 * Per run (every 15 minutes, .github/workflows/heritage-train-liveness.yml):
 *   1. `HERITAGE_TRAIN_ENABLED` repo variable on studio-b-ai/ops-pipeline — in Actions it arrives
 *      pre-read as `HERITAGE_TRAIN_ENABLED_VALUE` from the workflow's `vars` context (the fleet App
 *      token cannot read repo variables: HTTP 403, 2026-09-03); `gh variable get` is the LOCAL fallback,
 *      classified via `parseTrainEnabled` (P1 codex fix, ops-pipeline#272): a genuinely-absent
 *      variable is `disabled` (expected, mirrors heritage-restart-train.yml's own job-level
 *      `if:` gate); any OTHER read failure (auth/scope/5xx) THROWS — a blind read must never be
 *      allowed to look like a confirmed "disabled" and CLOSE a live outage issue.
 *   2. Open `train:ready` PRs across the train's two ticket repos (`gh pr list --label
 *      <TRAIN_READY_LABEL> --state open --limit <cap> --json number`) — the label constant is
 *      imported from lib/restart-train-fire.ts (never hardcoded here, Rule #184); a full-cap
 *      page logs a loud warning (Rule #331 — a silent truncation would undercount the queue).
 *      ⚠️ TICKET_REPOS below DUPLICATES (does not import) restart-train.ts's own
 *      `TICKET_REPOS` constant (that file, line ~194): restart-train.ts is FORBIDDEN to edit
 *      for this leg, and its `TICKET_REPOS` is not exported (importing an unexported binding
 *      from a worker script would also drag in and execute that script's top-level `main()`
 *      side effects, which is structurally wrong for a pure read). If the train ever grows a
 *      third ticket repo, both lists must be updated together — flagged here loudly rather than
 *      silently drifting.
 *   3. The most recent COMPLETED, SCHEDULE-TRIGGERED run of `heritage-restart-train.yml` on
 *      this repo (`gh run list --event schedule --status completed --limit 1`, selected via the
 *      pure `pickLastScheduledRun`) — P1 codex fix: a human `workflow_dispatch` tick proves
 *      nothing about whether the cron itself is alive (tonight's exact failure shape was a
 *      human fixing the queue by hand while the cron stayed dead), so ONLY schedule-triggered
 *      runs feed the verdict. A separate, purely informational read of the newest run of ANY
 *      event is surfaced in the issue body as "last manual tick" when it isn't itself a
 *      schedule run — it never influences the verdict.
 *   4. `evaluateTrainLiveness()` turns the above into one of four verdicts; a malformed
 *      timestamp anywhere in the inputs throws (P3 codex fix) rather than silently computing a
 *      NaN that falls through the staleness check as a false `ok`.
 *   5. Reconcile via the Rule #165 auto-reconciled-issue pattern (github-issues.ts), Rule #292
 *      transition-only: `stale` with no open `train-liveness` issue → open one; `stale` with
 *      one already open → do nothing (no per-run comment/retitle — unlike backlog-staleness's
 *      per-manager aggregate, this is a simple on/off alert, not a running table); anything
 *      else (`ok`/`idle`/`disabled`) with an open issue → close it with a comment naming the
 *      run that proved the train alive; anything else with no open issue → nothing to do.
 *
 * `--dry-run`: real reads throughout (Rule #376 — a dry run that reads nothing proves
 *   nothing), zero issue mutations. Standard flag-presence semantics used by every sibling
 *   worker in this repo (backlog-staleness-worker.ts, dead-cron-worker.ts): ABSENT = live,
 *   PRESENT = dry-run. heritage-train-liveness.yml passes this flag only when its
 *   `dry_run` workflow_dispatch input is true (that input itself defaults to `"true"` for a
 *   safe manual dispatch) — scheduled ticks never pass it, so the cron always runs live,
 *   exactly mirroring backlog-staleness.yml's own DRY_RUN_FLAG construction.
 * `--now <ISO>`: overrides the clock (the #464/#471 plant ladder) — omit for the real time.
 * `--force-stale-minutes <n>`: PLANTED KNOWN-BAD (Rule #471) — fabricates the last-scheduled-run
 *   timestamp as exactly `n` minutes before `--now`/the real clock, so the `stale` → open-issue
 *   path can be exercised live once without waiting for (or faking) a real cron outage. This
 *   overrides ONLY the last-run age, never the queued-ticket count or `HERITAGE_TRAIN_ENABLED`
 *   read — both of those stay real reads, so the control only actually opens an issue if a real
 *   `train:ready` ticket happens to be queued and the train is enabled at the time it runs (by
 *   design: Rule #471's planted control proves the MECHANISM, it does not fabricate the whole
 *   scenario). Every issue opened this way carries the `formatLivenessIssueTitle`/
 *   `formatLivenessIssueBody` PLANTED CONTROL marker so nobody mistakes it for a real outage.
 *
 * Codex review fixes (ops-pipeline#272 — folded into one commit, this file's second pass):
 *   P1 fetchLastScheduledRun() / pickLastScheduledRun — schedule-only verdict input.
 *   P1 fetchTrainEnabled() / parseTrainEnabled — fail-loud (throw) on anything but a confirmed
 *       read or a confirmed "not found"; never silently treat an ambiguous failure as disabled.
 *   P2 QUEUE_LIST_LIMIT + warn-on-cap — `gh pr list` no longer relies on its 30-row default.
 *   P3 evaluateTrainLiveness's own timestamp validation (see train-liveness-lib.ts) — this file
 *       just needs to let that throw propagate to main().catch() rather than swallow it.
 */

import { gh, ensureLabel, listIssuesByLabel, openIssue, closeIssue } from "./lib/github-issues.js";
import { TRAIN_READY_LABEL } from "./lib/restart-train-fire.js";
import {
  evaluateTrainLiveness,
  formatLivenessIssueTitle,
  formatLivenessIssueBody,
  pickLastScheduledRun,
  parseTrainEnabled,
  TRAIN_LIVENESS_LABEL,
  TRAIN_LIVENESS_STALE_MINUTES,
  type LivenessQueuedTicket,
  type RunLike,
} from "./lib/train-liveness-lib.js";

const SELF_REPO = "studio-b-ai/ops-pipeline";
const TRAIN_WORKFLOW_FILE = "heritage-restart-train.yml";
const HERITAGE_TRAIN_ENABLED_VAR = "HERITAGE_TRAIN_ENABLED";

// See the file header: duplicated from (not imported from) restart-train.ts's own
// TICKET_REPOS constant — that file is out of scope for this leg and does not export it.
const TICKET_REPOS = ["studio-b-ai/studiob", "studio-b-ai/client-asthetik"] as const;

// P2 codex fix: `gh pr list` defaults to 30 rows with no --limit — an unbounded queue would be
// silently undercounted. 100 is generous headroom over any realistic train:ready queue depth;
// a full-cap page logs a loud warning rather than silently trusting a possibly-truncated count
// (Rule #331 — a cap hit is a warning, not a paging mechanism).
const QUEUE_LIST_LIMIT = 100;

// ≤100 chars each (GitHub's hard cap on label descriptions — 422s at `gh label create`
// otherwise; caught here by lib/__tests__/github-issues.test.ts's source-level scan, the
// exact guard ops-pipeline#136's first live firing was missing, Rule #159/#464).
const TRAIN_LIVENESS_LABEL_DESCRIPTION = "Heritage restart train cron-liveness watch (#448): open = restart-train cron silent, tickets queued";
const TRAIN_LIVENESS_LABEL_COLOR = "B60205"; // same family as restart-train.ts's own MACHINERY_LABEL_COLOR — both are alarms about this train
const MACHINERY_ALERT_LABEL = "machinery-alert"; // shared cross-cutting tag (backlog-managers.yaml's machinery_labels) — excludes this leg's issues from rule-17 ranking
const MACHINERY_ALERT_LABEL_DESCRIPTION = "Rule #165 monitor issue -- excluded from LANES rule 17 ranking (backlog-managers.yaml)";
const MACHINERY_ALERT_LABEL_COLOR = "5319E7";

// ───────────────────────────── gh reads ─────────────────────────────

/** Raw `gh run list --json databaseId,updatedAt,createdAt,url,event` row shape — matches lib's `RunLike`. */
type GhRunRow = RunLike;

function runList(extraArgs: string[]): GhRunRow[] {
  const raw = gh([
    "run", "list",
    "--repo", SELF_REPO,
    "--workflow", TRAIN_WORKFLOW_FILE,
    "--status", "completed",
    ...extraArgs,
    "--json", "databaseId,updatedAt,createdAt,url,event",
  ]);
  return JSON.parse(raw) as GhRunRow[];
}

/**
 * The most recent COMPLETED, SCHEDULE-TRIGGERED run — the ONLY thing that feeds the verdict
 * (P1 codex fix). Fetches server-side filtered to `--event schedule` AND re-filters/selects via
 * the pure `pickLastScheduledRun` (defense in depth — see that function's header).
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

interface GhPrNumberRow {
  number: number;
}

/** Open `train:ready` PRs across every ticket repo the train reads from. */
function fetchQueuedTickets(): LivenessQueuedTicket[] {
  const out: LivenessQueuedTicket[] = [];
  for (const repo of TICKET_REPOS) {
    const raw = gh([
      "pr", "list",
      "--repo", repo,
      "--label", TRAIN_READY_LABEL,
      "--state", "open",
      "--limit", String(QUEUE_LIST_LIMIT),
      "--json", "number",
    ]);
    const rows = JSON.parse(raw) as GhPrNumberRow[];
    if (rows.length === QUEUE_LIST_LIMIT) {
      console.warn(`[train-liveness] WARN queue read hit the ${QUEUE_LIST_LIMIT} cap for ${repo} — count may be low`);
    }
    for (const r of rows) out.push({ repo, number: r.number });
  }
  return out;
}

/**
 * `HERITAGE_TRAIN_ENABLED` repo variable, classified via `parseTrainEnabled` (P1 codex fix): a
 * genuinely-absent variable is `{ enabled: false }` (expected, mirrors the workflow's own
 * job-level `if:` gate); any OTHER gh failure (auth, scope, transient 5xx) is `{ error }` — the
 * caller MUST throw on that, never treat it as `disabled` (Rule #322/#456: a blind watchdog must
 * never reconcile on an unconfirmed read).
 */
function fetchTrainEnabled(): { enabled: boolean } | { error: string } {
  // Workflow-injected value from the `vars` context (no token needed; the fleet App token 403s on
  // actions/variables). An EMPTY string = the variable is not defined on the repo = disabled — the
  // same reading heritage-restart-train.yml's own job-level `if:` applies. Local runs without the env
  // var fall through to `gh variable get`.
  const injected = process.env.HERITAGE_TRAIN_ENABLED_VALUE;
  if (injected !== undefined) {
    return parseTrainEnabled({ stdout: injected, stderr: "", exitCode: 0 });
  }
  try {
    const stdout = gh(["variable", "get", HERITAGE_TRAIN_ENABLED_VAR, "--repo", SELF_REPO]);
    return parseTrainEnabled({ stdout, stderr: "", exitCode: 0 });
  } catch (err) {
    const anyErr = err as NodeJS.ErrnoException & { stderr?: string; status?: number | null; stdout?: string };
    const stderr = anyErr.stderr ?? (err instanceof Error ? err.message : String(err));
    const exitCode = typeof anyErr.status === "number" ? anyErr.status : 1;
    return parseTrainEnabled({ stdout: anyErr.stdout ?? "", stderr, exitCode });
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
    `=== train-liveness-worker${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""} now=${nowIso}${
      forceStaleMinutes !== null ? ` --force-stale-minutes ${forceStaleMinutes} (Rule #471 PLANTED CONTROL)` : ""
    } ===`,
  );

  // P1 fix: a genuine read failure (auth/scope/5xx) must STOP the run before any reconcile —
  // never fall through as if it were a confirmed "disabled". No issue mutation has happened by
  // this point, so throwing here is exactly Rule #322/#456's "blind watchdog performs no
  // reconcile" contract.
  const trainEnabledResult = fetchTrainEnabled();
  if ("error" in trainEnabledResult) {
    const msg = `[train-liveness] enabled-read FAILED: ${trainEnabledResult.error}`;
    console.error(msg);
    throw new Error(msg);
  }
  const trainEnabled = trainEnabledResult.enabled;

  const queuedTickets = fetchQueuedTickets();
  const lastScheduledRun = fetchLastScheduledRun();
  const lastAnyRun = fetchLastAnyCompletedRun();
  // Informational only (issue body "last manual tick") — present only when the newest run of
  // ANY event is NOT itself a schedule run (otherwise it's the same run already shown above).
  const lastManualRun = lastAnyRun && lastAnyRun.event !== "schedule" ? lastAnyRun : null;

  let lastCompletedRunIso: string | null = lastScheduledRun ? lastScheduledRun.updatedAt : null;
  if (forceStaleMinutes !== null) {
    // Rule #471 planted control: fabricate an old completion timestamp so the stale->open-issue
    // path can be exercised live once, independent of whether the real cron is actually down.
    lastCompletedRunIso = new Date(new Date(nowIso).getTime() - forceStaleMinutes * 60_000).toISOString();
    console.log(
      `[train-liveness] PLANTED CONTROL: overriding lastCompletedRunIso to ${lastCompletedRunIso} (${forceStaleMinutes} min before now) — this does NOT itself mean the real cron is down.`,
    );
  }

  // P3 fix: evaluateTrainLiveness itself throws TypeError('invalid ISO timestamp: ...') on a
  // malformed nowIso/lastCompletedRunIso — deliberately NOT caught here, so it propagates to
  // main().catch() below: log loud, exit non-zero, no reconcile performed (the issue-mutation
  // code below never runs).
  const result = evaluateTrainLiveness({
    nowIso,
    lastCompletedRunIso,
    queuedTickets: queuedTickets.length,
    trainEnabled,
    windowMinutes: TRAIN_LIVENESS_STALE_MINUTES,
  });

  console.log(`[train-liveness] reason: ${result.reason}`);
  console.log(
    `[train-liveness] queued (${queuedTickets.length}): ${queuedTickets.length > 0 ? queuedTickets.map((t) => `${t.repo}#${t.number}`).join(", ") : "(none)"}`,
  );
  console.log(
    `[train-liveness] last SCHEDULE-triggered completed run: ${
      lastScheduledRun ? `${lastScheduledRun.url} (updatedAt=${lastScheduledRun.updatedAt})` : "none found"
    }`,
  );
  if (lastManualRun) {
    console.log(
      `[train-liveness] last manual tick (informational, does NOT feed the verdict): ${lastManualRun.url} (event=${lastManualRun.event}, updatedAt=${lastManualRun.updatedAt})`,
    );
  }

  const openIssues = listIssuesByLabel(SELF_REPO, TRAIN_LIVENESS_LABEL, "open");
  if (openIssues.length > 1) {
    // Rule #165's invariant is AT MOST ONE open issue per monitor label — more than one means
    // something upstream double-opened. Reconcile against the first and say so loudly rather
    // than silently picking one.
    console.warn(
      `[train-liveness] WARNING: ${openIssues.length} open ${TRAIN_LIVENESS_LABEL} issues found (expected <=1) — reconciling against #${openIssues[0].number} only; the rest need a human look.`,
    );
  }
  const existing = openIssues[0] ?? null;

  const issueAction: "opened" | "closed" | "unchanged" | "none" =
    result.verdict === "stale" ? (existing ? "unchanged" : "opened") : existing ? "closed" : "none";

  if (dryRun) {
    if (issueAction === "opened") {
      const planted = forceStaleMinutes !== null;
      const title = formatLivenessIssueTitle(result.silentMinutes, queuedTickets.length, planted);
      const body = formatLivenessIssueBody({
        nowIso,
        silentMinutes: result.silentMinutes,
        queuedTickets,
        lastRunUrl: lastScheduledRun ? lastScheduledRun.url : null,
        windowMinutes: TRAIN_LIVENESS_STALE_MINUTES,
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
      const title = formatLivenessIssueTitle(result.silentMinutes, queuedTickets.length, planted);
      const body = formatLivenessIssueBody({
        nowIso,
        silentMinutes: result.silentMinutes,
        queuedTickets,
        lastRunUrl: lastScheduledRun ? lastScheduledRun.url : null,
        windowMinutes: TRAIN_LIVENESS_STALE_MINUTES,
        lastManualTick: lastManualRun ? { url: lastManualRun.url, updatedAt: lastManualRun.updatedAt } : null,
        planted,
      });
      ensureLabel(SELF_REPO, TRAIN_LIVENESS_LABEL, TRAIN_LIVENESS_LABEL_DESCRIPTION, TRAIN_LIVENESS_LABEL_COLOR);
      ensureLabel(SELF_REPO, MACHINERY_ALERT_LABEL, MACHINERY_ALERT_LABEL_DESCRIPTION, MACHINERY_ALERT_LABEL_COLOR);
      openIssue(SELF_REPO, `${TRAIN_LIVENESS_LABEL},${MACHINERY_ALERT_LABEL}`, title, body);
      console.log(`OPENED ${TRAIN_LIVENESS_LABEL} issue: ${title}`);
    } else if (issueAction === "closed") {
      const comment = `Train ticked again — verdict=${result.verdict} (${result.reason}). Last SCHEDULE-triggered completed run: ${
        lastScheduledRun ? lastScheduledRun.url : "none"
      }. Auto-closed by the train-liveness worker.`;
      closeIssue(SELF_REPO, existing!.number, comment);
      console.log(`CLOSED ${TRAIN_LIVENESS_LABEL} issue #${existing!.number}.`);
    }
  }

  console.log(
    `[train-liveness] verdict=${result.verdict} silent=${result.silentMinutes} queued=${queuedTickets.length} enabled=${trainEnabled} issue=${issueAction} dryRun=${dryRun}`,
  );
}

main().catch((err) => {
  console.error(`train-liveness-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
