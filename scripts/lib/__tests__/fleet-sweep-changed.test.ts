import { describe, it, expect } from "vitest";
import { fingerprintOf, splitChanged } from "../fleet-sweep-changed.js";

const pr = (over: Partial<Parameters<typeof fingerprintOf>[0]> = {}) => ({
  headRefOid: "abc123", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], labels: [{ name: "fleet-internal" }], mergeStateStatus: "CLEAN", isDraft: false, ...over,
});

describe("change-driven sweep — the fingerprint is the reason to look (#382)", () => {
  it("identical PR + identical gate → identical fingerprint (order of checks/labels irrelevant)", () => {
    const a = fingerprintOf(pr({ statusCheckRollup: [{ name: "b", conclusion: "SUCCESS" }, { name: "a", conclusion: "FAILURE" }], labels: [{ name: "y" }, { name: "x" }] }), "g1");
    const b = fingerprintOf(pr({ statusCheckRollup: [{ name: "a", conclusion: "FAILURE" }, { name: "b", conclusion: "SUCCESS" }], labels: [{ name: "x" }, { name: "y" }] }), "g1");
    expect(a).toBe(b);
  });
  it.each([
    ["new head sha", pr({ headRefOid: "def456" })],
    ["a check flipped", pr({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })],
    ["a label added", pr({ labels: [{ name: "fleet-internal" }, { name: "hold" }] })],
    ["mergeState changed", pr({ mergeStateStatus: "DIRTY" })],
    ["draft toggled", pr({ isDraft: true })],
  ])("known-bad control: %s → fingerprint changes", (_n, changed) => {
    expect(fingerprintOf(changed, "g1")).not.toBe(fingerprintOf(pr(), "g1"));
  });
  it("a door change (gate sha) re-evaluates everything once (#381)", () => {
    expect(fingerprintOf(pr(), "g1")).not.toBe(fingerprintOf(pr(), "g2"));
  });
  it("splitChanged: unchanged PRs are skipped WITH their prior receipt; changed + never-seen are evaluated", () => {
    const entries = [{ repo: "r", pr_number: "1" }, { repo: "r", pr_number: "2" }, { repo: "r", pr_number: "3" }];
    const live = { "r#1": "same", "r#2": "moved", "r#3": "new" };
    const state = { "r#1": { fp: "same", at: "t0", verdict: "DIRTY" }, "r#2": { fp: "old", at: "t0", verdict: "missed" } };
    const { changed, unchanged } = splitChanged(entries, live, state);
    expect(changed.map((e) => e.pr_number)).toEqual(["2", "3"]);
    expect(unchanged).toEqual([{ key: "r#1", prior: { fp: "same", at: "t0", verdict: "DIRTY" } }]);
  });
  it("known-good control: empty state → everything is evaluated (first run after the door change)", () => {
    const entries = [{ repo: "r", pr_number: "1" }];
    expect(splitChanged(entries, { "r#1": "x" }, {}).changed).toHaveLength(1);
  });
});
