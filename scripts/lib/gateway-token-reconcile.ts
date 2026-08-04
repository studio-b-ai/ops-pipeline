/**
 * Pure issue-reconcile decisions for gateway-token-watch.ts — GitHub issues ARE the alert
 * state (Kevin directive 2026-07-30: issues instead of Slack; the monitor auto-cleans them).
 * Open issue = condition active; closed = resolved. Extracted for negative-control tests
 * (Rule #322), mirroring gateway-token-classify.ts.
 */

import { createHash } from "node:crypto";

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

// ───────────────────────────── gate cycle identity (ops-pipeline#34) ─────────────────────────────

export const GATE_TITLE_BASE = "[token-watch] revocation gate GREEN — approve legacy-token revocation";

/**
 * Deterministic identity of the CURRENT revocation cycle, derived entirely from DB state:
 * the sorted legacy token set with each token's last_used_at. Any event that starts a new
 * cycle changes it —
 *   - a straggler episode (a legacy token authenticates → its last_used_at moves),
 *   - remediation (a token is revoked or allowlisted → it leaves the set),
 *   - regrowth (a new legacy token appears → it joins the set).
 *
 * Stateless by construction: no clock, no persisted counter — the same DB state always
 * yields the same key, so re-runs and dry-runs agree (and tests are trivial).
 */
export function gateCycleKey(tokens: Array<{ name: string; lastUsedIso: string | null }>): string {
  const canonical = tokens
    .map((t) => `${t.name}|${t.lastUsedIso ?? "never"}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/** The gate issue's title carries the cycle key, so issue identity IS cycle identity. */
export function gateTitle(cycleKey: string): string {
  return `${GATE_TITLE_BASE} [cycle ${cycleKey}]`;
}

/**
 * Recognizes gate issues across BOTH formats: the pre-#34 bare title (e.g. #17, closed
 * 2026-08-04) and the cycle-keyed format. Straggler/blind titles never match.
 */
export function isGateTitle(title: string): boolean {
  return title === GATE_TITLE_BASE || title.startsWith(`${GATE_TITLE_BASE} [cycle `);
}

/**
 * Why a revocation-gate issue closed. The causes mean DIFFERENT things and the close
 * comment must say which (ops-pipeline#32, Rule #412):
 *
 *   - `legacy-set-empty`   — every legacy token is revoked. The job is DONE; this is the
 *                            receipt the gate issue exists to produce.
 *   - `gate-un-greened`    — a straggler was used again. Legacy tokens REMAIN, and revoking
 *                            them now would break a live consumer.
 *   - `cycle-superseded`   — the legacy set or its usage changed while this cycle's issue
 *                            sat open; a fresh issue for the new cycle replaces it. Emitted
 *                            by the caller's stale-cycle sweep, never by reconcileGate.
 *
 * Before this discriminant existed, `reconcileGate` returned a bare "close" and the caller
 * emitted one comment covering opposite meanings. On 2026-08-04 that disjunction caused a
 * sibling session to read a COMPLETED revocation as a regression and pull the
 * already-executed command off Kevin's queue.
 */
export type GateCloseReason = "legacy-set-empty" | "gate-un-greened" | "cycle-superseded";

export interface GateReconcile {
  action: ReconcileAction;
  /** Set only when `action === "close"`; `null` otherwise. */
  reason: GateCloseReason | null;
}

/**
 * Revocation-gate issue reconcile. Differences from a plain condition:
 * - zero legacy tokens left (all revoked) → the gate is vacuous — never open, close if open;
 * - a gate issue closed by a human is that CYCLE's ack and is not reopened while the cycle
 *   persists. `everClosed` = "a closed gate issue exists for the CURRENT cycle's title".
 *
 * Cycle mechanics (ops-pipeline#34): issue identity is per-cycle — the title carries
 * `gateCycleKey(legacy)`. When the legacy set or its usage changes, the key changes, the
 * old cycle's closed issue no longer matches `everClosed`, and the gate CAN open a fresh
 * issue for the new cycle. Before #34, `everClosed` matched one immortal title, so a single
 * human ack suppressed the gate forever — a regrown legacy set would never have surfaced.
 *
 * Caller contract for `issueOpen`: with `legacyCount > 0` pass "is THIS cycle's issue
 * open"; with `legacyCount === 0` pass "is ANY gate issue open" (the vacuous close must
 * sweep every lingering gate issue, whatever cycle key its title carries).
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
      : reason === "gate-un-greened"
        ? "**A straggler token was used again, so the gate is no longer GREEN.** Legacy tokens REMAIN — revoking them now would break a live consumer. Re-stage only once the gate reads GREEN again."
        : "**The legacy set or its usage changed while this gate issue sat open** — this cycle no longer describes current state. Superseded; a fresh gate issue for the new cycle carries the current token list.";
  return `${headline}\n\n${counts}\n\nAuto-closed by the token watch.`;
}
