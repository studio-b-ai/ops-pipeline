/**
 * automerge-telemetry.ts — evaluation-receipt formatting for the squasher auto-merge
 * gate (gate v2, Kevin-approved 2026-08-02). Pure, log-based, no new storage: every
 * gate evaluation in scripts/pr-automerge-gate.ts emits ONE line built by
 * `formatGateReceiptLine` to the GH Actions workflow run log (stdout) — nothing is
 * posted to Slack, no issue is opened, no external table is written.
 *
 * The line always carries repo, PR number, resolved class (or "unclassified"), and
 * verdict. On a miss it ALSO carries which leg failed first, from a FIXED vocabulary,
 * never a silently-omitted field.
 *
 * ── Leg vocabulary widened 2026-08-04 (ops-pipeline#24) ───────────────────────────
 * v2 deliberately collapsed author/label and file-list-truncation misses into
 * "other", documented as "the explicit fail-closed default for any leg not named
 * here". That was a defensible v2 call, but squasher-health monitoring supersedes it:
 * "other" was doing double duty as BOTH the routine-miss bucket AND the bucket a
 * genuine crash lands in (the ops-pipeline#19 permissions crash emitted exactly
 * `leg=other`). A monitor that cannot separate "the gate correctly declined" from
 * "the gate blew up" reports confident nonsense.
 *
 * Post-change, every EXPECTED decline has a named leg and **"other" means ONLY
 * "unforeseen — the gate threw"**. It is emitted at exactly one site: the catch-all
 * in pr-automerge-gate.ts. `leg=other` in a run log is therefore always worth a look.
 */

import type { PrDiffClass } from "./automerge-classify.js";

/**
 * "candidate" (ops#190 B1): a code-fix in a TRAIN-class repo passed EVERY gate leg
 * but the squasher never merges there — it applied `train:candidate` and handed the
 * merge decision to the human `train:ready` authority. Neither a qualified merge
 * nor a miss; monitors treat it as a healthy terminal outcome.
 */
export type GateReceiptVerdict = "qualified" | "missed" | "candidate";

/**
 * Which leg failed FIRST. Ordered here as the gate evaluates them:
 * - `ci-rollup`    PR state / CI green / merge readiness (the cheap short-circuit).
 * - `truncation`   `gh pr view --json files` came back paginated, so the file list
 *                  is INCOMPLETE and classification cannot safely proceed. A correct
 *                  fail-closed decline, NOT an error.
 * - `class-match`  the file set resolved to no single diff class, or resolved to one
 *                  this caller has not enabled.
 * - `line-cap`     a class's shape matched but the diff exceeded that class's cap.
 * - `eligibility`  the PR is not in the squasher's lane at all — wrong author, or the
 *                  `bugsquasher` label is absent.
 * - `named-checks` (code-fix only, ops#190 B1) the caller's required_checks list is
 *                  empty (leg inert, fail-closed) or a named check is missing /
 *                  in-flight / not strictly SUCCESS on the head commit.
 * - `review`       the independent review returned anything other than exactly CLEAN
 *                  (including any API error — fail-closed).
 * - `other`        UNFORESEEN ONLY. The gate threw. Investigate.
 */
export type GateReceiptLeg =
  | "ci-rollup"
  | "truncation"
  | "class-match"
  | "line-cap"
  | "eligibility"
  | "named-checks"
  | "review"
  | "other";

export interface GateReceiptInput {
  repo: string;
  pr: number;
  /** The resolved PR diff class, or "unclassified" when classification never
   *  resolved one (includes the ci-rollup short-circuit path, where classification
   *  never even ran). */
  prClass: PrDiffClass | "unclassified";
  verdict: GateReceiptVerdict;
  /** Required when verdict is "missed" (defaults to "other" if omitted — fail-closed:
   *  a miss NEVER silently omits its leg). Ignored when verdict is "qualified". */
  leg?: GateReceiptLeg;
  reasons?: string[];
}

function escapeReasons(reasons: string[]): string {
  // Reasons can themselves contain double quotes (a diff line, a file path with an
  // apostrophe-quoted value) — normalize to single quotes so the whole reasons
  // field stays one shell/log-safe double-quoted token.
  return reasons.join("; ").replace(/"/g, "'");
}

export function formatGateReceiptLine(input: GateReceiptInput): string {
  const parts = ["[gate-receipt]", `repo=${input.repo}`, `pr=${input.pr}`, `class=${input.prClass}`, `verdict=${input.verdict}`];

  if (input.verdict === "missed") {
    parts.push(`leg=${input.leg ?? "other"}`);
    if (input.reasons && input.reasons.length > 0) {
      parts.push(`reasons="${escapeReasons(input.reasons)}"`);
    }
  }

  return parts.join(" ");
}
