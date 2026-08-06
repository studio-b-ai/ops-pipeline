import { describe, expect, it } from "vitest";
import {
  classifyHealth,
  conditionTitle,
  parseReceipts,
  type SweepRun,
} from "../squasher-health-classify.js";

// Rule #223: fixtures are RECORDED, not hand-crafted — these are verbatim lines from
// bolt-wms sweep run 30934728749 (2026-08-04, the first-autonomous-merge sweep) plus
// the leg=other shape from the pre-#19 crash era.
const LIVE_LOG = `
2026-08-04T17:37:00Z [gate-receipt] repo=studio-b-ai/bolt-wms pr=1464 class=docs-comment verdict=qualified
2026-08-04T17:37:10Z [gate-receipt] repo=studio-b-ai/bolt-wms pr=1463 class=docs-comment verdict=missed leg=review reasons="independent review verdict 'FLAG' !== 'CLEAN'"
2026-08-04T17:37:20Z [gate-receipt] repo=studio-b-ai/bolt-wms pr=1458 class=unclassified verdict=missed leg=ci-rollup reasons="state=OPEN ciClean=false mergeStateStatus=UNSTABLE"
`;
const CRASH_LOG = `[gate-receipt] repo=studio-b-ai/bolt-wms pr=1456 class=unclassified verdict=missed leg=other reasons="fetchPr threw"`;

const NOW = new Date("2026-08-04T20:00:00Z");

function run(overrides: Partial<SweepRun> = {}): SweepRun {
  return { databaseId: 1, status: "completed", conclusion: "success", createdAt: "2026-08-04T19:17:00Z", ...overrides };
}

describe("parseReceipts", () => {
  it("parses the live sweep's three receipts, legs included", () => {
    const r = parseReceipts(LIVE_LOG);
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ repo: "studio-b-ai/bolt-wms", pr: 1464, cls: "docs-comment", verdict: "qualified", leg: null });
    expect(r[1].leg).toBe("review");
    expect(r[2].leg).toBe("ci-rollup");
  });
  it("plain log noise yields nothing (negative control)", () => {
    expect(parseReceipts("Sweep found 3 open bugsquasher PR(s).\n[merged] pr-automerge-gate ...")).toEqual([]);
  });
});

describe("classifyHealth — healthy state is SILENT (the known-good direction, #471)", () => {
  it("fresh successful sweep + clean receipts → zero conditions", () => {
    const conditions = classifyHealth([run()], parseReceipts(LIVE_LOG), 4, NOW);
    expect(conditions).toEqual([]);
  });
  it("declines (leg=review / leg=ci-rollup) are the gate WORKING, never a condition", () => {
    const conditions = classifyHealth([run()], parseReceipts(LIVE_LOG), 4, NOW);
    expect(conditions.find((c) => c.key === "crash-receipts")).toBeUndefined();
  });
});

describe("classifyHealth — each condition fires on its known-bad", () => {
  it("dead-sweep: latest completed run outside the SLA window", () => {
    const stale = [run({ createdAt: "2026-08-04T10:00:00Z" })]; // 10h ago vs 4h SLA
    const c = classifyHealth(stale, [], 4, NOW);
    expect(c.map((x) => x.key)).toContain("dead-sweep");
    expect(c.find((x) => x.key === "dead-sweep")!.detail).toContain("INERT");
  });

  it("dead-sweep: no completed runs at all (stuck in_progress forever counts as dead)", () => {
    const hung = [run({ status: "in_progress", conclusion: null, createdAt: "2026-08-04T19:50:00Z" })];
    const c = classifyHealth(hung, [], 4, NOW);
    expect(c.map((x) => x.key)).toContain("dead-sweep");
  });

  it("runs-failing: latest completed run concluded failure (the #19 class)", () => {
    const failing = [run({ conclusion: "failure" })];
    const c = classifyHealth(failing, [], 4, NOW);
    expect(c.map((x) => x.key)).toContain("runs-failing");
    expect(c.find((x) => x.key === "runs-failing")!.detail).toContain("'failure'");
  });

  it("crash-receipts: leg=other fires and names the PR", () => {
    const c = classifyHealth([run()], parseReceipts(CRASH_LOG), 4, NOW);
    const crash = c.find((x) => x.key === "crash-receipts");
    expect(crash).toBeDefined();
    expect(crash!.detail).toContain("#1456");
  });

  it("conditions are independent — a repo can be dead AND failing at once", () => {
    const both = [run({ conclusion: "failure", createdAt: "2026-08-04T10:00:00Z" })];
    const keys = classifyHealth(both, [], 4, NOW).map((x) => x.key);
    expect(keys).toContain("dead-sweep");
    expect(keys).toContain("runs-failing");
  });
});

