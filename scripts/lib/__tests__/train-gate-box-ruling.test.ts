import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 2026-09-15 ruling (stint #372): "`box` opens EVERY decision leg (review included);
// only the CI rollup / mergeable floor stands." The train gate
// (evaluateTrainReadyInner) reached its independent-review leg only AFTER the
// authority leg had already passed on a roster-human `box` event — so the model
// vote re-litigated Kevin's key: client-asthetik#391 was refused with his `box`
// present on `review verdict FLAG (0/3 CLEAN)` (run 34939031962). The squasher
// path's `evaluateQueuedOverride` has skipped the review leg on that exact law
// since ops#260 (toto#24 merged that way); the train gate now honors `box` the
// same way. These are source-shape guards (#159): the gate file runs `main()` at
// module load, so its legs cannot be unit-imported — the assertions pin the train
// section's shape instead.
//
// Both directions (#322/#471):
//   - the train section must NOT call the review model or the human-receipt
//     predicate (box overrides them);
//   - the floor must STAND: authority, merge-readiness (CI rollup + mergeable),
//     and the revalidate are untouched;
//   - the squasher (B-side) path above the train section must KEEP its own
//     review leg — this change is scoped to the train gate only.

const SOURCE = readFileSync(join(__dirname, "..", "..", "pr-automerge-gate.ts"), "utf8");
const TRAIN_SECTION_MARKER = "queued (train) gate (A1)";
const markerAt = SOURCE.indexOf(TRAIN_SECTION_MARKER);
const squasherSection = markerAt === -1 ? "" : SOURCE.slice(0, markerAt);
const trainSection = markerAt === -1 ? "" : SOURCE.slice(markerAt);

describe("train-gate box ruling (2026-09-15, stint #372)", () => {
  it("planted: the train gate section contains no independent-review machinery — `box` opens the review leg", () => {
    expect(markerAt).toBeGreaterThan(-1);
    expect(trainSection).not.toContain("independentReviewVote(");
    expect(trainSection).not.toContain("TRAIN_READY_REVIEW_SYSTEM");
    expect(trainSection).not.toContain("humanReviewReceipt(");
  });

  it("control: the floor stands — authority, merge-readiness (CI rollup + mergeable), and revalidate legs are intact in the train section", () => {
    expect(trainSection).toContain("evaluateLabelAuthority({");
    expect(trainSection).toContain("evaluateMergeReadiness({");
    expect(trainSection).toContain("isRollupClean(");
    expect(trainSection).toContain("hasAuthoritySnapshotDrifted(");
    expect(trainSection).toContain("mergePr(repo, pr, prJson.headRefOid)");
  });

  it("control: the ruling is documented at the excised leg's site, naming the ruling and the floor", () => {
    expect(trainSection).toContain("OVERRIDDEN BY `box` (2026-09-15 ruling");
    expect(trainSection).toContain("rollup / mergeable floor stands");
  });

  it("control: the squasher (B-side) path keeps its own independent-review leg — the override is train-only", () => {
    expect(squasherSection).toContain("independentReviewVote(");
    expect(squasherSection).toContain("humanReviewReceipt(");
    expect(squasherSection).toContain("evaluateQueuedOverride");
  });
});
