import { describe, it, expect } from "vitest";
import { fingerprintOf, POLICY_VERSION, selectAndRecord, splitChanged } from "../fleet-sweep-changed.js";

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

// ───── door policy (row 928): POLICY_VERSION re-evaluates the pile exactly once, spread over sweeps ─────

describe("POLICY_VERSION — a policy bump is one re-evaluation of every open labelled PR, not more, not fewer", () => {
  const prs = [pr(), pr({ headRefOid: "def456" }), pr({ labels: [{ name: "fleet-internal" }, { name: "needs-human" }] }), pr({ mergeStateStatus: "BLOCKED" })];

  it("is a non-empty string and is part of every fingerprint", () => {
    expect(POLICY_VERSION.length).toBeGreaterThan(0);
    for (const p of prs) expect(fingerprintOf(p, "g1")).toContain(POLICY_VERSION);
  });

  it("known-BAD control: bumping the version changes EVERY fingerprint (same PR, same gate sha, same labels)", () => {
    for (const p of prs) expect(fingerprintOf(p, "g1", "v1")).not.toBe(fingerprintOf(p, "g1", "v2"));
  });

  it("known-GOOD control: the same version is stable (nothing re-evaluates without a reason)", () => {
    for (const p of prs) expect(fingerprintOf(p, "g1", "v2")).toBe(fingerprintOf(p, "g1", "v2"));
  });

  it("the default version is the exported constant", () => {
    expect(fingerprintOf(pr(), "g1")).toBe(fingerprintOf(pr(), "g1", POLICY_VERSION));
  });

  // The full drain, through the REAL selectAndRecord: 9 parked PRs in 3 repos, per-repo cap 2, global cap 5.
  const entries = Array.from({ length: 9 }, (_, i) => ({ repo: `r${i % 3}`, pr_number: String(i + 1), train_ready: false }));
  const liveAt = (v: string) => Object.fromEntries(entries.map((e) => [`${e.repo}#${e.pr_number}`, fingerprintOf(pr({ headRefOid: `sha${e.pr_number}` }), "g1", v)]));
  const order = { maxFanout: 5, perRepoCap: 2, runOffset: 0 };

  function sweepUntilQuiet(startState: Record<string, { fp: string; at: string; verdict?: string }>, live: Record<string, string>) {
    let state = startState;
    const evaluated: string[] = [];
    const perSweep: number[] = [];
    for (let run = 0; run < 12; run++) {
      const res = selectAndRecord(entries, live, state, `t${run}`, { ...order, runOffset: run });
      perSweep.push(res.emitted.length);
      evaluated.push(...res.emitted.map((e) => `${e.repo}#${e.pr_number}`));
      state = res.nextState;
      if (res.emitted.length === 0) break;
    }
    return { evaluated, perSweep, state };
  }

  it("a bump from v1 to v2 evaluates every one of the 9 PRs EXACTLY once across several capped sweeps, then goes quiet", () => {
    // v1 era: everything recorded (the pile is parked)
    const v1 = sweepUntilQuiet({}, liveAt("v1"));
    expect(v1.evaluated.sort()).toEqual(entries.map((e) => `${e.repo}#${e.pr_number}`).sort());
    // the bump
    const v2 = sweepUntilQuiet(v1.state, liveAt("v2"));
    expect(v2.evaluated.sort()).toEqual(entries.map((e) => `${e.repo}#${e.pr_number}`).sort()); // every PR, none lost
    expect(new Set(v2.evaluated).size).toBe(v2.evaluated.length); // none twice
    expect(v2.perSweep.filter((n) => n > 0).length).toBeGreaterThan(1); // it SPREAD over sweeps (the caps held)
    expect(Math.max(...v2.perSweep)).toBeLessThanOrEqual(5);
    expect(v2.perSweep.at(-1)).toBe(0); // and it went quiet: not evaluated again
  });

  it("a sweep AFTER the drain, with the same version and unchanged PRs, evaluates nothing", () => {
    const first = sweepUntilQuiet({}, liveAt("v2"));
    const again = selectAndRecord(entries, liveAt("v2"), first.state, "later", order);
    expect(again.emitted).toEqual([]);
    expect(again.unchanged).toHaveLength(9);
  });

  it("deferred entries are NOT recorded: a capped-out PR keeps its prior fingerprint and returns next sweep (the 10/06 bulk-record defect)", () => {
    const state = Object.fromEntries(entries.map((e) => [`${e.repo}#${e.pr_number}`, { fp: "old", at: "t0", verdict: "missed" }]));
    const res = selectAndRecord(entries, liveAt("v2"), state, "t1", order);
    expect(res.deferred.length).toBeGreaterThan(0);
    for (const e of res.deferred) expect(res.nextState[`${e.repo}#${e.pr_number}`]).toEqual({ fp: "old", at: "t0", verdict: "missed" });
    for (const e of res.emitted) expect(res.nextState[`${e.repo}#${e.pr_number}`].fp).toBe(liveAt("v2")[`${e.repo}#${e.pr_number}`]);
  });

  it("a PR enumerated twice (e.g. bugsquasher + box variants) whose variants straddle the cap is NOT recorded until both ran", () => {
    const dup = [
      { repo: "rA", pr_number: "1", train_ready: true },
      { repo: "rA", pr_number: "1", train_ready: false },
      { repo: "rA", pr_number: "2", train_ready: false },
      { repo: "rA", pr_number: "3", train_ready: false },
    ];
    const live = { "rA#1": "n1", "rA#2": "n2", "rA#3": "n3" };
    // runOffset 1 rotates rA's capped group to [#2, #3, #1] and the cap of 1 keeps only #2 — so the
    // bugsquasher variant of #1 is CUT while its train variant (uncapped group) is still emitted.
    const res = selectAndRecord(dup, live, {}, "t1", { maxFanout: 100, perRepoCap: 1, runOffset: 1 });
    expect(res.emitted.map((e) => `${e.repo}#${e.pr_number}:${e.train_ready}`).sort()).toEqual(["rA#1:true", "rA#2:false"]);
    expect(res.deferred.map((e) => `${e.repo}#${e.pr_number}:${e.train_ready}`).sort()).toEqual(["rA#1:false", "rA#3:false"]);
    expect(res.nextState["rA#1"]).toBeUndefined(); // one variant is still owed an evaluation, so the key stays unrecorded
    expect(res.nextState["rA#2"]).toMatchObject({ fp: "n2" }); // a fully-emitted key IS recorded
    expect(res.nextState["rA#3"]).toBeUndefined();
  });

  it("PRs that left the enumeration are pruned from the state (it never grows past the open labelled set)", () => {
    const res = selectAndRecord([entries[0]], { "r0#1": "x" }, { "r0#1": { fp: "x", at: "t0" }, "gone#9": { fp: "y", at: "t0" } }, "t1");
    expect(Object.keys(res.nextState)).toEqual(["r0#1"]);
  });

  it("without a cap, every changed entry is emitted and recorded (the pre-cap behaviour for callers that pass none)", () => {
    const res = selectAndRecord(entries, liveAt("v2"), {}, "t1");
    expect(res.emitted).toHaveLength(9);
    expect(res.deferred).toHaveLength(0);
    expect(Object.keys(res.nextState)).toHaveLength(9);
  });
});