describe("conditionTitle (the reconcile identity)", () => {
  it("is stable and repo-scoped", () => {
    expect(conditionTitle("studio-b-ai/bolt-wms", "dead-sweep")).toBe("[squasher-health] studio-b-ai/bolt-wms: dead-sweep");
  });
});

// ── infrastructure vs machinery (2026-08-06 GitHub Actions major_outage) ──────
describe("infrastructure conclusions are not machinery failures", () => {
  const run = (conclusion: string) => ({
    databaseId: 31124894441,
    status: "completed",
    conclusion,
    // Pinned relative to NOW (#256) — 1h old, comfortably inside the 4h SLA,
    // so dead-sweep cannot fire and confound these assertions.
    createdAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
  });

  it("PLANTED CONTROL — the live misfire: a cancelled sweep must NOT report runs-failing", () => {
    // bolt-wms#1520, 2026-08-06: job=cancelled, zero failed steps, evaluate job
    // skipped. The old classifier called this "the gate is ERRORING" and sent
    // the reader to an empty log.
    const c = classifyHealth([run("cancelled")], [], 4, NOW);
    const keys = c.map((x) => x.key);
    expect(keys).not.toContain("runs-failing");
    expect(keys).toContain("sweep-infrastructure");
  });

  it("says INFRASTRUCTURE plainly and refuses both false readings", () => {
    const [cond] = classifyHealth([run("cancelled")], [], 4, NOW)
      .filter((x) => x.key === "sweep-infrastructure");
    expect(cond.detail).toMatch(/INFRASTRUCTURE/);
    expect(cond.detail).toMatch(/githubstatus/);
    // It must not claim the gate broke, nor that the gate is fine.
    expect(cond.detail).not.toMatch(/gate is ERRORING/);
    expect(cond.detail).toMatch(/unmeasured/);
  });

  it("covers startup_failure and stale — the runner never ran the job", () => {
    for (const conclusion of ["startup_failure", "stale"]) {
      const keys = classifyHealth([run(conclusion)], [], 4, NOW)
        .map((x) => x.key);
      expect(keys).toContain("sweep-infrastructure");
      expect(keys).not.toContain("runs-failing");
    }
  });

  it("DON'T-LOOSEN GUARD — a real failure still reports runs-failing", () => {
    // The whole point of the monitor. A genuine gate error must not be
    // reclassified as somebody else's problem.
    const keys = classifyHealth([run("failure")], [], 4, NOW)
      .map((x) => x.key);
    expect(keys).toContain("runs-failing");
    expect(keys).not.toContain("sweep-infrastructure");
  });

  it("timed_out stays MACHINERY — a hang is a real symptom, not infrastructure", () => {
    const keys = classifyHealth([run("timed_out")], [], 4, NOW)
      .map((x) => x.key);
    expect(keys).toContain("runs-failing");
  });

  it("success raises neither", () => {
    const keys = classifyHealth([run("success")], [], 4, NOW)
      .map((x) => x.key);
    expect(keys).not.toContain("runs-failing");
    expect(keys).not.toContain("sweep-infrastructure");
  });
});
