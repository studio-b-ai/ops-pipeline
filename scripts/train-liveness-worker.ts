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
 *   1. `HERITAGE_TRAIN_ENABLED` repo variable on studio-b-ai/ops-pipeline — `gh variable get`;
 *      a MISSING variable is treated as `false` (never alert on a deliberately/effectively-off
 *      train — mirrors heritage-restart-train.yml's own job-level `if:` gate).
 *   2. Open `train:ready` PRs across the train's two ticket repos (`gh pr list --label
 *      <TRAIN_READY_LABEL> --state open --json number`) — the label constant is imported from
 *      lib/restart-train-fire.ts (never hardcoded here, Rule #184).
 *      ⚠️ TICKET_REPOS below DUPLICATES (does not import) restart-train.ts's own
 *      `TICKET_REPOS` constant (that file, line ~194): restart-train.ts is FORBIDDEN to edit
 *      for this leg, and its `TICKET_REPOS` is not exported (importing an unexported binding
 *      from a worker script would also drag in and execute that script's top-level `main()`
 *      side effects, which is structurally wrong for a pure read). If the train ever grows a
 *      third ticket repo, both lists must be updated together — flagged here loudly rather than
 *      silently drifting.
 *   3. The most recent COMPLETED run of `heritage-restart-train.yml` on this repo (`gh run list
 *      --status completed --limit 1`) — any trigger event counts as a real tick (a
 *      `workflow_dispatch` run proves the scheduler infrastructure is fine even if the cron
 *      itself somehow didn't fire that tick).
 *   4. `evaluateTrainLiveness()` turns the above into one of four verdicts.
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
 * `--force-stale-minutes <n>`: PLANTED KNOWN-BAD (Rule #471) — fabricates the last-completed-run
 *   timestamp as exactly `n` minutes before `--now`/the real clock, so the `stale` → open-issue
 *   path can be exercised live once without waiting for (or faking) a real cron outage. This
 *   overrides ONLY the last-run age, never the queued-ticket count or `HERITAGE_TRAIN_ENABLED`
 *   read — both of those stay real reads, so the control only actually opens an issue if a real
 *   `train:ready` ticket happens to be queued and the train is enabled at the time it runs (by
 *   design: Rule #471's planted control proves the MECHANISM, it does not fabricate the whole
 *   scenario). Every issue opened this way carries the `formatLivenessIssueTitle`/
 *   `formatLivenessIssueBody` PLANTED CONTROL marker so nobody mistakes it for a real outage.
 */

import { gh, ensureLabel, listIssuesByLabel, openIssue, closeIssue } from "./lib/github-issues.js";
import { TRAIN_READY_LABEL } from "./lib/restart-train-fire.js";
import {
  evaluateTrainLiveness,
  formatLivenessIssueTitle,
  formatLivenessIssueBody,
  TRAIN_LIVENESS_LABEL,
  TRAIN_LIVENESS_STALE_MINUTES,
  type LivenessQueuedTicket,
} from "./lib/train-liveness-lib.js";

const SELF_REPO = "studio-b-ai/ops-pipeline";
const TRAIN_WORKFLOW_FILE = "heritage-restart-train.yml";
const HERITAGE_TRAIN_ENABLED_VAR = "HERITAGE_TRAIN_ENABLED";

// See the file header: duplicated from (not imported from) restart-train.ts's own
// TICKET_REPOS constant — that file is out of scope for this leg and does not export it.
const TICKET_REPOS = ["studio-b-ai/studiob", "studio-b-ai/client-asthetik"] as const;

const TRAIN_LIVENESS_LABEL_DESCRIPTION =
  "Heritage restart train cron-liveness watch (Rule #448): open = the */5 cron is silent while train:ready tickets are queued";
const TRAIN_LIVENESS_LABEL_COLOR = "B60205"; // same family as restart-train.ts's own MACHINERY_LABEL_COLOR — both are alarms about this train
const MACHINERY_ALERT_LABEL = "machinery-alert"; // shared cross-cutting tag (backlog-managers.yaml's machinery_labels) — excludes this leg's issues from rule-17 ranking
const MACHINERY_ALERT_LABEL_DESCRIPTION =
  "Rule #165 auto-reconciled monitor issue — excluded from LANES rule 17 ranking (see backlog-managers.yaml machinery_labels)";
const MACHINERY_ALERT_LABEL_COLOR = "5319E7";

// ───────────────────────────── gh reads ─────────────────────────────

interface GhRunRow {
  databaseId: number;
  updatedAt: string;
  createdAt: string;
  url: string;
  event: string;
}

/** The most recent COMPLETED run of heritage-restart-train.yml, or `null` if it has never completed one. */
function fetchLastCompletedRun(): GhRunRow | null {
  const raw = gh([
    "run", "list",
    "--repo", SELF_REPO,
    "--workflow", TRAIN_WORKFLOW_FILE,
    "--status", "completed",
    "--limit", "1",
    "--json", "databaseId,updatedAt,createdAt,url,event",
  ]);
  const rows = JSON.parse(raw) as GhRunRow[];
  return rows[0] ?? null;
}

interface GhPrNumberRow {
  number: number;
}

/** Open `train:ready` PRs across every ticket repo the train reads from. */
function fetchQueuedTickets(): LivenessQueuedTicket[] {
  const out: LivenessQueuedTicket[] = [];
  for (const repo of TICKET_REPOS) {
    const raw = gh(["pr", "list", "--repo", repo, "--label", TRAIN_READY_LABEL, "--state", "open", "--json", "number"]);
    const rows = JSON.parse(raw) as GhPrNumberRow[];
    for (const r of rows) out.push({ repo, number: r.number });
  }
  return out;
}

/** `HERITAGE_TRAIN_ENABLED` repo variable === 'true'. A missing/unreadable variable is `false` — never alert on a deliberately/effectively-off train (mirrors the workflow's own job-level `if:` gate). */
function fetchTrainEnabled(): boolean {
  try {
    const raw = gh(["variable", "get", HERITAGE_TRAIN_ENABLED_VAR, "--repo", SELF_REPO]);
    return raw.trim() === "true";
  } catch {
    return false;
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

  const trainEnabled = fetchTrainEnabled();
  const queuedTickets = fetchQueuedTickets();
  const lastRun = fetchLastCompletedRun();

  let lastCompletedRunIso: string | null = lastRun ? lastRun.updatedAt : null;
  if (forceStaleMinutes !== null) {
    // Rule #471 planted control: fabricate an old completion timestamp so the stale->open-issue
    // path can be exercised live once, independent of whether the real cron is actually down.
    lastCompletedRunIso = new Date(new Date(nowIso).getTime() - forceStaleMinutes * 60_000).toISOString();
    console.log(
      `[train-liveness] PLANTED CONTROL: overriding lastCompletedRunIso to ${lastCompletedRunIso} (${forceStaleMinutes} min before now) — this does NOT itself mean the real cron is down.`,
    );
  }

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
    `[train-liveness] last completed run: ${lastRun ? `${lastRun.url} (event=${lastRun.event}, updatedAt=${lastRun.updatedAt})` : "none found"}`,
  );

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
        lastRunUrl: lastRun ? lastRun.url : null,
        windowMinutes: TRAIN_LIVENESS_STALE_MINUTES,
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
        lastRunUrl: lastRun ? lastRun.url : null,
        windowMinutes: TRAIN_LIVENESS_STALE_MINUTES,
        planted,
      });
      ensureLabel(SELF_REPO, TRAIN_LIVENESS_LABEL, TRAIN_LIVENESS_LABEL_DESCRIPTION, TRAIN_LIVENESS_LABEL_COLOR);
      ensureLabel(SELF_REPO, MACHINERY_ALERT_LABEL, MACHINERY_ALERT_LABEL_DESCRIPTION, MACHINERY_ALERT_LABEL_COLOR);
      openIssue(SELF_REPO, `${TRAIN_LIVENESS_LABEL},${MACHINERY_ALERT_LABEL}`, title, body);
      console.log(`OPENED ${TRAIN_LIVENESS_LABEL} issue: ${title}`);
    } else if (issueAction === "closed") {
      const comment = `Train ticked again — verdict=${result.verdict} (${result.reason}). Last completed run: ${
        lastRun ? lastRun.url : "none"
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
