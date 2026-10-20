/**
 * crew-merge-guards.ts — the guards every door that can MERGE a crew PR runs, in one place
 * (stint #928, Kevin 9/26-27; extracted after the #580 door review at a9b614c, findings
 * F1-F8).
 *
 * WHY A LIB. The first cut of these guards lived inside pr-automerge-gate.ts. That covers
 * the fleet sweep's two doors (`evaluateQueuedOverride`, `evaluateTrainReady`), but studiob's
 * REAL box door is scripts/restart-train.ts (`fireQueueHead`): the sweep never routes
 * studiob box PRs to the gate (squasher-fleet-sweep.yml sets owns_box=false for studiob),
 * and restart-train deliberately never imports pr-automerge-gate.ts (that file runs its own
 * CLI at module scope). A guard that exists in only one door is not a guard on the merge.
 * So the I/O + decisions live here, imported by BOTH — this file imports neither of them.
 *
 * WHAT IS GUARDED (crew PR = `fleet-internal` label without `bugsquasher`, `isCrewPr`):
 *
 *   1. STALE BASE, box or no box (Kevin 9/27). A crew PR whose base is more than a day
 *      behind main, or behind by a commit touching a file the PR touches, is rebased
 *      (update-branch) and its CI re-run before it is eligible. `staleBaseGuard`.
 *   2. TRIPWIRE VISIBILITY. Every UNATTENDED crew merge carries `automerge:code-fix`, the
 *      label the post-merge 5xx tripwire's caller-side filter watches. `ensureTripwireLabel`
 *      (creates the label in the repo first when it is missing — toto/power-unit/lightsout
 *      do not have it — then adds it).
 *   3. THE BOT'S BOX IS BOUND TO WHAT THE GATE QUALIFIED. The gate's own bot `box` is the
 *      unattended class (`isGateAuthorizedActor`). It is honored only while (a) the PR does
 *      not carry `needs-human` (a human ask is open — only Kevin's own box opens it) and
 *      (b) the CURRENT head carries a `crew-qualified` check-run posted by the fleet App on
 *      that exact sha. A crew can write neither (check runs are App-only), so a push that
 *      lands between the gate's last head read and its box write yields a box on a head the
 *      gate never qualified — and that box is simply not honored. `crewMergeDoorGuard`.
 *   4. KEVIN'S OWN BOX SURVIVES THE GATE'S OWN REBASE. The update-branch the gate itself
 *      requests (1) adds a merge commit after Kevin's box, which the stale-label rule would
 *      treat as "code changed after authorization" — stripping a box the gate itself made
 *      stale, so a stale crew PR could never merge on a box. `authorizeAcrossGateRebase`
 *      accepts exactly that commit and nothing else: a GitHub-signed merge commit whose
 *      first parent is the previous head, whose second parent is on the base branch, with an
 *      App-posted `crew-rebase` attestation on the previous head (the gate posts it only
 *      after GitHub accepted its update-branch), chained to the PR's current head. Any crew
 *      push — a plain commit, an unsigned or foreign merge, a force-push — still stales it.
 *
 * Fail-closed throughout: an unreadable fact is "not provable", never "fine" (Rule #322).
 */

import { execFileSync } from "node:child_process";

import { evaluateStaleBase, isCrewPr, type StaleBaseFacts, type StaleBaseVerdict } from "./automerge-classify.js";
import {
  evaluateLabelAuthority,
  GATE_AUTHORITY_LOGIN,
  isGateAuthorizedActor,
  TRAIN_READY_ALIASES,
  TRAIN_READY_LABEL,
  type AuthorityInput,
  type AuthorityTimelineItem,
  type AuthorityVerdict,
} from "./label-authority.js";

// ───────────────────────────── vocabulary ─────────────────────────────

/** The label the post-merge tripwire's caller-side filter keys on (`contains(labels.*.name, '…')`). */
export const CODE_FIX_MERGE_LABEL = "automerge:code-fix";
const CODE_FIX_MERGE_LABEL_DESCRIPTION = "Merged unattended by the fleet gate; watched by the post-merge 5xx tripwire";
const CODE_FIX_MERGE_LABEL_COLOR = "0e8a16";
export const NEEDS_HUMAN_LABEL = "needs-human";
/** The gate's attestation, posted on the sha it qualified, BEFORE it writes candidate/box. */
export const CREW_QUALIFIED_CHECK_NAME = "crew-qualified";
/** The gate's attestation, posted on the OLD head after GitHub accepted its update-branch. */
export const CREW_REBASE_CHECK_NAME = "crew-rebase";
/** The fleet App's slug — the `[bot]`-less spelling of the login whose box the gate honors. */
export const GATE_APP_SLUG = GATE_AUTHORITY_LOGIN.replace(/\[bot\]$/, "");
/** GitHub caps the compare endpoint's `files` at 300 for the whole comparison. */
const COMPARE_FILES_CAP = 300;

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0];

