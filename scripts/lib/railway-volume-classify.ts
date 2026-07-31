/**
 * railway-volume-classify.ts — pure classification logic for the fleet-wide Railway
 * volume-usage monitor (CLAUDE.md Rule #302 family).
 *
 * Origin: 2026-07-27 — the aesthetik-production `Postgres` service's 500MB Railway volume sat at
 * ≥96% for 24h+ with ZERO alerting, hit 100%, and crash-looped ~10 hours, taking the whole
 * Acumatica gateway down. This monitor exists so a volume climbing toward full is caught, not a
 * multi-hour outage discovered by users.
 *
 * Pure (no I/O, no network) so it is fully unit-testable. Mirrors credential-classify.ts's shape:
 * network/parsing lives in railway-volume-probes.ts; this file only turns numbers into a status.
 *
 * v2 (2026-07-31, Kevin directive): alert state moved from a committed dedup-state-file +
 * transition-computation (this file used to also export `computeTransition`/`MonitorStatus` for
 * that) to auto-reconciled GitHub issues — an open issue for an entity now IS the dedup, and a
 * severity change on an already-open issue is a comment+retitle (see
 * `lib/severity-issue-reconcile.ts`'s `reconcileSeverity`), not a "did the status change since
 * last run" computation. `computeTransition`/`MonitorStatus`/`Transition` are removed as dead code
 * (nothing calls them post-conversion — verified via repo-wide grep before deletion).
 */

export type VolumeStatus = "OK" | "WARN" | "CRITICAL";

/** WARN at ≥75% used, CRITICAL at ≥90% — per the chip spec (2026-07-27 authorization). */
export const WARN_THRESHOLD_PCT = 75;
export const CRITICAL_THRESHOLD_PCT = 90;

export interface UsageClassification {
  /** 0-100+ (can theoretically exceed 100 momentarily on a raced write). */
  usagePct: number;
  status: VolumeStatus;
}

/**
 * Classify a single volume instance's usage. Callers MUST filter to `sizeMB > 0` before calling
 * (a volume with no configured size can't have a usage percentage) — this throws rather than
 * silently returning a nonsense 0%/Infinity%, so a caller bug surfaces immediately instead of
 * shipping a wrong number into an alert (Rule #266 — verify the VALUE, not just that code ran).
 */
export function classifyUsage(currentSizeMB: number, sizeMB: number): UsageClassification {
  if (!(sizeMB > 0)) {
    throw new Error(`classifyUsage requires sizeMB > 0 (got ${sizeMB})`);
  }
  const usagePct = (currentSizeMB / sizeMB) * 100;
  const status: VolumeStatus =
    usagePct >= CRITICAL_THRESHOLD_PCT ? "CRITICAL" : usagePct >= WARN_THRESHOLD_PCT ? "WARN" : "OK";
  return { usagePct, status };
}
