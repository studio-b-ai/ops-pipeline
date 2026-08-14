/**
 * needs-human-crossrepo-lib.ts — pure decision logic for the ops-pipeline#88 cross-repo
 * sweep (needs-human-crossrepo.ts). Zero I/O, mirroring needs-human-router-lib.ts and
 * every other reconcile lib in this repo.
 *
 * Origin: the same-repo router (ops-pipeline#66, needs-human-router.ts) already parses
 * the probe's machine trailer and, on a clean `ROUTING: cross-repo studio-b-ai/<repo>` +
 * `NEEDS-KEVIN: no` trailer, posts a HOLD receipt naming the target — v1 had no fleet
 * write credential, so cross-repo filing HELD rather than acted (Rule #184). Issue #88
 * shipped the fleet GitHub App that unlocks real cross-repo writes; this file is the
 * decision half of the sweep that resolves those holds.
 *
 * This lib does NOT re-implement trailer parsing — it composes `parseProbeRouting` from
 * needs-human-probe-lib.ts, the SAME function needs-human-router-lib.ts composes, so the
 * trailer grammar has exactly one owner regardless of which sweep is reading it.
 *
 * Scope discipline: this sweep acts ONLY on a clean, explicit cross-repo trailer.
 * Same-repo trailers, NEEDS-KEVIN:yes trailers, and unparseable/legacy comments (`null`
 * from parseProbeRouting) all resolve to `skip` here — those cases are the SAME-REPO
 * router's job (needs-human-router.ts already owns same-repo routing, the NEEDS-KEVIN
 * hold, and the documented legacy default), and re-deciding them here would let the two
 * sweeps race the same signal to different conclusions. The cross-repo sweep's entire
 * remit is the ONE case the same-repo router structurally cannot act on: filing the twin
 * issue in another repo.
 *
 * Marker + trust reuse (deliberate, not an oversight): `ROUTE_RECEIPT_MARKER` — imported
 * from needs-human-router-lib.ts, the SAME constant the same-repo router posts for its
 * own route-same-repo case — is also what this sweep posts on a successful cross-repo
 * route, and `isTrustedMarkerAuthor` (same import) now recognizes BOTH the same-repo
 * router's `github-actions[bot]` identity AND this sweep's own fleet-App-token identity
 * (ops-pipeline#88, codex review pass 1 P1 — a same-repo-router-only trust check meant
 * neither sweep could recognize the OTHER's receipts, which broke both self-recognition
 * on re-evaluation and 👎 detection on either sweep's own posted receipts). A shared,
 * mutually-trusted marker means the same-repo router's own RECALL pass (which searches
 * by REACTION, not by label, specifically because a route removes the `needs-human`
 * label) transparently also catches a late 👎 on an already-cross-repo-routed origin
 * issue and closes the ORIGIN — but it has no way to reach the TWIN, which lives in a
 * different repo it never looks at. This sweep therefore runs its OWN recall pass (the
 * script's job, not this file's — see `crossRepoRecallDisposition` below), keyed off a
 * MACHINE-READABLE twin pointer this sweep embeds inside its own route receipt
 * (`buildTwinPointer`/`extractTwinPointer`) so a post-routing 👎 can close both sides
 * even after the origin's `needs-human` label — and with it, this sweep's own label-based
 * enumeration — is long gone (ops-pipeline#88, codex review pass 1 P1 — "Handle rejected
 * already-routed twins").
 */

import { parseProbeRouting } from "./needs-human-probe-lib.js";

/** `ownRepo`/target values here are fully-qualified "studio-b-ai/<repo>". Returns just the
 * "<repo>" half — used for twin-title construction and human-facing short names. */
export function shortRepoName(fullyQualifiedRepo: string): string {
  const slashIdx = fullyQualifiedRepo.indexOf("/");
  return slashIdx === -1 ? fullyQualifiedRepo : fullyQualifiedRepo.slice(slashIdx + 1);
}

const TWIN_ORIGIN_TITLE_MAX = 80;

/** The idempotency KEY prefix — deliberately just `[from <short>#<n>]`, not the full twin
 * title, so a later human edit to the twin's title (or a truncation-length change here)
 * never breaks re-detection. See `twinExists` below, which matches on this prefix only. */
