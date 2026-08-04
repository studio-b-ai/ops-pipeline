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
 * Why the revocation-gate issue closed. The two causes mean OPPOSITE things, so the close
 * comment must say which (ops-pipeline#32, Rule #412):
 *
 *   - `legacy-set-empty` — every legacy token is revoked. The job is DONE; this is the
 *                          receipt the gate issue exists to produce.
 *   - `gate-un-greened`  — a straggler was used again. Legacy tokens REMAIN, and revoking
 *                          them now would break a live consumer.
 *
 * Before this discriminant existed, `reconcileGate` returned a bare "close" and the caller
 * emitted one comment covering both: "a straggler appeared or the legacy set changed". On
 * 2026-08-04 that disjunction caused a sibling session to read a COMPLETED revocation as a
 * regression and pull the already-executed command off Kevin's queue.
 */
export type GateCloseReason = "legacy-set-empty" | "gate-un-greened";

export interface GateReconcile {
  action: ReconcileAction;
  /** Set only when `action === "close"`; `null` otherwise. */
  reason: GateCloseReason | null;
}

/**
 * Revocation-gate issue reconcile. Differences from a plain condition:
 * - zero legacy tokens left (all revoked) → the gate is vacuous — never open, close if open;
 * - a PREVIOUSLY CLOSED gate issue is not reopened by "still green" (closing it is the
 *   human's ack; re-opening would nag). The caller passes `everClosed` = a closed gate issue
 *   exists.
 *
 * WARNING: `everClosed` is MONOTONIC — a closed issue stays closed forever, so once this gate
 * has been acked it can never re-open, including after a genuine CLOSED→GREEN cycle. That is
 * a SEPARATE defect from the one this discriminant fixes; see ops-pipeline#34. Do not write a
 * close comment promising the issue will reopen — it will not.
 */
export function reconcileGate(
  gateGreen: boolean,
  legacyCount: number,
  issueOpen: boolean,
  everClosed: boolean,
): GateReconcile {
  if (legacyCount === 0) {
    return issueOpen
      ? { action: "close", reason: "legacy-set-empty" }
      : { action: "none", reason: null };
  }
  if (gateGreen && !issueOpen && !everClosed) return { action: "open", reason: null };
  if (!gateGreen && issueOpen) return { action: "close", reason: "gate-un-greened" };
  return { action: "none", reason: null };
}

/**
 * The close comment. Names the ACTUAL cause and carries the counts, so the receipt travels
 * WITH the notification instead of living only in a run log nobody opens — the 2026-08-04
 * misread happened with `0 legacy, 0 straggler(s)` sitting one click away in the run summary.
 *
 * Deliberately makes NO claim about reopening (see reconcileGate's warning above).
 */
export function gateCloseComment(
  reason: GateCloseReason,
  legacyCount: number,
  stragglerCount: number,
): string {
  const counts = `Counts at close: **${legacyCount} legacy**, **${stragglerCount} straggler(s)**.`;
  const headline =
    reason === "legacy-set-empty"
      ? "**Every legacy gateway token is revoked** — the revocation gate is satisfied and there is nothing left to approve. This is the completion receipt, not a regression."
      : "**A straggler token was used again, so the gate is no longer GREEN.** Legacy tokens REMAIN — revoking them now would break a live consumer. Re-stage only once the gate reads GREEN again.";
  return `${headline}\n\n${counts}\n\nAuto-closed by the token watch.`;
}
