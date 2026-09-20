import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_DIR = join(import.meta.dirname, "..", "..");
const src = readFileSync(join(SCRIPTS_DIR, "pr-automerge-gate.ts"), "utf8");

/**
 * Stint #372 — the door gap vs the box ruling. In train mode (a PR enumerated on
 * `box` alone — squasher-fleet-sweep `tr` entries and the org-wide `label:box`
 * leg) `evaluateTrainReadyInner` still ran the independent review leg and refused
 * on it: client-asthetik#391 was refused 2026-09-15T06:55Z with Kevin's `box`
 * present, "independent review verdict FLAG (0/3 CLEAN)" (squasher-fleet-sweep run
 * 34939031962 job 104283427915). The ruling: `box` opens EVERY decision leg,
 * review included; only the CI rollup / mergeable floor stands — exactly as
 * `evaluateQueuedOverride` merges on the squasher path.
 *
 * These are source-structure assertions (same pattern as gate-flag-card.test.ts):
 * the gate's live callers are gh/Anthropic I/O, so the contract is pinned on the
 * function body itself — and checked BOTH directions (#322/#471): the squasher
 * `evaluate()` must STILL run its review vote, proving the extraction window sees
 * the leg when it exists.
 */

/** The body of evaluateTrainReadyInner, bounded by the next top-level declaration. */
function trainReadyInnerBody(): string {
  const start = src.indexOf("async function evaluateTrainReadyInner(");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("async function main(", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("train mode honors `box` on the review leg (stint #372 ruling)", () => {
  it("evaluateTrainReadyInner runs NO model review — no vote, no FLAG card, no refusal enroll, no diff fetch", () => {
    const body = trainReadyInnerBody();
    expect(body).not.toContain("independentReviewVote(");
    expect(body).not.toContain("postFlagCard(");
    expect(body).not.toContain("enrollGateRefusal(");
    expect(body).not.toContain("fetchDiffBySha(");
    // The removed prompt constant stays removed — no orphaned reference.
    expect(src).not.toContain("TRAIN_READY_REVIEW_SYSTEM =");
  });

  it("the floor stands: label authority, then readiness/CI, then revalidate, then the SHA-pinned merge", () => {
    const body = trainReadyInnerBody();
    const authorityIdx = body.indexOf("evaluateLabelAuthority({");
    const readinessIdx = body.indexOf("evaluateMergeReadiness({");
    const revalidateIdx = body.indexOf("hasAuthoritySnapshotDrifted(");
    const mergeIdx = body.indexOf("mergePr(repo, pr, prJson.headRefOid)");
    expect(authorityIdx).toBeGreaterThan(-1);
    expect(readinessIdx).toBeGreaterThan(authorityIdx); // stale-strip must run regardless of CI
    expect(revalidateIdx).toBeGreaterThan(readinessIdx); // drift check after the floor
    expect(mergeIdx).toBeGreaterThan(revalidateIdx); // merge only after every leg
  });

  it("negative control by construction: the readiness predicate still consumes the CI rollup AND mergeStateStatus", () => {
    const body = trainReadyInnerBody();
    const readinessIdx = body.indexOf("evaluateMergeReadiness({");
    const mergeIdx = body.indexOf("mergePr(repo, pr, prJson.headRefOid)");
    const window = body.slice(readinessIdx, mergeIdx);
    // A red rollup or a DIRTY/UNSTABLE mergeStateStatus still refuses before any
    // merge — brain#160 (DIRTY) / client-asthetik#372 (UNSTABLE) shapes.
    expect(window).toContain("isRollupClean(prJson.statusCheckRollup");
    expect(window).toContain("mergeStateStatus: prJson.mergeStateStatus");
    expect(window).toContain('return { outcome: "refused", detail }');
  });

  it("positive control: the squasher gate STILL runs its review vote — the extraction window is not blind", () => {
    const evalStart = src.indexOf("async function evaluate(");
    expect(evalStart).toBeGreaterThan(-1);
    const trainStart = src.indexOf("async function evaluateTrainReadyInner(");
    expect(trainStart).toBeGreaterThan(evalStart);
    const squasherBody = src.slice(evalStart, trainStart);
    expect(squasherBody).toContain("independentReviewVote(");
    expect(squasherBody).toContain("fetchDiffBySha(");
  });

  it("the ruling is documented at the removed leg's site (the receipt the next reader gets)", () => {
    const body = trainReadyInnerBody();
    expect(body).toContain("box` opens EVERY decision leg");
    expect(body).toContain("34939031962"); // the run that refused client-asthetik#391
  });
});
