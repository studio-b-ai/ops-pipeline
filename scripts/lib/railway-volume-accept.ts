/**
 * railway-volume-accept.ts — the Leg-2 "per-volume accepted-state" for railway-volume-monitor.ts
 * (ops-pipeline#71, design approved by Kevin 2026-08-12 — see the issue's design-review comment).
 *
 * Origin: ops#12 (wasala-platform Postgres, 79.3% used, 158,609MB/200,000MB, measured FLAT —
 * -36MB over 4 days) is a diagnosed-static corpus with no resize warranted. Thresholds are
 * global constants (`WARN_THRESHOLD_PCT`/`CRITICAL_THRESHOLD_PCT` in railway-volume-classify.ts),
 * so without an override the issue must stay open forever purely as dedup state — training
 * readers to ignore the label (Rule #60). This module lets ONE specific, manifest-declared,
 * volume-instance-scoped override close that issue honestly (feeds `reconcileSeverity` the
 * literal "OK", same as real recovery) while still re-firing the moment usage crosses the
 * accepted mark, the path drifts, or the review date passes.
 *
 * Deliberately keyed by `volume_instance_id`, NOT path/name: the acceptance must be at least as
 * specific as the alert key (`volumeEntityKey` in railway-volume-monitor.ts also carries the
 * instance id), or it would silently suppress a same-named volume living in a DIFFERENT
 * environment. `path` is carried too and is a REQUIRED cross-check against the live record's own
 * path at match time — a mismatch means the override no longer describes the volume it claims to
 * (moved service, renamed environment, or a manifest copy/paste error) and must NOT silently
 * apply; it becomes a flagged config defect instead (see `railway-volume-monitor.ts`'s
 * `ACCEPTED-STATE INVALID` issue handling).
 *
 * This file is pure decision logic — no I/O, no `gh` calls, no clock reads beyond what callers
 * pass in explicitly — mirroring `railway-volume-classify.ts` and `railway-volume-reconcile.ts`.
 */

import type { ProjectRef } from "./railway-volume-probes.js";
import { WARN_THRESHOLD_PCT, CRITICAL_THRESHOLD_PCT, type VolumeStatus } from "./railway-volume-classify.js";

// ───────────────────────────── manifest shape ─────────────────────────────

/** Raw shape as it appears in railway-projects.manifest.yaml, before validation — every field is `unknown` on purpose (YAML gives us no type guarantees). */
export interface RawAcceptedVolume {
  volume_instance_id?: unknown;
  path?: unknown;
  accepted_below_pct?: unknown;
  review_by?: unknown;
  reason?: unknown;
  issue?: unknown;
}

/**
 * A manifest project entry that MAY carry `accepted_volumes`. Deliberately a separate type from
 * `ProjectRef` (never modified — see railway-volume-probes.ts) rather than widening it: `ProjectRef`
 * is also `unionProjects`'s parameter/return type, and a discovered (live API) project can never
 * carry manifest-only acceptance data, so widening it there would let a discovered project silently
 * imply "no acceptances" instead of "this field doesn't apply here." Structurally assignable TO
 * `ProjectRef` wherever one is expected (extra optional field), so passing this type into
 * `unionProjects` needs no cast.
 */
export interface ManifestProjectEntry extends ProjectRef {
  accepted_volumes?: RawAcceptedVolume[];
}

// ───────────────────────────── validated shape ─────────────────────────────

/** A structurally-valid, ready-to-apply acceptance override. */
export interface AcceptedVolume {
  volumeInstanceId: string;
  path: string;
  acceptedBelowPct: number;
  /** Strict `YYYY-MM-DD`, round-trip validated (see `isValidReviewByDate`). */
  reviewBy: string;
  reason: string;
  issue: number | null;
}

/** A load-time or match-time defect in one `accepted_volumes` entry. `volumeInstanceId` is null only when the id field itself is missing/invalid — there is nothing to key the flag issue on but the entry itself. */
export interface AcceptanceDefect {
  volumeInstanceId: string | null;
  reason: string;
}

export interface AcceptanceMapResult {
  /** Keyed by `volume_instance_id` — contains ONLY entries that passed every structural check. */
  map: Map<string, AcceptedVolume>;
  defects: AcceptanceDefect[];
}

