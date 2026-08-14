/**
 * needs-human-router-lib.ts — pure decision logic for the ops-pipeline#66 router (Kevin ruling
 * 2026-08-14: "auto-route immediately" — the reaction is a BRAKE, never a gate).
 *
 * Origin: the needs-human diagnostic probe (ops-pipeline#20) posts a hypothesis on an escalated
 * issue; Kevin's 👍 had no machine on the other end (#66's incident — a probe correctly routed
 * a bug cross-repo, he reacted, and it sat parked 2 days). The fix is NOT "wait for approval" —
 * per the design comment (issue #66, CTO seat 2026-08-14 ~03:45Z) it is autopilot: route on the
 * probe's own trailer immediately; a 👎 from an authorized human recalls/rejects it after the
 * fact. This file is the decision half — zero I/O, mirroring every other reconcile lib in this
 * repo (credential-reconcile.ts, gateway-token-reconcile.ts, railway-volume-reconcile.ts).
 *
 * Two entry points, matching the design comment's two passes:
 *   - `routeDisposition` — the MAIN per-issue pass, over open `needs-human`-labeled issues.
 *   - `recallDisposition` — the RECALL pass, over issues found via reaction search (a same-repo
 *     route REMOVES the `needs-human` label, so a late 👎 on an already-routed issue is
 *     invisible to the main pass by construction — the recall leg is how it still gets caught).
 *
 * Both compose `parseProbeRouting` from needs-human-probe-lib.ts (the trailer parser) rather
 * than re-parsing — ONE place owns the trailer grammar.
 */

import { parseProbeRouting } from "./needs-human-probe-lib.js";

/** Posted once a same-repo route (or a pre-routing rejection) has happened — the load-bearing
 * dedup state for the MAIN pass (design comment step 1) and what the RECALL pass searches for. */
export const ROUTE_RECEIPT_MARKER = "<!-- needs-human-router:v1 -->";

/** Posted once for a hold (NEEDS-KEVIN or cross-repo) — deliberately a DIFFERENT marker than
 * ROUTE_RECEIPT_MARKER so a held issue never reads as routed (it keeps its `needs-human` label
 * and is re-evaluated every run; only the RECEIPT COMMENT itself is deduped by this marker). */
export const HOLD_RECEIPT_MARKER = "<!-- needs-human-router:hold:v1 -->";

export function hasRouteReceipt(commentBodies: string[]): boolean {
  return commentBodies.some((b) => b.includes(ROUTE_RECEIPT_MARKER));
}

export function hasHoldReceipt(commentBodies: string[]): boolean {
  return commentBodies.some((b) => b.includes(HOLD_RECEIPT_MARKER));
}

/**
 * Either marker present = "the router has already acted on this issue at least once." Used by
 * the RECALL pass: a same-repo-routed issue lost its `needs-human` label, so searching by label
 * can never find it again — this is the predicate the recall pass's reaction-search candidates
 * are filtered against instead (design comment step 5).
 */
export function hasAnyRouterReceipt(commentBodies: string[]): boolean {
  return hasRouteReceipt(commentBodies) || hasHoldReceipt(commentBodies);
}

export interface Reactor {
  /** GitHub reaction content: "+1" | "-1" | ... — only "-1" (👎) is ever load-bearing here. */
  content: string;
  login: string;
}

/**
 * Rule #398: a reaction is origin-signed (it really did traverse GitHub's API) but that is not
 * authorization — only an org member's 👎 is a brake. `orgMembers` is resolved by the CALLER
 * (an `orgs/{org}/members/{login}` probe, I/O) so this stays pure and directly testable for the
 * "unauthorized reactor is ignored" case (chip A's #398 test) without any network mocking.
 */
export function hasAuthorizedDisapproval(reactors: Reactor[], orgMembers: Set<string>): boolean {
  return reactors.some((r) => r.content === "-1" && orgMembers.has(r.login));
}

export type RouterDisposition =
  | { kind: "skip-already-routed" }
  | { kind: "close-rejected" }
  | { kind: "hold-needs-kevin" }
  | { kind: "route-same-repo" }
  | { kind: "hold-cross-repo"; target: string; targetAllowed: boolean }
  | { kind: "no-probe" };

export interface RouterDecisionInput {
  /** The caller enumerates OPEN needs-human issues only (design comment's per-repo loop) — this
   * exists as a defensive guard, not a real branch: an issue reaching here closed is never
   * actionable, so it resolves the same way an already-routed issue does (nothing to do). */
  isOpen: boolean;
  hasRouteReceiptMarker: boolean;
  /** Raw probe comment body (identified by the caller via PROBE_MARKER), or null when no probe
   * comment exists yet. Parsing happens HERE (via parseProbeRouting) so the trailer grammar has
   * exactly one owner. */
  probeCommentBody: string | null;
  /** Pre-resolved via hasAuthorizedDisapproval() above, over whatever comments exist BEFORE any
   * routing (the probe comment — a receipt cannot exist yet on this path, since step 1 already
   * short-circuited when it does). */
  hasAuthorizedDisapproval: boolean;
  /** Fully-qualified "studio-b-ai/<repo>" allowlist — the v1 covered-repo set. */
  allowlist: Set<string>;
  /** The caller's own fully-qualified repo — used to normalize a cross-repo trailer that
   * (degenerately) names the repo the issue already lives in. */
  ownRepo: string;
}

