/**
 * label-authority.ts — ops#190 rung A1: the `box` label-authority predicate,
 * GraphQL timeline fetch, and the stale-label removal leg for the "automerge b+A v2"
 * program (docs/plans/2026-08-28-automerge-b-plus-a-v2.md §3.1-3.3).
 *
 * WHY THIS EXISTS (v1's fatal flaw, doc §1 D1/D2): v1 derived merge authority from
 * PARSING COMMENT BODIES (restart-train-lib.ts's original pin parser — a
 * "TRAIN-PIN <iso> · head=<sha> · applied-by=<login>" grammar the author of THIS file
 * invented, never a GitHub-attributed fact) and from TIMESTAMPS (staleness by clock
 * comparison, forgeable by anyone who can edit/backdate a comment or whose clock
 * skews). Both are attacker- and bug-controllable: any commenter can type that exact
 * string. v2 replaces both with GraphQL `timelineItems` — SERVER-ATTRIBUTED events
 * (who labeled it, in what ORDER relative to commits/force-pushes) that no comment
 * body can forge. That legacy comment-grammar parser was explicitly NOT touched or
 * reused here at the time this module was first built (brief: "leave the legacy
 * comment parser alone, it's a superseded, never-relied-upon-for-authority path") —
 * that separation is what let this predicate ship and get verified independently.
 * ops-pipeline#172 rung 1 (the restart-train worker's ticket-assembly cutover onto
 * this predicate, replacing the old parser's call site outright rather than leaving
 * it dead-but-present) has since deleted that legacy parser and its supporting
 * type/regex from restart-train-lib.ts entirely — see that file's
 * `train:after`/`train:consolidate` section header for the current state; nothing in
 * that deletion touches this file.
 *
 * Fail-closed doctrine (Rules #4, #322, #412, #464, #471 — the dominant law across
 * this whole repo): every ambiguous, truncated, empty, or unrecognized input resolves
 * to `authorized: false`. There is no code path in `evaluateLabelAuthority` that can
 * return `authorized: true` by falling through an unhandled case — the function ends
 * on an explicit `return { authorized: true, ... }` only after every refusal branch
 * above it has been checked and passed.
 *
 * Two layers, deliberately separated for testability (mirrors automerge-classify.ts's
 * pure-core/thin-glue split, and sidesteps the exact hazard automerge-args.ts's own
 * header comment documents: `pr-automerge-gate.ts` calls `main().catch(...)`
 * unconditionally at module scope, so nothing in THIS file may import it):
 *   - PURE core (no network, fully unit-tested): `evaluateLabelAuthority`,
 *     `resolveAuthorityLogins`, `hasAuthoritySnapshotDrifted`,
 *     `formatStaleLabelRemovalReceipt`.
 *   - I/O glue (gh CLI, not directly unit-tested — verified via live plants per doc
 *     §5, matching how `fetchPr`/`fetchDiffBySha`/`mergePr` in pr-automerge-gate.ts
 *     are already verified): `fetchAuthorityTimeline`, `removeStaleReadyLabel`,
 *     `postAuthorityReceipt`.
 */

import { execFileSync } from "node:child_process";

// ───────────────────────────── label constants ─────────────────────────────

/**
 * ONE human key on GitHub: `box` = merge it (RULED 2026-09-15 ~01:1xZ, "Box is the one key" —
 * brain library/supplementary-regulations/2026-09-15-box-is-the-one-key.md; Kevin: "this is why
 * I've told you to consolidate all of that to box as a label"). `box` is `queued` RENAMED, not a
 * third word: Kevin's sha-pinned, GraphQL-attributed `box` opens every DECISION leg of the door
 * (class-match · line-cap · named-checks · review); `hold` = park it; `needs-human` is the door's
 * ask, never a human's word. The floor never lowers: a red CI rollup refuses whatever the label
 * says (#459). Retired vocabulary (Kevin 2026-09-15 05:5xZ: "there should be no more train ready,
 * no queued ... box ... should be in all repos"): `queued` and `box` are NOT aliases — they
 * do not authorize, and the labels are deleted from every org repo. `reviewed` stays only as the
 * review-leg receipt (stock-built), never a key. The constant NAMES stay so every call site reads
 * as before; only the values moved.
 */
export const TRAIN_READY_LABEL = "box";
export const TRAIN_HOLD_LABEL = "hold";

/**
 * ops-pipeline#260 leg 4 — the squasher-class pair. Kevin's `box` on a PR the gate REFUSED
 * (line cap, sensitive path, review finding, named check) is his word on the decision line: the
 * sweep merges it, sha-pinned to the head he labeled, through the SAME predicate below (roster
 * human, not a bot, no commit after the label). `hold` parks it — hold wins, always.
 */
export const QUEUED_LABEL = "box";
export const HOLD_LABEL = "hold";

/**
 * NO aliases. The 01:1xZ ruling allowed `queued` as a transition-week alias; Kevin cut the week
 * the same night (05:5xZ: "no more train ready, no queued") — `box` is the only spelling the door
 * reads, in every repo. The plumbing (`readyAliases`) stays so a future rename can ride it; this
 * list is EMPTY and label-authority.test.ts asserts both the emptiness and that a `queued` or
 * `box` label reads as no-ready-label. `reviewed` was never a key — only the review-leg
 * receipt (pr-automerge-gate.ts `humanReviewReceipt`).
 */
export const TRAIN_READY_ALIASES: readonly string[] = [];

/** The (ready, hold) label pair the predicate evaluates. Defaults = the train pair. */
export interface AuthorityLabelPair {
  ready: string;
  hold: string;
  /** Transition spellings that still authorize as `ready`. Omit = no aliases (the `reviewed`
   *  receipt pair reads exactly one spelling). */
  readyAliases?: readonly string[];
}
export const TRAIN_LABEL_PAIR: AuthorityLabelPair = { ready: TRAIN_READY_LABEL, hold: TRAIN_HOLD_LABEL, readyAliases: TRAIN_READY_ALIASES };
export const QUEUED_LABEL_PAIR: AuthorityLabelPair = { ready: QUEUED_LABEL, hold: HOLD_LABEL, readyAliases: TRAIN_READY_ALIASES };

// ───────────────────────────── authority roster (doc §3.2) ─────────────────────────────

