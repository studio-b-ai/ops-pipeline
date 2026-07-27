/**
 * railway-volume-classify.ts — pure classification + state-transition logic for the fleet-wide
 * Railway volume-usage monitor (CLAUDE.md Rule #302 family).
 *
 * Origin: 2026-07-27 — the aesthetik-production `Postgres` service's 500MB Railway volume sat at
 * ≥96% for 24h+ with ZERO alerting, hit 100%, and crash-looped ~10 hours, taking the whole
 * Acumatica gateway down. This monitor exists so a volume climbing toward full is a Slack alert,
 * not a multi-hour outage discovered by users.
 *
 * Pure (no I/O, no network) so it is fully unit-testable. Mirrors credential-classify.ts's shape:
 * network/parsing lives in railway-volume-probes.ts; this file only classifies numbers and
 * compares states.
 *
 * Alerting law (Rules #292/#358): a monitor must alert once per STATE TRANSITION, never per run —
 * a cron re-firing the same WARN every 6h forever trains the reader to ignore the channel. So this
 * module's job is narrow: turn (currentSizeMB, sizeMB) into a status, and turn (prevStatus,
 * currStatus) into "did this change, and which direction" — the caller (railway-volume-monitor.ts)
 * owns persisting prevStatus and deciding whether to post.
 */

export type VolumeStatus = "OK" | "WARN" | "CRITICAL";

/**
 * Superset of VolumeStatus used ONLY for state-transition dedup: `computeTransition` also drives
 * per-PROJECT "could we even fetch this project's volumes?" tracking (a project-level GraphQL
 * error — e.g. a bad project id, or a resolver bug like the aesthetik-production `service{}` one
 * documented in railway-volume-probes.ts — must not silently vanish into a console.warn; it gets
 * the same once-per-transition escalation treatment as a volume's own WARN/CRITICAL, mirroring
 * credential-expiry-monitor.ts's PROBE_FAILED status). Ranked WORSE than CRITICAL so entering it
 * from any volume-usage status is always an escalation, and leaving it is always a recovery.
 */
export type MonitorStatus = VolumeStatus | "PROBE_FAILED";

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

const RANK: Record<MonitorStatus, number> = { OK: 0, WARN: 1, CRITICAL: 2, PROBE_FAILED: 3 };

export interface Transition {
  changed: boolean;
  /** "escalate" = getting worse (OK→WARN, OK→CRITICAL, WARN→CRITICAL, any→PROBE_FAILED); "recover" = getting better. */
  direction: "escalate" | "recover" | "none";
}

/**
 * Pure: compare a volume's (or a project-probe's) previous persisted status to its current one.
 *
 * An entity never seen before has no entry in the state file — the caller passes `prev = "OK"` for
 * that case (documented at the callsite), so a first-ever WARN/CRITICAL/PROBE_FAILED still alerts
 * (it's a real transition from the assumed baseline) while a first-ever OK stays silent.
 */
export function computeTransition(prev: MonitorStatus, curr: MonitorStatus): Transition {
  if (prev === curr) return { changed: false, direction: "none" };
  return { changed: true, direction: RANK[curr] > RANK[prev] ? "escalate" : "recover" };
}
