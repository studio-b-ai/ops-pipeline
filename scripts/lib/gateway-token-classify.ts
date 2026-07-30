/**
 * Pure classification logic for gateway-token-watch.ts — extracted (mirroring
 * railway-volume-classify.ts) so the straggler boundary and the revocation gate get real
 * negative-control tests (Rule #322: an oracle that can't reject a known-bad proves nothing).
 */

export type TokenStatus = "QUIET" | "STRAGGLER";

/**
 * A legacy token is a STRAGGLER iff it has authenticated AT or AFTER the cutover boundary.
 * `null` last_used_at (never used) is always QUIET.
 */
export function classifyLegacyToken(lastUsedAt: Date | null, cutover: Date): TokenStatus {
  if (!lastUsedAt) return "QUIET";
  return lastUsedAt.getTime() >= cutover.getTime() ? "STRAGGLER" : "QUIET";
}

/**
 * The revocation gate is GREEN iff there are zero stragglers AND the full quiet window has
 * elapsed since cutover. `now` is injected for testability.
 */
export function revocationGate(stragglerCount: number, cutover: Date, quietDays: number, now: Date): "GREEN" | "CLOSED" {
  const gateOpensAt = cutover.getTime() + quietDays * 24 * 60 * 60 * 1000;
  return stragglerCount === 0 && now.getTime() >= gateOpensAt ? "GREEN" : "CLOSED";
}
