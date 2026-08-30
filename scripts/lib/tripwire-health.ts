/**
 * tripwire-health.ts — pure attribution + health-window classification for the post-merge
 * 5xx tripwire (ops-pipeline#190 B2; design of record
 * docs/plans/2026-08-28-automerge-b-plus-a-v2.md §4.2).
 *
 * Everything here is PURE — the runner (post-merge-tripwire.ts) owns all I/O. Both functions
 * are the load-bearing halves of the tripwire's honesty contract (Rule #412: what the alert may
 * SAY; #295: trigger scope == remediation scope):
 *
 * - `attributeDeployment` binds the merged PR to exactly ONE Railway deployment — by
 *   commitHash === squash sha AND createdAt AFTER the PR closed. Pre-existing same-sha
 *   deployments (a re-run of an old build, a rollback to the same commit) are ignored by the
 *   createdAt guard; once the runner binds an id, later redeploys neither re-arm nor re-trip.
 *
 * - `classifyHealthWindow` renders the verdict from ONE end-of-window metrics read. The gate is
 *   5xx-ONLY, scoped to the deployed service (#295 — trigger scope matches what a revert would
 *   remediate). Stated residual per §4.2 (#412): 2xx-wrong-content, 401/403/404, async-job
 *   breakage, and low-traffic endpoints all PASS this tripwire — it is a 5xx regression
 *   tripwire, not a health oracle.
 */

import type { DeploymentWithMeta, HttpStatusGroup } from "./railway-deployment-probes.js";

// ───────────────────────────── constants (§4.2, "sustained" made concrete) ─────────────────────────────

/** Health window measured from the deployment reaching SUCCESS. */
export const WINDOW_SECONDS = 600;

/** Metrics bucket size — 20 samples across the window. */
export const STEP_SECONDS = 30;

/**
 * First 60s after SUCCESS is recorded but NON-GATING (§4.2; Rules #208/#234 boot-burst — alert
 * clusters at-or-just-after a deploy are the boot window, not sustained failure).
 */
export const BOOT_GRACE_SECONDS = 60;

/**
 * Trip = "sustained 5xx": ≥3 distinct gating buckets containing any 5xx, OR ≥10 total gating
 * 5xx responses — either alone trips. A single-bucket flap escapes; the bias runs slightly
 * sensitive because the remediation is a HUMAN-GATED revert PR (§4.2 — never auto-merged, #97),
 * so a false trip costs a review click, not a rollback.
 */
export const TRIP_MIN_5XX_BUCKETS = 3;
export const TRIP_MIN_5XX_TOTAL = 10;

// ───────────────────────────── deployment attribution ─────────────────────────────

/**
 * The §4.2 attribution predicate: `meta.commitHash === squash sha` AND `createdAt` strictly
 * after the PR's closed timestamp. Returns the EARLIEST qualifying deployment (first match by
 * createdAt) or null when none qualifies yet — the runner polls until one appears or its
 * attribution timeout escalates "deploy never attributed" (no revert; a missing deploy is a
 * deploy-pipeline question, not a health verdict).
 *
 * ISO-8601 UTC strings from both GitHub (closedAt) and Railway (createdAt) compare correctly
 * as strings only when identically formatted — Railway emits fractional seconds, GitHub does
 * not — so both sides go through Date.parse. An unparseable createdAt disqualifies that
 * deployment (fail-closed: never bind on a timestamp we cannot read).
 */
export function attributeDeployment(
  deployments: DeploymentWithMeta[],
  squashSha: string,
  prClosedAtIso: string,
): DeploymentWithMeta | null {
  const closedAtMs = Date.parse(prClosedAtIso);
  if (Number.isNaN(closedAtMs)) {
    throw new Error(`unparseable PR closed timestamp: ${prClosedAtIso}`);
  }
  const qualifying = deployments.filter((d) => {
    if (d.commitHash !== squashSha) return false;
    const createdMs = Date.parse(d.createdAt);
    if (Number.isNaN(createdMs)) return false;
    return createdMs > closedAtMs;
  });
  if (qualifying.length === 0) return null;
  return qualifying.reduce((earliest, d) => (Date.parse(d.createdAt) < Date.parse(earliest.createdAt) ? d : earliest));
}