/**
 * The ONLY logins this gate will ever treat as merge-authorizing. A caller may pass a
 * NARROWER list into `resolveAuthorityLogins` (e.g. a per-repo config that wants to
 * restrict further) — it can never WIDEN it. This const is the ceiling, not a default
 * a caller can override upward; `resolveAuthorityLogins` enforces that by intersection,
 * never union.
 */
export const MERGE_AUTHORITY_LOGINS: readonly string[] = ["kbibelhausen"];

/**
 * 2026-09-06 (Kevin, "go" on the Engineer's strictness read): the ONE bot whose ready label
 * counts, and ONLY on a PR that currently carries every label in
 * GATE_AUTHORITY_REQUIRED_LABELS — `candidate` is the gate's own tripwire (applied in the
 * same gate run, after every leg passed) and `bugsquasher` marks the squasher class. Any
 * other bot, or this bot on a PR missing either label, is still refused categorically.
 * `hold` still wins before this is ever consulted; the staleness leg still applies after.
 * (2026-09-15: the label the bot applies is now `box`; its transition-week `queued`
 * applications authorize through the alias below.)
 */
export const GATE_AUTHORITY_LOGIN = "studiob-fleet-bot[bot]";
export const GATE_AUTHORITY_REQUIRED_LABELS: readonly string[] = ["bugsquasher", "candidate"];
/**
 * 2026-09-13 (Kevin, "both fixes approved" — brain #112 design call): a SECOND narrow class the same bot may queue —
 * `fleet-internal` + `candidate`. `fleet-internal` is applied by the shift runner at box ONLY when the PR's repo is in the
 * fleet registry (scripts/squasher-fleet.json) AND the diff touches no path named as a live surface in the team's kit (#97)
 * — the runner is the classifier, this gate is the ceiling. Everything else about the gate is unchanged: `hold` wins,
 * CI must be SUCCESS, the Sonnet vote must be CLEAN, the sha is pinned, staleness applies. Any other bot, any human other
 * than MERGE_AUTHORITY_LOGINS, or this bot on a PR missing either label → still refused.
 */
export const GATE_AUTHORITY_CLASSES: readonly (readonly string[])[] = [
  GATE_AUTHORITY_REQUIRED_LABELS,
  ["fleet-internal", "candidate"],
];

export function isGateAuthorizedActor(actorLogin: string, currentLabels: readonly string[]): boolean {
  return actorLogin === GATE_AUTHORITY_LOGIN && GATE_AUTHORITY_CLASSES.some((cls) => cls.every((l) => currentLabels.includes(l)));
}

/**
 * Resolves the EFFECTIVE roster `evaluateLabelAuthority` should check `actorLogin`
 * against: the intersection of `callerLogins` (if provided) with `MERGE_AUTHORITY_LOGINS`
 * — never their union. A login present ONLY in `callerLogins` (not in
 * `MERGE_AUTHORITY_LOGINS`) is silently dropped, not authorized — a caller cannot
 * widen authority by passing a longer list. Omitting `callerLogins` entirely returns
 * the full default roster unchanged.
 */
export function resolveAuthorityLogins(callerLogins?: readonly string[]): readonly string[] {
  if (callerLogins === undefined) return MERGE_AUTHORITY_LOGINS;
  const ceiling = new Set(MERGE_AUTHORITY_LOGINS);
  return callerLogins.filter((login) => ceiling.has(login));
}

// ───────────────────────────── timeline shape (doc §3.1 steps 1-3) ─────────────────────────────

export type AuthorityTimelineItemType =
  | "LABELED"
  | "UNLABELED"
  | "PULL_REQUEST_COMMIT"
  | "HEAD_REF_FORCE_PUSHED";

/**
 * One GraphQL `timelineItems` node, reduced to exactly what the pure predicate needs.
 * `position` is the item's 0-based index in SERVER chronological order (oldest first)
 * — `fetchAuthorityTimeline` assigns it as the array index of the GraphQL response's
 * `nodes` list, so it is always unique and always order-preserving; the predicate
 * compares `position` values to each other, NEVER an absolute count or a timestamp
 * (doc FORBIDDEN: "NO timestamps/clock comparisons for staleness — timeline ORDER
 * only").
 */
export interface AuthorityTimelineItem {
  type: AuthorityTimelineItemType;
  /** Only meaningful for LABELED/UNLABELED — the label's name. */
  label?: string;
  /** Only meaningful for LABELED/UNLABELED — the GitHub-attributed actor login for
   *  that event. A bot actor's login always ends in "[bot]" (e.g.
   *  "github-actions[bot]"). */
  actorLogin?: string;
  position: number;
  /** Only populated for LABELED (the GraphQL query only selects `createdAt` on the
   *  `LabeledEvent` fragment, ops-pipeline#172 rung 1) — the server-attributed instant
   *  the label was applied. This is FIFO-ordering data ONLY, consumed by the
   *  restart-train worker to sort tickets; `evaluateLabelAuthority` itself never reads
   *  this field and makes every staleness decision from `position` (timeline order),
   *  never a timestamp comparison (doc §3.1 item 3 — unchanged by this addition). */
  createdAt?: string;
}

