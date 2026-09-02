#!/usr/bin/env tsx
/**
 * restart-train.ts — Heritage restart train worker (ops-pipeline#172).
 *
 * I/O glue around scripts/lib/restart-train-lib.ts (pure) + scripts/lib/railway-deployment-probes.ts
 * (Railway GraphQL) + scripts/lib/label-authority.ts (GraphQL timeline fetch + the label-authority
 * predicate, gh CLI) + scripts/lib/github-issues.ts (gh CLI wrapper). Read those files' headers
 * first — no classification/scheduling decision lives here.
 *
 * Canon: brain vault `library/architecture/2026-08-19-heritage-restart-train-design.md` (design
 * v0) + `library/decisions/2026-08-19-heritage-restart-train-merge-authority-label-gated.md`
 * (Kevin LOCKED option A, merge authority, 2026-08-19T20:45Z) + tracker `ops-pipeline#172`.
 *
 * RUNG 3 (this build; Kevin GO "done;go", sitting 2026-08-28 §8.4) is live: with `--fire` (the
 * cron's mode — see heritage-restart-train.yml), a green, authorized, window-clear queue head is
 * sha-pinned squash-MERGED instead of paged as CLICK DUE, and a cross-tick OBSERVE state machine
 * follows the restart that merge triggered to `END` / `END · FAILED`. GitHub itself is the
 * machine's durable state (#413): `train:in-flight` on the merged PR = "being observed", the
 * `restart-train:observe=` comment markers = "receipts already posted". Classification logic
 * (both legs, the WINDOW_BLOCKED re-dispatch law, the #269/#448 timeout ladder) lives in
 * scripts/lib/restart-train-fire.ts — read its header first. RUNG 1 (ops-pipeline#172) added two
 * things on top of rung 0's dry-run scheduling, both gated behind `--post` like everything else
 * this worker writes:
 *
 *   (1) Leg A kills v1's D1 defect in ticket assembly: `train:ready` authority now comes from
 *       GitHub-attributed GraphQL timeline events (label-authority.ts), never a parseable comment
 *       body, and a STALE label (a push landing after the authorizing label) is stripped +
 *       receipted — with the receipt posted on the TICKET'S OWN PR, not `--target` — rather than
 *       silently excluded.
 *   (2) Leg B, run via `--page` (see Flags below): once the queue head's window is CLEAR, nothing
 *       is in flight (no un-cleared prior CLICK DUE), and its CI rollup is green, the worker posts
 *       ONE `CLICK DUE` comment on the queue-head PR itself (+ a mirror on `--target`) telling a
 *       human to click merge; a red/pending rollup posts a HELD-style deduped line instead
 *       (Rule #89: never page a human to a red-CI PR). See `maybePage` below.
 *
 * Rung 3's writes on top of rungs 0-1: the squash-merge itself (one-shot, never retried, never
 * `--delete-branch` — #328, always `--match-head-commit`), `train:in-flight` add/remove +
 * `train:ready` removal on the merged PR, START/END/END·FAILED ledger lines on `--target` + the
 * PR, machinery issues on studio-b-ai/ops-pipeline (label `restart-train`, #165 auto-reconciled:
 * ANY open issue = the train is locked via checkHold; stuck-observe issues auto-close when
 * observation completes, FAILED/anomaly issues are human-close-only, #161), and — for a
 * WINDOW_BLOCKED client-asthetik publish — one workflow_dispatch of acuops-build on main once
 * the window law clears (never with gate overrides, Rule #19: the train WAITS, it never
 * overrides). It still never touches branch protection and never writes client-asthetik#280,
 * which stays a READ-ONLY source (restart-train-args.ts refuses it as --target).
 *
 * Facts built per run:
 *   1. client-asthetik Actions: the most recent `deploy / Deploy to production` job with
 *      conclusion=success across the last 5 workflow runs of workflow id 262954027 ("AcuOps
 *      (Heritage Fabrics)"). ⚠️ LIVE-VERIFIED 2026-08-19: the bare job name "deploy" (no " / "
 *      qualifier) also appears on some runs with conclusion=skipped when the deploy stage never
 *      actually fired (confirmed on run 32297034397 — workflow-level conclusion "success", but
 *      its own "deploy" job "skipped" because upstream gates skipped it) — filtering on the EXACT
 *      qualified job name "deploy / Deploy to production" + conclusion=success is REQUIRED, not
 *      optional. Rule #266: verify the VALUE (which job, which conclusion), not just that a
 *      request returns 200. Cross-checked against a real #280 END line for run 32236101007 (job
 *      completed_at 2026-08-19T09:17:50Z, matching END comment 2026-08-19T09:17:50Z exactly).
 *   2. Railway studiob-api: latest SUCCESS deployment via railway-deployment-probes.ts.
 *      ⚠️ UNVERIFIED LIVE — see that file's header. No RAILWAY_API_TOKEN was available in this
 *      build's sandbox; the query shape is grounded in Railway's documented pattern and degrades
 *      to "no candidate this run" on any failure, never a crash or a bad PLAN line.
 *   3. client-asthetik#280 comments → parseEndComments (the human "calendar"'s END lines).
 *   4. `train:ready` PRs on studiob + client-asthetik → each evaluated via
 *      `fetchAuthorityTimeline` + `evaluateLabelAuthority` (label-authority.ts, GraphQL
 *      `timelineItems` — server-attributed, never a comment body). AUTHORIZED builds a `Ticket`
 *      (`labeledAt` = the authorizing LabeledEvent's server `createdAt`; `pinnedHeadSha` = the
 *      head observed at this same fetch, since AUTHORIZED already certifies no push landed after
 *      labeling). STALE strips the label + posts a write-only receipt (when `--post`) and
 *      excludes the PR this tick. Any other refusal (bot actor, unauthorized actor, hold-present,
 *      no-ready-label, truncated/empty timeline, a timeline fetch error) excludes the PR this
 *      tick with one log line — never fabricated, matching this worker's original fail-closed
 *      posture.
 *
 * Flags:
 *   --dry-run     Default true (i.e. whenever `--fire` is absent). Scheduling/paging only.
 *   --fire        Rung 3 live mode. Requires `--post` AND `--page`; refuses `--now` (live merges
 *                 run on the REAL clock only — the window law is meaningless under a simulated
 *                 timestamp; all three guards throw in restart-train-args.ts). Converts the
 *                 CLICK DUE page into the sha-pinned squash-merge + observe machine above, and
 *                 arms the WINDOW_BLOCKED re-dispatch.
 *   --now <ISO>   Replay clock threaded into every pure-lib call. Omit for the real time.
 *   --target <org/repo#n>   Where PLAN/HELD lines post. Default studio-b-ai/ops-pipeline#172.
 *                 NEVER client-asthetik#280 — that is a READ source (the human calendar); this
 *                 worker must not write to it.
 *   --post        Default false. Gates ALL issue-commenting AND the rung 1 stale-`train:ready`
 *                 label removal — with `--post` unset, a STALE ticket is logged and excluded but
 *                 its label is left alone (this worker's original read-only posture, preserved
 *                 for tests and local/manual runs). The CTO's first live dispatch (with the fleet
 *                 App's now-granted pull_requests/checks/actions scopes, landed 2026-08-19
 *                 ~21:52Z) was this worker's first real post, per Rule #464 (a guard's first live
 *                 firing is part of its ship).
 *   --page        Default false, independent of `--post` (Leg B, ops-pipeline#172). Turns on the
 *                 CLICK DUE paging check (`maybePage`, below) — omitting it leaves this worker at
 *                 exactly its Leg-A-only behavior (scheduling + label authority, no paging). Like
 *                 every other write this worker makes, an actual CLICK DUE/HELD post additionally
 *                 requires `--post`; `--page` alone only logs what WOULD have been posted. Wired
 *                 unconditionally into the cron invocation (heritage-restart-train.yml) — `--page`
 *                 turns the CHECK on, it never bypasses any gate inside `maybePage`.
 *
 * Hold check runs FIRST, before any fact-building: `train:hold` label on --target OR env
 * HERITAGE_TRAIN_HOLD=1 OR (rung 3) ANY open `restart-train`-labeled machinery issue on
 * ops-pipeline → (if --post) post exactly one `HELD` line, deduped against the target's own last
 * comment already starting with "HELD", and exit 0 without computing anything else — EXCEPT the
 * observe pass, which still runs under hold: a held train keeps watching its in-flight restart,
 * which is how a stuck-observe machinery hold self-resolves (#165 auto-reconcile).
 *
 * Any API read error (gh CLI failure, GraphQL error, unexpected shape) → exit non-zero, post
 * NOTHING. A missing App-token scope surfaces as `READ_DENIED:<scope>` specifically — kept as
 * defensive code even though the fleet App's pull_requests/checks/actions scopes were granted
 * 2026-08-19 ~21:52Z (a future scope regression should still fail loud and specific, not as a
 * bare stack trace three layers removed from "which permission").
 */

