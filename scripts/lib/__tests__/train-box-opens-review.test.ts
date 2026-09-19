import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateMergeReadiness } from "../automerge-classify.js";
import { formatTrainMergeReceipt } from "../merge-door.js";

const SCRIPTS_DIR = join(import.meta.dirname, "..", "..");

/**
 * Stint #372 (2026-09-19) — the door gap this file guards. In train mode (a PR
 * enumerated on `box` alone — squasher-fleet-sweep `--train-ready` entries and the
 * org-wide box leg) `evaluateTrainReadyInner` still ran an independent model review
 * AFTER the label-authority leg had verified Kevin's sha-pinned `box`, and refused on
 * it: client-asthetik#391 refused 07:0xZ on "review verdict FLAG 0/3" WITH the box
 * present (run 34939031962 job 104283427915).
 *
 * The ruling (library/decisions/2026-09-15-box-is-the-one-key.md, law 1): `box` "opens
 * every DECISION leg of the door (class-match · line-cap · named-checks · review). The
 * floor never lowers: a red CI rollup or a sensitive path refuses whatever the label
 * says." The squasher path's `evaluateQueuedOverride` has worked exactly this way
 * since ops-pipeline#260 leg 4 — the train gate now honors box identically.
 *
 * Positive control (the stint): a box-only PR with a FLAG-shaped diff and green CI
 * merges — nothing on the train path may invoke the model vote or refuse on it.
 * Negative control: a box-only PR with a red rollup, DIRTY or UNSTABLE mergeStateStatus
 * still refuses — the readiness floor is untouched (brain#160 DIRTY,
 * client-asthetik#372 UNSTABLE, both refused this run).
 */

const src = readFileSync(join(SCRIPTS_DIR, "pr-automerge-gate.ts"), "utf8");

/** The train gate's body, bounded so assertions can't bleed into evaluate()/main(). */
function trainGateBody(): string {
  const start = src.indexOf("async function evaluateTrainReadyInner");
  const end = src.indexOf("async function main", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("the train gate honors box exactly as evaluateQueuedOverride does (stint #372)", () => {
  it("no model vote, human-receipt probe, or review refusal exists anywhere on the train path", () => {
    const body = trainGateBody();
    expect(body).not.toContain("independentReviewVote(");
    expect(body).not.toContain("humanReviewReceipt(");
    expect(body).not.toContain("reviewFlagCardOnHead(");
    expect(body).not.toContain('leg: "review"');
    expect(body).not.toContain("postFlagCard(");
    // The code shape of a review refusal — the historical "review verdict FLAG 0/3"
    // quote survives only inside the removal comment, which is why this asserts on
    // `review.verdict` (the expression), never the prose.
    expect(body).not.toContain("review.verdict");
    expect(body).not.toContain("ReviewVerdict");
  });

  it("the leg order is authority → readiness floor → revalidate → merge, with nothing between", () => {
    const body = trainGateBody();
    const authorityIdx = body.indexOf("evaluateLabelAuthority({");
    const readinessIdx = body.indexOf("evaluateMergeReadiness({");
    const revalidateIdx = body.indexOf("hasAuthoritySnapshotDrifted(before, after)");
    const mergeIdx = body.indexOf("mergePr(repo, pr, prJson.headRefOid)");
    expect(authorityIdx).toBeGreaterThan(-1);
    expect(readinessIdx).toBeGreaterThan(authorityIdx); // floor AFTER authority (stale-label strip runs regardless of CI)
    expect(revalidateIdx).toBeGreaterThan(readinessIdx); // nothing (review or otherwise) sits between floor and revalidate
    expect(mergeIdx).toBeGreaterThan(revalidateIdx);
  });

  it("the removal comment cites the ruling, so a future reader does not re-add the leg", () => {
    const body = trainGateBody();
    expect(body).toContain("opens every DECISION leg");
    expect(body).toContain("client-asthetik#391");
    expect(body).toContain("evaluateQueuedOverride");
  });

  it("the retired train review prompt is gone from the file (no dead model spend config)", () => {
    expect(src).not.toContain("TRAIN_READY_REVIEW_SYSTEM");
  });
});

describe("the floor never lowers — box opens decision legs, never the readiness floor", () => {
  const base = { state: "OPEN", isDraft: false };

  it("positive control: a CLEAN mergeable head with a green rollup is ready", () => {
    expect(evaluateMergeReadiness({ ...base, ciClean: true, mergeStateStatus: "CLEAN" }).ready).toBe(true);
  });

  // The stint's negative controls: brain#160 (DIRTY) and client-asthetik#372 (UNSTABLE)
  // refused on the 2026-09-19 run; both must KEEP refusing under the new gate.
  it.each(["DIRTY", "UNSTABLE", "BEHIND", "BLOCKED", "UNKNOWN"])("negative control: mergeStateStatus %s still refuses", (mss) => {
    const r = evaluateMergeReadiness({ ...base, ciClean: true, mergeStateStatus: mss });
    expect(r.ready).toBe(false);
    expect(r.detail).toContain(mss);
  });

  it("negative control: a red/pending CI rollup refuses even on a CLEAN mergeStateStatus", () => {
    expect(evaluateMergeReadiness({ ...base, ciClean: false, mergeStateStatus: "CLEAN" }).ready).toBe(false);
  });

  it("negative control: draft or closed refuses", () => {
    expect(evaluateMergeReadiness({ state: "OPEN", isDraft: true, ciClean: true, mergeStateStatus: "CLEAN" }).ready).toBe(false);
    expect(evaluateMergeReadiness({ state: "MERGED", isDraft: false, ciClean: true, mergeStateStatus: "CLEAN" }).ready).toBe(false);
  });
});

describe("the merge receipt tells the truth about what ran (#412: prose is a claim)", () => {
  const receipt = formatTrainMergeReceipt({
    door: null,
    authorizingLogin: "kbibelhausen",
    authorizingPosition: 4,
    headRefOid: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  });

  it("no longer claims a model review that never ran", () => {
    expect(receipt).not.toContain("independent review");
    expect(receipt).not.toContain("Sonnet");
    expect(receipt).not.toMatch(/review.*✅ CLEAN/);
  });

  it("states the law instead: decision legs opened by box; the floor stands", () => {
    expect(receipt).toContain("decision legs (review)");
    expect(receipt).toContain("opened by `box`");
    expect(receipt).toContain("the floor above never lowers");
    // The floor rows are still present and still claimed ✅.
    expect(receipt).toContain("| merge-ready (OPEN, not draft, mergeStateStatus CLEAN) + CI rollup clean | ✅ |");
    expect(receipt).toContain("| authority (label-authority v2, revalidated pre-merge) | ✅ authorized by `kbibelhausen` (timeline position 4) |");
  });
});