export interface AuthorityInput {
  /** The PR's CURRENT label names — a fresh, direct fetch (e.g. `gh pr view --json
   *  labels`), independent of the timeline. Ready/hold presence is read from HERE,
   *  never inferred from the timeline walk. */
  currentLabels: string[];
  /** Every relevant timeline item, in server chronological order (oldest first),
   *  each carrying its own `position` (see AuthorityTimelineItem). */
  timeline: AuthorityTimelineItem[];
  /** The roster to check the authorizing actor's login against — already resolved
   *  via `resolveAuthorityLogins` (this function does not re-apply the intersection;
   *  it trusts the roster it's given). */
  authorityLogins: readonly string[];
  /** true when the GraphQL fetch's `last: 250` window did not capture the FULL set
   *  of relevant timeline events (`fetchAuthorityTimeline`'s `truncated`). MUST fail
   *  closed regardless of what the visible window shows — an event outside the
   *  window (an earlier commit, an earlier relabel) could invalidate any conclusion
   *  drawn from inside it. */
  truncated: boolean;
  /** Which (ready, hold) pair to evaluate. Omitted = the train pair — every
   *  pre-existing caller and test is unchanged. The squasher gate passes
   *  `QUEUED_LABEL_PAIR` (ops-pipeline#260 leg 4). */
  labels?: AuthorityLabelPair;
  /**
   * OBSERVE-ONLY THIS LAP (ops-pipeline#190 rollout step 3; ruling: brain
   * library/supplementary-regulations/2026-09-19-the-box-binds-to-the-patch-id.md,
   * "the box binds to the patch-id, not the sha"). When present, carries the recorded
   * bp2 patch-id from the authorizing LabeledEvent (if `box-patch-id-labeled.yml` ever
   * minted one for it) and the patch-id computed fresh against the CURRENT head. Read
   * ONLY at the Step 3 staleness gate below to LOG what the patch-id predicate would
   * have decided — omitting it, or leaving `boxPatchIdWins` false (its default),
   * changes nothing about the verdict this function returns.
   */
  boxPatchId?: BoxPatchIdObserveContext;
  /**
   * OBSERVE-ONLY THIS LAP. Defaults to false. No branch in `evaluateLabelAuthority`
   * reads this to change the returned `AuthorityVerdict` yet — it exists on this
   * interface now so a later rung (rollout step 5) is a call-site change, not another
   * signature change. Read only for the observe-only log line's own wording below.
   */
  boxPatchIdWins?: boolean;
}

/**
 * The two ids `evaluateLabelAuthority` compares, log-only, at the Step 3 staleness
 * gate this lap. See `AuthorityInput.boxPatchId`. Mirrors `BoxPatchIdRecord.patchId`
 * (scripts/lib/box-patch-id.ts) without importing that module — this file's own
 * doctrine keeps each `scripts/lib/*.ts` file's dependency surface independently
 * readable (see this file's `gh()` below), and the two id strings need no shared
 * runtime code, only the same `bp2:...` format.
 */
export interface BoxPatchIdObserveContext {
  /** The bp2 patch-id minted for the authorizing LabeledEvent, if one was ever
   *  recorded. Absent means "no observation available" (e.g. minted before this
   *  rollout step shipped, or the key-tag state differs) — never treated as a
   *  mismatch on its own. */
  recordedPatchId?: string;
  /** The bp2 patch-id computed fresh against the CURRENT head, against the same base
   *  used to mint `recordedPatchId` (`mintBoxPatchId`, scripts/lib/box-patch-id.ts). */
  currentPatchId: string;
}

// ───────────────────────────── verdict ─────────────────────────────

export type AuthorityRefusalReason =
  | "no-ready-label"
  | "hold-present"
  | "bot-actor"
  | "unauthorized-actor"
  | "stale-label"
  | "timeline-truncated"
  | "no-authorizing-event";

export type AuthorityVerdict =
  | { authorized: false; reason: AuthorityRefusalReason; detail: string }
  | { authorized: true; authorizingEvent: { actorLogin: string; position: number; label?: string } };

/**
 * The narrowed shape of an `AuthorityVerdict` specifically for `reason: "stale-label"`
 * — a plain named type, NOT `Extract<AuthorityVerdict, {reason: "stale-label"}>`.
 * `Extract` filters union MEMBERS by assignability of the WHOLE member shape; since
 * `AuthorityVerdict`'s false-branch member types `reason` as the wider
 * `AuthorityRefusalReason` union (not the literal `"stale-label"`), that member is not
 * assignable to a `{reason: "stale-label"}` filter and `Extract` silently resolves to
 * `never` — a real bug caught by `tsc`, not a hypothetical. A caller that has already
 * narrowed a live `AuthorityVerdict` value via `if (!v.authorized) { if (v.reason ===
 * "stale-label") { ... } }` gets a structurally-identical object at that point, which
 * IS assignable to this plain interface (structural typing, no cast needed there).
 */
export interface StaleLabelAuthorityVerdict {
  authorized: false;
  reason: "stale-label";
  detail: string;
}

/**
 * The predicate, EXACTLY per doc §3.1 steps 1-3 (pure — no network; the fetch that
 * produces `input.timeline`/`input.truncated` lives in `fetchAuthorityTimeline`
 * below, kept separate so this core is directly unit-testable):
 *
 *   1. The ready label (`box`, or its transition alias) present AND `hold` absent in
 *      `currentLabels` — hold wins, ALWAYS, checked before anything else (a PR can be
 *      ready-labeled and simultaneously held; hold must win the reported reason too,
 *      not just the outcome).
 *   2. Walk the timeline's LABELED/UNLABELED events for the ready label in order,
 *      tracking who currently "owns" the label (LABELED sets the owner, UNLABELED
 *      clears it) — the survivor at the end of the walk is "the LAST LabeledEvent
 *      with no subsequent UnlabeledEvent for it". That event's `actorLogin`:
 *        - is refused categorically if it ends in "[bot]" — checked BEFORE the
 *          roster check, so a bot login can NEVER authorize even if some future
 *          config mistake puts a bot string in the roster;
 *        - else must be a member of `authorityLogins`, or the verdict is
 *          `unauthorized-actor`.
 *   3. No `PULL_REQUEST_COMMIT` or `HEAD_REF_FORCE_PUSHED` item may sit at a LATER
 *      `position` than that authorizing LabeledEvent — if one does, the label is
 *      STALE (someone changed the code after the authorizing human clicked "ready");
 *      the caller (pr-automerge-gate.ts's `evaluateTrainReady`) is expected to strip
 *      the label and post a write-only receipt, never merge.
 *
 * `truncated: true` and an empty timeline both fail closed unconditionally — see the
 * inline comments below for why each is checked where it is.
 */