import { createHash } from "node:crypto";
import {
  closeIssue,
  commentIssue,
  ensureLabel,
  gh,
  listIssueComments,
  listIssuesByLabel,
  openIssue,
  removeLabel,
  type IssueComment,
  type IssueRef,
} from "./lib/github-issues.js";
import {
  fetchProjectRefs,
  fetchServiceDeployments,
  latestSuccessfulDeployment,
  RAILWAY_TERMINAL_STATUSES,
} from "./lib/railway-deployment-probes.js";
import {
  clampCandidatesToNow,
  clampCommentsToNow,
  clampTicketsToNow,
  computeAnchor,
  keepAtOrBefore,
  latestEndAnchorCandidate,
  orderQueue,
  planLines,
  planStateKey,
  parseEndComments,
  findDanglingPlan,
  parseTrainAfterTokens,
  hasTrainConsolidate,
  repoClassFor,
  windowState,
  clickDueStateKey,
  formatClickDueLine,
  parseClickDueComments,
  isClickDueStillInFlight,
  type AnchorCandidate,
  type AnchorResult,
  type Ticket,
  type QueueEntry,
  type RestartTrainComment,
} from "./lib/restart-train-lib.js";
import {
  evaluateLabelAuthority,
  fetchAuthorityTimeline,
  resolveAuthorityLogins,
  removeStaleReadyLabel,
  postAuthorityReceipt,
  formatStaleLabelRemovalReceipt,
  hasAuthoritySnapshotDrifted,
  type AuthoritySnapshot,
  type AuthorityTimelineItem,
  type StaleLabelAuthorityVerdict,
} from "./lib/label-authority.js";
import {
  classifyCaRun,
  classifyStudiobDeployments,
  formatEndFailedLine,
  formatEndLine,
  formatObserveNote,
  formatStartLine,
  isRevertTitle,
  observeStateKey,
  observeTimeoutVerdict,
  pickDeployJob,
  pickLatestRun,
  TRAIN_IN_FLIGHT_LABEL,
  TRAIN_READY_LABEL,
  type CaRunClassification,
  type StudiobDeployClassification,
  type WorkflowJobLike,
  type WorkflowRunLike,
} from "./lib/restart-train-fire.js";
import { isRollupClean, evaluateMergeReadiness, type RollupItem } from "./lib/automerge-classify.js";
import { loadTrainSanctionedSkips } from "./lib/automerge-skip-allowlist.js";
import { parseArgs, parseTarget, CALENDAR_REPO, CALENDAR_ISSUE, type Flags } from "./lib/restart-train-args.js";

const TICKET_REPOS = ["studio-b-ai/studiob", "studio-b-ai/client-asthetik"] as const;
const CLIENT_ASTHETIK_WORKFLOW_ID = "262954027"; // "AcuOps (Heritage Fabrics)" — live-verified 2026-08-19
const DEPLOY_JOB_NAME = "deploy / Deploy to production"; // NOT bare "deploy" — see file header
const STUDIOB_PLATFORM_PROJECT_ID = "433dec0e-6963-4b66-bdd2-6049ba189b81";
const STUDIOB_API_SERVICE_NAME = "studiob-api";
const RAILWAY_ENV_NAME = "production";

// ── rung-3 constants ──
const MACHINERY_REPO = "studio-b-ai/ops-pipeline";
/** Open issue carrying this label on MACHINERY_REPO = the train is LOCKED (checkHold) — #165. */
const MACHINERY_LABEL = "restart-train";
/**
 * Exact canonical GitHub label metadata (Kevin's 2026-08-29 label consolidation — "if my only
 * label is train:ready then I want it to be that way in github"). `ensureLabel` is
 * `gh label create --force`, which OVERWRITES description/color on every call — these strings
 * must match what lives on GitHub or every tick flip-flops the label metadata. Both fit under
 * GITHUB_LABEL_DESCRIPTION_MAX (100) — `assertLabelDescription` throws at build otherwise.
 */
const MACHINERY_LABEL_DESC = "Restart-train machinery (auto-reconciled, #165): open issue = train locked pending diagnosis";
const MACHINERY_LABEL_COLOR = "B60205";
const IN_FLIGHT_LABEL_DESC = "Machine-applied by the restart train: this restart is the ONE in flight (ops-pipeline#172)";
const IN_FLIGHT_LABEL_COLOR = "FBCA04";
/** Rule #208 END gate: /health on the NEW deployment (Railway's own hostname — a probe of the
 *  deployment itself, not a user-facing link, so the bare railway.app host is correct here). */
const STUDIOB_HEALTH_URL = "https://studiob-api-production-2df4.up.railway.app/health";
/** Observe-receipt dedup marker on the merged PR (postObserveReceipts) — 12 hex chars of the
 *  sha256 of the observe state key. Last marker wins; a changed key = a real transition. */
const OBSERVE_MARKER_RE = /<!-- restart-train:observe=([0-9a-f]{12}) -->/;

// ───────────────────────────── READ_DENIED classification ─────────────────────────────

/**
 * Missing App-token scope surfaces distinctly from a generic API error (brief requirement) —
 * grep receipt: `READ_DENIED`. `gh`'s execFileSync throws with the raw stderr text in the
 * message; a 403 from GitHub's REST/GraphQL API carries a recognizable phrase we can match on
 * without parsing structured JSON out of a thrown string.
 */
function classifyReadError(err: unknown, scopeHint: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const denied = /\b403\b|Resource not accessible by integration|must have the/i.test(msg);
  if (denied) return new Error(`READ_DENIED:${scopeHint} — ${msg}`);
  return err instanceof Error ? err : new Error(msg);
}

// ───────────────────────────── hold check ─────────────────────────────

async function checkHold(target: { repo: string; number: number }): Promise<{ held: boolean; reason: string }> {
  if (process.env.HERITAGE_TRAIN_HOLD === "1") {
    return { held: true, reason: "env HERITAGE_TRAIN_HOLD=1" };
  }
  let labelsJson: string;
  try {
    labelsJson = gh(["issue", "view", String(target.number), "--repo", target.repo, "--json", "labels"]);
  } catch (err) {
    throw classifyReadError(err, "issues:read (hold-label check)");
  }
  const { labels } = JSON.parse(labelsJson) as { labels: Array<{ name: string }> };
  const holdLabeled = labels.some((l) => l.name === "train:hold");
  if (holdLabeled) return { held: true, reason: "train:hold label on --target" };
  // Rung 3: any open restart-train machinery issue = the train is locked pending a human
  // diagnosis (#161/#165 — closing the issue releases it). The probe fails CLOSED: an unknown
  // lock state must never fire a merge.
  let machineryOpen: IssueRef[];
  try {
    machineryOpen = listIssuesByLabel(MACHINERY_REPO, MACHINERY_LABEL, "open");
  } catch {
    return { held: true, reason: "machinery-issue probe failed — fail-closed (#161)" };
  }
  if (machineryOpen.length > 0) {
    const first = machineryOpen[0];
    return { held: true, reason: `open restart-train machinery issue: ops-pipeline#${first.number} — ${first.title}` };
  }
  return { held: false, reason: "" };
}

// ───────────────────────────── fact-builders ─────────────────────────────

/**
 * client-asthetik Actions anchor candidate. Query-string params go directly in the URL (`gh api
 * "path?k=v&k2=v2"`), NOT `-f k=v` without `-X GET` — live-verified 2026-08-19: bare `-f` flags
 * default `gh api` to a POST, which 404s against this GET-only collection endpoint.
 */
async function fetchClientAsthetikAnchorCandidate(nowIso: string): Promise<AnchorCandidate | null> {
  // Source-level replay clamp (codex pass-3 P2, PR #174): filter runs to completed_at <= now
  // BEFORE picking the latest — clamping after the reduce lets a run completed after the replay
  // instant shadow the earlier run that should anchor. keepAtOrBefore passes malformed stamps
  // through; a malformed winner is rejected fail-closed by computeAnchor downstream.
  const stampOk = keepAtOrBefore(nowIso);
  let runsJson: string;
  try {
    runsJson = gh([
      "api",
      `repos/${TICKET_REPOS[1]}/actions/workflows/${CLIENT_ASTHETIK_WORKFLOW_ID}/runs?status=success&per_page=5`,
      "--jq",
      "[.workflow_runs[].id]",
    ]);
  } catch (err) {
    throw classifyReadError(err, "actions:read (client-asthetik workflow runs)");
  }
  const runIds = JSON.parse(runsJson) as number[];

  let best: { completedAtIso: string; runId: number } | null = null;
  for (const runId of runIds) {
    let jobsJson: string;
    try {
      jobsJson = gh(["api", `repos/${TICKET_REPOS[1]}/actions/runs/${runId}/jobs`, "--jq", ".jobs"]);
    } catch (err) {
      throw classifyReadError(err, "actions:read (client-asthetik run jobs)");
    }
    const jobs = JSON.parse(jobsJson) as Array<{
      name: string;
      conclusion: string | null;
      completed_at: string | null;
    }>;
    const deployJob = jobs.find(
      (j) => j.name === DEPLOY_JOB_NAME && j.conclusion === "success" && j.completed_at,
    );
    if (
      deployJob?.completed_at &&
      stampOk(deployJob.completed_at) &&
      (!best || deployJob.completed_at > best.completedAtIso)
    ) {
      best = { completedAtIso: deployJob.completed_at, runId };
    }
  }
  if (!best) return null;
  return {
    source: "client-asthetik-actions",
    completedAtIso: best.completedAtIso,
    detail: `client-asthetik run ${best.runId} job "${DEPLOY_JOB_NAME}"`,
  };
}

/**
 * Railway studiob-api anchor candidate. Absence of RAILWAY_API_TOKEN (unset locally, present in
 * CI via secrets per the workflow) is "no candidate from this source this run", never an error —
 * a local/replay run deliberately omits Railway facts. A REAL fetch failure with the token set
 * THROWS (fail-closed): silently degrading to null would narrow the fact set, and computeAnchor
 * takes the LATEST of the candidates — fewer candidates can yield an anchor EARLIER than reality
 * and open the 30-min window too soon. A red no-post cycle is the designed outcome during a
 * Railway outage (the every-5-minutes cron retries next cycle). Codex pass-4 P2 "degrade to null" REJECTED
 * on this basis, 2026-08-19.
 */
