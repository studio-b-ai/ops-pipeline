#!/usr/bin/env tsx
/**
 * needs-human-crossrepo.ts — ops-pipeline#88, the cross-repo leg of the needs-human
 * autopilot (ops-pipeline#66 design comment: CTO seat, 2026-08-14 ~03:45Z, issue #66
 * comment 5289224655 — read that FIRST). Issue #88 itself (closed same night) is the
 * fleet GitHub App setup record this script depends on: `studiob-fleet-bot` (App ID
 * 4595770), installed org-wide with `issues:write` + `metadata:read`, App ID + private
 * key stored as ops-pipeline repo secrets `FLEET_APP_ID` / `FLEET_APP_PRIVATE_KEY`.
 *
 * Architecture (Rule #38): a reusable workflow CALLED FROM another repo cannot read
 * ops-pipeline's own repo secrets — that's why needs-human-router.ts (the same-repo
 * router) runs as a reusable workflow with each CALLER's ambient token instead. Cross-
 * repo filing needs the opposite shape: a token that can write to repos OTHER than the
 * one running the workflow. So this script runs from a NEW, NON-reusable workflow
 * (.github/workflows/needs-human-crossrepo.yml) that lives entirely IN ops-pipeline,
 * where the secrets are native, mints a fresh org-wide installation token every run via
 * `actions/create-github-app-token@v1`, and sweeps ALL FIVE covered repos in ONE
 * invocation using that single token (unlike the router's five separate per-repo cron
 * callers) — this script itself just reads `GH_TOKEN` from the environment, the same
 * convention every other script in this repo uses; it has no idea whether that token is
 * an installation token or a personal one.
 *
 * What this resolves: the same-repo router, on a clean `ROUTING: cross-repo
 * studio-b-ai/<repo>` + `NEEDS-KEVIN: no` trailer, has no fleet write credential and
 * posts a HOLD receipt naming the target rather than acting (Rule #184 discipline — v1
 * scope boundary, needs-human-router-lib.ts's routeDisposition `hold-cross-repo` case).
 * This script is what actually files the twin issue once the token exists. It does NOT
 * duplicate the same-repo router's own decisions (same-repo trailers, NEEDS-KEVIN holds,
 * the legacy default) — see needs-human-crossrepo-lib.ts's header comment for the full
 * scope-discipline and marker-reuse rationale (this script reuses ROUTE_RECEIPT_MARKER /
 * HOLD_RECEIPT_MARKER from needs-human-router-lib.ts on purpose, so the same-repo
 * router's existing recall pass transparently also catches a late 👎 on an already-
 * cross-repo-routed origin issue).
 *
 * Metering (#331): unlike the same-repo router's ACTION_CAP over ALL mutations, this
 * script caps only ISSUE-CREATIONS (filing a NEW twin in a repo other than the one this
 * process is even running against is the one genuinely expensive, higher-blast-radius
 * action here) at ISSUE_CREATION_CAP per run — loud when capped. Receipt-posting and
 * label-removal are NOT capped; they only ever fire alongside (or to complete) a
 * creation that already happened, or as a lightweight hold/reject receipt.
 *
 * `--dry-run`: identical reads throughout — including the twin-existence search and the
 * org-membership fallback (Rule #376: a dry run that reads nothing proves nothing) —
 * zero mutations, one preview line per planned action, labeled distinctly: `TWIN-FILE`
 * (would create the twin issue), `SWEEP-ROUTE` (would post the receipt + remove the
 * label, either right after a fresh TWIN-FILE or completing a prior partial run's
 * dangling twin), `SWEEP-REJECT` (would close-reject, and the twin too if one exists),
 * `SWEEP-HOLD` (would post the off-allowlist hold receipt).
 *
 * Usage: tsx needs-human-crossrepo.ts [--dry-run]  (no --repo — this script always
 * sweeps every covered repo in one run; that's the whole point of holding the fleet
 * token centrally instead of distributing it to five callers).
 */

