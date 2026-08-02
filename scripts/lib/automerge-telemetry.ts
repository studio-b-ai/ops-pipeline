/**
 * automerge-telemetry.ts — evaluation-receipt formatting for the squasher auto-merge
 * gate (gate v2, Kevin-approved 2026-08-02). Pure, log-based, no new storage: every
 * gate evaluation in scripts/pr-automerge-gate.ts emits ONE line built by
 * `formatGateReceiptLine` to the GH Actions workflow run log (stdout) — nothing is
 * posted to Slack, no issue is opened, no external table is written.
 *
 * The line always carries repo, PR number, resolved class (or "unclassified"), and
 * verdict. On a miss it ALSO carries which leg failed first, from a FIXED five-bucket
 * vocabulary (class-match, line-cap, ci-rollup, review, other) — "other" is the
 * explicit fail-closed default for any leg not named here (e.g. author/label), never
 * a silently-omitted field.
 */

import type { PrDiffClass } from "./automerge-classify.js";

export type GateReceiptVerdict = "qualified" | "missed";

export type GateReceiptLeg = "class-match" | "line-cap" | "ci-rollup" | "review" | "other";

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