export function evaluateLabelAuthority(input: AuthorityInput): AuthorityVerdict {
  const { currentLabels, timeline, authorityLogins, truncated } = input;
  const READY = input.labels?.ready ?? TRAIN_READY_LABEL;
  const HOLD = input.labels?.hold ?? TRAIN_HOLD_LABEL;
  // Transition-week aliases (2026-09-15): the train pair reads `queued` as `box` for one
  // week. An explicit pair WITHOUT readyAliases (the `reviewed` receipt pair) reads exactly
  // one spelling — aliases never leak onto a receipt that was only ever one word.
  const ALIASES = input.labels?.readyAliases ?? (input.labels === undefined ? TRAIN_READY_ALIASES : []);
  const READY_SPELLINGS = [READY, ...ALIASES];
  const SPELLING_NOTE = ALIASES.length > 0 ? ` (or the transition alias ${ALIASES.map((a) => `\`${a}\``).join(", ")})` : "";

  // ── Step 1: label state, read DIRECTLY from currentLabels (no timeline dependency
  // at all) — checked first because it's the cheapest possible check and because
  // "hold wins, always" must win the REPORTED REASON too, not just the boolean
  // outcome, even in a (should-never-happen) state where the ready label is also absent.
  if (currentLabels.includes(HOLD)) {
    return { authorized: false, reason: "hold-present", detail: `${HOLD} is present on the PR — hold wins, always, regardless of any other leg.` };
  }
  if (!READY_SPELLINGS.some((l) => currentLabels.includes(l))) {
    return { authorized: false, reason: "no-ready-label", detail: `${READY}${SPELLING_NOTE} is not present in the PR's current labels.` };
  }

  // ── Timeline data-integrity gate, BEFORE any reasoning about its contents (Rule
  // #4/#322: doubt about the instrument itself is checked before trusting anything it
  // reports). truncated implies the visible window may be missing an EARLIER event
  // that would change the walk below (e.g. an earlier relabel, an earlier commit) —
  // there is no safe partial conclusion to draw from a known-incomplete timeline.
  if (truncated) {
    return {
      authorized: false,
      reason: "timeline-truncated",
      detail: "the GraphQL timeline fetch was truncated (more than 250 relevant events) — the authorizing event cannot be reliably located inside an incomplete window.",
    };
  }
  if (timeline.length === 0) {
    // the ready label is present per currentLabels (checked above), yet there is no
    // server-attributed event at all to point to as its authorizing LabeledEvent —
    // never trust the label's mere presence without an event trail behind it.
    return {
      authorized: false,
      reason: "no-authorizing-event",
      detail: `${READY}${SPELLING_NOTE} is present on the PR but the timeline returned zero LABELED/UNLABELED/commit/force-push events to attribute it to.`,
    };
  }

  // ── Step 2: walk LABELED/UNLABELED events for the ready label (any spelling), in the
  // given order, to find the current surviving applier — "the LAST LabeledEvent with no
  // subsequent UnlabeledEvent for it". A later relabel by a DIFFERENT actor correctly
  // supersedes an earlier one; an intervening unlabel-then-relabel is exactly "last event
  // wins". An UNLABELED for ANY tracked spelling clears the owner: real timelines cannot
  // contain an UnlabeledEvent for a spelling that was never on the PR, so cross-spelling
  // clears only ever appear in fabricated data — where clearing is the fail-closed answer.
  let currentApplier: AuthorityTimelineItem | null = null;
  for (const item of timeline) {
    if (item.label === undefined || !READY_SPELLINGS.includes(item.label)) continue;
    if (item.type === "LABELED") {
      currentApplier = item;
    } else if (item.type === "UNLABELED") {
      currentApplier = null;
    }
  }

  if (!currentApplier) {
    // currentLabels says the ready label is applied, but no net-surviving LABELED event
    // for it exists in this (complete, non-truncated, non-empty) timeline — an
    // inconsistent state (e.g. GraphQL replication lag, or the label was set through
    // some path that doesn't emit a timeline event). Fail closed rather than assume
    // authorization from label presence alone.
    return {
      authorized: false,
      reason: "no-authorizing-event",
      detail: `${READY}${SPELLING_NOTE} is present on the PR but no LabeledEvent for it survives to the end of the timeline walk (every LabeledEvent found was superseded by a later UnlabeledEvent).`,
    };
  }

  const actorLogin = currentApplier.actorLogin ?? "";

  // Bot check FIRST, unconditionally — before the roster check — so that a bot login
  // is refused even if some future misconfiguration puts a bot string inside the
  // roster passed as `authorityLogins` (doc FORBIDDEN: "ANY actorLogin ending in
  // [bot] refused categorically").
  // 2026-09-06: the ONE exception — the fleet gate's own ready label on a PR that carries
  // its `candidate` tripwire AND `bugsquasher` (isGateAuthorizedActor); every other bot,
  // and this bot on any other PR, is still refused here.
  // The exception follows the TRAIN pair ONLY (`box`, and its `queued` alias during the
  // transition week): for any other ready label (the `reviewed` human receipt,
  // 2026-09-06 "that works") a bot actor is refused as before.
  const gateActor = READY === TRAIN_READY_LABEL && isGateAuthorizedActor(actorLogin, currentLabels);
  if (actorLogin.endsWith("[bot]") && !gateActor) {
    return {
      authorized: false,
      reason: "bot-actor",
      detail: `the authorizing ${READY} LabeledEvent (position ${currentApplier.position}) was applied by "${actorLogin}", a bot actor — bots are refused categorically, roster membership is irrelevant.`,
    };
  }

  if (!gateActor && !authorityLogins.includes(actorLogin)) {
    return {
      authorized: false,
      reason: "unauthorized-actor",
      detail: `the authorizing ${READY} LabeledEvent (position ${currentApplier.position}) was applied by "${actorLogin}", which is not in the effective authority roster [${authorityLogins.join(", ")}].`,
    };
  }

  // ── Step 3: staleness — no commit or force-push may sit AFTER the authorizing
  // LabeledEvent's position. Positions are assigned as array indices by
  // `fetchAuthorityTimeline` (see AuthorityTimelineItem), so two distinct items can
  // never share a position from real data; a strict `>` comparison is exactly
  // "appears after" per the doc's own wording.
  const staleItem = timeline.find(
    (item) =>
      (item.type === "PULL_REQUEST_COMMIT" || item.type === "HEAD_REF_FORCE_PUSHED") &&
      item.position > currentApplier!.position,
  );
  if (staleItem) {
    // OBSERVE-ONLY (ops-pipeline#190 rollout step 3 — see AuthorityInput.boxPatchId):
    // logs what the patch-id predicate WOULD decide here, never returns it. The
    // `return` below this block is unconditional and unchanged regardless of what
    // this branch logs or whether `input.boxPatchId` is even present.
    if (input.boxPatchId) {
      const { recordedPatchId, currentPatchId } = input.boxPatchId;
      const patchIdAgrees = recordedPatchId !== undefined && recordedPatchId === currentPatchId;
      console.error(
        `[box-patch-id observe-only] stale-label at position ${staleItem.position} ` +
          `(recorded=${recordedPatchId ?? "none"}, current=${currentPatchId}): the patch-id predicate would ` +
          `${patchIdAgrees ? "KEEP" : "STRIP"} this label — boxPatchIdWins=${input.boxPatchIdWins ?? false}, ` +
          `verdict unchanged this lap.`,
      );
    }
    return {
      authorized: false,
      reason: "stale-label",
      detail: `a ${staleItem.type} event at position ${staleItem.position} sits AFTER the authorizing ${READY} LabeledEvent at position ${currentApplier.position} (applied by "${actorLogin}") — the code changed after authorization was granted.`,
    };
  }

  return { authorized: true, authorizingEvent: { actorLogin, position: currentApplier.position, label: currentApplier.label } };
}