import {
  closeIssue,
  commentIssue,
  gh,
  getCommentReactions,
  listIssueComments,
  listIssuesByLabel,
  removeLabel,
  type IssueComment,
} from "./lib/github-issues.js";
import {
  buildTwinTitle,
  crossRepoDisposition,
  findTwinMatch,
  shortRepoName,
  summarizeCrossRepoDispositions,
  twinTitlePrefix,
  type CrossRepoDisposition,
  type TwinCandidate,
} from "./lib/needs-human-crossrepo-lib.js";
import { createAuthorizedReactorChecker } from "./lib/needs-human-authorization.js";
import { parseProbeRouting, PROBE_MARKER } from "./lib/needs-human-probe-lib.js";
import {
  hasAuthorizedDisapproval,
  hasHoldReceipt,
  hasRouteReceipt,
  HOLD_RECEIPT_MARKER,
  isTrustedMarkerAuthor,
  ROUTE_RECEIPT_MARKER,
  type Reactor,
} from "./lib/needs-human-router-lib.js";

const ORG = "studio-b-ai";
const LABEL = "needs-human";
const ISSUE_CREATION_CAP = 5;

// The v1 covered-repo set — identical to needs-human-router.ts's ALLOWLIST (the design
// comment: "Cross-repo allowlist = the same set" as the repos where needs-human issues
// exist today). Kept as its own literal here rather than imported: importing it would
// mean reaching into needs-human-router.ts itself, which the chip prompt forbids editing
// beyond the deliverable-A import swap, and a shared constant isn't worth a THIRD module
// for five static strings that change together with the router's own allowlist by
// construction (both lists are reviewed in the same PR whenever a repo is added).
const COVERED_REPOS = ["bolt-wms", "studiob", "studiob-price-sync", "webhook-router", "asthetik-trade-theme"].map(
  (r) => `${ORG}/${r}`,
);
const ALLOWLIST = new Set(COVERED_REPOS);

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

// ───────────────────────────── shared helpers (mirrors needs-human-router.ts's own) ─────────────────────────────

function trustedComments(comments: IssueComment[]): IssueComment[] {
  return comments.filter((c) => isTrustedMarkerAuthor(c.login));
}

function findLast(comments: IssueComment[], marker: string): IssueComment | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i]?.body.includes(marker)) return comments[i];
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

/** Rule #398, resolved with real I/O — identical shape to needs-human-router.ts's own
 * resolveDisapproval, parameterized with the shared per-run checker (deliverable A)
 * instead of module-level state. Reactions on every TRUSTED-AUTHOR comment this OR the
 * same-repo router posted (the probe comment, a route receipt, a hold receipt —
 * whichever exist, since markers are shared, see needs-human-crossrepo-lib.ts's header),
 * narrowed to authorized 👎s only. */
function resolveDisapproval(repo: string, comments: IssueComment[], isAuthorizedReactor: (login: string) => boolean): boolean {
  const candidates = trustedComments(comments).filter(
    (c) => c.body.includes(PROBE_MARKER) || c.body.includes(ROUTE_RECEIPT_MARKER) || c.body.includes(HOLD_RECEIPT_MARKER),
  );
  const reactors: Reactor[] = [];
  for (const c of candidates) {
    for (const r of getCommentReactions(repo, c.id)) reactors.push({ content: r.content, login: r.login });
  }
  const downvoteLogins = new Set(reactors.filter((r) => r.content === "-1").map((r) => r.login));
  const authorized = new Set<string>();
  for (const login of downvoteLogins) {
    if (isAuthorizedReactor(login)) authorized.add(login);
  }
  return hasAuthorizedDisapproval(reactors, authorized);
}

// ───────────────────────────── twin existence search (idempotency) ─────────────────────────────

interface TwinRef {
  number: number;
  title: string;
  url: string;
}

/** Primary source: GitHub's search index. Best-effort — a bracket-and-hash-heavy title
 * prefix is atypical search-query text, and the search index itself can lag a just-filed
 * issue by a few minutes, so failures or empty results here are expected, not fatal; the
 * plain list-scan fallback below is what's actually authoritative. */