// ───────────────────────────── comments (advisory, never throw) ─────────────────────────────

/** Posts `body` once per marker: a re-evaluation of the same head never re-comments. NEVER throws. */
export function commentOncePerMarker(repo: string, pr: number, marker: string, body: string): void {
  try {
    const prior = gh(["pr", "view", String(pr), "--repo", repo, "--json", "comments", "--jq", `[.comments[].body | select(contains("${marker}"))] | length`]).trim();
    if (prior !== "0") return;
    gh(["pr", "comment", String(pr), "--repo", repo, "--body", `${marker}\n${body}`]);
  } catch (e) {
    console.log(`[warn] crew-merge-guards ${repo}#${pr}: comment failed (non-fatal): ${firstLine(e)}`);
  }
}

// ───────────────────────────── gate attestations (check runs) ─────────────────────────────
//
// Check runs are the one write surface a crew cannot reach: GitHub only lets a GitHub App
// create them (a PAT — the identity crews run under — gets a 403). The fleet gate runs on the
// fleet App's token, so a check run whose `app.slug` is the fleet App's is the gate speaking.

export interface GateCheck {
  name: string;
  conclusion: string | null;
  /** `app.slug` of the check run's creator. */
  app: string | null;
  text: string | null;
}

/** Posts a NEUTRAL, completed check run on `sha` (neutral reads clean in isRollupClean; skipped would not). */
export function postGateCheck(repo: string, sha: string, name: string, title: string, text: string): void {
  gh([
    "api",
    `repos/${repo}/check-runs`,
    "-X",
    "POST",
    "-f",
    `name=${name}`,
    "-f",
    `head_sha=${sha}`,
    "-f",
    "status=completed",
    "-f",
    "conclusion=neutral",
    "-f",
    `output[title]=${title}`,
    "-f",
    `output[summary]=${title}`,
    "-f",
    `output[text]=${text}`,
  ]);
}

