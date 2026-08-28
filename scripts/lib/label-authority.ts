/**
 * label-authority.ts — ops#190 rung A1: the `train:ready` label-authority predicate,
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

export const TRAIN_READY_LABEL = "train:ready";
export const TRAIN_HOLD_LABEL = "train:hold";

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
   *  labels`), independent of the timeline. `train:hold`/`train:ready` presence is
   *  read from HERE, never inferred from the timeline walk. */
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
  | { authorized: true; authorizingEvent: { actorLogin: string; position: number } };

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
 *   1. `train:ready` present AND `train:hold` absent in `currentLabels` — hold wins,
 *      ALWAYS, checked before anything else (a PR can be ready-labeled and
 *      simultaneously held; hold must win the reported reason too, not just the
 *      outcome).
 *   2. Walk the timeline's LABELED/UNLABELED events for `train:ready` in order,
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

  // ── Step 1: label state, read DIRECTLY from currentLabels (no timeline dependency
  // at all) — checked first because it's the cheapest possible check and because
  // "hold wins, always" must win the REPORTED REASON too, not just the boolean
  // outcome, even in a (should-never-happen) state where train:ready is also absent.
  if (currentLabels.includes(TRAIN_HOLD_LABEL)) {
    return { authorized: false, reason: "hold-present", detail: `${TRAIN_HOLD_LABEL} is present on the PR — hold wins, always, regardless of any other leg.` };
  }
  if (!currentLabels.includes(TRAIN_READY_LABEL)) {
    return { authorized: false, reason: "no-ready-label", detail: `${TRAIN_READY_LABEL} is not present in the PR's current labels.` };
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
    // train:ready is present per currentLabels (checked above), yet there is no
    // server-attributed event at all to point to as its authorizing LabeledEvent —
    // never trust the label's mere presence without an event trail behind it.
    return {
      authorized: false,
      reason: "no-authorizing-event",
      detail: `${TRAIN_READY_LABEL} is present on the PR but the timeline returned zero LABELED/UNLABELED/commit/force-push events to attribute it to.`,
    };
  }

  // ── Step 2: walk LABELED/UNLABELED events for train:ready, in the given order, to
  // find the current surviving applier — "the LAST LabeledEvent with no subsequent
  // UnlabeledEvent for it". A later relabel by a DIFFERENT actor correctly supersedes
  // an earlier one; an intervening unlabel-then-relabel is exactly "last event wins".
  let currentApplier: AuthorityTimelineItem | null = null;
  for (const item of timeline) {
    if (item.label !== TRAIN_READY_LABEL) continue;
    if (item.type === "LABELED") {
      currentApplier = item;
    } else if (item.type === "UNLABELED") {
      currentApplier = null;
    }
  }

  if (!currentApplier) {
    // currentLabels says train:ready is applied, but no net-surviving LABELED event
    // for it exists in this (complete, non-truncated, non-empty) timeline — an
    // inconsistent state (e.g. GraphQL replication lag, or the label was set through
    // some path that doesn't emit a timeline event). Fail closed rather than assume
    // authorization from label presence alone.
    return {
      authorized: false,
      reason: "no-authorizing-event",
      detail: `${TRAIN_READY_LABEL} is present on the PR but no LabeledEvent for it survives to the end of the timeline walk (every LabeledEvent found was superseded by a later UnlabeledEvent).`,
    };
  }

  const actorLogin = currentApplier.actorLogin ?? "";

  // Bot check FIRST, unconditionally — before the roster check — so that a bot login
  // is refused even if some future misconfiguration puts a bot string inside the
  // roster passed as `authorityLogins` (doc FORBIDDEN: "ANY actorLogin ending in
  // [bot] refused categorically").
  if (actorLogin.endsWith("[bot]")) {
    return {
      authorized: false,
      reason: "bot-actor",
      detail: `the authorizing ${TRAIN_READY_LABEL} LabeledEvent (position ${currentApplier.position}) was applied by "${actorLogin}", a bot actor — bots are refused categorically, roster membership is irrelevant.`,
    };
  }

  if (!authorityLogins.includes(actorLogin)) {
    return {
      authorized: false,
      reason: "unauthorized-actor",
      detail: `the authorizing ${TRAIN_READY_LABEL} LabeledEvent (position ${currentApplier.position}) was applied by "${actorLogin}", which is not in the effective authority roster [${authorityLogins.join(", ")}].`,
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
    return {
      authorized: false,
      reason: "stale-label",
      detail: `a ${staleItem.type} event at position ${staleItem.position} sits AFTER the authorizing ${TRAIN_READY_LABEL} LabeledEvent at position ${currentApplier.position} (applied by "${actorLogin}") — the code changed after authorization was granted.`,
    };
  }

  return { authorized: true, authorizingEvent: { actorLogin, position: currentApplier.position } };
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

const AUTHORITY_TIMELINE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(
        itemTypes: [LABELED_EVENT, UNLABELED_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]
        last: ${AUTHORITY_TIMELINE_PAGE_SIZE}
      ) {
        filteredCount
        pageInfo { hasPreviousPage }
        nodes {
          __typename
          ... on LabeledEvent { label { name } actor { login } createdAt }
          ... on UnlabeledEvent { label { name } actor { login } }
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
          pageInfo?: { hasPreviousPage?: boolean | null } | null;
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
export function fetchAuthorityTimeline(repo: string, prNumber: number): { timeline: AuthorityTimelineItem[]; truncated: boolean } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`fetchAuthorityTimeline: repo must be "org/repo", got ${JSON.stringify(repo)}`);
  }

  const out = gh([
    "api",
    "graphql",
    "-f",
    `query=${AUTHORITY_TIMELINE_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${name}`,
    "-F",
    `number=${prNumber}`,
  ]);

  const parsed = JSON.parse(out) as GraphQLTimelineResponse;
  const conn = parsed.data?.repository?.pullRequest?.timelineItems;
  if (!conn) {
    // Fail closed on any unexpected shape (missing PR, missing repo, a GraphQL
    // `errors` response `gh api graphql` didn't already turn into a non-zero exit) —
    // never silently degrade to "empty timeline", which a caller cannot distinguish
    // from a genuinely-empty relevant window (Rule #4).
    throw new Error(`fetchAuthorityTimeline: unexpected GraphQL response shape for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
  }

  // Fail closed on a malformed/untrustworthy connection shape rather than trust the
  // compile-time `as GraphQLTimelineResponse` assertion above at runtime (codex P1,
  // ops#190 A1 review): `JSON.parse` + `as` performs ZERO runtime validation, so a
  // missing, null, or non-numeric `filteredCount` would silently coerce
  // `conn.filteredCount > timeline.length` below to `false` (e.g. `undefined > 5` is
  // `false`, and `null > 5` is also `false` since `null` coerces to `0`) — reporting
  // NOT-truncated on a response this function has no trustworthy signal about, which
  // `evaluateLabelAuthority` could then walk as if it were a complete, reliable
  // window. Same reasoning for `nodes` not actually being an array at runtime, for
  // `pageInfo.hasPreviousPage` not actually being a boolean (a missing pageInfo must
  // refuse, never read as "no previous page"), and for a `filteredCount` smaller than
  // the node count actually received (internally inconsistent — the FILTERED count can
  // never be less than the nodes the same filtered query returned). Any of these
  // throws, matching this function's existing throw-on-untrustworthy-shape convention
  // immediately above and in the unrecognized-`__typename` branch below (Rule #4:
  // doubt resolves toward refusal — the caller's fail-closed error handling, not this
  // function, decides the outcome).
  if (!Array.isArray(conn.nodes)) {
    throw new Error(`fetchAuthorityTimeline: GraphQL response "nodes" is not an array for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
  }
  if (typeof conn.filteredCount !== "number" || !Number.isFinite(conn.filteredCount) || conn.filteredCount < 0) {
    throw new Error(`fetchAuthorityTimeline: GraphQL response "filteredCount" is not a valid non-negative number for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
  }
  if (typeof conn.pageInfo?.hasPreviousPage !== "boolean") {
    throw new Error(`fetchAuthorityTimeline: GraphQL response "pageInfo.hasPreviousPage" is not a boolean for ${repo}#${prNumber}: ${out.slice(0, 500)}`);
  }
  if (conn.filteredCount < conn.nodes.length) {
    throw new Error(
      `fetchAuthorityTimeline: GraphQL response is internally inconsistent (filteredCount ${conn.filteredCount} < ` +
        `nodes.length ${conn.nodes.length}) for ${repo}#${prNumber}`,
    );
  }

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
    // have been an unauthorized relabel of `train:ready` this function failed to
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
      actorLogin: node.actor?.login ?? undefined,
      position: index,
      createdAt: node.createdAt ?? undefined,
    };
  });

  // Truncation = `pageInfo.hasPreviousPage` (the connection's own windowing signal:
  // relevant events exist BEFORE this `last: N` window) OR `filteredCount >
  // timeline.length` as a belt-and-suspenders inconsistency guard. Deliberately NOT
  // `totalCount`: live-proven 2026-08-28 (studiob#613, train run 33218268263 +
  // three direct GraphQL probes) that `totalCount` on `timelineItems` counts the
  // UNFILTERED timeline — it ignores the `itemTypes:` argument — so any ordinary
  // issue comment (including the train's OWN CLICK DUE receipt comment) pushes it
  // past `nodes.length` on a complete window, permanently fail-closing a healthy PR
  // as "timeline-truncated" one tick after the train itself comments. Probe receipt:
  // filteredCount:2 / nodes:2 / hasPreviousPage:false / totalCount:3 on a PR with 2
  // relevant events + 1 comment. `filteredCount` respects the filter, and comparing
  // it against the ACTUAL returned count (not the literal page-size constant) still
  // catches the should-never-happen short-page case (Rule #4: doubt resolves toward
  // refusal — but a signal proven to fire on healthy PRs is a false-refusal
  // generator, not conservatism; Rule #471's planted GOOD control caught this).
  return { timeline, truncated: conn.pageInfo.hasPreviousPage === true || conn.filteredCount > timeline.length };
}

/**
 * Removes a stale `train:ready` label (doc §3.1 step 3 / the stale-label removal
 * leg). Called by `evaluateTrainReady` when `evaluateLabelAuthority` returns
 * `reason: "stale-label"` — never merges, never touches any other label.
 */
export function removeStaleReadyLabel(repo: string, prNumber: number): void {
  gh(["pr", "edit", String(prNumber), "--repo", repo, "--remove-label", TRAIN_READY_LABEL]);
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

/**
 * Formats the write-only receipt posted when a stale `train:ready` label is removed.
 * Pure (no I/O) — `evaluateTrainReady` calls this to build the body, then passes the
 * result to `postAuthorityReceipt`.
 */
export function formatStaleLabelRemovalReceipt(verdict: StaleLabelAuthorityVerdict, headRefOid: string): string {
  return [
    "**`train:ready` removed — stale label** (label-authority v2, ops#190 rung A1)",
    "",
    verdict.detail,
    "",
    `Evaluated sha: \`${headRefOid}\`.`,
    "",
    "This comment is a write-only receipt — no automation reads it back. Re-apply `train:ready` after reviewing the new head to requeue.",
  ].join("\n");
}