function twinCandidatesViaSearch(target: string, prefix: string): TwinCandidate[] {
  try {
    const out = gh(["search", "issues", "--repo", target, `${prefix} in:title`, "--json", "number,title,url", "--limit", "50"]);
    const parsed = JSON.parse(out) as TwinRef[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.log(`    [warn] gh search issues failed for ${target} — continuing with the plain list-scan fallback: ${describeError(err)}`);
    return [];
  }
}

/** Fallback: a plain, unfiltered issue-list title scan (open + closed — a twin can have
 * been closed already, e.g. via a prior recall) — Rule #260/#376: search-index lag
 * tolerance means this is the AUTHORITATIVE half, not a backup for cosmetics. `--limit
 * 1000` mirrors needs-human-router.ts's own convention for the same reason (#331). */
function twinCandidatesViaList(target: string): TwinCandidate[] {
  try {
    const out = gh(["issue", "list", "--repo", target, "--state", "all", "--limit", "1000", "--json", "number,title,url"]);
    const parsed = JSON.parse(out) as TwinRef[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.log(`    [warn] gh issue list fallback failed for ${target}: ${describeError(err)}`);
    return [];
  }
}

/** Either source finding the twin counts (deliverable C: "if either finds it, disposition
 * skip-twin-exists"). Only called for a target already confirmed on the allowlist — an
 * off-allowlist name may not even be a real repo, and hold-invalid-target never needs a
 * twin reference regardless. */
function findTwin(target: string, ownRepoShort: string, issueNumber: number): TwinRef | undefined {
  const prefix = twinTitlePrefix(ownRepoShort, issueNumber);
  const candidates: TwinCandidate[] = [...twinCandidatesViaSearch(target, prefix), ...twinCandidatesViaList(target)];
  return findTwinMatch(candidates as TwinRef[], ownRepoShort, issueNumber);
}

function fileTwinIssue(repo: string, title: string, body: string): TwinRef {
  const out = gh(["issue", "create", "--repo", repo, "--title", title, "--body", body]).trim();
  const match = out.match(/\/issues\/(\d+)\s*$/);
  if (!match?.[1]) throw new Error(`fileTwinIssue: couldn't parse an issue number from gh's own creation output: "${out}"`);
  return { number: Number(match[1]), title, url: out };
}

// ───────────────────────────── receipts ─────────────────────────────

const CULPRIT_HEADING = "## Culprit hypothesis";
const MARKDOWN_HEADING_RE = /^##\s/;

/** A one-paragraph quote of the probe's own headline hypothesis, for the twin's body —
 * deterministic string extraction between the fixed "## Culprit hypothesis" heading
 * (buildSystemPrompt's own §1, needs-human-probe-lib.ts) and the next "## " heading. */
function extractCulpritHypothesis(probeBody: string): string {
  const lines = probeBody.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === CULPRIT_HEADING);
  if (startIdx === -1) {
    return '_(no "## Culprit hypothesis" section found in the probe comment — see the origin issue for the full diagnosis)_';
  }
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => MARKDOWN_HEADING_RE.test(l.trim()));
  const section = (endIdx === -1 ? rest : rest.slice(0, endIdx)).join("\n").trim();
  return section.length > 0 ? section : '_(empty "## Culprit hypothesis" section)_';
}

function crossRepoTwinBody(originRepo: string, originNumber: number, headline: string): string {
  return [
    `_Auto-filed by the cross-repo sweep (ops-pipeline#88) from a \`needs-human\` diagnostic probe in [\`${shortRepoName(originRepo)}#${originNumber}\`](${issueUrl(originRepo, originNumber)})._`,
    "",
    "## Probe's culprit hypothesis (quoted from the origin issue)",
    "",
    headline,
    "",
    "---",
    "",
    `Origin: ${originRepo}#${originNumber}`,
  ].join("\n");
}

function crossRepoRouteReceipt(target: string, twinNumber: number, twinUrl: string): string {
  return [
    ROUTE_RECEIPT_MARKER,
    `🌐 **Cross-repo routed** — filed as [\`${shortRepoName(target)}#${twinNumber}\`](${twinUrl}) (ops-pipeline#88, the fleet-App cross-repo sweep).`,
    "",
    "React 👎 here to have the next sweep close this AND the linked twin as rejected, or just close either one.",
    "",
    "_(ops-pipeline#66/#88 — Kevin ruling 2026-08-14: route immediately, a 👎 is a brake, never a gate. The `needs-human` label has been removed.)_",
  ].join("\n");
}