// ───────────────────────────── revalidate-drift comparator (doc §3.1 step 7) ─────────────────────────────

/**
 * A minimal snapshot of the fields `evaluateTrainReady`'s revalidate leg (doc §3.1
 * step 7) re-fetches immediately before merging: "re-fetch labels+headRefOid once,
 * LAST call before merge, any delta ⇒ abort cycle". `state`/`mergeStateStatus` are
 * included too — both can flip (e.g. a PR closed, or mergeability degrading) in the
 * window between the first fetch and the merge call, and either is exactly the kind
 * of delta this leg exists to catch.
 */
export interface AuthoritySnapshot {
  labels: readonly string[];
  headRefOid: string;
  state: string;
  mergeStateStatus: string;
}

/**
 * true if ANY field relevant to the merge decision changed between `before` (the
 * snapshot the whole evaluation was computed against) and `after` (the LAST read,
 * taken immediately before the merge call) — label SET equality ignores order
 * (GitHub's label array order is not semantically meaningful and must never trigger
 * a false-positive abort), everything else is exact-match. A `true` result means the
 * caller aborts THIS cycle without merging; the next scheduled/triggered run
 * re-evaluates the new state from scratch (Rules #109/#161: no same-cycle retry on an
 * undiagnosed change).
 */
export function hasAuthoritySnapshotDrifted(before: AuthoritySnapshot, after: AuthoritySnapshot): boolean {
  if (before.headRefOid !== after.headRefOid) return true;
  if (before.state !== after.state) return true;
  if (before.mergeStateStatus !== after.mergeStateStatus) return true;

  const beforeLabels = [...before.labels].sort();
  const afterLabels = [...after.labels].sort();
  if (beforeLabels.length !== afterLabels.length) return true;
  for (let i = 0; i < beforeLabels.length; i++) {
    if (beforeLabels[i] !== afterLabels[i]) return true;
  }
  return false;
}

// ───────────────────────────── I/O glue (gh CLI) ─────────────────────────────
//
// Not directly unit-tested — matches this repo's established convention (the
// existing `fetchPr`/`fetchDiffBySha`/`mergePr`/`commentOnPr` in
// pr-automerge-gate.ts have never had direct tests either; I/O glue is verified via
// live plants, per doc §5, not mocked unit tests). Each function below defines its
// own tiny `gh()` wrapper rather than importing one — this file cannot import
// anything from pr-automerge-gate.ts (its module-scope `main().catch(...)` would
// fire), and every other lib file in this repo (e.g. github-issues.ts) independently
// defines the same ~3-line wrapper rather than sharing one; this file matches that
// convention rather than introducing a new shared module out of scope for this rung.

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

/** How many trailing timeline items (in the four requested types) `fetchAuthorityTimeline`
 *  fetches per PR. `truncated` fires whenever the window provably misses earlier
 *  relevant events (`pageInfo.hasPreviousPage`) or the connection's `filteredCount`
 *  exceeds what was actually returned — see the comment on that derivation below.
 *  `filteredCount`, NOT `totalCount`: live-proven 2026-08-28 (studiob#613, run
 *  33218268263) that `totalCount` IGNORES the `itemTypes:` filter — an ordinary
 *  issue comment (e.g. the train's own CLICK DUE receipt) pushes `totalCount` past
 *  `nodes.length` on a fully-complete window, which read as permanent
 *  "timeline-truncated" fail-closed refusal of a healthy PR. `filteredCount`
 *  respects the filter. */
export const AUTHORITY_TIMELINE_PAGE_SIZE = 250;
/** Upper bound on backward pages walked per fetch (2026-09-06, the bolt-wms#2120
 *  label-loop incident: a runaway relabel loop pushed one PR to 311 relevant events,
 *  so the single `last: 250` window reported `truncated` and the human `reviewed`
 *  receipt at position 2 became unreadable through EVERY door — fail-closed by design,
 *  but permanently, for a PR whose authorizing event is plainly on the record). The
 *  fetch now walks `before: startCursor` back to the connection's start, so a noisy
 *  timeline still yields the COMPLETE relevant window; only a timeline that exceeds
 *  PAGE_SIZE × MAX_PAGES (2,000 events) — or an internally inconsistent response —
 *  still reports `truncated` (and still refuses). */
export const AUTHORITY_TIMELINE_MAX_PAGES = 8;