async function fetchRailwayAnchorCandidate(nowIso: string): Promise<AnchorCandidate | null> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) return null;

  const refs = await fetchProjectRefs(token, STUDIOB_PLATFORM_PROJECT_ID);
  if (!refs.ok) throw new Error(`Railway project refs fetch failed: ${refs.error}`);
  const service = refs.services.find((s) => s.name === STUDIOB_API_SERVICE_NAME);
  const env = refs.environments.find((e) => e.name === RAILWAY_ENV_NAME);
  if (!service || !env) {
    throw new Error(
      `Railway project refs missing expected names — service "${STUDIOB_API_SERVICE_NAME}" ${
        service ? "found" : "NOT FOUND"
      }, environment "${RAILWAY_ENV_NAME}" ${env ? "found" : "NOT FOUND"} (project ${STUDIOB_PLATFORM_PROJECT_ID})`,
    );
  }
  const deploysResult = await fetchServiceDeployments(token, STUDIOB_PLATFORM_PROJECT_ID, env.id, service.id, 10);
  if (!deploysResult.ok) throw new Error(`Railway deployments fetch failed: ${deploysResult.error}`);
  // Source-level replay clamp (codex pass-3 P2, PR #174) — same law as the Actions source:
  // drop deployments updated after `now` BEFORE the latest-reduce so a post-instant deployment
  // cannot shadow the one that should anchor. Malformed stamps pass through per keepAtOrBefore.
  const stampOk = keepAtOrBefore(nowIso);
  const latest = latestSuccessfulDeployment(deploysResult.deployments.filter((d) => stampOk(d.updatedAt)));
  if (!latest) return null;
  return {
    source: "studiob-api-railway",
    completedAtIso: latest.updatedAt,
    detail: `studiob-api Railway deployment ${latest.id}`,
  };
}

async function fetchCalendarComments(): Promise<RestartTrainComment[]> {
  try {
    // IssueComment and RestartTrainComment are structurally identical ({id, body, login,
    // createdAt}) — see restart-train-lib.ts's RestartTrainComment doc comment.
    return listIssueComments(CALENDAR_REPO, CALENDAR_ISSUE);
  } catch (err) {
    throw classifyReadError(err, "issues:read (client-asthetik#280)");
  }
}

/**
 * Builds `Ticket`s from every open `train:ready` PR on the two ticket repos, per-PR authority
 * decided by `evaluateLabelAuthority` (label-authority.ts) over a GraphQL timeline fetch — never
 * a comment body (v1's D1 defect; see this file's header). `post` gates the STALE leg's mutation
 * (label removal + receipt) exactly like every other write in this worker; the read/log/exclude
 * behavior is identical either way, only the mutation itself is skipped when `post` is false.
 *
 * Every refusal (AUTHORIZED=false for any reason, or a timeline fetch error) excludes the PR from
 * this tick with exactly one log line — never fabricated, per this worker's fail-closed posture.
 * A per-PR authority-timeline fetch error is caught and logged HERE, not thrown: unlike the
 * repo-wide `pr list` call above it (a failure there means "can't proceed for this whole repo",
 * so it still throws) or the comments fetch below it (already-AUTHORIZED, so a failure there
 * would force guessing at afterTokens/consolidate — still thrown, unchanged from before), a
 * single PR's timeline being unreadable this tick is exactly the kind of ambiguous-input case
 * this worker resolves toward exclusion, not toward killing every other repo's tickets too.
 */
async function fetchTickets(nowIso: string, post: boolean): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  const authorityLogins = resolveAuthorityLogins();
  for (const repo of TICKET_REPOS) {
    let prsJson: string;
    try {
      prsJson = gh([
        "pr",
        "list",
        "--repo",
        repo,
        "--label",
        "train:ready",
        "--state",
        "open",
        "--json",
        "number,headRefOid,labels",
        "--limit",
        "50",
      ]);
    } catch (err) {
      throw classifyReadError(err, `pull_requests:read (${repo} train:ready list)`);
    }
    const prs = JSON.parse(prsJson) as Array<{
      number: number;
      headRefOid: string;
      labels: Array<{ name: string }>;
    }>;
    for (const pr of prs) {
      const currentLabels = pr.labels.map((l) => l.name);

      let timelineResult: { timeline: AuthorityTimelineItem[]; truncated: boolean };
      try {
        timelineResult = fetchAuthorityTimeline(repo, pr.number);
      } catch (err) {
        const classified = classifyReadError(err, `pull_requests:read (${repo}#${pr.number} authority timeline)`);
        console.log(
          `[restart-train] ${repo}#${pr.number}: authority-timeline fetch error — excluded this tick (fail-closed): ${classified.message}`,
        );
        continue;
      }

      const verdict = evaluateLabelAuthority({
        currentLabels,
        timeline: timelineResult.timeline,
        authorityLogins,
        truncated: timelineResult.truncated,
      });

      if (!verdict.authorized) {
        if (verdict.reason === "stale-label") {
          // Narrowing `verdict.reason === "stale-label"` does not retroactively make `verdict`
          // assignable to the plain `StaleLabelAuthorityVerdict` interface at the type-checker
          // level (see that interface's doc comment in label-authority.ts) — an explicit cast is
          // required even though the runtime shape is already exactly right.
          const staleVerdict = verdict as StaleLabelAuthorityVerdict;
          if (post) {
            removeStaleReadyLabel(repo, pr.number);
            postAuthorityReceipt(repo, pr.number, formatStaleLabelRemovalReceipt(staleVerdict, pr.headRefOid));
            console.log(
              `[restart-train] ${repo}#${pr.number}: stale train:ready removed + receipt posted — ${verdict.detail}`,
            );
          } else {
            console.log(
              `[restart-train] ${repo}#${pr.number}: stale train:ready (--post not set, not removing/posting) — ${verdict.detail}`,
            );
          }
        } else {
          console.log(
            `[restart-train] ${repo}#${pr.number}: label-authority refused (${verdict.reason}) — excluded this tick: ${verdict.detail}`,
          );
        }
        continue;
      }

      // AUTHORIZED. labeledAt comes from the authorizing LabeledEvent's own timeline position —
      // fetchAuthorityTimeline validates createdAt is present/non-empty for every LABELED node
      // (label-authority.ts), so a missing value here would mean the position index itself is
      // wrong; fail closed rather than push a Ticket with an unparseable FIFO key.
      const labeledAtItem = timelineResult.timeline[verdict.authorizingEvent.position];
      const labeledAt = labeledAtItem?.createdAt;
      if (!labeledAt) {
        console.log(
          `[restart-train] ${repo}#${pr.number}: authorized but the authorizing event has no createdAt at its recorded position — excluded this tick (fail-closed)`,
        );
        continue;
      }

      let comments: RestartTrainComment[];
      try {
        comments = listIssueComments(repo, pr.number);
      } catch (err) {
        throw classifyReadError(err, `issues:read (${repo}#${pr.number} comments)`);
      }
      // Replay clamp BEFORE dependency-token parsing (codex P2b, PR #174 pass 1, still
      // applicable to afterTokens/consolidate): a train:after/consolidate comment posted after
      // `now` did not exist at the replay instant. (Label STATE has no history — a replay sees
      // today's train:ready set; a documented replay-fidelity limitation, not fixable here.)
      comments = clampCommentsToNow(comments, nowIso);

      tickets.push({
        repo,
        number: pr.number,
        repoClass: repoClassFor(repo),
        labeledAt,
        // AUTHORIZED already certifies no commit/force-push timeline item sits after the
        // authorizing LabeledEvent (evaluateLabelAuthority's staleness check) — the head
        // observed at THIS fetch is provably the same head that's been live since labeling, so
        // pinnedHeadSha and currentHeadSha both come from the same read (see Ticket's doc
        // comment in restart-train-lib.ts).
        pinnedHeadSha: pr.headRefOid,
        currentHeadSha: pr.headRefOid,
        afterTokens: parseTrainAfterTokens(comments),
        consolidate: hasTrainConsolidate(comments),
      });
    }
  }
  return tickets;
}

// ───────────────────────────── posting (gated behind --post) ─────────────────────────────

const STATE_MARKER_RE = /<!-- restart-train:state=([0-9a-f]{12}) -->/;

/**
 * Post the cycle's PLAN lines as ONE comment, deduped on the scheduling-state fingerprint
 * (`planStateKey` — see its doc for why body equality can't work: clear-now/chained slot
 * instants churn every cycle by construction). The posted comment carries a hidden
 * `<!-- restart-train:state=<sha256-12> -->` marker; if the LAST marker-bearing comment on the
 * target has the same hash, the state hasn't transitioned and nothing is posted (#292 —
 * post per state transition, never per cycle). Alternation (A → B → A) correctly reposts.
 * `listIssueComments` paginates the full ascending comment list, so the last-marker scan is
 * exact, not a window.
 */
async function postLines(
  target: { repo: string; number: number },
  lines: string[],
  post: boolean,
  stateKey: string,
): Promise<void> {
  console.log(`[restart-train] ${lines.length} line(s) for ${target.repo}#${target.number}:`);
  for (const line of lines) console.log(`  ${line}`);
  if (lines.length === 0) {
    console.log("[restart-train] empty plan — nothing to post");
    return;
  }
  const keyHash = createHash("sha256").update(stateKey).digest("hex").slice(0, 12);
  console.log(`[restart-train] state ${keyHash} :: ${stateKey}`);
  if (!post) {
    console.log("[restart-train] --post not set — not posting (default; tests/manual runs never pass it)");
    return;
  }
  let comments: IssueComment[];
  try {
    comments = listIssueComments(target.repo, target.number);
  } catch (err) {
    throw classifyReadError(err, "issues:read (target state-dedup check)");
  }
  let lastPostedHash: string | null = null;
  for (const c of comments) {
    const m = STATE_MARKER_RE.exec(c.body);
    if (m) lastPostedHash = m[1];
  }
  if (lastPostedHash === keyHash) {
    console.log(`[restart-train] scheduling state unchanged since last post (${keyHash}) — not reposting (#292)`);
    return;
  }
  commentIssue(target.repo, target.number, `${lines.join("\n")}\n\n<!-- restart-train:state=${keyHash} -->`);
  console.log(`[restart-train] posted 1 comment (state ${keyHash})`);
}

