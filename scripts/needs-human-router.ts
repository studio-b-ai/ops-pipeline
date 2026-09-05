#!/usr/bin/env tsx
/**
 * needs-human-router.ts — ops-pipeline#66 chip A (design comment: CTO seat, 2026-08-14
 * ~03:45Z, issue #66 comment 5289224655 — read that FIRST for the full rationale).
 *
 * Kevin's ruling: "auto-route immediately." A 👎 from an authorized human is a BRAKE, never
 * a gate — this script routes on the probe's own machine trailer (needs-human-probe-lib.ts's
 * `parseProbeRouting`) without waiting for approval, and only reacts to an explicit rejection.
 *
 * Architecture: the house pattern (mirrors needs-human-probe.yml / squasher-automerge.yml). This
 * is the reusable HALF — a thin per-repo cron caller (`needs-human-router.yml`) `uses:` the
 * reusable workflow, which checks out ops-pipeline for scripts and runs THIS file against the
 * caller's OWN repo with the caller's OWN ambient GITHUB_TOKEN. No centralized cross-repo write
 * credential exists (verified in the design comment — no fleet GitHub App is wired), so cross-
 * repo routing HOLDS in v1 rather than acting (Rule #184: no cross-repo writes).
 *
 * Two passes per run, both against `--repo`'s own issues only:
 *   1. MAIN pass — every OPEN `needs-human`-labeled issue. Decision: needs-human-router-lib.ts's
 *      `routeDisposition`.
 *   2. RECALL pass — issues found via `gh search issues --reactions ">0"` (NOT label-scoped): a
 *      same-repo route REMOVES the `needs-human` label, so a late 👎 on an already-routed issue
 *      is invisible to pass 1 by construction. Decision: `recallDisposition`.
 *
 * Metering (#331): at most ACTION_CAP mutating actions per run, TOTAL across both passes (main
 * first, in issue-number order, then recall) — loud log line when the cap defers work to the
 * next hourly run. `--dry-run`: identical reads (real `gh` calls throughout — Rule #376, a dry
 * run that reads nothing proves nothing), zero mutations, one preview line per issue.
 *
 * Usage: tsx needs-human-router.ts --repo <owner/repo> [--dry-run]
 */

import {
  addLabel,
  closeIssue,
  commentIssue,
  ensureLabel,
  getCommentReactions,
  listIssueComments,
  listIssuesByLabel,
  removeLabel,
  gh,
  type IssueComment,
} from "./lib/github-issues.js";
import { railHold, type HoldRail } from "./lib/hold-rail.js";
import { createAuthorizedReactorChecker } from "./lib/needs-human-authorization.js";
import { PROBE_MARKER } from "./lib/needs-human-probe-lib.js";
import {
  HOLD_RECEIPT_MARKER,
  ROUTE_RECEIPT_MARKER,
  hasAnyRouterReceipt,
  hasAuthorizedDisapproval,
  hasHoldReceipt,
  hasRouteReceipt,
  isTrustedMarkerAuthor,
  recallDisposition,
  routeDisposition,
  summarizeDispositions,
  type Reactor,
  type RouterDisposition,
} from "./lib/needs-human-router-lib.js";

const LABEL = "needs-human";
const ORG = "studio-b-ai";
const ACTION_CAP = 10;

// ops-pipeline#317 (Kevin ruling 2026-09-05 "default to WORK"): a routed issue whose probe
// trailer didn't parse still ROUTES, but this label goes on so the format bug stays visible in
// the lane backlog (rather than being silently swallowed by a same-repo default). ensureLabel is
// called before each add so a caller repo that doesn't yet have the label gets one — idempotent
// via `--force`, mirroring every other alert-issue monitor's own bootstrap pattern.
const PROBE_TRAILER_UNPARSED_LABEL = "probe-trailer-unparsed";
const PROBE_TRAILER_UNPARSED_DESCRIPTION = "ops#317: probe machine trailer unparseable; routed anyway";
const PROBE_TRAILER_UNPARSED_COLOR = "FBCA04";