/** Every check run on `sha`, reduced to what provenance needs. Throws on a gh failure (callers fail closed). */
export function fetchGateChecks(repo: string, sha: string): GateCheck[] {
  const out = gh([
    "api",
    `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    "--paginate",
    "--jq",
    ".check_runs[] | {name: .name, conclusion: .conclusion, app: .app.slug, text: .output.text}",
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GateCheck);
}

/** True iff the fleet App posted a completed neutral `name` check run on exactly `sha`. NEVER throws: unreadable ⇒ false. */
export function hasGateCheck(repo: string, sha: string, name: string): boolean {
  try {
    return fetchGateChecks(repo, sha).some((c) => c.name === name && c.app === GATE_APP_SLUG && c.conclusion === "neutral");
  } catch {
    return false;
  }
}

/** The gate attests it qualified `sha`. Throws on failure — the caller writes NO merge-authorizing label then. */
export function postCrewQualified(repo: string, sha: string): void {
  postGateCheck(repo, sha, CREW_QUALIFIED_CHECK_NAME, `qualified ${sha.slice(0, 7)}`, JSON.stringify({ qualifiedSha: sha, by: GATE_APP_SLUG }));
}

// ───────────────────────────── tripwire label ─────────────────────────────

export type TripwireLabelResult = { ok: true; wrote: boolean } | { ok: false; error: string };

/**
 * Creates the repo label if it does not exist (a GET first — `gh label create --force` would
 * overwrite the description/color of a label a repo already curates). Throws on any failure
 * other than a clean 404-then-create.
 */
function ensureRepoLabelExists(repo: string): void {
  try {
    gh(["api", `repos/${repo}/labels/${encodeURIComponent(CODE_FIX_MERGE_LABEL)}`]);
    return;
  } catch (err) {
    const msg = firstLine(err);
    if (!/HTTP 404|Not Found/i.test(msg)) throw err;
  }
  try {
    gh(["label", "create", CODE_FIX_MERGE_LABEL, "--repo", repo, "--description", CODE_FIX_MERGE_LABEL_DESCRIPTION, "--color", CODE_FIX_MERGE_LABEL_COLOR]);
  } catch (err) {
    if (!/already exists/i.test(firstLine(err))) throw err; // lost a create race: fine
  }
}

/**
 * Every unattended crew merge must be visible to the post-merge 5xx tripwire, whose caller-side
 * filter keys on `automerge:code-fix`. Idempotent (a label already on the PR is not re-written —
 * GitHub emits no event for a no-op add, and the flap guard counts adds); creates the label in
 * the repo first when missing. The label carries ZERO authority (the tripwire re-derives its own
 * verdict). NEVER throws: `ok:false` means the caller must NOT authorize a merge — an unmerged PR
 * beats an unwatched one.
 */
export function ensureTripwireLabel(repo: string, pr: number, labels: readonly string[]): TripwireLabelResult {
  if (labels.includes(CODE_FIX_MERGE_LABEL)) return { ok: true, wrote: false };
  try {
    ensureRepoLabelExists(repo);
    gh(["pr", "edit", String(pr), "--repo", repo, "--add-label", CODE_FIX_MERGE_LABEL]);
    return { ok: true, wrote: true };
  } catch (err) {
    return { ok: false, error: firstLine(err) };
  }
}

// ───────────────────────────── stale-base re-run ─────────────────────────────

/**
 * The two reads the pure `evaluateStaleBase` predicate needs, from the API the gate already
 * uses (`compare`): how many commits the base branch has that the PR head lacks (`ahead_by` of
 * `<prHead>...<base>`), the fork point's date, the paths the base changed since the fork, and the
 * base tip's date. `--jq` keeps the (patch-bearing) compare payload out of node's buffer.
 */
export function fetchStaleBaseFacts(repo: string, baseRefName: string, headRefOid: string, prPaths: readonly string[]): StaleBaseFacts {
  const base = encodeURIComponent(baseRefName);
  const cmp = JSON.parse(
    gh([
      "api",
      `repos/${repo}/compare/${headRefOid}...${base}?per_page=1`,
      "--jq",
      "{ahead_by: .ahead_by, merge_base_date: .merge_base_commit.commit.committer.date, file_count: ((.files // []) | length), files: [(.files // [])[] | .filename, (.previous_filename // empty)]}",
    ]),
  ) as { ahead_by: number; merge_base_date: string | null; file_count: number; files: string[] };
  const baseTipDate = gh(["api", `repos/${repo}/commits/${base}`, "--jq", ".commit.committer.date"]).trim();
  return {
    behindBy: cmp.ahead_by,
    mergeBaseDate: cmp.merge_base_date,
    baseTipDate,
    baseChangedPaths: cmp.files,
    baseChangedPathsTruncated: cmp.file_count >= COMPARE_FILES_CAP,
    prPaths,
  };
}

export type StaleBaseGuardResult =
  | { action: "proceed" }
  /** Anything but `proceed` means the caller must NOT merge or label this cycle. */
  | { action: "rerun-requested" | "rerun-failed" | "unverifiable"; reasons: string[] };

export interface StaleBaseGuardHooks {
  /** Called after GitHub accepted the update-branch (the gate uses it for the box-patch-id refresh). May throw — swallowed. */
  afterUpdateBranch?: (oldHeadSha: string, requestStartedAt: bigint) => void;
}

/**
 * The stale-base leg's I/O: read the facts, decide (`evaluateStaleBase`), and on a stale verdict
 * request the update-branch. NEVER throws and NEVER returns `proceed` unless the base was
 * positively read and found fresh — a blind probe is `unverifiable` (refuse), not fresh
 * (Rule #322). `reasons[0]` carries the receipt vocabulary callers print verbatim:
 * `stale-base-rerun-requested: …` | `stale-base-rerun-failed: …` | `stale-base-unverifiable: …`.
 *
 * After GitHub accepts the update-branch it posts a `crew-rebase` attestation on the OLD head
 * (best effort): that App-only record is what lets Kevin's own box survive the merge commit the
 * request creates (`authorizeAcrossGateRebase`). Without it Kevin's box simply goes stale as it
 * did before — safe, just not convenient.
 */
export function staleBaseGuard(
  repo: string,
  pr: number,
  prJson: { baseRefName: string; headRefOid: string; files: { path: string }[] },
  hooks: StaleBaseGuardHooks = {},
): StaleBaseGuardResult {
  const base = prJson.baseRefName;
  const sha7 = prJson.headRefOid.slice(0, 7);
  let verdict: StaleBaseVerdict;
  try {
    verdict = evaluateStaleBase(fetchStaleBaseFacts(repo, base, prJson.headRefOid, prJson.files.map((f) => f.path)));
  } catch (err) {
    return {
      action: "unverifiable",
      reasons: [`stale-base-unverifiable: could not read how far behind ${base} this PR is (${firstLine(err)}) — refused this cycle; a probe that cannot answer never reads fresh (Rule #322)`],
    };
  }
  if (!verdict.stale) {
    console.log(`[info] crew-merge-guards ${repo}#${pr}: stale-base leg — base is fresh against ${base}; proceeding.`);
    return { action: "proceed" };
  }

  const why = verdict.reasons.join("; ");
  // Captured BEFORE the update-branch call (Rule #382).
  const updateBranchStart = process.hrtime.bigint();
  try {
    gh(["api", "-X", "PUT", `repos/${repo}/pulls/${pr}/update-branch`, "-f", `expected_head_sha=${prJson.headRefOid}`]);
  } catch (e) {
    const message = firstLine(e);
    commentOncePerMarker(
      repo,
      pr,
      `<!-- stale-base-rerun:failed:${sha7} -->`,
      [
        `**squasher auto-merge gate — STALE BASE, returned to crew** (stint #928; Kevin 9/27)`,
        "",
        `This crew PR's base is stale (${why}) and the gate's update-branch from \`${base}\` was refused (${message}) — e.g. a merge conflict, or the head moved. The gate will not merge it, with or without a \`box\`. Rebase onto \`${base}\`, resolve the conflict, and push; CI must re-run green on the new head before it is eligible.`,
        "",
        `Evaluated sha: \`${prJson.headRefOid}\`.`,
      ].join("\n"),
    );
    return { action: "rerun-failed", reasons: [`stale-base-rerun-failed: ${why} — update-branch refused (${message}); returned to its crew, never merged`] };
  }
  try {
    postGateCheck(repo, prJson.headRefOid, CREW_REBASE_CHECK_NAME, `gate update-branch from ${sha7}`, JSON.stringify({ from: prJson.headRefOid, base, by: GATE_APP_SLUG }));
  } catch (attestErr) {
    console.log(`[warn] crew-merge-guards ${repo}#${pr}: crew-rebase attestation failed (non-fatal — a human box on this PR will go stale instead of surviving the rebase): ${firstLine(attestErr)}`);
  }
  try {
    hooks.afterUpdateBranch?.(prJson.headRefOid, updateBranchStart);
  } catch (hookErr) {
    console.log(`[warn] crew-merge-guards ${repo}#${pr}: after-update-branch hook failed (non-fatal): ${firstLine(hookErr)}`);
  }
  commentOncePerMarker(
    repo,
    pr,
    `<!-- stale-base-rerun:requested:${sha7} -->`,
    [
      `**squasher auto-merge gate — STALE BASE, re-run requested** (stint #928; Kevin 9/27)`,
      "",
      `This crew PR's base is stale: ${why}. The gate asked GitHub to merge \`${base}\` into the branch and will not merge this head — a \`box\` does not skip the re-run (Kevin's own box survives the gate's merge commit; a crew push still voids it). CI re-runs on the merged head; once it is green the PR is re-evaluated. If the re-run fails, the PR stays refused and is returned to its crew to fix.`,
      "",
      `Evaluated sha: \`${prJson.headRefOid}\`.`,
    ].join("\n"),
  );
  return {
    action: "rerun-requested",
    reasons: [`stale-base-rerun-requested: ${why} — update-branch requested at ${sha7}; CI re-runs on the merged head and the PR is re-evaluated (box or no box)`],
  };
}

// ───────────────────────────── Kevin's box across the gate's own rebase ─────────────────────────────

export interface GateRebaseContext {
  repo: string;
  /** The PR's CURRENT head oid, from a fresh fetch. */
  headOid: string;
  baseRefName: string;
  /** Injectable for tests; default: the fleet App's `crew-rebase` check run exists on `sha`. */
  hasRebaseAttestation?: (sha: string) => boolean;
  /** Injectable for tests; default: GitHub's compare says `oid` is an ancestor of (or equal to) the base tip. */
  isBaseAncestor?: (oid: string) => boolean;
}

function defaultIsBaseAncestor(repo: string, baseRefName: string, oid: string): boolean {
  const status = gh(["api", `repos/${repo}/compare/${oid}...${encodeURIComponent(baseRefName)}?per_page=1`, "--jq", ".status"]).trim();
  // compare <oid>...<base>: "ahead" = base has commits oid lacks and oid has none base lacks (oid is an ancestor); "identical" = same commit.
  return status === "ahead" || status === "identical";
}

/**
 * The timeline with the gate's own update-branch merge commits removed — or null when the
 * post-label items are anything other than a clean chain of them. Pure but for the two injected
 * seams. A chain link is accepted ONLY if all of these hold:
 *   - it is a PULL_REQUEST_COMMIT (a force-push anywhere after the label ⇒ null);
 *   - it is a merge commit: exactly two parents, both known;
 *   - its FIRST parent is the previous head (for the first link: the last commit before the box
 *     label, i.e. the sha Kevin boxed) — so it merges INTO the boxed lineage, not beside it;
 *   - its SECOND parent is on the base branch (`isBaseAncestor`) — what was merged in is base;
 *   - GitHub itself signed it (`signedByGitHub`) — not a crew's hand-built merge;
 *   - the fleet App attested an update-branch from the previous head (`hasRebaseAttestation`) —
 *     the gate asked for this rebase, so a UI "resolve conflicts" merge with hand-edited content
 *     does not ride a box;
 * and the last link must be the PR's current head. Every unknown is "not provable" ⇒ null.
 */
function timelineWithoutGateRebases(input: AuthorityInput, ctx: GateRebaseContext): AuthorityTimelineItem[] | null {
  const ready = input.labels?.ready ?? TRAIN_READY_LABEL;
  const aliases = input.labels?.readyAliases ?? (input.labels === undefined ? TRAIN_READY_ALIASES : []);
  const spellings = [ready, ...aliases];

  let applier: AuthorityTimelineItem | null = null;
  for (const item of input.timeline) {
    if (item.label === undefined || !spellings.includes(item.label)) continue;
    if (item.type === "LABELED") applier = item;
    else if (item.type === "UNLABELED") applier = null;
  }
  if (!applier) return null;

  const isHeadMove = (i: AuthorityTimelineItem) => i.type === "PULL_REQUEST_COMMIT" || i.type === "HEAD_REF_FORCE_PUSHED";
  const post = input.timeline.filter((i) => isHeadMove(i) && i.position > applier!.position).sort((a, b) => a.position - b.position);
  if (post.length === 0) return null;
  if (post.some((i) => i.type !== "PULL_REQUEST_COMMIT")) return null;

  const before = input.timeline.filter((i) => i.type === "PULL_REQUEST_COMMIT" && i.position < applier!.position).sort((a, b) => a.position - b.position);
  let prev = before.at(-1)?.oid;
  if (!prev) return null; // cannot name the boxed sha

  const attested = ctx.hasRebaseAttestation ?? ((sha: string) => hasGateCheck(ctx.repo, sha, CREW_REBASE_CHECK_NAME));
  const onBase = ctx.isBaseAncestor ?? ((oid: string) => defaultIsBaseAncestor(ctx.repo, ctx.baseRefName, oid));

  for (const item of post) {
    if (!item.oid || !item.parents || item.parents.length !== 2 || item.signedByGitHub !== true) return null;
    if (item.parents[0] !== prev) return null;
    if (!onBase(item.parents[1])) return null;
    if (!attested(prev)) return null;
    prev = item.oid;
  }
  if (prev !== ctx.headOid) return null;
  return input.timeline.filter((i) => !post.includes(i));
}

/**
 * `evaluateLabelAuthority` that does not strip a box the GATE ITSELF made stale. Identical to
 * the plain predicate for every verdict except `stale-label`; for that one it re-evaluates with
 * the gate's own update-branch merge commits taken out of the timeline — when, and only when,
 * `timelineWithoutGateRebases` can prove every post-label commit is one. Everything else the
 * predicate checks (hold, roster, bot, an earlier push) is re-run on the adjusted timeline, so a
 * crew commit anywhere in the chain still stales the box. Any error ⇒ the original verdict.
 */
export function authorizeAcrossGateRebase(input: AuthorityInput, ctx: GateRebaseContext): AuthorityVerdict {
  const first = evaluateLabelAuthority(input);
  if (first.authorized || first.reason !== "stale-label") return first;
  let adjusted: AuthorityTimelineItem[] | null;
  try {
    adjusted = timelineWithoutGateRebases(input, ctx);
  } catch (err) {
    console.log(`[warn] crew-merge-guards ${ctx.repo}: gate-rebase proof failed (${firstLine(err)}) — the box stays stale`);
    return first;
  }
  if (!adjusted) return first;
  const second = evaluateLabelAuthority({ ...input, timeline: adjusted });
  if (second.authorized) {
    console.log(`[info] crew-merge-guards ${ctx.repo}: the box survives the gate's own update-branch merge commit(s) (GitHub-signed, first parent = previous head, second parent on ${ctx.baseRefName}, attested, chained to head ${ctx.headOid.slice(0, 7)})`);
  }
  return second;
}

// ───────────────────────────── the door guard ─────────────────────────────

export type CrewDoorResult =
  | { action: "proceed" }
  /** The BOT's box is not honored (kind says why). Nothing is written; the caller falls through / skips. */
  | { action: "decline"; kind: "needs-human" | "unqualified"; detail: string }
  /** The cycle is aborted — nothing merges this cycle (kind says why); a later sweep re-evaluates. */
  | { action: "hold"; kind: "stale-base" | "tripwire-label"; reasons: string[] };

export interface CrewDoorInput {
  repo: string;
  pr: number;
  labels: readonly string[];
  headRefOid: string;
  baseRefName: string;
  files: { path: string }[];
  /** The authorizing LabeledEvent's actor (the already-authorized box). */
  authorizingActor: string;
  staleBaseHooks?: StaleBaseGuardHooks;
}

/**
 * What every door runs, after the box is authorized and BEFORE it merges. Non-crew PRs pass
 * untouched. In order: the bot's box is honored only on a head the gate qualified and with no
 * `needs-human` standing (decline — Kevin's own box skips this, it is the key that opens a
 * flagged PR); then the stale-base leg (hold); then, for the bot's unattended merge, the tripwire
 * label (hold — written or failed, the cycle is refused and the next one merges).
 */
export function crewMergeDoorGuard(input: CrewDoorInput): CrewDoorResult {
  if (!isCrewPr(input.labels)) return { action: "proceed" };
  const botBox = isGateAuthorizedActor(input.authorizingActor, input.labels);

  if (botBox) {
    if (input.labels.includes(NEEDS_HUMAN_LABEL)) {
      return { action: "decline", kind: "needs-human", detail: `the bot's box is not honored while '${NEEDS_HUMAN_LABEL}' is on the PR — a human ask is open; only Kevin's own box opens it` };
    }
    if (!hasGateCheck(input.repo, input.headRefOid, CREW_QUALIFIED_CHECK_NAME)) {
      return {
        action: "decline",
        kind: "unqualified",
        detail: `the bot's box is not honored: the current head ${input.headRefOid.slice(0, 7)} carries no '${CREW_QUALIFIED_CHECK_NAME}' check run from the fleet App — the gate did not qualify THIS sha (a push landed around the box write, or the attestation could not be read)`,
      };
    }
  }

  const stale = staleBaseGuard(input.repo, input.pr, { baseRefName: input.baseRefName, headRefOid: input.headRefOid, files: input.files }, input.staleBaseHooks);
  if (stale.action !== "proceed") return { action: "hold", kind: "stale-base", reasons: stale.reasons };

  if (botBox) {
    const tripwire = ensureTripwireLabel(input.repo, input.pr, input.labels);
    if (!tripwire.ok) {
      return {
        action: "hold",
        kind: "tripwire-label",
        reasons: [`tripwire-label-missing: the bot-boxed crew PR lacks '${CODE_FIX_MERGE_LABEL}' and writing it FAILED (${tripwire.error}) — no merge (an unwatched unattended merge is refused)`],
      };
    }
    if (tripwire.wrote) {
      return {
        action: "hold",
        kind: "tripwire-label",
        reasons: [`tripwire-label-missing: the bot-boxed crew PR lacked '${CODE_FIX_MERGE_LABEL}' (the post-merge tripwire's filter) — written; no merge this cycle, a later sweep merges`],
      };
    }
  }
  return { action: "proceed" };
}