async function postHeldIfNotDuped(
  target: { repo: string; number: number },
  reason: string,
  post: boolean,
): Promise<void> {
  const line = `HELD · ${reason} · checked at ${new Date().toISOString()}`;
  if (!post) {
    console.log(`[restart-train] HELD (${reason}) — --post not set, not posting`);
    return;
  }
  let comments: IssueComment[];
  try {
    comments = listIssueComments(target.repo, target.number);
  } catch (err) {
    throw classifyReadError(err, "issues:read (target dedup check)");
  }
  const last = comments[comments.length - 1];
  if (last && last.body.trim().startsWith("HELD")) {
    console.log("[restart-train] last comment on target is already HELD — not reposting (dedup)");
    return;
  }
  commentIssue(target.repo, target.number, line);
}

// ───────────────────────────── paging (rung 1 Leg B, gated behind --page) ─────────────────────────────

const CLICK_DUE_MARKER_RE = /<!-- restart-train:click-due=([0-9a-f]{12}) -->/;

/**
 * Fetches ONLY the fields `evaluateMergeReadiness` needs (+ the rollup items `isRollupClean`
 * reduces) via a narrow, independent `gh pr view` call — never imports `pr-automerge-gate.ts`
 * (confirmed unsafe: an unconditional module-scope `main().catch(...)` at its bottom would run
 * that program's own CLI on import) or its `fetchPr`. Field list mirrors that file's OWN
 * `--json` selection without importing anything executable from it (Rule #283: reuse the
 * predicate, not the runner).
 *
 * Rung 3 additions to the field list: `title` (revert refusal — a human merges reverts),
 * `labels` + `headRefOid` (the BEFORE half of the pre-merge authority snapshot,
 * `hasAuthoritySnapshotDrifted`) — one fetch serves both the readiness gate and the fire path.
 */
async function fetchQueueHeadRollup(
  repo: string,
  number: number,
): Promise<{
  state: string;
  isDraft: boolean;
  mergeStateStatus: string;
  statusCheckRollup: RollupItem[];
  title: string;
  labels: Array<{ name: string }>;
  headRefOid: string;
}> {
  let out: string;
  try {
    out = gh([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,isDraft,mergeStateStatus,statusCheckRollup,title,labels,headRefOid",
    ]);
  } catch (err) {
    throw classifyReadError(err, "pull_requests:read (queue-head rollup check)");
  }
  return JSON.parse(out) as {
    state: string;
    isDraft: boolean;
    mergeStateStatus: string;
    statusCheckRollup: RollupItem[];
    title: string;
    labels: Array<{ name: string }>;
    headRefOid: string;
  };
}

/**
 * A ticket is "in flight" when the most recent `CLICK DUE` posted on `--target` is NEWER than
 * the CURRENT anchor — i.e. no restart has completed since that paging happened. This
 * self-resolves without separately tracking a matching END: `computeAnchor` only advances
 * `anchor.anchorIso` past a CLICK DUE's own stamp once a genuinely NEW restart-completion fact
 * (client-asthetik Actions success, Railway deploy, or a manual END on #280) lands — which by
 * construction happens AFTER the human clicks merge and the restart finishes — so the
 * comparison flips from "in flight" to "clear" at exactly the right moment, with no separate
 * bookkeeping. Fail-closed (treated as in-flight) if either stamp is unparseable: the
 * double-restart-collision hazard this guards against is strictly worse than one missed paging
 * cycle (Rule #4).
 */
async function isTicketInFlight(
  target: { repo: string; number: number },
  anchor: Extract<AnchorResult, { ok: true }>,
  nowIso: string,
): Promise<{ inFlight: boolean; detail: string }> {
  let rawComments: RestartTrainComment[];
  try {
    rawComments = listIssueComments(target.repo, target.number);
  } catch (err) {
    throw classifyReadError(err, "issues:read (target in-flight check)");
  }
  const comments = clampCommentsToNow(rawComments, nowIso);
  const clickDues = parseClickDueComments(comments);
  const last = clickDues.length > 0 ? clickDues[clickDues.length - 1] : null;
  if (!last) return { inFlight: false, detail: "no prior CLICK DUE on target" };
  // last.isoStamp is passed THROUGH as-is (never coalesced to null) — an empty string means a
  // CLICK DUE WAS posted but its stamp is malformed, which must fail closed via
  // isClickDueStillInFlight's own Number.isNaN branch, NOT read as "no prior CLICK DUE" (that
  // reading is reserved for `last === null` above, a genuinely different case: nothing posted).
  const inFlight = isClickDueStillInFlight(last.isoStamp, anchor.anchorIso);
  return { inFlight, detail: `last CLICK DUE ${last.isoStamp || "(unparseable)"} vs anchor ${anchor.anchorIso}` };
}

/**
 * Posts the `CLICK DUE` line to BOTH `--target` (via `commentIssue`, the same seam
 * `postLines`/`postHeldIfNotDuped` already use) and the queue-head PR (via
 * `postAuthorityReceipt` — label-authority.ts's existing write-only PR-comment helper, reused
 * per Rule #283 rather than forking a new poster). Deduped against the QUEUE-HEAD PR's OWN
 * comment history via a `restart-train:click-due=<hash>` marker distinct from `postLines`'
 * `restart-train:state=` marker — `--target` accumulates PLAN/HELD noise from every OTHER
 * ticket too, so only the queue-head PR's own thread can correctly answer "have I already told
 * a human to click merge on THIS PR at THIS pinned head" (#292: once per state transition, not
 * per cron cycle).
 *
 * Write ORDER is deliberate (codex review, rung 1 PR): the marker-carrying PR post goes LAST,
 * not first. `gh` calls are not transactional — either write can fail independently — and the
 * marker is the ONLY durable "already told a human" fact this function leaves behind. Marker
 * write LAST means a partial failure always resolves to "retry both on the next cron cycle"
 * (worst case: one harmless duplicate `--target` mirror line) rather than "the marker silently
 * committed, so the dedup check at the top skips ALL further attempts forever" — a permanently
 * dropped mirror with no self-healing path, since the queue head's `pinnedHeadSha` (part of the
 * state key) doesn't change while it's stuck waiting on a human to click. Rule #4: a rare
 * duplicate notice is a strictly better failure mode than a silent, permanent, unretriable one.
 */
async function postClickDue(
  target: { repo: string; number: number },
  ticket: Ticket,
  nowIso: string,
  anchor: Extract<AnchorResult, { ok: true }>,
  post: boolean,
): Promise<void> {
  const stateKey = clickDueStateKey(ticket.repo, ticket.number, ticket.pinnedHeadSha);
  const keyHash = createHash("sha256").update(stateKey).digest("hex").slice(0, 12);
  const line = formatClickDueLine(ticket.repo, ticket.number, ticket.pinnedHeadSha, nowIso, anchor.anchorIso, anchor.source);
  console.log(`[restart-train] --page: CLICK DUE candidate ${keyHash} :: ${stateKey}`);
  console.log(`  ${line}`);
  if (!post) {
    console.log("[restart-train] --page: --post not set — not posting (default; tests/manual runs never pass it)");
    return;
  }
  let prComments: IssueComment[];
  try {
    prComments = listIssueComments(ticket.repo, ticket.number);
  } catch (err) {
    throw classifyReadError(err, "issues:read (queue-head PR click-due dedup check)");
  }
  let lastPostedHash: string | null = null;
  for (const c of prComments) {
    const m = CLICK_DUE_MARKER_RE.exec(c.body);
    if (m) lastPostedHash = m[1];
  }
  if (lastPostedHash === keyHash) {
    console.log(`[restart-train] --page: CLICK DUE state unchanged since last post (${keyHash}) — not reposting (#292)`);
    return;
  }
  // Mirror first, marker-carrying PR post LAST — see the doc comment above for why the order
  // matters under partial write failure.
  commentIssue(target.repo, target.number, line);
  postAuthorityReceipt(ticket.repo, ticket.number, `${line}\n\n<!-- restart-train:click-due=${keyHash} -->`);
  console.log(
    `[restart-train] --page: posted CLICK DUE (state ${keyHash}) to ${ticket.repo}#${ticket.number} + mirror on ${target.repo}#${target.number}`,
  );
}

