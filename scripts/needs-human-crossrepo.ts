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
 * Two passes per repo (added in codex review pass 1, folding two P1 findings — see the
 * fixed-issues list below): a MAIN pass over open `needs-human`-labeled issues
 * (processIssue), then a RECALL pass (runRecallPass) mirroring needs-human-router.ts's
 * own two-pass shape — reaction-search-based, not label-based, since a completed route
 * removes the label. The recall pass is what makes "react 👎 to close this AND the
 * linked twin" true even after the origin's label (and this sweep's OWN label-based
 * enumeration of it) is long gone: this sweep embeds a machine-readable twin pointer in
 * its own route receipt (needs-human-crossrepo-lib.ts's buildTwinPointer) specifically so
 * the recall pass can find and close the twin with no re-search needed.
 *
 * Codex review pass 1 (2026-08-14) folded, both P1s and both P2s: (1) the fleet App bot's
 * comments weren't a trusted marker author, so neither sweep recognized this sweep's own
 * receipts — fixed by widening needs-human-router-lib.ts's isTrustedMarkerAuthor; (2) a
 * 👎 after a completed route couldn't reach the twin — fixed by the recall pass above;
 * (3) a failed twin-existence list-scan silently read as "no twin," risking a duplicate
 * creation — fixed by findTwin's three-state result (found/not-found/check-failed),
 * never falling through to file-cross-repo on "check-failed"; (4) close-rejected closed
 * the origin before the twin, stranding the twin open on a mid-failure — reordered to
 * twin-then-origin everywhere this sweep closes both.
 *
 * Codex review pass 2 folded one more P1, born directly from fix (1) above: widening
 * trust also means the SAME-REPO router's OWN recall pass now recognizes this sweep's
 * route receipts and can close the ORIGIN on a 👎 all by itself — racing this sweep's
 * recall pass to it. If that router wins, an open-state-scoped search here would never
 * find the (now-closed) origin again, stranding the twin exactly as before, just via a
 * new path. Fixed by making searchCrossRepoRoutedOrigins state-agnostic (content-search
 * keyed on this sweep's own twin-pointer marker text, not open-state-plus-reactions) and
 * every recall-pass close a `safeCloseIssue` (idempotent-on-already-closed) — see both
 * functions' doc comments below for the full reasoning.
 *
 * Metering (#331): unlike the same-repo router's ACTION_CAP over ALL mutations, this
 * script caps only ISSUE-CREATIONS (filing a NEW twin in a repo other than the one this
 * process is even running against is the one genuinely expensive, higher-blast-radius
 * action here) at ISSUE_CREATION_CAP per run — loud when capped. Receipt-posting,
 * label-removal, and closes (main pass or recall pass) are NOT capped; they only ever
 * fire alongside (or to complete) a creation that already happened, or as a lightweight
 * hold/reject receipt.
 *
 * `--dry-run`: identical reads throughout — including the twin-existence search, the
 * recall pass's reaction search, and the org-membership fallback (Rule #376: a dry run
 * that reads nothing proves nothing) — zero mutations, one preview line per planned
 * action, labeled distinctly: `TWIN-FILE` (would create the twin issue), `SWEEP-ROUTE`
 * (would post the receipt + remove the label, either right after a fresh TWIN-FILE or
 * completing a prior partial run's dangling twin), `SWEEP-REJECT` (would close-reject,
 * and the twin too if one exists — main pass or recall pass), `SWEEP-HOLD` (would post
 * the off-allowlist hold receipt).
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
  buildTwinPointer,
  buildTwinTitle,
  crossRepoDisposition,
  crossRepoRecallDisposition,
  extractTwinPointer,
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
 * 1000` mirrors needs-human-router.ts's own convention for the same reason (#331). Unlike
 * the search fallback above, THIS source's failure is load-bearing — see
 * `TwinLookupResult`'s "check-failed" kind below: since this is the authoritative check,
 * a failure here must never be silently read as "no twin", which risks a duplicate
 * creation (codex review pass 1 P2 — "Fail closed when the list-scan twin check fails"). */
function twinCandidatesViaList(target: string): { candidates: TwinCandidate[]; failed: boolean } {
  try {
    const out = gh(["issue", "list", "--repo", target, "--state", "all", "--limit", "1000", "--json", "number,title,url"]);
    const parsed = JSON.parse(out) as TwinRef[];
    return { candidates: Array.isArray(parsed) ? parsed : [], failed: false };
  } catch (err) {
    console.log(
      `    [warn] gh issue list fallback failed for ${target}: ${describeError(err)} — treating the twin-existence check as INCONCLUSIVE, not "no twin"`,
    );
    return { candidates: [], failed: true };
  }
}

/**
 * Three states, not a boolean/undefined (codex review pass 1 P2): "found" and
 * "not-found" are both CONFIDENT answers a caller may act on; "check-failed" means the
 * authoritative list-scan itself errored, so the caller has NO reliable signal either way
 * and must never proceed to file-cross-repo on it (a false "not-found" there creates a
 * duplicate twin in a foreign repo — the one mistake this whole idempotency mechanism
 * exists to prevent). Either the search index OR the list-scan finding a match counts as
 * "found" regardless of the OTHER source's health (deliverable C: "if either finds it,
 * disposition skip-twin-exists") — "check-failed" only applies when NEITHER found a match
 * AND the authoritative source specifically is the reason why. `kind` (not `status`) to
 * match this codebase's own discriminated-union convention (CrossRepoDisposition et al).
 */
type TwinLookupResult = { kind: "found"; twin: TwinRef } | { kind: "not-found" } | { kind: "check-failed" };

/** Only called for a target already confirmed on the allowlist — an off-allowlist name
 * may not even be a real repo, and hold-invalid-target never needs a twin reference
 * regardless. */
function findTwin(target: string, ownRepoShort: string, issueNumber: number): TwinLookupResult {
  const prefix = twinTitlePrefix(ownRepoShort, issueNumber);
  const searchCandidates = twinCandidatesViaSearch(target, prefix);
  const listResult = twinCandidatesViaList(target);
  const allCandidates: TwinCandidate[] = [...searchCandidates, ...listResult.candidates];
  const match = findTwinMatch(allCandidates as TwinRef[], ownRepoShort, issueNumber);
  if (match) return { kind: "found", twin: match };
  if (listResult.failed) return { kind: "check-failed" };
  return { kind: "not-found" };
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
    // The machine-readable twin pointer (codex review pass 1 P1 — "Handle rejected
    // already-routed twins") — see needs-human-crossrepo-lib.ts's buildTwinPointer doc
    // comment. This is what makes the promise on the next line actually true: once the
    // `needs-human` label is gone, this pointer is the ONLY way the recall pass (below)
    // can find the twin again to make good on "closes this AND the linked twin".
    buildTwinPointer(target, twinNumber),
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

// Accepts the MINIMAL shape it actually reads (number + url), not the full TwinRef — the
// recall pass (below) only has a twin POINTER (repo#number, reconstructible URL), never a
// full search result with a title, and constructing a fake title just to satisfy a wider
// type would be worse than the type accurately reflecting what this function needs.
function crossRepoRejectReceipt(target: string | undefined, twin: { number: number; url: string } | undefined): string {
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
      // Twin FIRST, origin SECOND (codex review pass 1 P2 — "Close the twin before the
      // origin"): closing the origin first and then failing to close the twin leaves the
      // origin permanently closed with a receipt claiming the twin was ALSO closed (a
      // false Rule #412 claim) while the twin is stranded open with nothing left to
      // re-evaluate it (a closed origin drops out of every open-issue search this sweep
      // runs). Closing the twin first means a failure on the origin half leaves the
      // origin OPEN and re-evaluable next run — safely retryable, and closing an
      // already-closed twin on that retry is an idempotent no-op.
      if (twin) closeIssue(disposition.target, twin.number, twinRecallCloseComment(ownRepo, issue.number));
      closeIssue(ownRepo, issue.number, crossRepoRejectReceipt(disposition.target, twin));
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
      const lookup = findTwin(parsed.target, ownRepoShort, issue.number);
      if (lookup.kind === "found") {
        twin = lookup.twin;
      } else if (lookup.kind === "check-failed") {
        // codex review pass 1 P2: the AUTHORITATIVE twin-existence check couldn't
        // complete — never fall through to file-cross-repo on an unresolved signal (a
        // false "not-found" here creates a duplicate twin in a foreign repo). Skip this
        // issue entirely for this run; the next run re-attempts the full check fresh.
        const head = `  [${ownRepoShort}] #${issue.number} "${truncate(issue.title, 70)}"`;
        console.log(`${head}  ⚠️  SKIPPED — twin-existence check for ${parsed.target} was inconclusive this run; retrying next run rather than risk a duplicate`);
        return { kind: "skip" };
      }
      // "not-found": twin stays undefined, proceeds to crossRepoDisposition normally.
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

// ───────────────────────────── recall pass (codex review pass 1 P1 — post-routing 👎) ─────────────────────────────

/**
 * Candidate discovery for the recall pass: every issue (OPEN **or CLOSED**) in `repo`
 * whose comments mention this sweep's own twin-pointer marker text — i.e., every origin
 * THIS sweep has EVER cross-repo-routed. `in:comments` is a real, documented GitHub
 * search qualifier (used elsewhere in this file too, via `in:title`, for the twin-
 * existence search).
 *
 * Deliberately state-agnostic (codex review pass 2 P1 — "Prevent same-repo recall from
 * consuming cross-repo receipts"): pass 1's fix widened isTrustedMarkerAuthor so the
 * SAME-REPO router's OWN recall pass now also recognizes this sweep's route receipts and
 * can close the ORIGIN on an authorized 👎 — which is exactly what makes that router's
 * recall pass finally able to help at all, but it has no idea a twin exists and can race
 * THIS sweep to the origin's close. If it wins that race, an `open`-scoped search here
 * would never find the (now-closed) origin again, stranding the twin forever — the same
 * failure this whole recall pass exists to prevent, just via a new path. Searching by
 * content instead of by open-state-plus-reactions structurally closes that race: no
 * matter WHICH mechanism closed the origin first, this sweep still finds it via its own
 * marker text and still gets a chance to close the twin. `--limit 1000` for the same
 * #331 reason as every other search/list call in this sweep.
 *
 * Best-effort only, unlike `findTwin`'s authoritative list-scan (Rule #376's
 * authoritative-fallback discipline does NOT apply here the same way): a missed
 * candidate this run just means the twin stays open a little longer, caught on a LATER
 * run once the search index catches up (an hour of slack before the next run, ample for
 * typical index lag) — never a duplicate-creation risk, so no plain-list fallback is
 * needed the way findTwin's file-cross-repo idempotency check requires one. False
 * POSITIVES are equally harmless: every candidate is still re-verified per-issue against
 * a REAL trusted marker + twin pointer below (`if (!pointer) continue`) before anything
 * is acted on, so an over-broad search here costs at most a few wasted API calls, never a
 * wrong action.
 *
 * TWO live-verified `gh` CLI quirks fixed here (this chip's own dry-run smoke test caught
 * BOTH — neither codex nor the unit suite would have; Rule #4/#234: tests passing is not
 * verification):
 *   1. NO `--state` flag. `gh search issues --state` accepts ONLY `open` or `closed` —
 *      `all` is rejected outright (`invalid argument "all" for "--state" flag`), unlike
 *      `gh issue list --state`'s `open|closed|all` (used correctly elsewhere in this
 *      file, e.g. twinCandidatesViaList). A first version passed `--state all` and it
 *      silently no-op'd EVERY run. Confirmed live: OMITTING `--state` entirely returns
 *      BOTH open and closed issues in one call (`gh search issues --repo
 *      studio-b-ai/ops-pipeline "needs-human" --json number,title,state` returned
 *      `states seen: {'closed', 'open'}`) — exactly the state-agnostic behavior needed.
 *   2. NO colon in the search term, and NO surrounding quotes. A quoted phrase containing
 *      `:` (`"needs-human-crossrepo:twin"`) — even though `:` is legal inside `in:title`
 *      elsewhere in this file — made `gh`'s own query-serialization mangle the argument
 *      into invalid syntax (`Invalid search query "( \"needs-human-crossrepo:\"twin...`,
 *      confirmed via a direct probe: the SAME quoted-colon string failed identically
 *      against a KNOWN-good repo/term). The unquoted, colon-free term
 *      `needs-human-crossrepo` (this sweep's unique marker prefix, no trailing `:twin`)
 *      works cleanly and was confirmed live to actually match real marker text (probed
 *      against `needs-human-router` — the same-repo router's own unique prefix — which
 *      correctly matched real routed-receipt comments in bolt-wms, including the known
 *      plant-test issues #1656/#1657).
 */
function searchCrossRepoRoutedOrigins(repo: string): IssueRow[] {
  try {
    const out = gh(["search", "issues", "--repo", repo, "needs-human-crossrepo", "in:comments", "--json", "number,title", "--limit", "1000"]);
    const parsed = JSON.parse(out) as IssueRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.log(`  [warn] recall-pass search failed for ${repo}: ${describeError(err)} — will retry next run`);
    return [];
  }
}

/** Wraps closeIssue so a close attempt on an issue some OTHER mechanism (the same-repo
 * router's recall pass, or a prior run of this same recall pass) already closed is a
 * logged no-op rather than a thrown error that would abort the whole run. This is new
 * territory for this codebase specifically: every OTHER recall-style close elsewhere here
 * pre-filters to `--state open` first (needs-human-router.ts's own recall pass included),
 * so it never attempts to close something already closed — this recall pass deliberately
 * searches state-agnostically (see searchCrossRepoRoutedOrigins above) specifically to
 * catch a race where the target MAY already be closed, so closeIssue's actual behavior on
 * an already-closed issue is no longer just theoretical here. */
function safeCloseIssue(repo: string, number: number, comment: string): void {
  try {
    closeIssue(repo, number, comment);
  } catch (err) {
    console.log(`    [warn] closeIssue(${repo}#${number}) failed — likely already closed by another mechanism (harmless, treated as done): ${describeError(err)}`);
  }
}

/**
 * Closes the gap codex review pass 1 P1 found ("Handle rejected already-routed twins"):
 * a fully-completed cross-repo route removes the origin's `needs-human` label, so the
 * MAIN pass (label-based enumeration) can never see that issue again — a 👎 arriving
 * after routing needs its own pass to be found at all, mirroring needs-human-router.ts's
 * own two-pass architecture in SHAPE (main pass + recall pass) though not in the recall
 * candidate-discovery mechanism (see searchCrossRepoRoutedOrigins's doc comment for why
 * this one must be state-agnostic, unlike that router's own open-only search).
 *
 * Every candidate is checked for a TRUSTED ROUTE_RECEIPT_MARKER comment carrying a twin
 * pointer (extractTwinPointer) — that pointer is BOTH the disambiguator (a same-repo-
 * routed issue shares the marker but never has a pointer, so it's correctly ignored here
 * — that's the same-repo router's own recall pass's job) AND the twin's identity, with no
 * re-search needed. `resolveDisapproval` reads comment REACTIONS, which persist
 * regardless of the issue's current open/closed state, so disapproval is resolved
 * identically whether or not something already closed the origin. On an authorized 👎,
 * closes the TWIN FIRST, then the ORIGIN (same failure-recovery ordering as the main
 * pass's own close-rejected case, codex review pass 1 P2) — both via `safeCloseIssue`,
 * since either side may already be closed by the time this pass gets to it.
 */
function runRecallPass(repo: string, dryRun: boolean, isAuthorizedReactor: (login: string) => boolean): CrossRepoDisposition[] {
  const candidates = searchCrossRepoRoutedOrigins(repo).sort((a, b) => a.number - b.number);
  const dispositions: CrossRepoDisposition[] = [];
  console.log(`[crossrepo] ${repo}: ${candidates.length} issue(s) ever cross-repo-routed by this sweep — recall pass.`);

  for (const issue of candidates) {
    const comments = listIssueComments(repo, issue.number);
    const trusted = trustedComments(comments);
    const routeComment = findLast(trusted, ROUTE_RECEIPT_MARKER);
    const pointer = routeComment ? extractTwinPointer(routeComment.body) : null;
    if (!pointer) continue; // search false-positive (marker text quoted/discussed elsewhere) or a same-repo-router receipt — not this sweep's to act on

    const disapproval = resolveDisapproval(repo, comments, isAuthorizedReactor);
    const recallResult = crossRepoRecallDisposition({ hasCrossRepoRouteReceipt: true, hasAuthorizedDisapproval: disapproval });
    if (recallResult.kind === "none") {
      dispositions.push({ kind: "skip" });
      continue;
    }

    const head = `  [recall:${shortRepoName(repo)}] #${issue.number} "${truncate(issue.title, 70)}"`;
    if (dryRun) {
      console.log(`${head}  SWEEP-REJECT (recall) -> would close origin + twin ${shortRepoName(pointer.target)}#${pointer.number} (either may already be closed) [PREVIEW — would apply]`);
      dispositions.push({ kind: "close-rejected", target: pointer.target, twinExists: true });
      continue;
    }
    safeCloseIssue(pointer.target, pointer.number, twinRecallCloseComment(repo, issue.number));
    safeCloseIssue(repo, issue.number, crossRepoRejectReceipt(pointer.target, { number: pointer.number, url: issueUrl(pointer.target, pointer.number) }));
    console.log(`${head}  SWEEP-REJECT (recall) -> closed origin + twin ${shortRepoName(pointer.target)}#${pointer.number} (or already closed) [APPLIED]`);
    dispositions.push({ kind: "close-rejected", target: pointer.target, twinExists: true });
  }

  return dispositions;
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
    allDispositions.push(...runRecallPass(repo, dryRun, isAuthorizedReactor));
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
