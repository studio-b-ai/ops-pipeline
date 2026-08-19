#!/usr/bin/env tsx
/**
 * restart-train.ts — Heritage restart train, RUNG 0 worker (ops-pipeline#172).
 *
 * I/O glue around scripts/lib/restart-train-lib.ts (pure) + scripts/lib/railway-deployment-probes.ts
 * (Railway GraphQL) + scripts/lib/github-issues.ts (gh CLI wrapper). Read those files' headers
 * first — no classification/scheduling decision lives here.
 *
 * Canon: brain vault `library/architecture/2026-08-19-heritage-restart-train-design.md` (design
 * v0) + `library/decisions/2026-08-19-heritage-restart-train-merge-authority-label-gated.md`
 * (Kevin LOCKED option A, merge authority, 2026-08-19T20:45Z) + tracker `ops-pipeline#172`.
 *
 * RUNG 0 = DRY-RUN ONLY. `--fire` is not a real mode yet — it throws immediately, unconditionally
 * (rung 3 not built). The only thing this worker ever does to a live GitHub repo is READ
 * (issues/comments/PRs/Actions runs) plus, when `--post` is explicitly passed, comment a
 * PLAN/HELD line on `--target`. It never labels, never merges, never touches a PR beyond reading
 * its head sha.
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
 *   4. `train:ready` PRs on studiob + client-asthetik → parseTrainPin / parseTrainAfterTokens /
 *      hasTrainConsolidate per PR's own comment thread, built into Ticket objects. A PR carrying
 *      the label but no TRAIN-PIN comment yet is excluded from this tick (normal race — the
 *      label-apply step, which posts the pin, is separate CTO-owned work per design §4 and is
 *      NOT built by rung 0), never fabricated.
 *
 * Flags:
 *   --dry-run     Default true. The ONLY mode rung 0 has — passing or omitting it changes
 *                 nothing; kept as a real flag so rung 3's `--fire` slots in as its opposite
 *                 without a call-site rewrite.
 *   --fire        Throws "rung 3 not built" unconditionally — a caller trying to skip ahead gets
 *                 an explicit, loud refusal instead of a silent dry-run.
 *   --now <ISO>   Replay clock threaded into every pure-lib call. Omit for the real time.
 *   --target <org/repo#n>   Where PLAN/HELD lines post. Default studio-b-ai/ops-pipeline#172.
 *                 NEVER client-asthetik#280 — that is a READ source (the human calendar); rung 0
 *                 must not write to it.
 *   --post        Default false. Gates ALL issue-commenting. Tests and local/manual runs during
 *                 this build never pass it — the CTO's first live dispatch (with the fleet App's
 *                 now-granted pull_requests/checks/actions scopes, landed 2026-08-19 ~21:52Z) is
 *                 this worker's first real post, per Rule #464 (a guard's first live firing is
 *                 part of its ship).
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
  orderQueue,
  planLines,
  planStateKey,
  parseEndComments,
  findDanglingPlan,
  parseTrainPin,
  parseTrainAfterTokens,
  hasTrainConsolidate,
  repoClassFor,
  type AnchorCandidate,
  type Ticket,
  type RestartTrainComment,
} from "./lib/restart-train-lib.js";
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
async function fetchClientAsthetikAnchorCandidate(): Promise<AnchorCandidate | null> {
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
    if (deployJob?.completed_at && (!best || deployJob.completed_at > best.completedAtIso)) {
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
async function fetchRailwayAnchorCandidate(): Promise<AnchorCandidate | null> {
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
  const latest = latestSuccessfulDeployment(deploysResult.deployments);
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

async function fetchTickets(): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
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
        "number,headRefOid,createdAt",
        "--limit",
        "50",
      ]);
    } catch (err) {
      throw classifyReadError(err, `pull_requests:read (${repo} train:ready list)`);
    }
    const prs = JSON.parse(prsJson) as Array<{ number: number; headRefOid: string; createdAt: string }>;
    for (const pr of prs) {
      let comments: RestartTrainComment[];
      try {
        comments = listIssueComments(repo, pr.number);
      } catch (err) {
        throw classifyReadError(err, `issues:read (${repo}#${pr.number} comments)`);
      }
      const pin = parseTrainPin(comments);
      if (!pin) {
        // No pin comment yet — the label-apply step (separate, CTO-owned, not built by rung 0)
        // hasn't posted it. Normal race per parseTrainPin's doc: exclude, never fabricate.
        console.log(
          `[restart-train] ${repo}#${pr.number}: train:ready but no TRAIN-PIN comment yet — excluded this tick`,
        );
        continue;
      }
      tickets.push({
        repo,
        number: pr.number,
        repoClass: repoClassFor(repo),
        appliedAt: pin.appliedAtIso,
        pinnedHeadSha: pin.pinnedHeadSha,
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

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const target = parseTarget(flags.target);
  console.log(`=== restart-train --dry-run now=${flags.now} target=${flags.target} post=${flags.post} ===`);

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
  const clientAsthetikCandidate = await fetchClientAsthetikAnchorCandidate();
  if (clientAsthetikCandidate) candidates.push(clientAsthetikCandidate);
  const railwayCandidate = await fetchRailwayAnchorCandidate();
  if (railwayCandidate) candidates.push(railwayCandidate);
  if (endEntries.length > 0) {
    const latestEnd = endEntries.reduce((a, b) => (a.isoStamp > b.isoStamp ? a : b));
    if (latestEnd.isoStamp) {
      candidates.push({
        source: "manual-end-comment",
        completedAtIso: latestEnd.isoStamp,
        detail: latestEnd.detail,
      });
    }
  }

  // Replay clamp again at the candidate layer: a PAST comment can still carry a future-typo'd
  // END stamp, and the Actions/Railway sources are clamped here too (a replay must not anchor
  // on a deploy that completed after the replay instant).
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

  const rawTickets = await fetchTickets();
  const tickets = clampTicketsToNow(rawTickets, flags.now);
  if (tickets.length !== rawTickets.length) {
    console.log(`[restart-train] clamp: dropped ${rawTickets.length - tickets.length} ticket(s) pinned after now=${flags.now}`);
  }
  console.log(`[restart-train] ${tickets.length} train:ready ticket(s) with a valid pin comment`);

  const queue = orderQueue(tickets);
  for (const entry of queue) {
    if (entry.status === "invalidated") {
      console.log(`[restart-train] invalidated: ${entry.ticket.repo}#${entry.ticket.number} — ${entry.reason}`);
    }
  }

  const lines = planLines(queue, anchor, flags.now);
  await postLines(target, lines, flags.post, planStateKey(queue, anchor));
}

main().catch((err) => {
  console.error(`restart-train FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