/**
 * Rung 1 Leg B (ops-pipeline#172) — only called when `--page` is set (`main()` gates the call
 * itself; without the flag this function never runs, and behavior stays byte-identical to rung
 * 0 / Leg A). Gate order, cheapest/no-I/O first:
 *   1. queue head exists (no I/O) — nothing to page against an empty/fully-invalidated queue.
 *   2. window CLEAR for the head's repoClass (no I/O) — reuses `windowState`, the exact
 *      predicate `computePlanSlots`'s first iteration already evaluates for this same ticket;
 *      not duplicated logic, just invoked directly for the one ticket that matters here.
 *   3. no ticket in flight (I/O: --target comments) — Rule #89 sibling: never double-page.
 *   4. queue head's CI rollup green (I/O: PR view) — a red/pending rollup posts a HELD-style
 *      deduped line instead (Rule #89: never page a human to a red-CI PR) and returns; a green
 *      rollup posts CLICK DUE. `evaluateMergeReadiness` also folds in state=OPEN, !isDraft, and
 *      mergeStateStatus=CLEAN, so this same gate incidentally also refuses an already-merged,
 *      already-closed, draft, or conflicted/behind-base queue head — never just "CI passed".
 * Every OTHER branch (window not clear, ticket in flight) is silent by design — the
 * unconditional PLAN-line post that already runs earlier in `main()` every cycle already
 * surfaces "not clear yet" state on `--target`; this function does not duplicate that line.
 *
 * Under `--fire` (rung 3) the CLICK DUE page is replaced by `fireQueueHead` — the SAME gate
 * ladder in the same order, with a merge at the slot where the page used to be.
 */
async function maybePage(
  target: { repo: string; number: number },
  queue: QueueEntry[],
  anchor: Extract<AnchorResult, { ok: true }>,
  nowIso: string,
  post: boolean,
  fire: boolean,
): Promise<void> {
  const first = queue[0];
  const head = first && first.status === "queued" ? first : null;
  if (!head) {
    console.log("[restart-train] --page: no queue head (empty or fully-invalidated queue) — nothing to page");
    return;
  }
  const ticket = head.ticket;

  const clearance = windowState(nowIso, ticket.repoClass, anchor.anchorIso);
  if (!clearance.clear) {
    console.log(`[restart-train] --page: queue head ${ticket.repo}#${ticket.number} window not clear yet — ${clearance.reason}`);
    return;
  }

  const flight = await isTicketInFlight(target, anchor, nowIso);
  if (flight.inFlight) {
    console.log(`[restart-train] --page: possible ticket in flight (${flight.detail}) — not paging`);
    return;
  }

  const prJson = await fetchQueueHeadRollup(ticket.repo, ticket.number);
  const readiness = evaluateMergeReadiness({
    state: prJson.state,
    isDraft: prJson.isDraft,
    // Train-scoped sanction (ops#235 amendment, 2026-09-02 22:18Z first-firing
    // incident): the train's merge authority is Kevin's label + the window
    // law (ops#265), not CI alone, so `train_repos:` by-design PR-event
    // skips count as clean here without loosening the squasher's gate.
    ciClean: isRollupClean(prJson.statusCheckRollup, loadTrainSanctionedSkips(ticket.repo)),
    mergeStateStatus: prJson.mergeStateStatus,
  });

  if (!readiness.ready) {
    console.log(
      `[restart-train] --page: queue head ${ticket.repo}#${ticket.number} rollup not green (${readiness.detail}) — not paging (Rule #89)`,
    );
    await postHeldIfNotDuped(target, `queue head ${ticket.repo}#${ticket.number} rollup not green — not paging`, post);
    return;
  }

  if (fire) {
    await fireQueueHead(target, ticket, prJson, nowIso, post);
    return;
  }

  await postClickDue(target, ticket, nowIso, anchor, post);
}

// ───────────────────────────── fire (rung 3) ─────────────────────────────

/**
 * The rung-3 merge itself. Reached ONLY through `maybePage`'s gate ladder with `--fire` set —
 * every gate that used to precede a CLICK DUE page (queue head exists, window clear, no ticket
 * in flight, rollup green + OPEN + !draft + mergeStateStatus CLEAN) has already passed by the
 * time this runs. Guards here are the ones a page never needed:
 *
 *   - Revert refusal: a revert PR is never merged unattended (standing law) — HELD line instead.
 *   - Pin recheck: the rollup fetch's headRefOid must equal the ticket's pinnedHeadSha
 *     (label-time authority, #172); drift = log + abort, no same-cycle retry.
 *   - Authority snapshot: `hasAuthoritySnapshotDrifted` between the rollup fetch and a FRESH
 *     re-read immediately before the merge closes the TOCTOU gap (labels pulled, PR closed,
 *     head moved, mergeStateStatus degraded between gate-check and fire).
 *
 * Merge law: ONE attempt, `--squash --match-head-commit <pinnedHeadSha>`, NEVER wrapped in
 * `withGhRetry` (#161 — a failed merge is diagnosed, not retried), NEVER `--delete-branch`
 * (#328). GitHub's own `--match-head-commit` re-validates the sha server-side, so even a race
 * past the snapshot loses harmlessly (the merge 405s).
 *
 * Post-merge steps are best-effort with graded fallout:
 *   - `train:in-flight` label add FAILING is LOUD + a machinery issue — the observe machine
 *     keys off that label, so without it this restart is untracked (degraded-not-wedged: the
 *     anchor still self-advances off the restart-completion facts, but a human must verify).
 *   - `train:ready` removal failing is cosmetic (log only) — the merged PR leaves the open-PR
 *     list, so fetchTickets never sees it again.
 *   - START receipts are log-on-failure — same reason: a merged PR can't re-fire, so a missed
 *     START line costs one ledger entry, never a duplicate merge.
 */
