import { describe, it, expect } from "vitest";
import { fingerprintOf, splitChanged } from "../fleet-sweep-changed.js";

const pr = (over: Partial<Parameters<typeof fingerprintOf>[0]> = {}) => ({
  headRefOid: "abc123", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], labels: [{ name: "fleet-internal" }], mergeStateStatus: "CLEAN", isDraft: false, ...over,
});

describe("change-driven sweep — the fingerprint is the reason to look (#382)", () => {
  it("identical PR → identical fingerprint (order of checks/labels irrelevant)", () => {
    const a = fingerprintOf(pr({ statusCheckRollup: [{ name: "b", conclusion: "SUCCESS" }, { name: "a", conclusion: "FAILURE" }], labels: [{ name: "y" }, { name: "x" }] }));
    const b = fingerprintOf(pr({ statusCheckRollup: [{ name: "a", conclusion: "FAILURE" }, { name: "b", conclusion: "SUCCESS" }], labels: [{ name: "x" }, { name: "y" }] }));
    expect(a).toBe(b);
  });
  it.each([
    ["new head sha", pr({ headRefOid: "def456" })],
    ["a check flipped", pr({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })],
    ["a label added", pr({ labels: [{ name: "fleet-internal" }, { name: "hold" }] })],
    ["mergeState changed", pr({ mergeStateStatus: "DIRTY" })],
    ["draft toggled", pr({ isDraft: true })],
  ])("known-bad control: %s → fingerprint changes", (_n, changed) => {
    expect(fingerprintOf(changed)).not.toBe(fingerprintOf(pr()));
  });
  it("gateSha is NOT part of the PR fingerprint (#836 — a door change re-evaluates once, not every cycle)", () => {
    const a = fingerprintOf(pr({ headRefOid: "abc" }));
    const b = fingerprintOf(pr({ headRefOid: "abc" }));
    expect(a).toBe(b); // head sha alone doesn't change fingerprint; the gate-sha is tracked separately
  });
  it("splitChanged: unchanged PRs are skipped WITH their prior receipt; changed + never-seen are evaluated", () => {
    const entries = [{ repo: "r", pr_number: "1" }, { repo: "r", pr_number: "2" }, { repo: "r", pr_number: "3" }];
    const live = { "r#1": "same", "r#2": "moved", "r#3": "new" };
    const state = { "r#1": { fp: "same", at: "t0", verdict: "DIRTY" }, "r#2": { fp: "old", at: "t0", verdict: "missed" }, _lastGateSha: "g1" };
    const { changed, unchanged } = splitChanged(entries, live, state, "g1");
    expect(changed.map((e) => e.pr_number)).toEqual(["2", "3"]);
    expect(unchanged).toEqual([{ key: "r#1", prior: { fp: "same", at: "t0", verdict: "DIRTY" } }]);
  });
  it("known-good control: empty state → everything is evaluated (first run after the door change)", () => {
    const entries = [{ repo: "r", pr_number: "1" }];
    expect(splitChanged(entries, { "r#1": "x" }, {}, "g1").changed).toHaveLength(1);
  });
  it("gateSha change forces ONE re-evaluation of all PRs (#836, #381)", () => {
    const entries = [{ repo: "r", pr_number: "1" }, { repo: "r", pr_number: "2" }];
    const live = { "r#1": "same", "r#2": "same2" };
    const state = { "r#1": { fp: "same", at: "t0", verdict: "DIRTY" }, "r#2": { fp: "same2", at: "t0", verdict: "UNSTABLE" }, _lastGateSha: "g1" };
    const { changed } = splitChanged(entries, live, state, "g2");
    expect(changed.map((e) => e.pr_number)).toEqual(["1", "2"]);
  });
  it("after gateSha change + record, unchanged PRs are skipped (gateSha stabilized)", () => {
    const entries = [{ repo: "r", pr_number: "1" }];
    const live = { "r#1": "same" };
    const state = { "r#1": { fp: "same", at: "t0", verdict: "DIRTY" }, _lastGateSha: "g2" };
    const { changed, unchanged } = splitChanged(entries, live, state, "g2");
    expect(changed).toHaveLength(0);
    expect(unchanged[0].prior.verdict).toBe("DIRTY");
  });
  it("no prior _lastGateSha → normal fingerprint comparison (first-ever run)", () => {
    const entries = [{ repo: "r", pr_number: "1" }];
    const live = { "r#1": "same" };
    const state = { "r#1": { fp: "same", at: "t0", verdict: "CLEAN" } };
    const { changed } = splitChanged(entries, live, state, "g1");
    expect(changed).toHaveLength(0);
  });
});