function invalidTargetReceipt(target: string): string {
  return [
    HOLD_RECEIPT_MARKER,
    `⏸️ **Cross-repo filing held** — the probe routed this to \`${target}\`, which is not on the cross-repo sweep's known repo allowlist (could be a typo, or a repo this sweep doesn't cover yet).`,
    "",
    "No action was taken. The `needs-human` label stays. React 👎 here to close as rejected. _(ops-pipeline#88 cross-repo sweep)_",
  ].join("\n");
}

function crossRepoRejectReceipt(target: string | undefined, twin: TwinRef | undefined): string {
  const twinLine = twin && target ? ` The linked twin [\`${shortRepoName(target)}#${twin.number}\`](${twin.url}) was closed too.` : "";
  return `🚫 Closed as rejected — an authorized 👎 on the probe comment.${twinLine} Reopen if this was a mistake. _(ops-pipeline#88 cross-repo sweep)_`;
}

function twinRecallCloseComment(originRepo: string, originNumber: number): string {
  return `🚫 Closed — the origin issue [\`${shortRepoName(originRepo)}#${originNumber}\`](${issueUrl(originRepo, originNumber)}) was rejected by an authorized 👎. _(ops-pipeline#88 cross-repo sweep)_`;
}

// ───────────────────────────── metering (#331 — issue-creations only) ─────────────────────────────

let creationsApplied = 0;
let creationsCapped = 0;

/** Tri-state, mirroring needs-human-router.ts's own tryApply: the cap is enforced in
 * BOTH modes (a dry run shows exactly what a real run would defer, not an uncapped
 * preview), only the actual mutation is skipped when dryRun. */
function tryCreation(dryRun: boolean): "applied" | "would-apply" | "capped" {
  if (creationsApplied >= ISSUE_CREATION_CAP) {
    creationsCapped++;
    return "capped";
  }
  creationsApplied++;
  return dryRun ? "would-apply" : "applied";
}

// ───────────────────────────── per-issue processing ─────────────────────────────

interface IssueRow {
  number: number;
  title: string;
}