async function fireQueueHead(
  target: { repo: string; number: number },
  ticket: Ticket,
  prView: Awaited<ReturnType<typeof fetchQueueHeadRollup>>,
  nowIso: string,
  post: boolean,
): Promise<void> {
  if (isRevertTitle(prView.title)) {
    console.log(`[restart-train] --fire: queue head ${ticket.repo}#${ticket.number} is a revert PR — refusing to merge unattended`);
    await postHeldIfNotDuped(target, `queue head ${ticket.repo}#${ticket.number} is a revert PR — a human merges reverts`, post);
    return;
  }

  if (prView.headRefOid !== ticket.pinnedHeadSha) {
    console.log(
      `[restart-train] --fire: ${ticket.repo}#${ticket.number} head ${prView.headRefOid.slice(0, 7)} != pinned ${ticket.pinnedHeadSha.slice(0, 7)} — aborting fire (label authority is sha-pinned; next cycle re-evaluates)`,
    );
    return;
  }

  const before: AuthoritySnapshot = {
    labels: prView.labels.map((l) => l.name),
    headRefOid: ticket.pinnedHeadSha,
    state: prView.state,
    mergeStateStatus: prView.mergeStateStatus,
  };
  let afterRaw: string;
  try {
    afterRaw = gh(["pr", "view", String(ticket.number), "--repo", ticket.repo, "--json", "labels,headRefOid,state,mergeStateStatus"]);
  } catch (err) {
    throw classifyReadError(err, "pull_requests:read (pre-merge revalidate)");
  }
  const afterParsed = JSON.parse(afterRaw) as {
    labels: Array<{ name: string }>;
    headRefOid: string;
    state: string;
    mergeStateStatus: string;
  };
  const after: AuthoritySnapshot = {
    labels: afterParsed.labels.map((l) => l.name),
    headRefOid: afterParsed.headRefOid,
    state: afterParsed.state,
    mergeStateStatus: afterParsed.mergeStateStatus,
  };
  if (hasAuthoritySnapshotDrifted(before, after)) {
    console.log(
      `[restart-train] --fire: ${ticket.repo}#${ticket.number} authority snapshot drifted between gate-check and fire — aborting (no same-cycle retry; next cycle re-evaluates from scratch)`,
    );
    return;
  }

  if (!post) {
    // Unreachable through the CLI (parseArgs makes --fire imply --post) — defensive belt for
    // any future programmatic caller (#376: the dry rung must not mutate).
    console.log(`[restart-train] --fire: WOULD merge ${ticket.repo}#${ticket.number} @ ${ticket.pinnedHeadSha.slice(0, 7)} (--post not set)`);
    return;
  }

  try {
    gh(["pr", "merge", String(ticket.number), "--repo", ticket.repo, "--squash", "--match-head-commit", ticket.pinnedHeadSha]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[restart-train] --fire: MERGE FAILED for ${ticket.repo}#${ticket.number} @ ${ticket.pinnedHeadSha.slice(0, 7)}: ${msg}`);
    throw err;
  }
  console.log(`[restart-train] --fire: MERGED ${ticket.repo}#${ticket.number} @ ${ticket.pinnedHeadSha.slice(0, 7)} (squash, sha-pinned)`);

  try {
    ensureLabel(ticket.repo, TRAIN_IN_FLIGHT_LABEL, IN_FLIGHT_LABEL_DESC, IN_FLIGHT_LABEL_COLOR);
    gh(["pr", "edit", String(ticket.number), "--repo", ticket.repo, "--add-label", TRAIN_IN_FLIGHT_LABEL]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[restart-train] --fire: ${TRAIN_IN_FLIGHT_LABEL} could NOT be applied to ${ticket.repo}#${ticket.number} — the observe machine cannot track this restart: ${msg}`,
    );
    await escalateMachinery(
      `[restart-train] anomaly — ${ticket.repo}#${ticket.number} merged but train:in-flight could not be applied`,
      `The merge landed (@ ${ticket.pinnedHeadSha}) but labeling failed, so the observe state machine cannot track this restart: ${msg}\n\nVerify the restart completed by hand (Railway deployment / acuops-build run), then close this issue to release the train (Rule #161).`,
      post,
    );
  }
  try {
    removeLabel(ticket.repo, ticket.number, TRAIN_READY_LABEL);
  } catch (err) {
    console.log(
      `[restart-train] --fire: could not remove ${TRAIN_READY_LABEL} from ${ticket.repo}#${ticket.number} (cosmetic — merged PRs leave the queue): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const startLine = formatStartLine(nowIso, ticket.repo, ticket.number, ticket.pinnedHeadSha);
  try {
    commentIssue(target.repo, target.number, startLine);
  } catch (err) {
    console.log(`[restart-train] --fire: START mirror on ${target.repo}#${target.number} failed (log-only): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    postAuthorityReceipt(ticket.repo, ticket.number, startLine);
  } catch (err) {
    console.log(`[restart-train] --fire: START receipt on ${ticket.repo}#${ticket.number} failed (log-only): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ───────────────────────────── observe state machine (rung 3) ─────────────────────────────

interface InFlightPr {
  repo: string;
  number: number;
  title: string;
  mergedAt: string | null;
  mergeCommitOid: string | null;
  state: string;
}

/** An in-flight PR narrowed to the merged shape the observe legs need. */
interface ObservedPr {
  repo: string;
  number: number;
  title: string;
  mergedAt: string;
  mergeCommitOid: string;
}

/**
 * GitHub itself is the machine's durable state (#413): the ONE PR carrying `train:in-flight`
 * IS the in-flight restart, across ticks and worker restarts. `--state all` is REQUIRED — a
 * merged PR is CLOSED, so the default open-only listing would go blind the instant the merge
 * lands (exactly when observation starts).
 */
function findInFlightPrs(): { ok: true; prs: InFlightPr[] } | { ok: false; error: string } {
  const prs: InFlightPr[] = [];
  for (const repo of TICKET_REPOS) {
    let out: string;
    try {
      out = gh([
        "pr",
        "list",
        "--repo",
        repo,
        "--label",
        TRAIN_IN_FLIGHT_LABEL,
        "--state",
        "all",
        "--json",
        "number,title,mergedAt,mergeCommit,state",
        "--limit",
        "10",
      ]);
    } catch (err) {
      return { ok: false, error: `${repo}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const rows = JSON.parse(out) as Array<{
      number: number;
      title: string;
      mergedAt: string | null;
      mergeCommit: { oid: string } | null;
      state: string;
    }>;
    for (const r of rows) {
      prs.push({ repo, number: r.number, title: r.title, mergedAt: r.mergedAt, mergeCommitOid: r.mergeCommit?.oid ?? null, state: r.state });
    }
  }
  return { ok: true, prs };
}

/**
 * One observe tick. Runs EVERY cycle — under hold and without an anchor too (`anchorIso: null`
 * suppresses only the WINDOW_BLOCKED re-dispatch, which needs the window law): a held train
 * keeps watching its in-flight restart, which is how a stuck-observe machinery hold
 * self-resolves (#165 auto-reconcile).
 *
 * Returns whether a restart is in flight — `main()` uses it to gate paging/firing (ONE in
 * flight, ever). Fail-closed throughout: an unlistable label state, multiple carriers, or an
 * unmerged carrier all report `inFlight: true` (blocking fires) + escalate, never "clear".
 */
async function runObservePass(
  target: { repo: string; number: number },
  flags: Flags,
  anchorIso: string | null,
): Promise<{ inFlight: boolean }> {
  const found = findInFlightPrs();
  if (!found.ok) {
    console.error(`[restart-train] observe: could not list ${TRAIN_IN_FLIGHT_LABEL} PRs — fail-closed as in-flight: ${found.error}`);
    return { inFlight: true };
  }
  if (found.prs.length === 0) return { inFlight: false };
  if (found.prs.length > 1) {
    const names = found.prs.map((p) => `${p.repo}#${p.number}`).join(", ");
    console.error(`[restart-train] observe: MULTIPLE PRs labeled ${TRAIN_IN_FLIGHT_LABEL} (${names}) — invariant broken, escalating`);
    await escalateMachinery(
      `[restart-train] anomaly — multiple PRs labeled ${TRAIN_IN_FLIGHT_LABEL}`,
      `Carriers: ${names}. The train's invariant is ONE restart in flight, ever — a human removes the label from all but the genuinely-live one (or all, if every restart completed), then closes this issue to release the train (Rule #161).`,
      flags.post,
    );
    return { inFlight: true };
  }
  const candidate = found.prs[0];
  if (!candidate.mergedAt || !candidate.mergeCommitOid) {
    console.error(
      `[restart-train] observe: ${candidate.repo}#${candidate.number} carries ${TRAIN_IN_FLIGHT_LABEL} but is not merged (state=${candidate.state}) — escalating`,
    );
    await escalateMachinery(
      `[restart-train] anomaly — ${candidate.repo}#${candidate.number} labeled ${TRAIN_IN_FLIGHT_LABEL} but not merged`,
      `state=${candidate.state}, mergedAt=${candidate.mergedAt ?? "null"}. The label is machine-applied AFTER a successful merge — an unmerged carrier means a hand-applied label or a half-completed fire. Remove the label (or merge by hand if that was the intent), then close this issue to release the train (Rule #161).`,
      flags.post,
    );
    return { inFlight: true };
  }
  const pr: ObservedPr = {
    repo: candidate.repo,
    number: candidate.number,
    title: candidate.title,
    mergedAt: candidate.mergedAt,
    mergeCommitOid: candidate.mergeCommitOid,
  };
  console.log(`[restart-train] observe: in-flight ${pr.repo}#${pr.number} (merged ${pr.mergedAt} @ ${pr.mergeCommitOid.slice(0, 7)})`);

  const repoClass = repoClassFor(pr.repo);
  if (repoClass === "studiob") {
    const cls = await observeStudiobLeg(pr.mergedAt);
    if (cls.kind === "deployed") {
      const health = await probeStudiobHealth();
      if (health.ok) {
        await completeObserve(target, pr, `${cls.detail}; ${health.detail}`, flags);
        return { inFlight: false };
      }
      console.log(`[restart-train] observe: Railway reports deployed but /health does not confirm (#208) — ${health.detail}`);
      await applyTimeoutLadder(pr, pr.mergedAt, `deployed but /health not confirming yet (${health.detail})`, flags);
      return { inFlight: true };
    }
    if (cls.kind === "failed") {
      await failObserve(target, pr, cls.detail, flags);
      return { inFlight: true };
    }
    console.log(`[restart-train] observe: waiting — ${cls.detail}`);
    await applyTimeoutLadder(pr, pr.mergedAt, cls.detail, flags);
    return { inFlight: true };
  }

  if (repoClass === "client-asthetik") {
    const { run, classification } = await observeCaLeg(pr.mergeCommitOid);
    if (classification.kind === "success" || classification.kind === "skipped") {
      await completeObserve(target, pr, classification.detail, flags);
      return { inFlight: false };
    }
    if (classification.kind === "failed") {
      await failObserve(target, pr, classification.detail, flags);
      return { inFlight: true };
    }
    if (classification.kind === "window-blocked") {
      await handleWindowBlocked(target, pr, run, classification.detail, anchorIso, flags);
      return { inFlight: true };
    }
    console.log(`[restart-train] observe: waiting — ${classification.detail}`);
    // Ladder base: the run's own created_at once one exists — a WINDOW_BLOCKED re-dispatch
    // resets the clock via its NEW run rather than counting from a merge that deliberately
    // waited out the overnight batch window.
    await applyTimeoutLadder(pr, run?.created_at ?? pr.mergedAt, classification.detail, flags);
    return { inFlight: true };
  }

  console.error(`[restart-train] observe: ${pr.repo}#${pr.number} carries ${TRAIN_IN_FLIGHT_LABEL} in an unrecognized repo class — escalating`);
  await escalateMachinery(
    `[restart-train] anomaly — ${pr.repo}#${pr.number} labeled ${TRAIN_IN_FLIGHT_LABEL} in an unrecognized repo`,
    `repoClassFor("${pr.repo}") returned "other" — the observe machine only understands the two ticket repos. Remove the label, then close this issue to release the train (Rule #161).`,
    flags.post,
  );
  return { inFlight: true };
}

/**
 * Railway leg for a studiob merge. EVERY failure degrades to `waiting` — deliberately
 * ASYMMETRIC with `fetchRailwayAnchorCandidate`, which THROWS on the same probes: a
 * narrowed anchor fact-set can open the merge window too EARLY (unsafe), while an
 * unobservable observation tick just waits, and the #269/#448 ladder escalates persistent
 * blindness from the merge stamp.
 */
async function observeStudiobLeg(mergedAtIso: string): Promise<StudiobDeployClassification> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    return { kind: "waiting", detail: "RAILWAY_API_TOKEN unset — cannot observe this tick (the ladder still escalates from the merge stamp)" };
  }
  const refs = await fetchProjectRefs(token, STUDIOB_PLATFORM_PROJECT_ID);
  if (!refs.ok) return { kind: "waiting", detail: `Railway project refs fetch failed — will retry: ${refs.error}` };
  const service = refs.services.find((s) => s.name === STUDIOB_API_SERVICE_NAME);
  const env = refs.environments.find((e) => e.name === RAILWAY_ENV_NAME);
  if (!service || !env) {
    return {
      kind: "waiting",
      detail: `Railway refs missing expected names (service ${service ? "found" : "MISSING"}, env ${env ? "found" : "MISSING"}) — will retry`,
    };
  }
  const deploys = await fetchServiceDeployments(token, STUDIOB_PLATFORM_PROJECT_ID, env.id, service.id, 10);
  if (!deploys.ok) return { kind: "waiting", detail: `Railway deployments fetch failed — will retry: ${deploys.error}` };
  return classifyStudiobDeployments(mergedAtIso, deploys.deployments, RAILWAY_TERMINAL_STATUSES);
}

/**
 * Rule #208 belt over Railway's SUCCESS status: a deployment can report SUCCESS while the
 * service serves nothing. HTTP 200 on /health is the gate; the body's `status` field is
 * informational only (never gated — its vocabulary belongs to studiob-api, not this worker).
 */
async function probeStudiobHealth(): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(STUDIOB_HEALTH_URL, { signal: ctrl.signal });
    if (res.status !== 200) return { ok: false, detail: `/health HTTP ${res.status}` };
    let statusWord = "";
    try {
      const body = (await res.json()) as { status?: unknown };
      if (typeof body.status === "string") statusWord = ` (status=${body.status})`;
    } catch {
      // Non-JSON body — informational only; HTTP 200 already passed the gate.
    }
    return { ok: true, detail: `/health 200${statusWord}` };
  } catch (err) {
    return { ok: false, detail: `/health probe failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Actions leg for a client-asthetik merge: the latest acuops-build run FOR THE MERGE COMMIT
 * (head_sha filter — the push-triggered deploy run's head IS the squash commit), then its
 * deploy job's conclusion. Degrades to `waiting` on any API failure (same asymmetry argument
 * as observeStudiobLeg). The run is returned alongside the classification regardless, so the
 * caller can base the timeout ladder on the run's own created_at.
 */
async function observeCaLeg(mergeCommitOid: string): Promise<{ run: WorkflowRunLike | null; classification: CaRunClassification }> {
  let runsJson: string;
  try {
    runsJson = gh([
      "api",
      `repos/${TICKET_REPOS[1]}/actions/workflows/${CLIENT_ASTHETIK_WORKFLOW_ID}/runs?head_sha=${mergeCommitOid}&per_page=20`,
      "--jq",
      "[.workflow_runs[] | {id, status, conclusion, event, created_at}]",
    ]);
  } catch (err) {
    return {
      run: null,
      classification: { kind: "waiting", detail: `runs fetch failed — will retry: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  const run = pickLatestRun(JSON.parse(runsJson) as WorkflowRunLike[]);
  if (!run || run.status !== "completed") return { run, classification: classifyCaRun(run, null) };
  let jobsJson: string;
  try {
    jobsJson = gh([
      "api",
      `repos/${TICKET_REPOS[1]}/actions/runs/${run.id}/jobs?per_page=100`,
      "--jq",
      "[.jobs[] | {name, conclusion, steps: [.steps[]? | {name, conclusion}]}]",
    ]);
  } catch (err) {
    return {
      run,
      classification: { kind: "waiting", detail: `run ${run.id} jobs fetch failed — will retry: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  return { run, classification: classifyCaRun(run, pickDeployJob(JSON.parse(jobsJson) as WorkflowJobLike[])) };
}

/**
 * Observe-line poster — same dedup shape and WRITE ORDER as `postClickDue` (see its doc
 * comment): mirror on `--target` FIRST, marker-carrying PR post LAST, because the marker is
 * the only durable "already posted" fact and a partial failure must resolve to retry-both,
 * never to a silently-committed marker. Phase-distinct state keys (`observeStateKey`) make
 * every TRANSITION post exactly once while repeat states stay silent (#292).
 *
 * Returns whether anything was posted (false = deduped or --post off).
 */
async function postObserveReceipts(
  target: { repo: string; number: number },
  pr: ObservedPr,
  line: string,
  stateKey: string,
  post: boolean,
): Promise<boolean> {
  const keyHash = createHash("sha256").update(stateKey).digest("hex").slice(0, 12);
  console.log(`[restart-train] observe: ${line}`);
  console.log(`[restart-train] observe: state ${keyHash} :: ${stateKey}`);
  if (!post) {
    console.log("[restart-train] observe: --post not set — not posting");
    return false;
  }
  let prComments: IssueComment[];
  try {
    prComments = listIssueComments(pr.repo, pr.number);
  } catch (err) {
    throw classifyReadError(err, "issues:read (observe receipt dedup check)");
  }
  let lastPostedHash: string | null = null;
  for (const c of prComments) {
    const m = OBSERVE_MARKER_RE.exec(c.body);
    if (m) lastPostedHash = m[1];
  }
  if (lastPostedHash === keyHash) {
    console.log(`[restart-train] observe: state unchanged since last post (${keyHash}) — not reposting (#292)`);
    return false;
  }
  commentIssue(target.repo, target.number, line);
  postAuthorityReceipt(pr.repo, pr.number, `${line}\n\n<!-- restart-train:observe=${keyHash} -->`);
  console.log(`[restart-train] observe: posted (state ${keyHash}) to ${pr.repo}#${pr.number} + mirror on ${target.repo}#${target.number}`);
  return true;
}

/** Successful END: receipts, release the in-flight label, auto-close any stuck-observe issue. */
async function completeObserve(
  target: { repo: string; number: number },
  pr: ObservedPr,
  detail: string,
  flags: Flags,
): Promise<void> {
  const line = formatEndLine(flags.now, pr.repo, pr.number, detail);
  await postObserveReceipts(target, pr, line, observeStateKey(pr.repo, pr.number, pr.mergeCommitOid, "end-success"), flags.post);
  if (!flags.post) return;
  try {
    removeLabel(pr.repo, pr.number, TRAIN_IN_FLIGHT_LABEL);
    console.log(`[restart-train] observe: ${TRAIN_IN_FLIGHT_LABEL} removed from ${pr.repo}#${pr.number} — train released`);
  } catch (err) {
    console.log(
      `[restart-train] observe: could not remove ${TRAIN_IN_FLIGHT_LABEL} (self-healing — next tick re-observes, the marker dedups, and the label removal retries): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await resolveStuckObserveIssues(pr, flags.post);
}

/**
 * Failed END. NO `train:failed` label (Kevin, 2026-08-29 label consolidation — "if my only
 * label is train:ready then I want it to be that way"): the END · FAILED ledger line is the
 * record, and the machinery issue ALONE is the lock (#165: open issue = train locked via
 * checkHold).
 *
 * Lock-before-unlock ordering: the in-flight label currently blocks fires (runObservePass
 * fail-closed). It is removed ONLY after `escalateMachinery` confirms an open machinery issue
 * verifiably exists — if the issue-open fails, the label STAYS so the train remains blocked.
 * A failed escalation must never unlock the train.
 */
async function failObserve(
  target: { repo: string; number: number },
  pr: ObservedPr,
  detail: string,
  flags: Flags,
): Promise<void> {
  const line = formatEndFailedLine(flags.now, pr.repo, pr.number, detail);
  await postObserveReceipts(target, pr, line, observeStateKey(pr.repo, pr.number, pr.mergeCommitOid, "end-failed"), flags.post);
  if (!flags.post) return;
  const locked = await escalateMachinery(
    `[restart-train] merge observation FAILED — ${pr.repo}#${pr.number} @ ${pr.mergeCommitOid.slice(0, 7)}`,
    `${detail}\n\nMerged ${pr.mergedAt} (merge commit ${pr.mergeCommitOid}). Closing this issue releases the train (Rule #161 — a human diagnoses before the next merge fires).`,
    flags.post,
  );
  if (!locked) {
    console.error(
      `[restart-train] observe: machinery lock NOT confirmed — keeping ${TRAIN_IN_FLIGHT_LABEL} on ${pr.repo}#${pr.number} so the in-flight gate keeps blocking fires`,
    );
    return;
  }
  try {
    removeLabel(pr.repo, pr.number, TRAIN_IN_FLIGHT_LABEL);
  } catch (err) {
    console.log(
      `[restart-train] observe: could not remove ${TRAIN_IN_FLIGHT_LABEL} after FAILED (retries next tick — the machinery issue already locks the train): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // The STUCK condition ("can't see the restart") cleared — observation completed, with a
  // failure verdict. The new FAILED issue still locks; only stuck-observe issues auto-close.
  await resolveStuckObserveIssues(pr, flags.post);
}

/**
 * Opens (or finds) a machinery issue on ops-pipeline — exact-TITLE dedup, so callers use
 * STABLE titles (no timestamps). Returns whether an open issue with this title verifiably
 * exists after the call: callers that release other locks key off this (a failed open must
 * never unlock the train). `false` on --post off or any error.
 */
async function escalateMachinery(title: string, body: string, post: boolean): Promise<boolean> {
  try {
    const open = listIssuesByLabel(MACHINERY_REPO, MACHINERY_LABEL, "open");
    if (open.some((i) => i.title === title)) {
      console.log(`[restart-train] machinery: issue already open — "${title}" (dedup)`);
      return true;
    }
    if (!post) {
      console.log(`[restart-train] machinery: WOULD open "${title}" (--post not set)`);
      return false;
    }
    ensureLabel(MACHINERY_REPO, MACHINERY_LABEL, MACHINERY_LABEL_DESC, MACHINERY_LABEL_COLOR);
    openIssue(MACHINERY_REPO, MACHINERY_LABEL, title, body);
    console.log(`[restart-train] machinery: opened "${title}" — train locked until a human closes it (#165/#161)`);
    return true;
  } catch (err) {
    console.error(`[restart-train] machinery: FAILED to open "${title}": ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * #269/#448 ladder for a restart that stays unobserved: within-window = silent; 1×–2× the
 * window = OVERDUE log; ≥2× = machinery escalation (stable title → one issue per stuck
 * restart, deduped across ticks). WINDOW_BLOCKED never reaches this — it is an intentional
 * known state with its own handler, not a stall.
 */
async function applyTimeoutLadder(pr: ObservedPr, baseIso: string, waitingDetail: string, flags: Flags): Promise<void> {
  const verdict = observeTimeoutVerdict(baseIso, flags.now, repoClassFor(pr.repo));
  const elapsedMin = Math.round((Date.parse(flags.now) - Date.parse(baseIso)) / 60_000);
  const elapsed = Number.isNaN(elapsedMin) ? "unmeasurable elapsed" : `${elapsedMin} min since ${baseIso}`;
  if (verdict === "within-window") return;
  if (verdict === "overdue") {
    console.log(`[restart-train] observe: OVERDUE — ${pr.repo}#${pr.number} ${elapsed} (${waitingDetail})`);
    return;
  }
  console.error(`[restart-train] observe: ESCALATE — ${pr.repo}#${pr.number} ${elapsed} (${waitingDetail})`);
  await escalateMachinery(
    `[restart-train] stuck observe — ${pr.repo}#${pr.number} restart not observed`,
    `Merged ${pr.mergedAt} @ ${pr.mergeCommitOid}; observation base ${baseIso}; last state: ${waitingDetail}\n\nIf the restart actually completed, the next observe tick ENDs and closes this issue automatically; otherwise diagnose the deploy pipeline (Rule #161) — closing this issue by hand also releases the train.`,
    flags.post,
  );
}

/**
 * Auto-closes STUCK-OBSERVE issues once observation completes (#165 auto-reconcile: the open
 * issue IS the condition; condition cleared ⇒ producer closes it). FAILED and anomaly issues
 * are NEVER auto-closed — a human diagnoses those (Rule #161).
 */
async function resolveStuckObserveIssues(pr: ObservedPr, post: boolean): Promise<void> {
  if (!post) return;
  try {
    const open = listIssuesByLabel(MACHINERY_REPO, MACHINERY_LABEL, "open");
    for (const issue of open) {
      if (!issue.title.startsWith("[restart-train] stuck observe")) continue;
      closeIssue(
        MACHINERY_REPO,
        issue.number,
        `Observation completed for ${pr.repo}#${pr.number} — auto-resolving (the stuck condition cleared; #165 auto-reconcile). FAILED/anomaly issues are never auto-closed (#161).`,
      );
      console.log(`[restart-train] machinery: auto-closed stuck-observe issue ops-pipeline#${issue.number}`);
    }
  } catch (err) {
    console.log(`[restart-train] machinery: stuck-observe auto-close failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * WINDOW_BLOCKED: the acuops-build deploy job refused to publish inside the business-hours
 * gate — an INTENTIONAL known state (the merge landed; only the publish waits). Receipts post
 * a NOTE keyed per blocked RUN. Re-dispatch of the publish fires exactly when ALL of these
 * hold: `--fire --post`, an anchor exists, the window law is CLEAR for client-asthetik, and
 * main's head still IS the merge commit (a moved main means a dispatch would publish someone
 * ELSE's code — that degrades to FAILED for human diagnosis). The dispatch carries NO gate
 * overrides — Rule #19: `skip_sandbox_gate`/`force_business_hours` stay human-only; the train
 * WAITS for the window instead. Dispatch failure logs and stays window-blocked
 * (`pickLatestRun` makes the retry idempotent — the next tick sees whichever run is newest).
 */
async function handleWindowBlocked(
  target: { repo: string; number: number },
  pr: ObservedPr,
  run: WorkflowRunLike | null,
  detail: string,
  anchorIso: string | null,
  flags: Flags,
): Promise<void> {
  const line = formatObserveNote(flags.now, pr.repo, pr.number, detail);
  await postObserveReceipts(target, pr, line, observeStateKey(pr.repo, pr.number, pr.mergeCommitOid, `window-blocked@run-${run?.id ?? 0}`), flags.post);
  if (!(flags.fire && flags.post)) {
    console.log("[restart-train] observe: window-blocked — standing by (re-dispatch requires --fire --post)");
    return;
  }
  if (!anchorIso) {
    console.log("[restart-train] observe: window-blocked — no anchor this tick, cannot evaluate the window law for re-dispatch");
    return;
  }
  const clearance = windowState(flags.now, repoClassFor(pr.repo), anchorIso);
  if (!clearance.clear) {
    console.log(`[restart-train] observe: window-blocked — window not clear yet for re-dispatch (${clearance.reason})`);
    return;
  }
  let mainSha: string;
  try {
    mainSha = gh(["api", `repos/${pr.repo}/commits/main`, "--jq", ".sha"]).trim();
  } catch (err) {
    console.log(`[restart-train] observe: window-blocked — main-head probe failed, not dispatching: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (mainSha !== pr.mergeCommitOid) {
    await failObserve(
      target,
      pr,
      `window-blocked publish cannot be re-dispatched — main (${mainSha.slice(0, 7)}) moved past the merge commit (${pr.mergeCommitOid.slice(0, 7)}); a dispatch would publish someone else's code`,
      flags,
    );
    return;
  }
  try {
    gh([
      "api",
      "-X",
      "POST",
      `repos/${pr.repo}/actions/workflows/${CLIENT_ASTHETIK_WORKFLOW_ID}/dispatches`,
      "-f",
      "ref=main",
      "-f",
      "inputs[environment]=production",
    ]);
    console.log(
      `[restart-train] observe: window clear — re-dispatched acuops-build for ${pr.repo}#${pr.number} @ main ${mainSha.slice(0, 7)} (no gate overrides, Rule #19)`,
    );
  } catch (err) {
    console.log(
      `[restart-train] observe: window-blocked — publish re-dispatch failed, staying window-blocked: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const target = parseTarget(flags.target);
  console.log(
    `=== restart-train ${flags.fire ? "--fire" : "--dry-run"} now=${flags.now} target=${flags.target} post=${flags.post} page=${flags.page} ===`,
  );

  const hold = await checkHold(target);
  if (hold.held) {
    console.log(`[restart-train] HELD: ${hold.reason}`);
    // Observation continues under hold (anchor suppressed — no re-dispatch): a held train
    // keeps watching its in-flight restart, which is how a stuck-observe machinery hold
    // self-resolves (#165 auto-reconcile). Fires stay blocked — the hold path never pages.
    await runObservePass(target, flags, null);
    await postHeldIfNotDuped(target, hold.reason, flags.post);
    return;
  }

  const rawCalendarComments = await fetchCalendarComments();
  // Replay clamp (see clampCommentsToNow's doc): no fact from after `now` may be parsed.
  const calendarComments = clampCommentsToNow(rawCalendarComments, flags.now);
  if (calendarComments.length !== rawCalendarComments.length) {
    console.log(
      `[restart-train] clamp: dropped ${rawCalendarComments.length - calendarComments.length} calendar comment(s) after now=${flags.now}`,
    );
  }
  const endEntries = parseEndComments(calendarComments);
  const dangling = findDanglingPlan(calendarComments, flags.now);

  const candidates: AnchorCandidate[] = [];
  const clientAsthetikCandidate = await fetchClientAsthetikAnchorCandidate(flags.now);
  if (clientAsthetikCandidate) candidates.push(clientAsthetikCandidate);
  const railwayCandidate = await fetchRailwayAnchorCandidate(flags.now);
  if (railwayCandidate) candidates.push(railwayCandidate);
  const endCandidate = latestEndAnchorCandidate(endEntries, flags.now);
  if (endCandidate) candidates.push(endCandidate);

  // Belt-and-braces candidate-layer clamp: every source above already clamps its RAW stream
  // before its latest-reduce (codex pass-3 P2 — reduce-then-clamp let a future fact shadow a
  // valid older one from the same source), so this layer should drop nothing in the normal
  // path; it stays as defense-in-depth for any future source added without its own clamp.
  const clampedCandidates = clampCandidatesToNow(candidates, flags.now);
  if (clampedCandidates.length !== candidates.length) {
    console.log(
      `[restart-train] clamp: dropped ${candidates.length - clampedCandidates.length} anchor candidate(s) after now=${flags.now}`,
    );
  }

  const anchor = computeAnchor({
    now: flags.now,
    candidates: clampedCandidates,
    danglingPlan: dangling.dangling,
    danglingPlanDetail: dangling.detail,
  });

  if (!anchor.ok) {
    console.log(`[restart-train] anchor unavailable: ${anchor.reason}`);
    // Observation runs even anchor-less (re-dispatch suppressed) — an in-flight restart must
    // never go unwatched because the anchor computation happens to be ambiguous this tick.
    await runObservePass(target, flags, null);
    await postLines(target, planLines([], anchor, flags.now), flags.post, planStateKey([], anchor));
    return;
  }
  console.log(`[restart-train] anchor: ${anchor.anchorIso} (${anchor.source}: ${anchor.detail})`);

  const observe = await runObservePass(target, flags, anchor.anchorIso);

  const rawTickets = await fetchTickets(flags.now, flags.post);
  const tickets = clampTicketsToNow(rawTickets, flags.now);
  if (tickets.length !== rawTickets.length) {
    console.log(`[restart-train] clamp: dropped ${rawTickets.length - tickets.length} ticket(s) labeled after now=${flags.now}`);
  }
  console.log(`[restart-train] ${tickets.length} train:ready ticket(s) with valid label authority`);

  const queue = orderQueue(tickets);
  for (const entry of queue) {
    if (entry.status === "invalidated") {
      console.log(`[restart-train] invalidated: ${entry.ticket.repo}#${entry.ticket.number} — ${entry.reason}`);
    }
  }

  const lines = planLines(queue, anchor, flags.now);
  await postLines(target, lines, flags.post, planStateKey(queue, anchor));

  if (flags.page) {
    if (observe.inFlight) {
      console.log("[restart-train] in-flight observation active — not paging/firing this tick (ONE in flight, ever)");
    } else {
      await maybePage(target, queue, anchor, flags.now, flags.post, flags.fire);
    }
  }
}

main().catch((err) => {
  console.error(`restart-train FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
