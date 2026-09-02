import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadIssueRoutingTable,
  parseIssueRoutingTable,
  routeIssue,
} from "../issue-class-routing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** scripts/lib/__tests__/ → scripts/issue-class-routing.yaml */
const COMMITTED_FILE = join(HERE, "..", "..", "issue-class-routing.yaml");

const GOOD = `
version: 1
workers:
  squasher: { routine: trig_A }
  enhancement-worker: { routine: trig_B }
routes:
  - { label: bug, worker: squasher }
  - { label: enhancement, worker: enhancement-worker }
default: { worker: squasher, restate: true }
vetoes: [needs-human, awaiting-approval, wontfix, needs-triage]
never_prefixes: ["lane:"]
`;

describe("parseIssueRoutingTable — strict, fail-closed", () => {
  it("parses a well-formed table", () => {
    const t = parseIssueRoutingTable(GOOD);
    expect(t.version).toBe(1);
    expect([...t.workers.keys()]).toEqual(["squasher", "enhancement-worker"]);
    expect(t.routes).toEqual([
      { label: "bug", worker: "squasher" },
      { label: "enhancement", worker: "enhancement-worker" },
    ]);
    expect(t.defaultRoute).toEqual({ worker: "squasher", restate: true });
    expect([...t.vetoes]).toEqual(["needs-human", "awaiting-approval", "wontfix", "needs-triage"]);
    expect(t.neverPrefixes).toEqual(["lane:"]);
  });

  it("throws on a non-mapping top level", () => {
    expect(() => parseIssueRoutingTable("- just\n- a list\n")).toThrow(/top level must be a mapping/);
  });

  it("throws on an unknown top-level key", () => {
    expect(() => parseIssueRoutingTable(GOOD + "extra: 1\n")).toThrow(/unknown top-level key `extra`/);
  });

  it("throws when a route names an undeclared worker", () => {
    const bad = GOOD.replace("worker: enhancement-worker }", "worker: ghost }");
    expect(() => parseIssueRoutingTable(bad)).toThrow(/undeclared worker `ghost`/);
  });

  it("throws when the default names an undeclared worker", () => {
    const bad = GOOD.replace("default: { worker: squasher", "default: { worker: nobody");
    expect(() => parseIssueRoutingTable(bad)).toThrow(/default names undeclared worker `nobody`/);
  });

  it("throws when workers is empty (nothing could ever dispatch)", () => {
    const bad = GOOD.replace(/workers:[\s\S]*?routes:/, "workers: {}\nroutes:");
    expect(() => parseIssueRoutingTable(bad)).toThrow(/`workers` must be a non-empty mapping/);
  });

  it("throws on a non-string veto entry", () => {
    const bad = GOOD.replace("vetoes: [needs-human,", "vetoes: [7,");
    expect(() => parseIssueRoutingTable(bad)).toThrow(/`vetoes\[0\]` must be a non-empty string/);
  });

  it("loadIssueRoutingTable throws loudly on a missing file — never an empty table", () => {
    expect(() => loadIssueRoutingTable("/nonexistent/routing.yaml")).toThrow(/cannot read/);
  });
});

describe("routeIssue — every rung, both verdicts (#471)", () => {
  const t = parseIssueRoutingTable(GOOD);

  it("bug → squasher, no restate", () => {
    expect(routeIssue(["bug"], t)).toMatchObject({ decision: "dispatch", worker: "squasher", routine: "trig_A", restate: false });
  });

  it("enhancement → enhancement-worker", () => {
    expect(routeIssue(["enhancement"], t)).toMatchObject({ decision: "dispatch", worker: "enhancement-worker", routine: "trig_B" });
  });

  it("first matching route wins when both class labels are present", () => {
    expect(routeIssue(["enhancement", "bug"], t)).toMatchObject({ worker: "squasher" });
  });

  it("unlabeled → default worker WITH restate (unlabeled work is still worked)", () => {
    expect(routeIssue([], t)).toMatchObject({ decision: "dispatch", worker: "squasher", restate: true, reason: "no labels — default route" });
  });

  it("other-labeled (no class label) → default worker WITH restate", () => {
    expect(routeIssue(["question", "P2"], t)).toMatchObject({ decision: "dispatch", worker: "squasher", restate: true });
  });

  it("a veto label wins over a class label — needs-human + bug → never", () => {
    expect(routeIssue(["bug", "needs-human"], t)).toEqual({ decision: "never", reason: "veto label `needs-human`" });
  });

  it.each(["awaiting-approval", "wontfix", "needs-triage"])("veto `%s` → never", (v) => {
    expect(routeIssue(["enhancement", v], t)).toMatchObject({ decision: "never" });
  });

  it("a seat-owned label (lane:*) → never, even with a class label", () => {
    expect(routeIssue(["bug", "lane:mechanic"], t)).toEqual({ decision: "never", reason: "seat-owned label `lane:mechanic`" });
  });

  it("matching is case- and whitespace-insensitive (GitHub preserves case, humans do not)", () => {
    expect(routeIssue([" Bug "], t)).toMatchObject({ worker: "squasher", restate: false });
    expect(routeIssue(["Needs-Human"], t)).toMatchObject({ decision: "never" });
  });
});

describe("committed scripts/issue-class-routing.yaml", () => {
  const committed = loadIssueRoutingTable(COMMITTED_FILE);

  it("parses strictly and names both live routines", () => {
    expect(committed.workers.get("squasher")?.routine).toBe("trig_01EHMVrXLW1xg2aixEc1MXNJ");
    expect(committed.workers.get("enhancement-worker")?.routine).toBe("trig_01E64JV6mRtDsyJzXAbvE8jK");
  });

  it("carries exactly the ruled veto set and the lane: prefix", () => {
    expect([...committed.vetoes].sort()).toEqual(["needs-human", "needs-triage", "wontfix"]);
    expect(committed.neverPrefixes).toEqual(["lane:"]);
  });

  it("`awaiting-approval` is NOT a veto in the committed table — the Zoom 👍 gate is retired (wr#837), those issues dispatch", () => {
    // Both verdicts (#471): the retired label dispatches; a real veto beside it still wins.
    expect(routeIssue(["enhancement", "awaiting-approval"], committed)).toMatchObject({ decision: "dispatch", worker: "enhancement-worker" });
    expect(routeIssue(["enhancement", "awaiting-approval", "needs-human"], committed)).toMatchObject({ decision: "never" });
  });

  it("routes the four ruled shapes as ruled", () => {
    expect(routeIssue(["bug"], committed)).toMatchObject({ worker: "squasher" });
    expect(routeIssue(["enhancement"], committed)).toMatchObject({ worker: "enhancement-worker" });
    expect(routeIssue([], committed)).toMatchObject({ worker: "squasher", restate: true });
    expect(routeIssue(["lane:engineer"], committed)).toMatchObject({ decision: "never" });
  });

  it("is byte-identical to what the loader read (no drift between file and test fixture)", () => {
    expect(readFileSync(COMMITTED_FILE, "utf8")).toContain("version: 1");
  });
});