// ops-pipeline#317 / #320 (Kevin ruling 2026-09-05 "default to WORK"): on every hold, the
// router adds this label so `/yard` can sweep by label AND rails the Dispatcher (+ any
// `lane:<seat>` seats) via the seat-inbox door — a hold with no board line is a defect.
// `--force` on `gh label create` means the same-hour ensure is idempotent (re-runs are
// no-ops), so the first firing on a caller repo without the label bootstraps it (#464:
// a first firing is part of the ship, not its follow-up).
const KEVIN_DECISION_LABEL = "kevin-decision";
const KEVIN_DECISION_DESCRIPTION = "ops#317/#320: /yard sweeps by this label — needs a Kevin decision";
const KEVIN_DECISION_COLOR = "D93F0B";

function ensureKevinDecisionLabel(repo: string): void {
  gh([
    "label", "create", KEVIN_DECISION_LABEL, "--repo", repo, "--force",
    "--description", KEVIN_DECISION_DESCRIPTION, "--color", KEVIN_DECISION_COLOR,
  ]);
}

function addKevinDecisionLabel(repo: string, num: number): void {
  // `gh issue edit --add-label` is idempotent (a repeat is a no-op, not an error), so
  // callers never need to pre-check membership.
  gh(["issue", "edit", String(num), "--repo", repo, "--add-label", KEVIN_DECISION_LABEL]);
}
// v1 covered repos = the cross-repo allowlist too (design comment: "Cross-repo allowlist = the
// same set" as the repos where needs-human issues exist today). Static per v1 — no fleet
// discovery, matching the design's explicit static-list scope.
const ALLOWLIST = new Set(
  ["bolt-wms", "studiob", "studiob-price-sync", "webhook-router", "asthetik-trade-theme"].map((r) => `${ORG}/${r}`),
);

function parseArgs(argv: string[]): { repo: string; dryRun: boolean } {
  let repo: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!repo) throw new Error("--repo <owner/repo> is required");
  return { repo, dryRun };
}

// ───────────────────────────── reactor authorization (per run) ─────────────────────────────

// Extracted to lib/needs-human-authorization.ts (ops-pipeline#88, chip A deliverable) so
// this router AND the new cross-repo sweep (needs-human-crossrepo.ts) share ONE
// AUTHORIZED_REACTORS allowlist + org-membership-fallback definition instead of two
// copies that could drift apart. Behavior is byte-identical to the PR #91 original (see
// that module's doc comment for the full plant-ladder provenance, preserved verbatim
// there) — only the location moved; this script still gets its own per-run cache via its
// own createAuthorizedReactorChecker() call, exactly as before.
const isAuthorizedReactor = createAuthorizedReactorChecker();

// ───────────────────────────── receipts ─────────────────────────────

function routeReceipt(probeTrailerUnparsed = false): string {
  const lines = [
    ROUTE_RECEIPT_MARKER,
    "🧭 **Auto-routed to this repo's lane backlog** — the probe comment above is the pre-brief.",
    "",
    "React 👎 here to have the next sweep close this as rejected, or just close it.",
    "",
    "_(ops-pipeline#66 — Kevin ruling 2026-08-14: route immediately, a 👎 is a brake, never a gate. The `needs-human` label has been removed.)_",
  ];
  if (probeTrailerUnparsed) {
    lines.push(
      "",
      "⚠️ The probe's machine trailer didn't parse cleanly — routed anyway (Kevin ruling 2026-09-05, ops#317: default to WORK; a hold requires a parsed `NEEDS-KEVIN: yes`). The `probe-trailer-unparsed` label was added so the format bug stays visible.",
    );
  }
  return lines.join("\n");
}

function closeRejectedReceipt(): string {
  return "🚫 Closed as rejected — an authorized 👎 on the probe comment, before this issue was routed. Reopen if this was a mistake. _(ops-pipeline#66 router)_";
}

function recallCloseRejectedReceipt(): string {
  return "🚫 Closed as rejected — an authorized 👎 arrived after this issue was already auto-routed (found via the recall sweep, since routing removes the `needs-human` label). Reopen if this was a mistake. _(ops-pipeline#66 router, recall pass)_";
}

