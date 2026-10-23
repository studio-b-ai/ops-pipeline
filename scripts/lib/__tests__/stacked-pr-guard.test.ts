import { describe, expect, it } from "vitest";
import { checkStackedPr } from "../stacked-pr-guard.js";

describe("checkStackedPr — both directions (Rule #322)", () => {
  it("known-BAD: base branch already merged to main → refused", () => {
    const result = checkStackedPr({
      baseRefName: "feature/x",
      baseBranchMergedToMain: true,
      baseBranchHasOpenPrToMain: false,
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("never reach main");
  });

  it("known-BAD: base branch not merged to main AND no open PR → refused (unknown status)", () => {
    const result = checkStackedPr({
      baseRefName: "feature/x",
      baseBranchMergedToMain: false,
      baseBranchHasOpenPrToMain: false,
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("unknown");
  });

  it("known-GOOD: target is main → safe, no stacking to check", () => {
    const result = checkStackedPr({
      baseRefName: "main",
      baseBranchMergedToMain: false,
      baseBranchHasOpenPrToMain: false,
    });
    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("known-GOOD: stacked on a feature branch that still has an open PR to main → safe", () => {
    const result = checkStackedPr({
      baseRefName: "feature/y",
      baseBranchMergedToMain: false,
      baseBranchHasOpenPrToMain: true,
    });
    expect(result.safe).toBe(true);
  });

  it("negative control: base=main with merged=true (contradictory — main can't be its own head) → safe (main bypass)", () => {
    const result = checkStackedPr({
      baseRefName: "main",
      baseBranchMergedToMain: true,
      baseBranchHasOpenPrToMain: false,
    });
    expect(result.safe).toBe(true);
  });

  it("guard fires even when merged AND open both true — merged is the alarm, it wins", () => {
    const result = checkStackedPr({
      baseRefName: "feature/z",
      baseBranchMergedToMain: true,
      baseBranchHasOpenPrToMain: true,
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("already been merged");
  });
});