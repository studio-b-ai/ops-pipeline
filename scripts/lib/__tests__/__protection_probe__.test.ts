// TEMPORARY known-bad probe (ops-pipeline#25, Rule #464): proves the newly-required
// "Scripts — typecheck + tests" check actually goes RED and BLOCKS a merge.
// This branch is never merged; it is closed and deleted as soon as the block is observed.
import { describe, expect, it } from "vitest";

describe("branch-protection probe", () => {
  it("FAILS ON PURPOSE — if this is green, the required check is not wired", () => {
    expect(1).toBe(2);
  });
});