// ───────────────────────────── date validation ─────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict `YYYY-MM-DD` validation via round-trip, NOT bare `Date.parse`/`isNaN`. `Date.parse`
 * SILENTLY NORMALIZES out-of-range calendar dates instead of rejecting them — verified live in
 * this Node runtime: `new Date("2026-02-31T00:00:00.000Z")` does not throw or produce `NaN`, it
 * rolls forward to `2026-03-03T00:00:00.000Z`. A `review_by: "2026-02-31"` typo would otherwise
 * silently become a real, months-later expiry instead of being rejected. Round-tripping the
 * parsed date back through `toISOString().slice(0, 10)` and requiring an EXACT match to the
 * original string catches this: `2026-03-03 !== 2026-02-31`.
 */
export function isValidReviewByDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * `today <= reviewBy` as a plain STRING comparison — both sides are already-validated
 * `YYYY-MM-DD` (zero-padded, fixed-width), so lexicographic order is chronological order. This
 * sidesteps `Date` object comparison entirely (no timezone-offset or DST class of bug possible)
 * once both inputs are known-valid ISO date strings.
 */
export function isWithinReviewWindow(todayIso: string, reviewBy: string): boolean {
  return todayIso <= reviewBy;
}

// ───────────────────────────── structural validation ─────────────────────────────

type ValidationResult = { ok: true; value: AcceptedVolume } | { ok: false; defect: AcceptanceDefect };

/**
 * Validate ONE raw `accepted_volumes` entry. Fails fast on the FIRST bad field (mirrors
 * `classifyUsage`'s throw-on-first-bad-precondition style elsewhere in this monitor) — "that ONE
 * override ignored" per the design review, not an exhaustive multi-reason report.
 */
function validateAcceptedVolume(raw: RawAcceptedVolume): ValidationResult {
  const id = typeof raw.volume_instance_id === "string" && raw.volume_instance_id.trim() !== "" ? raw.volume_instance_id : null;
  if (!id) {
    return { ok: false, defect: { volumeInstanceId: null, reason: `volume_instance_id missing or not a non-empty string (got ${JSON.stringify(raw.volume_instance_id)})` } };
  }
  if (typeof raw.path !== "string" || raw.path.trim() === "") {
    return { ok: false, defect: { volumeInstanceId: id, reason: `path missing or not a non-empty string (got ${JSON.stringify(raw.path)})` } };
  }
  if (typeof raw.reason !== "string" || raw.reason.trim() === "") {
    return { ok: false, defect: { volumeInstanceId: id, reason: "reason missing or empty" } };
  }
  if (!isValidReviewByDate(raw.review_by)) {
    return { ok: false, defect: { volumeInstanceId: id, reason: `review_by missing or unparseable — must be a strict, real YYYY-MM-DD (got ${JSON.stringify(raw.review_by)})` } };
  }
  const pct = raw.accepted_below_pct;
  if (typeof pct !== "number" || !Number.isFinite(pct) || !(pct > WARN_THRESHOLD_PCT && pct < CRITICAL_THRESHOLD_PCT)) {
    return {
      ok: false,
      defect: {
        volumeInstanceId: id,
        reason: `accepted_below_pct must be a number strictly between ${WARN_THRESHOLD_PCT} and ${CRITICAL_THRESHOLD_PCT} — an acceptance can never swallow a CRITICAL (got ${JSON.stringify(pct)})`,
      },
    };
  }
  const issue = typeof raw.issue === "number" && Number.isFinite(raw.issue) ? raw.issue : null;
  return {
    ok: true,
    value: { volumeInstanceId: id, path: raw.path, acceptedBelowPct: pct, reviewBy: raw.review_by, reason: raw.reason, issue },
  };
}

/**
 * Build the acceptance map DIRECTLY from the parsed manifest project list — deliberately NEVER
 * from `unionProjects(...)`'s output. `unionProjects` resolves an id conflict by letting the
 * DISCOVERED (live API) project win over the manifest entry ("discovered overwrites on
 * conflict") — the day `RAILWAY_API_TOKEN` is re-scoped and discovery starts returning a project
 * that's also in the manifest, that project's `accepted_volumes` would silently vanish from the
 * union's output even though the manifest file still declares it. Building straight from the
 * parsed manifest sidesteps that failure mode entirely: this map's correctness never depends on
 * whether discovery succeeded, returned partial results, or started working today for the first
 * time.
 */