const AUTHORITY_TIMELINE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(
        itemTypes: [LABELED_EVENT, UNLABELED_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]
        last: ${AUTHORITY_TIMELINE_PAGE_SIZE}
        before: $before
      ) {
        filteredCount
        pageInfo { hasPreviousPage startCursor }
        nodes {
          __typename
          ... on LabeledEvent { label { name } actor { __typename login } createdAt }
          ... on UnlabeledEvent { label { name } actor { __typename login } }
        }
      }
    }
  }
}`;

const TIMELINE_TYPENAME_MAP: Record<string, AuthorityTimelineItemType> = {
  LabeledEvent: "LABELED",
  UnlabeledEvent: "UNLABELED",
  PullRequestCommit: "PULL_REQUEST_COMMIT",
  HeadRefForcePushedEvent: "HEAD_REF_FORCE_PUSHED",
};

interface GraphQLTimelineNode {
  __typename: string;
  label?: { name?: string | null } | null;
  actor?: { login?: string | null } | null;
  /** Only requested on the `LabeledEvent` fragment above — always absent/undefined on
   *  every other node type. */
  createdAt?: string | null;
}

interface GraphQLTimelineResponse {
  data?: {
    repository?: {
      pullRequest?: {
        timelineItems?: {
          filteredCount: number;
          pageInfo?: { hasPreviousPage?: boolean | null; startCursor?: string | null } | null;
          nodes: GraphQLTimelineNode[];
        } | null;
      } | null;
    } | null;
  };
}

/**
 * Fetches the last `AUTHORITY_TIMELINE_PAGE_SIZE` LABELED/UNLABELED/commit/force-push
 * events for a PR via GraphQL `timelineItems` (doc §3.1: server-attributed events,
 * never comment text, never a REST timeline endpoint — GraphQL as specified) and maps
 * them into `evaluateLabelAuthority`'s pure input shape, preserving server order via
 * array index as `position`.
 *
 * Throws on any `gh`/GraphQL-level failure (network, auth, PR/repo not found, an
 * unrecognized node `__typename` outside the four requested types) — this function
 * does NOT itself decide a verdict; the caller (`evaluateTrainReady` in
 * pr-automerge-gate.ts) is responsible for catching and resolving any error to a
 * non-merge outcome, exactly as the existing `fetchPr`/`fetchDiffBySha` already let
 * `gh` failures propagate to their caller.
 */
/**
 * 2026-09-06 (live, studiob#642/#666): GitHub's GraphQL names a GitHub-App actor
 * `Bot:studiob-fleet-bot` — WITHOUT the `[bot]` suffix REST shows — so every
 * `login.endsWith("[bot]")` check in this file (the categorical bot refusal AND the
 * gate's own `queued` exception) was blind to GraphQL bot actors: the fleet gate's
 * `queued` on #642 fell through to the roster check and was refused as an
 * "unauthorized-actor" instead of matching GATE_AUTHORITY_LOGIN. Normalize at the
 * ONE place the timeline is read: a `Bot` actor's login carries the `[bot]` suffix
 * downstream, exactly as REST would spell it. Pure; tested both ways.
 */
export function normalizeActorLogin(actor: { __typename?: string | null; login?: string | null } | null | undefined): string | undefined {
  const login = actor?.login;
  if (typeof login !== "string" || login.length === 0) return undefined;
  if (actor?.__typename === "Bot" && !login.endsWith("[bot]")) return `${login}[bot]`;
  return login;
}

/** One GraphQL page runner — injectable so the pagination walk is testable without a
 *  live `gh` (the default shells out exactly as before). Returns the raw response text. */
export type AuthorityTimelineQueryRunner = (variables: { owner: string; repo: string; number: number; before: string | null }) => string;

function runAuthorityTimelineQuery(variables: { owner: string; repo: string; number: number; before: string | null }): string {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${AUTHORITY_TIMELINE_QUERY}`,
    "-f",
    `owner=${variables.owner}`,
    "-f",
    `repo=${variables.repo}`,
    "-F",
    `number=${variables.number}`,
  ];
  if (variables.before !== null) args.push("-f", `before=${variables.before}`);
  return gh(args);
}