function applyDisposition(ctx: {
  ownRepo: string;
  ownRepoShort: string;
  issue: IssueRow;
  disposition: CrossRepoDisposition;
  probeComment: IssueComment | undefined;
  holdReceiptPresent: boolean;
  routeReceiptPresent: boolean;
  twin: TwinRef | undefined;
  dryRun: boolean;
}): void {
  const { ownRepo, ownRepoShort, issue, disposition, probeComment, holdReceiptPresent, routeReceiptPresent, twin, dryRun } = ctx;
  const head = `  [${ownRepoShort}] #${issue.number} "${truncate(issue.title, 70)}"`;

  switch (disposition.kind) {
    case "skip":
      console.log(`${head}  skip`);
      return;

    case "hold-invalid-target": {
      if (holdReceiptPresent) {
        console.log(`${head}  hold-invalid-target -> ${disposition.target} (receipt already posted — no action)`);
        return;
      }
      if (dryRun) {
        console.log(`${head}  SWEEP-HOLD -> would post hold-invalid-target receipt for ${disposition.target} [PREVIEW — would apply]`);
        return;
      }
      commentIssue(ownRepo, issue.number, invalidTargetReceipt(disposition.target));
      console.log(`${head}  SWEEP-HOLD -> hold-invalid-target receipt posted for ${disposition.target} [APPLIED]`);
      return;
    }

    case "skip-twin-exists": {
      if (!twin) {
        // Defensive: crossRepoDisposition only returns this kind when the caller passed
        // twinExists:true, which this script only ever does after a successful findTwin
        // — this branch should be structurally unreachable. A loud flag beats a silent
        // no-op if that invariant is ever violated (Rule #158).
        console.log(`${head}  ⚠️  skip-twin-exists -> ${disposition.target} but no twin reference was captured — investigate, no action taken`);
        return;
      }
      if (routeReceiptPresent) {
        console.log(`${head}  skip-twin-exists -> ${shortRepoName(disposition.target)}#${twin.number} (receipt + label already complete — no action)`);
        return;
      }
      // Recovery path (deliverable C's documented residual): a PRIOR run's step (a) —
      // file the twin — succeeded, but (b) [receipt] and/or (c) [label removal] didn't.
      // The twin-exists search already found that prior twin, so this run completes
      // (b)/(c) WITHOUT ever calling fileTwinIssue again — no duplicate twin gets filed.
      if (dryRun) {
        console.log(
          `${head}  SWEEP-ROUTE -> would complete receipt + label removal for existing twin ${shortRepoName(disposition.target)}#${twin.number} [PREVIEW — would apply]`,
        );
        return;
      }
      commentIssue(ownRepo, issue.number, crossRepoRouteReceipt(disposition.target, twin.number, twin.url));
      removeLabel(ownRepo, issue.number, LABEL);
      console.log(
        `${head}  SWEEP-ROUTE -> completed receipt + label removal for existing twin ${shortRepoName(disposition.target)}#${twin.number} [APPLIED]`,
      );
      return;
    }

    case "file-cross-repo": {
      const twinTitle = buildTwinTitle(ownRepoShort, issue.number, issue.title);
      const creationResult = tryCreation(dryRun);
      if (creationResult === "capped") {
        console.log(`${head}  file-cross-repo -> ${disposition.target} [CAPPED — deferred to next run, Rule #331]`);
        return;
      }
      if (creationResult === "would-apply") {
        console.log(`${head}  TWIN-FILE -> would create "${twinTitle}" in ${disposition.target} [PREVIEW — would apply]`);
        console.log(`${head}  SWEEP-ROUTE -> would post receipt on origin + remove '${LABEL}' label [PREVIEW — would apply]`);
        return;
      }
      const headline = probeComment ? extractCulpritHypothesis(probeComment.body) : "_(no probe comment body captured)_";
      // Step (a): file the twin, UNLABELED (rule 9 lane backlog — an unlabeled issue is
      // an ordinary backlog item the owning lane's re-entry folds already consume; a
      // needs-human twin would just re-create the exact same nobody-pool problem #66 was
      // filed to fix). If this throws, execution stops here: the origin issue is
      // untouched — still labeled, no marker — safely re-evaluated fresh next run.
      const twinCreated = fileTwinIssue(disposition.target, twinTitle, crossRepoTwinBody(ownRepo, issue.number, headline));
      console.log(`${head}  TWIN-FILE -> ${shortRepoName(disposition.target)}#${twinCreated.number} [APPLIED]`);
      // Steps (b) then (c) — receipt BEFORE label removal, mirroring
      // needs-human-router.ts's OWN route-same-repo ordering and its documented
      // reasoning: if (b) throws here, the origin is left labeled with NO marker — the
      // NEXT run's twin-exists search finds the twin fileTwinIssue just created and
      // routes to skip-twin-exists, which completes (b)/(c) without ever re-filing (a).
      // If (b) succeeds but (c) throws, the marker is posted and the label lingers — the
      // SAME accepted residual needs-human-router.ts's own route-same-repo case accepts
      // (a lingering label re-evaluates to a safe no-op every run rather than risking a
      // self-heal silently overriding a deliberate human re-escalation).
      commentIssue(ownRepo, issue.number, crossRepoRouteReceipt(disposition.target, twinCreated.number, twinCreated.url));
      removeLabel(ownRepo, issue.number, LABEL);
      console.log(`${head}  SWEEP-ROUTE -> receipt posted + '${LABEL}' label removed [APPLIED]`);
      return;
    }

    case "close-rejected": {
      const describe = twin
        ? `close-rejected (authorized 👎) + closing twin ${shortRepoName(disposition.target)}#${twin.number}`
        : "close-rejected (authorized 👎, pre-routing)";
      if (dryRun) {
        console.log(`${head}  SWEEP-REJECT -> would ${describe} [PREVIEW — would apply]`);
        return;
      }
      closeIssue(ownRepo, issue.number, crossRepoRejectReceipt(disposition.target, twin));
      if (twin) closeIssue(disposition.target, twin.number, twinRecallCloseComment(ownRepo, issue.number));
      console.log(`${head}  SWEEP-REJECT -> ${describe} [APPLIED]`);
      return;
    }
  }
}