export function buildAcceptanceMap(manifestProjects: ManifestProjectEntry[]): AcceptanceMapResult {
  const map = new Map<string, AcceptedVolume>();
  const defects: AcceptanceDefect[] = [];

  for (const project of manifestProjects) {
    for (const raw of project.accepted_volumes ?? []) {
      const result = validateAcceptedVolume(raw);
      if (result.ok) {
        map.set(result.value.volumeInstanceId, result.value);
      } else {
        defects.push(result.defect);
      }
    }
  }

  return { map, defects };
}

/**
 * Acceptances whose `volume_instance_id` matches NO live volume instance this run — dangling,
 * flagged the same way as a structural defect (design review: "matches NO live volume -> dangling
 * -> flagged"). Separate from `buildAcceptanceMap` because "live" is only known AFTER the
 * per-project fetch loop runs; this stays a pure function over an explicit id set so it needs no
 * network access to unit-test.
 */
export function findDanglingAcceptances(map: Map<string, AcceptedVolume>, liveVolumeInstanceIds: Set<string>): AcceptanceDefect[] {
  const dangling: AcceptanceDefect[] = [];
  for (const id of map.keys()) {
    if (!liveVolumeInstanceIds.has(id)) {
      dangling.push({ volumeInstanceId: id, reason: `volume_instance_id matches no live volume instance this run (dangling acceptance — the volume may have been deleted, or this id was mistyped)` });
    }
  }
  return dangling;
}

// ───────────────────────────── the acceptance predicate ─────────────────────────────

export type AcceptanceRejectReason = "path-mismatch" | "expired" | "usage-at-or-above-accepted";

export interface AcceptancePredicateInput {
  /** The validated override for this volume instance, or undefined when none exists. */
  override: AcceptedVolume | undefined;
  /** The volume's own live path THIS run, in the same `<project>/<env>/<service>/<volume>` shape as `override.path` — WITHOUT the ` [<instanceId>]` suffix (that's the map key, not part of the path string). */
  liveEntityPath: string;
  usagePct: number;
  /** Caller's "today", already a validated `YYYY-MM-DD` (e.g. `new Date().toISOString().slice(0, 10)`) — passed in explicitly so this stays clock-free and trivially testable. */
  todayIso: string;
}

export interface AcceptancePredicateResult {
  accepted: boolean;
  /** Populated only when an override EXISTS but was rejected — distinguishes "no override" (null) from "override exists but doesn't currently apply." */
  rejectReason: AcceptanceRejectReason | null;
}

/**
 * ```
 * accepted = override exists
 *         && override.path === liveEntityPathWithoutInstanceId
 *         && today <= review_by
 *         && usagePct < accepted_below_pct
 * ```
 * Per the design review verbatim. All four conjuncts are REQUIRED — a path drift, an expired
 * review date, or usage climbing to meet/exceed the accepted ceiling each independently fail the
 * acceptance closed (never open a silent pass-through).
 */
export function evaluateAcceptance(input: AcceptancePredicateInput): AcceptancePredicateResult {
  const { override, liveEntityPath, usagePct, todayIso } = input;
  if (!override) return { accepted: false, rejectReason: null };
  if (override.path !== liveEntityPath) return { accepted: false, rejectReason: "path-mismatch" };
  if (!isWithinReviewWindow(todayIso, override.reviewBy)) return { accepted: false, rejectReason: "expired" };
  if (!(usagePct < override.acceptedBelowPct)) return { accepted: false, rejectReason: "usage-at-or-above-accepted" };
  return { accepted: true, rejectReason: null };
}

/**
 * `effectiveStatus` feeds `reconcileSeverity` — an accepted volume closes its already-open issue
 * (the literal `"OK"`) rather than merely suppressing FUTURE opens, per the design review. There
 * is deliberately no third clear-status string spelling out the word ACCEPTED as a status value:
 * `reconcileSeverity` only special-cases the literal `"OK"` as clear, so inventing a new
 * clear-status string would require touching `severity-issue-reconcile.ts` (out of scope,
 * untouched — see this PR's grep checks) and would silently stop closing anything. The word
 * ACCEPTED (no quotes — never a code-level status literal) is still used, deliberately, as purely
 * PRESENTATIONAL text — the padded status column and the close-comment headline in
 * railway-volume-monitor.ts — never as a value flowing through
 * `reconcileSeverity`/`buildSeverityTitle`.
 */
export function effectiveStatus(accepted: boolean, computedStatus: VolumeStatus): VolumeStatus {
  return accepted ? "OK" : computedStatus;
}