export function twinTitlePrefix(ownRepoShort: string, issueNumber: number): string {
  return `[from ${ownRepoShort}#${issueNumber}]`;
}

/**
 * Deterministic twin-issue title. `[from <ownRepo-short>#<n>] <origin title, truncated>`
 * — the prefix is the idempotency key (twinExists matches on it alone), the truncated
 * origin title is purely for human scanability in the target repo's issue list.
 */
export function buildTwinTitle(ownRepoShort: string, issueNumber: number, originTitle: string): string {
  const truncated =
    originTitle.length <= TWIN_ORIGIN_TITLE_MAX ? originTitle : `${originTitle.slice(0, TWIN_ORIGIN_TITLE_MAX - 1)}…`;
  return `${twinTitlePrefix(ownRepoShort, issueNumber)} ${truncated}`;
}

export interface TwinCandidate {
  number: number;
  title: string;
}

/**
 * Finds the twin among candidate issues in the target repo (the caller supplies
 * candidates via I/O — a `gh search issues ... in:title` pass PLUS a plain issue-list
 * title scan, search-index-lag tolerance; either source's rows can be passed in here
 * together). Matches on the `[from <short>#<n>]` PREFIX only — title-drift tolerant: a
 * human editing the twin's title after filing (or a future truncation-length change)
 * never breaks re-detection, since only the deterministic prefix is load-bearing.
 */
export function findTwinMatch<T extends TwinCandidate>(
  candidates: T[],
  ownRepoShort: string,
  issueNumber: number,
): T | undefined {
  const prefix = twinTitlePrefix(ownRepoShort, issueNumber);
  return candidates.find((c) => c.title.startsWith(prefix));
}

export function twinExists(candidates: TwinCandidate[], ownRepoShort: string, issueNumber: number): boolean {
  return findTwinMatch(candidates, ownRepoShort, issueNumber) !== undefined;
}

export type CrossRepoDisposition =
  | { kind: "skip" }
  | { kind: "close-rejected"; target: string; twinExists: boolean }
  | { kind: "file-cross-repo"; target: string }
  | { kind: "skip-twin-exists"; target: string }
  | { kind: "hold-invalid-target"; target: string };

export interface CrossRepoDecisionInput {
  /** The caller enumerates OPEN needs-human issues only — this exists as a defensive
   * guard, not a real branch, mirroring needs-human-router-lib.ts's identical field. */
  isOpen: boolean;
  /** ROUTE_RECEIPT_MARKER already present on this issue (imported from
   * needs-human-router-lib.ts — the SAME marker; see this file's header comment on
   * marker reuse). Checked FIRST and UNCONDITIONALLY, mirroring the same-repo router's
   * own step 1: an issue this sweep already routed (or that a prior partial run got as
   * far as posting the receipt for) is never re-filed, even if a fresh 👎 just landed —
   * a late 👎 on an already-routed issue is the SAME-REPO router's recall pass's job
   * (it shares this marker), not this function's. The one thing that pass can't reach
   * (closing the TWIN) is handled by the close-rejected branch below, which only fires
   * BEFORE this marker exists — see this file's header comment. */
  hasRouteReceiptMarker: boolean;
  /** Raw trusted probe comment body (identified by the caller via PROBE_MARKER, authored
   * by the trusted bot login), or null when no probe comment exists yet. Parsed HERE via
   * parseProbeRouting so the trailer grammar has exactly one owner. */
  probeCommentBody: string | null;
  /** Pre-resolved by the caller (mirrors needs-human-router-lib.ts's identical field):
   * true only for a 👎 from an AUTHORIZED reactor (Rule #398) on a trusted marker
   * comment (the probe comment or this sweep's own receipt) — never a raw reaction count. */
  hasAuthorizedDisapproval: boolean;
  /** The caller's own fully-qualified "studio-b-ai/<repo>" — used to normalize a
   * cross-repo trailer that (degenerately) names the repo the issue already lives in. */
  ownRepo: string;
  /** Fully-qualified "studio-b-ai/<repo>" allowlist — the v1 covered-repo set, doubling
   * as the cross-repo target allowlist. */
  allowlist: Set<string>;
  /** Whether a twin issue already exists in the (allowlisted) target — resolved by the
   * caller via `findTwinMatch`/`twinExists` over real search results. Only meaningful
   * (and only ever computed by the caller) once a clean cross-repo trailer names an
   * on-allowlist target; the caller is free to pass `false` unconditionally otherwise —
   * this function never reaches a branch that reads it in those cases. */
  twinExists: boolean;
}