function processIssue(
  ownRepo: string,
  ownRepoShort: string,
  issue: IssueRow,
  dryRun: boolean,
  isAuthorizedReactor: (login: string) => boolean,
): CrossRepoDisposition {
  const comments = listIssueComments(ownRepo, issue.number);
  const trusted = trustedComments(comments);
  const probeComment = findLast(trusted, PROBE_MARKER);
  const routeReceiptPresent = hasRouteReceipt(trusted.map((c) => c.body));
  const holdReceiptPresent = hasHoldReceipt(trusted.map((c) => c.body));
  const disapproval = resolveDisapproval(ownRepo, comments, isAuthorizedReactor);

  // Only worth the I/O of a twin search when this issue is even a CANDIDATE cross-repo
  // route (clean trailer, needsKevin false, a real cross-repo target, on the allowlist,
  // and not already fully routed) — crossRepoDisposition below re-derives the same
  // trailer facts from probeCommentBody, so this pre-check exists purely to avoid an
  // unnecessary search/list call for the common case (no probe, same-repo, held, etc.),
  // never to decide anything the pure function doesn't ALSO decide from scratch.
  let twin: TwinRef | undefined;
  if (!routeReceiptPresent && probeComment) {
    const parsed = parseProbeRouting(probeComment.body);
    if (parsed && !parsed.needsKevin && parsed.routing === "cross-repo" && parsed.target !== ownRepo && ALLOWLIST.has(parsed.target)) {
      twin = findTwin(parsed.target, ownRepoShort, issue.number);
    }
  }

  const disposition = crossRepoDisposition({
    isOpen: true,
    hasRouteReceiptMarker: routeReceiptPresent,
    probeCommentBody: probeComment ? probeComment.body : null,
    hasAuthorizedDisapproval: disapproval,
    ownRepo,
    allowlist: ALLOWLIST,
    twinExists: twin !== undefined,
  });

  applyDisposition({ ownRepo, ownRepoShort, issue, disposition, probeComment, holdReceiptPresent, routeReceiptPresent, twin, dryRun });
  return disposition;
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  console.log(`=== needs-human-crossrepo sweep${dryRun ? " --dry-run (real reads, zero mutations)" : ""} ===`);
  console.log(`Covered repos: ${COVERED_REPOS.join(", ")}`);

  const isAuthorizedReactor = createAuthorizedReactorChecker();
  const allDispositions: CrossRepoDisposition[] = [];

  for (const repo of COVERED_REPOS) {
    const ownRepoShort = shortRepoName(repo);
    const issues = listIssuesByLabel(repo, LABEL, "open").sort((a, b) => a.number - b.number);
    console.log("");
    console.log(`[crossrepo] ${repo}: ${issues.length} open '${LABEL}' issue(s).`);
    for (const issue of issues) {
      const disposition = processIssue(repo, ownRepoShort, issue, dryRun, isAuthorizedReactor);
      allDispositions.push(disposition);
    }
  }

  const summary = summarizeCrossRepoDispositions(allDispositions);
  console.log("");
  console.log("Summary — all covered repos:");
  for (const [kind, count] of Object.entries(summary)) {
    console.log(`  ${kind.padEnd(20)} ${count}`);
  }
  console.log(`  issue creations: ${creationsApplied}${dryRun ? " (previewed, not applied)" : " applied"}, cap=${ISSUE_CREATION_CAP}`);
  if (creationsCapped > 0) {
    console.log(`  ⚠️  CAPPED — ${creationsCapped} cross-repo filing(s) deferred to the next run (Rule #331).`);
  }
}

main().catch((err) => {
  console.error(`[crossrepo] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
