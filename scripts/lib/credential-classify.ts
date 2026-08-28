/**
 * credential-classify.ts — pure classification logic for the credential-expiry monitor.
 *
 * Implements CLAUDE.md Rule #302: classify each credential's real expiry/aliveness into an
 * actionable result. Pure (no I/O, no network) so it is fully unit-testable with a pinned
 * clock (Rule #256). The active-probe result + the manifest's recorded expiry go in; a
 * result + days-to-expiry + WARN threshold come out.
 *
 * NEVER logs or returns a credential value — only NAME-level metadata flows through here.
 */

export type CredStatus = "OK" | "WARN" | "DEAD" | "NO_EXPIRY" | "PROBE_FAILED";

/** Result of an active probe (see credential-probes.ts). */
export interface ProbeResult {
  /** false = the aliveness probe confirmed the credential is dead/revoked/expired. */
  alive: boolean;
  /** ISO date string from the active probe (authoritative), or null if the probe can't read it. */
  expiry: string | null;
  /** Where `expiry` came from — the live probe, or the manifest's recorded date. */
  source: "probe" | "recorded";
  /** Set when the probe could not run (network blip, missing creds, unparseable). → PROBE_FAILED. */
  error?: string;
  /** true = the credential type does not expire (e.g. a classic GitHub PAT with no expiry header). */
  nonExpiring?: boolean;
  /** Short NAME-level detail for the run log (e.g. a password-change DATE) — NEVER a secret value. */
  note?: string;
}

export interface ClassifyInput {
  /** ISO date from the manifest (`recorded_expiry`), or null/undefined if not recorded. */
  recordedExpiry?: string | null;
  probe: ProbeResult;
  /**
   * Manifest `non_expiring: true` — the credential is non-expiring BY DESIGN (ladder rung 2,
   * decision 2026-08-17: non-expiring + monitored + revoke-on-signal). Alive + no expiry is then
   * OK, not NO_EXPIRY: the daily aliveness probe IS the monitoring; a standing NO_EXPIRY issue that
   * never closes would only train the seat to ignore the label (Rules #60/#292). Contradiction guard:
   * a declared non-expiring item that ALSO carries an expiry (probe or recorded) is PROBE_FAILED —
   * a manifest that says both cannot be trusted either way.
   */
  declaredNonExpiring?: boolean;
}

export interface Classification {
  status: CredStatus;
  /** Whole calendar days (UTC) until expiry. Negative = overdue. null when no expiry is known. */
  daysToExpiry: number | null;
  /** The WARN band the credential currently sits in, or null. */
  threshold: 14 | 7 | 1 | null;
  /** The effective expiry used for the computation (ISO), or null. */
  expiry: string | null;
  expirySource: "probe" | "recorded" | null;
}

/** WARN bands in ascending order so the tightest matching band wins. */
const WARN_BANDS = [1, 7, 14] as const;

/** Constructor helper — keeps the union literals as call args, never inline object keys. */
function mk(
  s: CredStatus,
  days: number | null,
  threshold: 14 | 7 | 1 | null,
  expiry: string | null,
  expirySource: "probe" | "recorded" | null,
): Classification {
  return { status: s, daysToExpiry: days, threshold, expiry, expirySource };
}

/**
 * Count whole calendar days between two instants, normalized to UTC midnight so a
 * same-day expiry is 0 and a next-day expiry is 1 regardless of wall-clock time.
 */
export function daysBetweenUTC(from: Date, to: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const fromMidnight = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toMidnight = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((toMidnight - fromMidnight) / MS_PER_DAY);
}

/**
 * Classify a credential. `now` is injectable so tests pin the clock (Rule #256).
 *
 * Precedence:
 *   1. probe.error set       → PROBE_FAILED (monitoring gap — couldn't determine state)
 *   2. probe.alive === false → DEAD (confirmed dead/revoked — the npm-token silent-break case)
 *   3. effective expiry = probe.expiry ?? recordedExpiry
 *        - none + declaredNonExpiring (manifest `non_expiring: true`, rung 2 by design) → OK
 *        - some + declaredNonExpiring → PROBE_FAILED (manifest contradiction — fail loud)
 *        - none + probe.nonExpiring (probe-detected, e.g. classic PAT) → NO_EXPIRY (message tailored)
 *        - none               → NO_EXPIRY (flag for backfill)
 *        - ≤1/≤7/≤14 days     → WARN (threshold = tightest band; overdue collapses to WARN@1)
 *        - else               → OK
 */
export function classify(input: ClassifyInput, now: Date = new Date()): Classification {
  const { recordedExpiry, probe } = input;

  if (probe.error) {
    return mk("PROBE_FAILED", null, null, null, null);
  }

  if (probe.alive === false) {
    return mk("DEAD", null, null, null, null);
  }

  let expiry: string | null = null;
  let expirySource: "probe" | "recorded" | null = null;
  if (probe.expiry) {
    expiry = probe.expiry;
    expirySource = "probe";
  } else if (recordedExpiry) {
    expiry = recordedExpiry;
    expirySource = "recorded";
  }

  if (input.declaredNonExpiring) {
    // Rung 2 by design: alive + no expiry anywhere → OK. An expiry from either source contradicts
    // the declaration → PROBE_FAILED (a monitoring gap in the MANIFEST, surfaced, never silently OK).
    if (!expiry) return mk("OK", null, null, null, null);
    return mk("PROBE_FAILED", null, null, expiry, expirySource);
  }

  if (!expiry) {
    // Alive but no known expiry — whether genuinely non-expiring (classic PAT → scope down /
    // migrate to keyless) or just unrecorded (→ backfill). Both are NO_EXPIRY (never silently OK,
    // which would hide a manifest hygiene gap); the monitor tailors the message from probe.nonExpiring.
    // (A DELIBERATE non-expiring credential declares `non_expiring: true` in the manifest — see above.)
    return mk("NO_EXPIRY", null, null, null, null);
  }

  const parsed = Date.parse(expiry);
  if (Number.isNaN(parsed)) {
    // An unparseable effective expiry is a monitoring gap, not a silent OK.
    return mk("PROBE_FAILED", null, null, expiry, expirySource);
  }

  const days = daysBetweenUTC(now, new Date(parsed));

  let threshold: 14 | 7 | 1 | null = null;
  for (const band of WARN_BANDS) {
    if (days <= band) {
      threshold = band;
      break;
    }
  }

  if (threshold !== null) {
    // Includes overdue (days < 0) → collapses to the tightest band (1).
    return mk("WARN", days, threshold, expiry, expirySource);
  }

  return mk("OK", days, null, expiry, expirySource);
}