// hold-needs-kevin fires for two distinct reasons (codex review pass 2 P2, 2026-08-14: a
// malformed trailer attempt is held rather than defaulted to same-repo — see
// needs-human-router-lib.ts's routeDisposition) — this text is deliberately hedged so it never
// overclaims which one actually happened (Rule #412: a receipt's prose is a claim to keep honest).
function holdNeedsKevinReceipt(): string {
  return [
    HOLD_RECEIPT_MARKER,
    "⏸️ **Held for Kevin decision** — either the probe's trailer explicitly flagged `NEEDS-KEVIN: yes` (locked semantics, pricing, credentials, customer-facing behavior, or a Kevin-gated rule), or its machine trailer didn't parse cleanly (in which case auto-routing would mean trusting a broken signal). Either way, this needs a human look.",
    "",
    "The `needs-human` label stays; this will NOT auto-route. React 👎 here to close as rejected. _(ops-pipeline#66 router)_",
  ].join("\n");
}

function holdCrossRepoReceipt(target: string, targetAllowed: boolean): string {
  const flag = targetAllowed
    ? ""
    : `\n\n⚠️ \`${target}\` is not on this router's known repo allowlist — flagging for review (could be a typo or an unrecognized repo).`;
  return [
    HOLD_RECEIPT_MARKER,
    `⏸️ **Cross-repo filing held** — the probe routed this to \`${target}\`, but v1 has no fleet write token for cross-repo issue creation (needs a GitHub App with \`issues:write\` org-wide, Kevin-gated org settings).`,
    "",
    `No action was taken against \`${target}\`. The \`needs-human\` label stays. React 👎 here to close as rejected. _(ops-pipeline#66 router)_${flag}`,
  ].join("\n");
}

// ───────────────────────────── shared helpers ─────────────────────────────

/**
 * Narrows to comments authored by the trusted bot identity ONLY (codex review pass 1 P1,
 * 2026-08-14) — every marker-matching call site in this file (finding the probe comment,
 * checking for an existing route/hold receipt, finding reaction-bearing candidates) MUST go
 * through this filter first. Without it, `.includes(marker)` over every comment body regardless
 * of author lets anyone with issue-comment access forge a fake probe trailer or a fake receipt
 * marker — see isTrustedMarkerAuthor's doc comment for the full exploit shape.
 */
function trustedComments(comments: IssueComment[]): IssueComment[] {
  return comments.filter((c) => isTrustedMarkerAuthor(c.login));
}

function findLast(comments: IssueComment[], marker: string): IssueComment | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i]?.body.includes(marker)) return comments[i];
  }
  return undefined;
}

/**
 * Rule #398, resolved with real I/O: reactions on every TRUSTED-AUTHOR comment the router or
 * probe posted on this issue (the probe comment, a route receipt, a hold receipt — whichever
 * exist), narrowed to org-member 👎s only. Only the DOWNVOTING logins are membership-checked
 * (not every reactor) to keep the API-call count proportional to actual brake attempts, not
 * thread popularity.
 */