/**
 * The per-issue cross-repo decision. Order is load-bearing (mirrors
 * needs-human-router-lib.ts's routeDisposition):
 *
 *   1. Not open / already routed (ROUTE_RECEIPT_MARKER present) -> skip, unconditionally.
 *   2. No probe comment yet -> skip (nothing to act on).
 *   3. Trailer doesn't parse cleanly (null — covers BOTH genuinely-legacy comments and
 *      malformed new-format attempts) -> skip. Unlike the same-repo router, this sweep
 *      NEVER falls back to a default for a `null` parse: the same-repo router already
 *      owns the documented legacy default (same-repo + needsKevin:false) for the
 *      standing pre-trailer comments, and a cross-repo action (filing a NEW issue in a
 *      DIFFERENT repo) is exactly the wrong place to guess from a broken or absent
 *      signal — the lowest-blast-radius default belongs to the same-repo path, not this
 *      one (Rule #167: never execute a prescription the diagnosis didn't actually make).
 *   4. NEEDS-KEVIN:yes -> skip (never act on a hold-for-Kevin issue, regardless of ROUTING).
 *   5. ROUTING:same-repo -> skip (not this sweep's job).
 *   6. Cross-repo target equal to the caller's own repo -> skip (degenerate
 *      self-reference; the same-repo router already normalizes this case itself).
 *   7. From here the trailer is a genuine, actionable cross-repo route. An authorized 👎
 *      pre-empts EVERYTHING below it — close-rejected, carrying whatever `twinExists`
 *      the caller resolved (so the caller knows whether to ALSO close a twin: relevant
 *      when a prior partial run already got as far as filing the twin — step (a) below —
 *      but never reached posting the receipt marker, so this function is still reachable
 *      at all with hasRouteReceiptMarker false).
 *   8. Target off the allowlist -> hold-invalid-target (never an action against the named
 *      repo — Rule #184 discipline: v1's static allowlist is the only thing this sweep
 *      is permitted to write to).
 *   9. Twin already exists (idempotency) -> skip-twin-exists. The caller's job, not this
 *      function's: complete any missing receipt/label-removal for the EXISTING twin,
 *      never file a second one.
 *  10. Otherwise -> file-cross-repo.
 */
export function crossRepoDisposition(input: CrossRepoDecisionInput): CrossRepoDisposition {
  if (!input.isOpen) return { kind: "skip" };
  if (input.hasRouteReceiptMarker) return { kind: "skip" };
  if (input.probeCommentBody === null) return { kind: "skip" };

  const parsed = parseProbeRouting(input.probeCommentBody);
  if (parsed === null) return { kind: "skip" }; // legacy or malformed — the same-repo router owns both defaults
  if (parsed.needsKevin) return { kind: "skip" };
  if (parsed.routing === "same-repo") return { kind: "skip" };
  if (parsed.target === input.ownRepo) return { kind: "skip" }; // degenerate self-reference

  const target = parsed.target;
  if (input.hasAuthorizedDisapproval) return { kind: "close-rejected", target, twinExists: input.twinExists };
  if (!input.allowlist.has(target)) return { kind: "hold-invalid-target", target };
  if (input.twinExists) return { kind: "skip-twin-exists", target };
  return { kind: "file-cross-repo", target };
}

export type CrossRepoDispositionKind = CrossRepoDisposition["kind"];

const ALL_CROSSREPO_DISPOSITION_KINDS: CrossRepoDispositionKind[] = [
  "skip",
  "close-rejected",
  "file-cross-repo",
  "skip-twin-exists",
  "hold-invalid-target",
];

/**
 * Per-disposition counts for the run summary — ALWAYS includes every kind at 0 when
 * absent this run (Rule #465: a summary that silently omits a zero-count disposition
 * reads as "that case doesn't exist" rather than "zero issues hit it this run"). Also
 * the natural home for the "empty issue set -> no actions" guarantee.
 */