// ───────────────────────────── health-window classification ─────────────────────────────

export interface HealthWindowInput {
  /** Epoch seconds when the bound deployment reached SUCCESS (window start). */
  successAtEpochSec: number;
}

export interface HealthWindowResult {
  verdict: "pass" | "trip";
  /** All requests observed inside the window (boot grace included), every status. */
  totalRequests: number;
  /** 5xx responses in gating buckets (after boot grace). */
  gatingFiveXxTotal: number;
  /** Distinct gating buckets containing ≥1 5xx. */
  gatingFiveXxBuckets: number;
  /** 5xx responses during the boot grace — recorded for the receipt, never gating (§4.2). */
  bootFiveXxTotal: number;
  /** True when the window saw ZERO requests of any status — an honest pass with an explicit note (#412: low traffic is a stated residual, not an escalation). */
  noTraffic: boolean;
  /** One-line human summary for the receipt. */
  detail: string;
}

function isFiveXx(statusCode: number): boolean {
  return statusCode >= 500 && statusCode <= 599;
}

/**
 * Classifies one end-of-window metrics read (§4.2: a single evaluation after the window
 * elapses — no mid-window peeking in v1). Samples outside [successAt, successAt+WINDOW] are
 * ignored entirely (the fetch range can legitimately over-cover); samples inside the boot
 * grace are counted into totals but never gate.
 */
export function classifyHealthWindow(groups: HttpStatusGroup[], input: HealthWindowInput): HealthWindowResult {
  const windowStart = input.successAtEpochSec;
  const windowEnd = windowStart + WINDOW_SECONDS;
  const gracEnd = windowStart + BOOT_GRACE_SECONDS;

  let totalRequests = 0;
  let gatingFiveXxTotal = 0;
  let bootFiveXxTotal = 0;
  const gatingFiveXxTs = new Set<number>();

  for (const group of groups) {
    for (const sample of group.samples) {
      if (sample.ts < windowStart || sample.ts > windowEnd) continue;
      if (sample.value <= 0) continue;
      totalRequests += sample.value;
      if (!isFiveXx(group.statusCode)) continue;
      if (sample.ts <= gracEnd) {
        bootFiveXxTotal += sample.value;
      } else {
        gatingFiveXxTotal += sample.value;
        gatingFiveXxTs.add(sample.ts);
      }
    }
  }

  const gatingFiveXxBuckets = gatingFiveXxTs.size;

  if (totalRequests === 0) {
    return {
      verdict: "pass",
      totalRequests: 0,
      gatingFiveXxTotal: 0,
      gatingFiveXxBuckets: 0,
      bootFiveXxTotal: 0,
      noTraffic: true,
      detail: `no_traffic: zero requests in the ${WINDOW_SECONDS}s window — pass by design (low-traffic is a stated §4.2 residual, not a health signal)`,
    };
  }

  const tripped = gatingFiveXxBuckets >= TRIP_MIN_5XX_BUCKETS || gatingFiveXxTotal >= TRIP_MIN_5XX_TOTAL;
  const summary =
    `${totalRequests} requests in window; ${gatingFiveXxTotal} gating 5xx across ${gatingFiveXxBuckets} bucket(s)` +
    (bootFiveXxTotal > 0 ? `; ${bootFiveXxTotal} boot-grace 5xx (non-gating)` : "");

  return {
    verdict: tripped ? "trip" : "pass",
    totalRequests,
    gatingFiveXxTotal,
    gatingFiveXxBuckets,
    bootFiveXxTotal,
    noTraffic: false,
    detail: tripped
      ? `sustained 5xx: ${summary} — trips at ≥${TRIP_MIN_5XX_BUCKETS} buckets or ≥${TRIP_MIN_5XX_TOTAL} total`
      : summary,
  };
}
