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
 * RUNG 0 (dry-run scheduling) is what this worker has always done: `--fire` is not a real mode
 * yet — it throws immediately, unconditionally (rung 3, the actual merge, is not built). RUNG 1
 * (ops-pipeline#172, this build) kills v1's D1 defect in ticket assembly: `train:ready` authority
 * now comes from GitHub-attributed GraphQL timeline events (label-authority.ts), never a
 * parseable comment body, and a STALE label (a push landing after the authorizing label) is
 * stripped + receipted rather than silently excluded. This worker still never merges and never
 * touches branch protection; it now DOES edit a PR's labels (strip a stale `train:ready`) and
 * comment on PRs beyond `--target`, both strictly narrower than a merge and both gated behind
 * `--post`.
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
 *   --dry-run     Default true. Passing or omitting it changes nothing yet; kept as a real flag
 *                 so rung 3's `--fire` slots in as its opposite without a call-site rewrite.
 *   --fire        Throws "rung 3 not built" unconditionally — a caller trying to skip ahead gets
 *                 an explicit, loud refusal instead of a silent dry-run.
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
 *
 * Hold check runs FIRST, before any fact-building: `train:hold` label on --target OR env
 * HERITAGE_TRAIN_HOLD=1 → (if --post) post exactly one `HELD` line, deduped against the target's
 * own last comment already starting with "HELD", and exit 0 without computing anything else.
 *
 * Any API read error (gh CLI failure, GraphQL error, unexpected shape) → exit non-zero, post
 * NOTHING. A missing App-token scope surfaces as `READ_DENIED:<scope>` specifically — kept as
 * defensive code even though the fleet App's pull_requests/checks/actions scopes were granted
 * 2026-08-19 ~21:52Z (a future scope regression should still fail loud and specific, not as a
 * bare stack trace three layers removed from "which permission").
 */

import { createHash } from "node:crypto";
import { commentIssue, gh, listIssueComments, type IssueComment } from "./lib/github-issues.js";
import {
  fetchProjectRefs,
  fetchServiceDeployments,
  latestSuccessfulDeployment,
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
  type AuthorityTimelineItem,
  type StaleLabelAuthorityVerdict,
} from "./lib/label-authority.js";
import { isRollupClean, evaluateMergeReadiness, type RollupItem } from "./lib/automerge-classify.js";
import { parseArgs, parseTarget, CALENDAR_REPO, CALENDAR_ISSUE } from "./lib/restart-train-args.js";

const TICKET_REPOS = ["studio-b-ai/studiob", "studio-b-ai/client-asthetik"] as const;
const CLIENT_ASTHETIK_WORKFLOW_ID = "262954027"; // "AcuOps (Heritage Fabrics)" — live-verified 2026-08-19
const DEPLOY_JOB_NAME = "deploy / Deploy to production"; // NOT bare "deploy" — see file header
const STUDIOB_PLATFORM_PROJECT_ID = "433dec0e-6963-4b66-bdd2-6049ba189b81";
const STUDIOB_API_SERVICE_NAME = "studiob-api";
const RAILWAY_ENV_NAME = "production";

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
  return { held: holdLabeled, reason: "train:hold label on --target" };
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
 */
async function fetchQueueHeadRollup(
  repo: string,
  number: number,
): Promise<{ state: string; isDraft: boolean; mergeStateStatus: string; statusCheckRollup: RollupItem[] }> {
  let out: string;
  try {
    out = gh(["pr", "view", String(number), "--repo", repo, "--json", "state,isDraft,mergeStateStatus,statusCheckRollup"]);
  } catch (err) {
    throw classifyReadError(err, "pull_requests:read (queue-head rollup check)");
  }
  return JSON.parse(out) as {
    state: string;
    isDraft: boolean;
    mergeStateStatus: string;
    statusCheckRollup: RollupItem[];
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
  const lastMs = Date.parse(last.isoStamp);
  const anchorMs = Date.parse(anchor.anchorIso);
  const inFlight = Number.isNaN(lastMs) || Number.isNaN(anchorMs) || lastMs > anchorMs;
  return { inFlight, detail: `last CLICK DUE ${last.isoStamp || "(unparseable)"} vs anchor ${anchor.anchorIso}` };
}

/**
 * Posts the `CLICK DUE` line to BOTH the queue-head PR (via `postAuthorityReceipt` —
 * label-authority.ts's existing write-only PR-comment helper, reused per Rule #283 rather than
 * forking a new poster) and `--target` (via `commentIssue`, the same seam
 * `postLines`/`postHeldIfNotDuped` already use). Deduped against the QUEUE-HEAD PR's OWN
 * comment history via a `restart-train:click-due=<hash>` marker distinct from `postLines`'
 * `restart-train:state=` marker — `--target` accumulates PLAN/HELD noise from every OTHER
 * ticket too, so only the queue-head PR's own thread can correctly answer "have I already told
 * a human to click merge on THIS PR at THIS pinned head" (#292: once per state transition, not
 * per cron cycle). The `--target` mirror carries no marker of its own — it is posted in the
 * same call, gated by the same dedup check, so it can never drift out of sync with it.
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
  postAuthorityReceipt(ticket.repo, ticket.number, `${line}\n\n<!-- restart-train:click-due=${keyHash} -->`);
  commentIssue(target.repo, target.number, line);
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
 */
async function maybePage(
  target: { repo: string; number: number },
  queue: QueueEntry[],
  anchor: Extract<AnchorResult, { ok: true }>,
  nowIso: string,
  post: boolean,
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
    ciClean: isRollupClean(prJson.statusCheckRollup),
    mergeStateStatus: prJson.mergeStateStatus,
  });

  if (!readiness.ready) {
    console.log(
      `[restart-train] --page: queue head ${ticket.repo}#${ticket.number} rollup not green (${readiness.detail}) — not paging (Rule #89)`,
    );
    await postHeldIfNotDuped(target, `queue head ${ticket.repo}#${ticket.number} rollup not green — not paging`, post);
    return;
  }

  await postClickDue(target, ticket, nowIso, anchor, post);
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const target = parseTarget(flags.target);
  console.log(`=== restart-train --dry-run now=${flags.now} target=${flags.target} post=${flags.post} page=${flags.page} ===`);

  const hold = await checkHold(target);
  if (hold.held) {
    console.log(`[restart-train] HELD: ${hold.reason}`);
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
    await postLines(target, planLines([], anchor, flags.now), flags.post, planStateKey([], anchor));
    return;
  }
  console.log(`[restart-train] anchor: ${anchor.anchorIso} (${anchor.source}: ${anchor.detail})`);

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
    await maybePage(target, queue, anchor, flags.now, flags.post);
  }
}

main().catch((err) => {
  console.error(`restart-train FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