function resolveDisapproval(repo: string, comments: IssueComment[]): boolean {
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

// ───────────────────────────── metering ─────────────────────────────

let mutationsApplied = 0;
let cappedCount = 0;

/** Applies (or, in dry-run, would apply) ONE mutating action against the shared #331 budget.
 * Returns what happened so the caller can log accurately. */
function tryApply(apply: () => void, dryRun: boolean): "applied" | "would-apply" | "capped" {
  if (mutationsApplied >= ACTION_CAP) {
    cappedCount++;
    return "capped";
  }
  mutationsApplied++;
  if (!dryRun) apply();
  return dryRun ? "would-apply" : "applied";
}

// ───────────────────────────── main pass ─────────────────────────────

interface IssueRow {
  number: number;
  title: string;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

async function runMainPass(repo: string, dryRun: boolean, actionedThisRun: Set<number>): Promise<RouterDisposition[]> {
  // ops-pipeline#320: `includeLabels: true` so the hold-rail leg can enumerate every
  // `lane:<seat>` label on a held issue and rail that seat too (in addition to Dispatcher).
  // Existing consumers of `IssueRef` are unaffected — the `labels` field is optional.
  const issues = listIssuesByLabel(repo, LABEL, "open", 1000, { includeLabels: true });
  const dispositions: RouterDisposition[] = [];

  console.log(`[router] ${repo}: ${issues.length} open '${LABEL}' issue(s) — main pass.`);

  for (const issue of issues.sort((a, b) => a.number - b.number)) {
    const comments = listIssueComments(repo, issue.number);
    const trusted = trustedComments(comments);
    const probeComment = findLast(trusted, PROBE_MARKER);
    const routeReceiptPresent = hasRouteReceipt(trusted.map((c) => c.body));
    const holdReceiptPresent = hasHoldReceipt(trusted.map((c) => c.body));
    const disapproval = resolveDisapproval(repo, comments);

    const disposition = routeDisposition({
      isOpen: true,
      hasRouteReceiptMarker: routeReceiptPresent,
      probeCommentBody: probeComment ? probeComment.body : null,
      hasAuthorizedDisapproval: disapproval,
      allowlist: ALLOWLIST,
      ownRepo: repo,
    });
    dispositions.push(disposition);

    const row: IssueRow = { number: issue.number, title: truncate(issue.title, 70) };
    const labelNames = (issue.labels ?? []).map((l) => l.name);
    await logMainOutcome(row, disposition, holdReceiptPresent, dryRun, actionedThisRun, repo, labelNames);
  }

  return dispositions;
}

async function logMainOutcome(
  issue: IssueRow,
  disposition: RouterDisposition,
  holdReceiptPresent: boolean,
  dryRun: boolean,
  actionedThisRun: Set<number>,
  repo: string,
  labels: readonly string[],
): Promise<void> {
  const head = `  #${issue.number} "${issue.title}"`;

  switch (disposition.kind) {
    case "skip-already-routed":
      // No mutation here — deliberately (codex review pass 3 P2, 2026-08-14, reverting pass
      // 2's self-heal attempt). A prior version retried removeLabel on the theory that "still
      // labeled + already carries ROUTE_RECEIPT_MARKER" could ONLY mean a partial failure
      // (comment posted, label removal didn't take). That reasoning missed a real case: a
      // human (or another workflow) can INTENTIONALLY re-add `needs-human` to an
      // already-routed issue — the receipt+label combination is NOT exclusive to a partial
      // failure — and the self-heal would silently strip that deliberate re-escalation right
      // back off without ever re-evaluating it. The route-same-repo case below already fixed
      // the stranding risk this was defending against (receipt now posts BEFORE label
      // removal, so a mid-failure leaves the issue fully re-evaluable, not stranded); the
      // residual case this reverts to accepting — comment succeeds, removeLabel fails, the
      // label lingers — just sits visibly in the needs-human backlog re-evaluating to this
      // same no-op every run, which is a correctness cost far below silently overriding a
      // human's explicit action.
      console.log(`${head}  skip-already-routed`);
      return;
    case "no-probe":
      console.log(`${head}  no-probe (no findings comment yet — nothing to route on)`);
      return;
    case "close-rejected": {
      const result = tryApply(() => closeIssue(repo, issue.number, closeRejectedReceipt()), dryRun);
      logResult(head, "close-rejected (authorized 👎, pre-routing)", result);
      if (result !== "capped") actionedThisRun.add(issue.number);
      return;
    }
    case "route-same-repo": {
      // Receipt FIRST, then label removal (codex review pass 2 P2, 2026-08-14): if
      // commentIssue failed AFTER removeLabel already succeeded, the issue would be unlabeled
      // with no durable receipt — invisible to BOTH the main pass (label gone, never
      // enumerated again) and the recall pass (hasAnyRouterReceipt requires the marker, which
      // never got posted) — permanently stranded. Comment-first means a failure here leaves
      // the issue exactly as it was pre-attempt: still labeled, no marker, safely
      // re-evaluated fresh next run. The skip-already-routed case above self-heals the other
      // partial-failure direction (comment succeeded, label removal didn't).
      //
      // ops#317: when the probe trailer didn't parse cleanly, ALSO add
      // `probe-trailer-unparsed` after the label removal — this surfaces the format bug in the
      // lane backlog without holding the underlying work (Kevin ruling 2026-09-05, "default to
      // WORK"). ensureLabel is idempotent (`--force`) and runs before addLabel so a caller repo
      // that doesn't yet carry the label bootstraps it on first use.
      const probeTrailerUnparsed = disposition.probeTrailerUnparsed === true;
      const result = tryApply(() => {
        commentIssue(repo, issue.number, routeReceipt(probeTrailerUnparsed));
        removeLabel(repo, issue.number, LABEL);
        if (probeTrailerUnparsed) {
          ensureLabel(repo, PROBE_TRAILER_UNPARSED_LABEL, PROBE_TRAILER_UNPARSED_DESCRIPTION, PROBE_TRAILER_UNPARSED_COLOR);
          addLabel(repo, issue.number, PROBE_TRAILER_UNPARSED_LABEL);
        }
      }, dryRun);
      const describe = probeTrailerUnparsed
        ? "route-same-repo (post receipt + remove label + add probe-trailer-unparsed)"
        : "route-same-repo (post receipt + remove label)";
      logResult(head, describe, result);
      if (result !== "capped") actionedThisRun.add(issue.number);
      return;
    }
    case "hold-needs-kevin": {
      if (holdReceiptPresent) {
        console.log(`${head}  hold-needs-kevin (receipt already posted — no action)`);
        return;
      }
      // ops-pipeline#317 / #320 (Kevin ruling 2026-09-05): on the FIRST hold, post the
      // hold receipt AND add `kevin-decision` (so `/yard` can sweep by label) AND rail
      // the Dispatcher inbox + each `lane:<seat>` seat (deterministic trigger, not a
      // memory-promise — #279). The whole first-firing dance lives inside ONE tryApply
      // so the shared #331 action budget still meters it as one action; the async rail
      // fires AFTER the sync gh work lands so a rail failure never strands the receipt
      // or label. `holdReceiptPresent` on subsequent runs re-enters the branch above and
      // skips — the marker-scan gate is the once-per-hold dedup by construction.
      const rail: HoldRail = {
        repo, issueNumber: issue.number, title: issue.title,
        reason: "held: probe flagged NEEDS-KEVIN: yes",
      };
      const result = tryApply(() => {
        commentIssue(repo, issue.number, holdNeedsKevinReceipt());
        ensureKevinDecisionLabel(repo);
        addKevinDecisionLabel(repo, issue.number);
      }, dryRun);
      logResult(head, "hold-needs-kevin (post hold receipt + add kevin-decision)", result);
      if (result === "applied") await railHold(rail, labels);
      else if (result === "would-apply") console.log(`${head}  hold-needs-kevin [PREVIEW — would rail dispatcher${labels.some((l) => l.startsWith("lane:")) ? ` + ${labels.filter((l) => l.startsWith("lane:")).join(",")}` : ""}]`);
      if (result !== "capped") actionedThisRun.add(issue.number);
      return;
    }
    case "hold-cross-repo": {
      const targetNote = disposition.targetAllowed ? disposition.target : `${disposition.target} [INVALID TARGET — off allowlist]`;
      if (holdReceiptPresent) {
        console.log(`${head}  hold-cross-repo -> ${targetNote} (receipt already posted — no action)`);
        return;
      }
      // Same dance as hold-needs-kevin above — see that branch for the ordering rationale
      // (sync gh mutations inside tryApply, async rail after, marker-scan is the once-
      // per-hold dedup). Reason names the target so the Dispatcher line makes the cross-
      // repo default-on-silence action legible without opening the issue.
      const rail: HoldRail = {
        repo, issueNumber: issue.number, title: issue.title,
        reason: disposition.targetAllowed
          ? `held: cross-repo → ${disposition.target}`
          : `held: cross-repo → ${disposition.target} (off allowlist)`,
      };
      const result = tryApply(() => {
        commentIssue(repo, issue.number, holdCrossRepoReceipt(disposition.target, disposition.targetAllowed));
        ensureKevinDecisionLabel(repo);
        addKevinDecisionLabel(repo, issue.number);
      }, dryRun);
      logResult(head, `hold-cross-repo -> ${targetNote} (post hold receipt + add kevin-decision)`, result);
      if (result === "applied") await railHold(rail, labels);
      else if (result === "would-apply") console.log(`${head}  hold-cross-repo [PREVIEW — would rail dispatcher${labels.some((l) => l.startsWith("lane:")) ? ` + ${labels.filter((l) => l.startsWith("lane:")).join(",")}` : ""}]`);
      if (result !== "capped") actionedThisRun.add(issue.number);
      return;
    }
  }
}

function logResult(head: string, describe: string, result: "applied" | "would-apply" | "capped"): void {
  if (result === "applied") console.log(`${head}  ${describe} [APPLIED]`);
  else if (result === "would-apply") console.log(`${head}  ${describe} [PREVIEW — would apply]`);
  else console.log(`${head}  ${describe} [CAPPED — deferred to next run]`);
}

// ───────────────────────────── recall pass ─────────────────────────────

/** `gh search issues --reactions ">0"` — deliberately NOT label-scoped: a same-repo route
 * removes `needs-human`, so a label-based query can never find an already-routed issue again.
 * `--limit 1000` (codex review pass 1 P2, 2026-08-14): `gh search issues` defaults to only 30
 * results — a repo with more than 30 open reaction-bearing issues would silently drop a routed
 * issue's late 👎 outside that page, exactly the recall pass's own reason for existing. Mirrors
 * `listIssuesByLabel`'s own limit convention. */
function searchOpenIssuesWithReactions(repo: string): IssueRow[] {
  const out = gh(["search", "issues", "--repo", repo, "--reactions", ">0", "--state", "open", "--json", "number,title", "--limit", "1000"]);
  const parsed = JSON.parse(out) as IssueRow[];
  return Array.isArray(parsed) ? parsed : [];
}

function runRecallPass(repo: string, dryRun: boolean, actionedThisRun: Set<number>): RouterDisposition[] {
  const candidates = searchOpenIssuesWithReactions(repo).sort((a, b) => a.number - b.number);
  const dispositions: RouterDisposition[] = [];

  console.log(`[router] ${repo}: ${candidates.length} open issue(s) with reactions>0 — recall pass.`);

  for (const issue of candidates) {
    if (actionedThisRun.has(issue.number)) {
      console.log(`  #${issue.number}  already actioned by the main pass this run — skipping recall`);
      continue;
    }
    const comments = listIssueComments(repo, issue.number);
    const hasReceiptMarker = hasAnyRouterReceipt(trustedComments(comments).map((c) => c.body));
    if (!hasReceiptMarker) {
      // Reactions exist but the router never touched this issue — out of scope for recall
      // (an ordinary 👍/👎 on an un-routed, still-labeled issue belongs to the MAIN pass).
      continue;
    }
    const disapproval = resolveDisapproval(repo, comments);
    const disposition = recallDisposition({ hasReceiptMarker, hasAuthorizedDisapproval: disapproval });

    if (disposition.kind === "none") {
      dispositions.push({ kind: "skip-already-routed" }); // counted as "already routed, nothing new" for the summary
      console.log(`  #${issue.number}  recall: none (routed, no authorized 👎 yet)`);
      continue;
    }

    const result = tryApply(() => closeIssue(repo, issue.number, recallCloseRejectedReceipt()), dryRun);
    logResult(`  #${issue.number} "${truncate(issue.title, 70)}"`, "recall close-rejected (authorized 👎 after routing)", result);
    if (result !== "capped") actionedThisRun.add(issue.number);
    dispositions.push({ kind: "close-rejected" });
  }

  return dispositions;
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const { repo, dryRun } = parseArgs(process.argv.slice(2));

  console.log(`=== needs-human-router — ${repo}${dryRun ? " --dry-run (real reads, zero mutations)" : ""} ===`);

  const actionedThisRun = new Set<number>();
  const mainDispositions = await runMainPass(repo, dryRun, actionedThisRun);
  const recallDispositions = runRecallPass(repo, dryRun, actionedThisRun);

  const allDispositions = [...mainDispositions, ...recallDispositions];
  const summary = summarizeDispositions(allDispositions);

  console.log("");
  console.log(`Summary — ${repo}:`);
  for (const [kind, count] of Object.entries(summary)) {
    console.log(`  ${kind.padEnd(20)} ${count}`);
  }
  console.log(`  mutating actions: ${mutationsApplied}${dryRun ? " (previewed, not applied)" : " applied"}, cap=${ACTION_CAP}`);
  if (cappedCount > 0) {
    console.log(`  ⚠️  CAPPED — ${cappedCount} action(s) deferred to the next run (Rule #331).`);
  }
}

main().catch((err) => {
  console.error(`[router] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