export function summarizeCrossRepoDispositions(
  dispositions: CrossRepoDisposition[],
): Record<CrossRepoDispositionKind, number> {
  const counts = Object.fromEntries(ALL_CROSSREPO_DISPOSITION_KINDS.map((k) => [k, 0])) as Record<
    CrossRepoDispositionKind,
    number
  >;
  for (const d of dispositions) counts[d.kind] += 1;
  return counts;
}

// ───────────────────────────── twin pointer (recall pass idempotency key) ─────────────────────────────

/**
 * Embeds a MACHINE-READABLE pointer to the twin issue inside the origin's own
 * ROUTE_RECEIPT_MARKER receipt comment (ops-pipeline#88, codex review pass 1 P1 — "Handle
 * rejected already-routed twins"). This is what makes a post-routing 👎 recoverable: once
 * a fully-successful route removes the origin's `needs-human` label, the origin drops out
 * of the main pass's label-based enumeration FOREVER — the only way anything can still
 * find "which twin does this origin point to" is by reading this pointer back out of the
 * receipt itself. A prose/markdown-link parse of the human-facing receipt text would be
 * fragile (wording can change, links can get re-flowed); this is a dedicated, greppable
 * HTML-comment marker, the same idiom as PROBE_MARKER / ROUTE_RECEIPT_MARKER /
 * HOLD_RECEIPT_MARKER. It also DISAMBIGUATES which mechanism posted a given
 * ROUTE_RECEIPT_MARKER comment: the same-repo router's own route-same-repo receipt shares
 * the marker but NEVER embeds this pointer, since it never files a twin at all.
 */
export function buildTwinPointer(target: string, twinNumber: number): string {
  return `<!-- needs-human-crossrepo:twin:${target}#${twinNumber} -->`;
}

const TWIN_POINTER_RE = /<!-- needs-human-crossrepo:twin:([\w.-]+\/[\w.-]+)#(\d+) -->/;

export interface TwinPointer {
  target: string;
  number: number;
}

/** Extracts the pointer `buildTwinPointer` embeds, or null when absent (a same-repo
 * route's receipt, a hold receipt, or any comment that never carried one). Used by the
 * cross-repo sweep's own recall pass to (a) identify that a receipt was posted by THIS
 * sweep specifically, and (b) know which twin to close — no I/O re-search needed, unlike
 * the main pass's file-cross-repo idempotency check. */
export function extractTwinPointer(commentBody: string): TwinPointer | null {
  const m = commentBody.match(TWIN_POINTER_RE);
  if (!m?.[1] || !m[2]) return null;
  return { target: m[1], number: Number(m[2]) };
}

// ───────────────────────────── recall pass (post-routing 👎) ─────────────────────────────

export interface CrossRepoRecallDecisionInput {
  /** A TRUSTED ROUTE_RECEIPT_MARKER comment is present on this issue AND carries a twin
   * pointer (extractTwinPointer non-null) — i.e., THIS sweep routed this origin
   * specifically, as opposed to the same-repo router's own route-same-repo case (which
   * shares the marker but never embeds a pointer). The caller resolves this by finding
   * the receipt and calling extractTwinPointer on it — see needs-human-crossrepo.ts. */
  hasCrossRepoRouteReceipt: boolean;
  hasAuthorizedDisapproval: boolean;
}

export type CrossRepoRecallDisposition = { kind: "close-rejected" } | { kind: "none" };

/**
 * The cross-repo sweep's own recall pass (ops-pipeline#88, codex review pass 1 P1),
 * mirroring needs-human-router-lib.ts's `recallDisposition` exactly in shape and for the
 * same reason: a completed route removes the `needs-human` label, so a late 👎 on an
 * already-routed issue is invisible to any label-based main pass by construction — a
 * reaction-search-based recall pass is the only way to find it again. Evaluated only for
 * issues the caller found via that search AND that already carry this sweep's own route
 * receipt (with a twin pointer). Unlike the same-repo router's recall pass (which can
 * only reach the origin), the caller here also has the twin pointer and closes BOTH.
 */
export function crossRepoRecallDisposition(input: CrossRepoRecallDecisionInput): CrossRepoRecallDisposition {
  if (input.hasCrossRepoRouteReceipt && input.hasAuthorizedDisapproval) return { kind: "close-rejected" };
  return { kind: "none" };
}