/**
 * The MAIN per-issue decision (design comment steps 1-4), evaluated for every open
 * `needs-human`-labeled issue in the caller's own repo.
 *
 * Order is load-bearing, not incidental:
 *   1. Already routed (ROUTE_RECEIPT_MARKER present) -> skip, UNCONDITIONALLY — a later 👎 on an
 *      already-routed issue is the RECALL pass's job (recallDisposition below), never this
 *      function's. Checking disapproval here too would let the two passes race the same signal.
 *   2. Authorized 👎, pre-routing -> close-rejected. This is the ONE place the brake acts in the
 *      main pass, and only because a human actually pressed it before routing ran.
 *   3. No probe comment yet -> no-probe (counted, never mutated — #331).
 *   4. Parse the trailer. `null` (no trailer / legacy comment) defaults to same-repo +
 *      needsKevin:false per the design comment (the standing ~21 pre-trailer probes; same-repo
 *      relabeling is the lowest-blast-radius action and self-correcting at fold time). Otherwise
 *      NEEDS-KEVIN:yes always wins regardless of ROUTING (a same-repo fix can still need a human
 *      — the design comment's step-3 bullets are checked in exactly this order: NEEDS-KEVIN
 *      first, then same-repo, then cross-repo).
 *
 * A cross-repo target equal to the caller's OWN repo is a degenerate same-repo case (the probe
 * naming the repo the issue already lives in) — normalized to route-same-repo rather than held
 * forever waiting for a fleet write token it never needed. v1 has no fleet App token at all
 * (verified in the design comment), so every OTHER cross-repo case holds regardless of allowlist
 * membership — `targetAllowed` is carried through purely so an off-allowlist target can be
 * flagged for review, never to trigger an action against the named repo (Rule #184: no
 * cross-repo writes in v1, full stop).
 */
export function routeDisposition(input: RouterDecisionInput): RouterDisposition {
  if (!input.isOpen) return { kind: "skip-already-routed" };
  if (input.hasRouteReceiptMarker) return { kind: "skip-already-routed" };
  if (input.hasAuthorizedDisapproval) return { kind: "close-rejected" };
  if (input.probeCommentBody === null) return { kind: "no-probe" };

  const parsed = parseProbeRouting(input.probeCommentBody);
  if (parsed === null) return { kind: "route-same-repo" }; // legacy default

  if (parsed.needsKevin) return { kind: "hold-needs-kevin" };
  if (parsed.routing === "same-repo") return { kind: "route-same-repo" };
  if (parsed.target === input.ownRepo) return { kind: "route-same-repo" }; // degenerate self-reference

  return { kind: "hold-cross-repo", target: parsed.target, targetAllowed: input.allowlist.has(parsed.target) };
}

export type RouterDispositionKind = RouterDisposition["kind"];

const ALL_DISPOSITION_KINDS: RouterDispositionKind[] = [
  "skip-already-routed",
  "close-rejected",
  "hold-needs-kevin",
  "route-same-repo",
  "hold-cross-repo",
  "no-probe",
];

/**
 * Per-disposition counts for the run summary — ALWAYS includes every disposition kind at 0 when
 * absent this run (Rule #465: a summary line that silently omits a zero-count disposition reads
 * as "that case doesn't exist" rather than "zero issues hit it this run"). Also the natural home
 * for the "empty issue set -> no actions" guarantee: summarizeDispositions([]) is all zeros.
 */
export function summarizeDispositions(dispositions: RouterDisposition[]): Record<RouterDispositionKind, number> {
  const counts = Object.fromEntries(ALL_DISPOSITION_KINDS.map((k) => [k, 0])) as Record<RouterDispositionKind, number>;
  for (const d of dispositions) counts[d.kind] += 1;
  return counts;
}

export interface RecallDecisionInput {
  /** hasAnyRouterReceipt() over the candidate issue's comments — proves the router already
   * acted (route OR hold) at least once, which is what makes this a recall candidate at all. */
  hasReceiptMarker: boolean;
  hasAuthorizedDisapproval: boolean;
}

export type RecallDisposition = { kind: "close-rejected" } | { kind: "none" };

/**
 * The RECALL pass (design comment step 5): "👎 recalls after the fact." Evaluated only for
 * issues the caller found via reaction search (NOT the label-based enumeration a same-repo route
 * removes the issue from) that already carry a router receipt. Trivial by design — the hard part
 * (finding the right candidate set at all) is the caller's I/O, not this function's job.
 */
export function recallDisposition(input: RecallDecisionInput): RecallDisposition {
  if (input.hasReceiptMarker && input.hasAuthorizedDisapproval) return { kind: "close-rejected" };
  return { kind: "none" };
}
