/**
 * Pure issue-reconcile decisions for gateway-token-watch.ts — GitHub issues ARE the alert
 * state (Kevin directive 2026-07-30: issues instead of Slack; the monitor auto-cleans them).
 * Open issue = condition active; closed = resolved. Extracted for negative-control tests
 * (Rule #322), mirroring gateway-token-classify.ts.
 */

export type ReconcileAction = "open" | "close" | "none";

/**
 * Straggler issue reconcile: condition active + no open issue → open; condition cleared +
 * open issue → close; otherwise leave alone (an already-open issue for an active condition
 * is NOT re-posted — the open issue is the dedup, Rules #292/#358 by construction).
 */
export function reconcileCondition(conditionActive: boolean, issueOpen: boolean): ReconcileAction {
  if (conditionActive && !issueOpen) return "open";
  if (!conditionActive && issueOpen) return "close";
  return "none";
}

/**
 * Revocation-gate issue reconcile. Differences from a plain condition:
 * - zero legacy tokens left (all revoked) → the gate is vacuous — never open, close if open;
 * - a PREVIOUSLY CLOSED gate issue is never reopened by "still green" (closing it is the
 *   human's ack; re-opening would nag — the issue only reopens if the gate goes CLOSED and
 *   then GREEN again, which shows up as a fresh open after the straggler episode's close).
 *   The caller passes `everClosed` = a closed gate issue exists.
 */
export function reconcileGate(
  gateGreen: boolean,
  legacyCount: number,
  issueOpen: boolean,
  everClosed: boolean,
): ReconcileAction {
  if (legacyCount === 0) return issueOpen ? "close" : "none";
  if (gateGreen && !issueOpen && !everClosed) return "open";
  if (!gateGreen && issueOpen) return "close";
  return "none";
}