export function fetchAuthorityTimeline(
  repo: string,
  prNumber: number,
  runQuery: AuthorityTimelineQueryRunner = runAuthorityTimelineQuery,
): { timeline: AuthorityTimelineItem[]; truncated: boolean } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`fetchAuthorityTimeline: repo must be "org/repo", got ${JSON.stringify(repo)}`);
  }
  // Walk BACKWARD from the newest page (`last: N`) via `before: startCursor` until the
  // connection reports no previous page or the page bound is hit. Pages are prepended
  // so the assembled array is oldest-first, matching the single-window semantics the
  // evaluator was written against (position = index in the assembled window).
  const collected: GraphQLTimelineNode[] = [];
  let filteredCount: number | null = null;
  let totalFilteredCount = 0;
  let expectedRemaining = 0;
  let before: string | null = null;
  let hasPreviousPage = true;
  let pages = 0;
  let lastOut = "";
  while (hasPreviousPage && pages < AUTHORITY_TIMELINE_MAX_PAGES) {
    const out = runQuery({ owner, repo: name, number: prNumber, before });
    lastOut = out;
    const parsed = JSON.parse(out) as GraphQLTimelineResponse;
    const conn = parsed.data?.repository?.pullRequest?.timelineItems;
    if (!conn) {
      throw new Error(`fetchAuthorityTimeline: unexpected GraphQL response shape for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
    }
    if (!Array.isArray(conn.nodes)) {
      throw new Error(`fetchAuthorityTimeline: GraphQL response "nodes" is not an array for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
    }
    if (typeof conn.filteredCount !== "number" || !Number.isFinite(conn.filteredCount) || conn.filteredCount < 0) {
      throw new Error(`fetchAuthorityTimeline: GraphQL response "filteredCount" is not a valid non-negative number for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
    }
    if (typeof conn.pageInfo?.hasPreviousPage !== "boolean") {
      throw new Error(`fetchAuthorityTimeline: GraphQL response "pageInfo.hasPreviousPage" is not a boolean for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
    }
    // GitHub's `timelineItems.filteredCount` is "the count of items after applying
    // `before`/`after`" — on a `before:`-cursored page it counts only the items OLDER
    // than the cursor, not the whole connection (live 2026-09-06 15:37Z on
    // bolt-wms#2120: page 1 = 311 with 250 nodes, page 2 = 61 — the first version of
    // this walk expected 311 again and threw "timeline changed during pagination",
    // failing the human-receipt check closed on the exact PR it was built to read).
    // Invariant: page N's filteredCount must equal the previous page's filteredCount
    // minus the previous page's node count. A mismatch means the connection changed
    // under the walk (an event landed mid-fetch) — refuse rather than stitch.
    if (filteredCount === null) {
      totalFilteredCount = conn.filteredCount;
    } else if (conn.filteredCount !== expectedRemaining) {
      throw new Error(
        `fetchAuthorityTimeline: timeline changed during pagination (expected ${expectedRemaining} items before the cursor, got ${conn.filteredCount}) for ${repo}#${prNumber}`,
      );
    }
    filteredCount = conn.filteredCount;
    expectedRemaining = conn.filteredCount - conn.nodes.length;
    collected.unshift(...conn.nodes);
    pages += 1;
    hasPreviousPage = conn.pageInfo.hasPreviousPage;
    if (hasPreviousPage) {
      if (typeof conn.pageInfo.startCursor !== "string" || conn.pageInfo.startCursor.length === 0) {
        throw new Error(`fetchAuthorityTimeline: GraphQL response claims a previous page but has no "pageInfo.startCursor" for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
      }
      if (conn.nodes.length === 0) {
        throw new Error(`fetchAuthorityTimeline: GraphQL response claims a previous page but returned an empty page for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
      }
      before = conn.pageInfo.startCursor;
    }
  }
  if (filteredCount === null) {
    throw new Error(`fetchAuthorityTimeline: no timeline page fetched for ${repo}#${prNumber}`);
  }
  if (totalFilteredCount < collected.length) {
    throw new Error(
      `fetchAuthorityTimeline: GraphQL response is internally inconsistent (filteredCount ${totalFilteredCount} < ` +
        `nodes.length ${collected.length}) for ${repo}#${prNumber}`,
    );
  }
  // `out` = the last page's raw text, quoted (truncated) in per-node shape errors below.
  const out = lastOut;
  const conn = { nodes: collected };
  const timeline: AuthorityTimelineItem[] = conn.nodes.map((node, index) => {
    const type = TIMELINE_TYPENAME_MAP[node.__typename];
    if (!type) {
      // Should be structurally impossible given the `itemTypes:` filter in the query
      // above — if GitHub ever returns a node outside that set, fail closed rather
      // than silently drop or mis-map it into the wrong bucket (Rule #4).
      throw new Error(`fetchAuthorityTimeline: unrecognized timeline node __typename "${node.__typename}" for ${repo}#${prNumber}`);
    }

    // Per-node shape validation (codex P1, ops#190 A1 review pass 2): the
    // connection-level `nodes`/`totalCount` check above only proves the ENVELOPE is
    // trustworthy — it says nothing about each individual node's `label`/`actor`
    // sub-object, which the `as GraphQLTimelineResponse` cast also never
    // runtime-checks. A LABELED/UNLABELED node with a missing or non-string
    // `label.name` would silently map to `label: undefined` below, which
    // `evaluateLabelAuthority`'s walk cannot distinguish from "an event for some
    // other, irrelevant label" — it would simply skip a node that might actually
    // have been an unauthorized relabel of `box` this function failed to
    // parse, leaving an EARLIER (possibly stale) authorized event looking like the
    // surviving authorization. A LABELED node additionally needs a trustworthy
    // `actor.login` — an actor-less LabeledEvent can never correctly pass the
    // roster/bot check, so it must be refused outright rather than silently treated
    // as "no actor, so ignore." UNLABELED events don't need a trustworthy actor:
    // removing a label only ever narrows authorization regardless of who removed
    // it, so an untrustworthy actor there isn't security-relevant — only requiring
    // `label.name` there (not `actor.login`) avoids over-refusing on a field the
    // predicate doesn't rely on for that event type (Rule #4: refuse on doubt about
    // what's SECURITY-RELEVANT, not on every optional field the query happens to ask
    // for). `PULL_REQUEST_COMMIT`/`HEAD_REF_FORCE_PUSHED` nodes carry neither field
    // per the query's fragment selection above, so neither check applies to them.
    if (type === "LABELED" || type === "UNLABELED") {
      if (typeof node.label?.name !== "string" || node.label.name.length === 0) {
        throw new Error(
          `fetchAuthorityTimeline: timeline node at position ${index} (${node.__typename}) has a ` +
            `missing or non-string "label.name" for ${repo}#${prNumber}: ${out.slice(0, 500)}`,
        );
      }
    }
    if (type === "LABELED" && (typeof node.actor?.login !== "string" || node.actor.login.length === 0)) {
      throw new Error(
        `fetchAuthorityTimeline: LabeledEvent node at position ${index} has a missing or non-string ` +
          `"actor.login" for ${repo}#${prNumber}: ${out.slice(0, 500)}`,
      );
    }
    // createdAt (ops-pipeline#172 rung 1): only requested on the LabeledEvent
    // fragment, and only consumed by the restart-train worker as a FIFO sort key —
    // never by this predicate's authority/staleness reasoning (that stays
    // position-based, per the header comment on AuthorityTimelineItem.createdAt
    // above). Validated with the same missing-or-non-string-fails-closed convention
    // as label.name/actor.login immediately above, rather than silently mapping an
    // absent value to `undefined` and letting a malformed FIFO key surface later as
    // an inscrutable `Date.parse(undefined)` NaN in the caller.
    if (type === "LABELED" && (typeof node.createdAt !== "string" || node.createdAt.length === 0)) {
      throw new Error(
        `fetchAuthorityTimeline: LabeledEvent node at position ${index} has a missing or non-string ` +
          `"createdAt" for ${repo}#${prNumber}: ${out.slice(0, 500)}`,
      );
    }

    return {
      type,
      label: node.label?.name ?? undefined,
      actorLogin: normalizeActorLogin(node.actor),
      position: index,
      createdAt: node.createdAt ?? undefined,
    };
  });
  // Truncation = a previous page still exists past the page bound (relevant events
  // exist BEFORE the assembled window) OR `filteredCount` exceeds what was assembled
  // (the connection knows of relevant events the pipeline never delivered). Either way
  // the authorizing event cannot be reliably located, and the evaluator refuses.
  return { timeline, truncated: hasPreviousPage || totalFilteredCount > timeline.length };
}

/**
 * Removes a stale `box` label (doc §3.1 step 3 / the stale-label removal
 * leg). Called by `evaluateTrainReady` when `evaluateLabelAuthority` returns
 * `reason: "stale-label"` — never merges, never touches any other label.
 */
export function removeStaleReadyLabel(repo: string, prNumber: number, label: string = TRAIN_READY_LABEL): void {
  gh(["pr", "edit", String(prNumber), "--repo", repo, "--remove-label", label]);
}

/**
 * Posts a receipt comment on the PR. WRITE-ONLY (doc §3.3): this is the only place in
 * the "automerge b+A v2" program that produces a receipt, and nothing anywhere in
 * this repo (or any caller) ever parses a receipt comment's body back into a
 * decision — that was v1's D2 defect (a receipt as the ONLY record, forgeable and
 * losable). Every receipt exists purely for human/audit visibility. Never key any
 * future logic off this text.
 */
export function postAuthorityReceipt(repo: string, prNumber: number, body: string): void {
  gh(["pr", "comment", String(prNumber), "--repo", repo, "--body", body]);
}

// ───────────────────── code-fix label flap circuit-breaker ─────────────────────
//
// WHY (bolt-wms#2120, 2026-09-06): the squasher gate's standard-repo code-fix path
// applies `automerge:code-fix` BEFORE the merge (the B2 tripwire's trigger filter),
// then revalidates the PR as its last act before merging. That label write is NOT
// inert. A repo whose CI listens on `pull_request: [labeled, unlabeled]` — bolt-wms's
// `Require review label` does exactly that — wakes a FRESH check-run on the label
// event. `isRollupClean` then correctly reads that queued run as non-terminal
// (fail-closed on in-flight work), the revalidate reports `merge readiness
// regressed`, the gate aborts and REMOVES the label it just added, and the unlabel
// event wakes another run. The gate invalidates its own revalidate.
//
// Each invocation is individually correct and fail-closed. What is missing is any
// memory that this PR already burned a cycle, so a repeat invoker churns without
// bound: bolt-wms#2120 took ~975 add/remove pairs between 06:07:55Z and 07:04:43Z,
// driving 1,169 Actions runs in under 8 hours against a 367-run FULL-DAY baseline
// (2026-09-05), plus ~4k API calls against a 5,000/hr PAT quota. The loop ended only
// when that quota ran out.
//
// This predicate gives the gate that memory, read from the PR's OWN timeline rather
// than any local state: count `automerge:code-fix` LABELED events since the last
// head move. Past the threshold the gate refuses to write the label again and hands
// the PR to a human. Per this module's doctrine it reasons from `position` (timeline
// ORDER), never a timestamp comparison, and a truncated window fails closed.

/** Adds of the merge label against ONE head before the gate stops writing it. Three
 *  tolerates a genuine retry (a re-run after a real transient) while catching a loop
 *  long before it can spend an Actions budget. */
export const CODE_FIX_FLAP_THRESHOLD = 3;

export type FlapVerdict =
  | { flapping: false; addsSinceHeadMove: number }
  /** `addsSinceHeadMove: null` = the count is UNKNOWN (truncated window), not zero. */
  | { flapping: true; addsSinceHeadMove: number | null; detail: string };

/**
 * True iff this PR's own timeline shows the merge label being applied repeatedly
 * against the SAME head — the signature of the self-invalidating revalidate above.
 *
 * Scoped deliberately to "since the last head move": a push or force-push is a new
 * subject, and the count resets with it. That keeps a legitimately-retried PR
 * mergeable while a stuck one stops burning CI.
 *
 * `truncated` fails closed (same contract as `evaluateLabelAuthority`) and is also
 * substantively right here: >250 relevant events on one PR is itself churn evidence.
 */
export function codeFixLabelFlap(
  input: { timeline: readonly AuthorityTimelineItem[]; truncated: boolean },
  mergeLabel: string,
  threshold: number = CODE_FIX_FLAP_THRESHOLD,
): FlapVerdict {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`codeFixLabelFlap: threshold must be a positive integer, got ${JSON.stringify(threshold)}`);
  }
  if (input.truncated) {
    return {
      flapping: true,
      addsSinceHeadMove: null,
      detail:
        `the GraphQL timeline fetch was truncated (more than ${AUTHORITY_TIMELINE_PAGE_SIZE} relevant events) — ` +
        `the number of \`${mergeLabel}\` applications against this head cannot be counted inside an incomplete ` +
        `window, and a PR with that many label/commit events is itself churn evidence.`,
    };
  }

  // Sort defensively: the caller's contract is chronological order, but every
  // conclusion below depends on it, so this function does not merely trust it.
  const ordered = [...input.timeline].sort((a, b) => a.position - b.position);

  let lastHeadMove = Number.NEGATIVE_INFINITY;
  for (const item of ordered) {
    if (item.type === "PULL_REQUEST_COMMIT" || item.type === "HEAD_REF_FORCE_PUSHED") {
      lastHeadMove = item.position;
    }
  }

  const addsSinceHeadMove = ordered.filter(
    (item) => item.type === "LABELED" && item.label === mergeLabel && item.position > lastHeadMove,
  ).length;

  if (addsSinceHeadMove >= threshold) {
    return {
      flapping: true,
      addsSinceHeadMove,
      detail:
        `\`${mergeLabel}\` has been applied ${addsSinceHeadMove} times against the current head (threshold ` +
        `${threshold}) with no push in between. That is the self-invalidating-revalidate loop: the label write ` +
        `wakes a \`pull_request: [labeled]\` check-run, the fresh non-terminal run deltas the revalidate, the ` +
        `gate removes the label, and the unlabel wakes another run. Refusing to write it again — a human decides ` +
        `this merge, and the repo's label-triggered CI is the thing to fix.`,
    };
  }

  return { flapping: false, addsSinceHeadMove };
}

/**
 * Formats the write-only receipt posted when a stale ready label is removed.
 * Pure (no I/O) — `evaluateTrainReady` calls this to build the body, then passes the
 * result to `postAuthorityReceipt`.
 *
 * `label` is the re-apply guidance (always the canonical `box` post-2026-09-15 — new
 * words are never written in the old spelling). `removed` names the spelling(s) the
 * caller actually stripped, which during the transition week can be the `queued`
 * alias — the receipt's first line is a claim about what was REMOVED (#412), so it
 * names that, never the canonical spelling by default.
 */
export function formatStaleLabelRemovalReceipt(verdict: StaleLabelAuthorityVerdict, headRefOid: string, label: string = TRAIN_READY_LABEL, removed?: string): string {
  return [
    `**\`${removed ?? label}\` removed — stale label** (label-authority v2, ops#190 rung A1)`,
    "",
    verdict.detail,
    "",
    `Evaluated sha: \`${headRefOid}\`.`,
    "",
    `This comment is a write-only receipt — no automation reads it back. Re-apply \`${label}\` after reviewing the new head to requeue.`,
  ].join("\n");
}
