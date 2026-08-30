import { describe, expect, it } from "vitest";
import {
  attributeDeployment,
  BOOT_GRACE_SECONDS,
  classifyHealthWindow,
  detectWindowContamination,
  TRIP_MIN_5XX_BUCKETS,
  TRIP_MIN_5XX_TOTAL,
  WINDOW_SECONDS,
} from "../tripwire-health.js";
import { parseUnifiedDiff, stripAbPrefix } from "../automerge-classify.js";
import type { DeploymentWithMeta, HttpStatusGroup } from "../railway-deployment-probes.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const CLOSED_AT = "2026-08-30T04:00:00Z";

function dep(overrides: Partial<DeploymentWithMeta>): DeploymentWithMeta {
  return {
    id: "dep-1",
    // pg-enum-drift-exempt: Railway DeploymentStatus enum value, not a Postgres enum
    status: "SUCCESS",
    createdAt: "2026-08-30T04:05:00.000Z",
    updatedAt: "2026-08-30T04:07:00.000Z",
    commitHash: SHA,
    ...overrides,
  };
}

describe("attributeDeployment", () => {
  // ───── Negative controls first (Rule #322/#471): every disqualifier returns null ─────

  it("returns null when no deployment carries the squash sha", () => {
    expect(attributeDeployment([dep({ commitHash: OTHER_SHA })], SHA, CLOSED_AT)).toBeNull();
  });

  it("returns null for a commitHash-less deployment (image redeploy)", () => {
    expect(attributeDeployment([dep({ commitHash: null })], SHA, CLOSED_AT)).toBeNull();
  });

  it("ignores a PRE-EXISTING same-sha deployment created before the PR closed (§4.2)", () => {
    const preExisting = dep({ id: "old", createdAt: "2026-08-30T03:59:59.000Z" });
    expect(attributeDeployment([preExisting], SHA, CLOSED_AT)).toBeNull();
  });

  it("ignores a same-sha deployment created exactly AT the closed timestamp (strictly-after)", () => {
    const atBoundary = dep({ id: "boundary", createdAt: "2026-08-30T04:00:00.000Z" });
    expect(attributeDeployment([atBoundary], SHA, CLOSED_AT)).toBeNull();
  });

  it("disqualifies (never binds) a deployment with an unparseable createdAt", () => {
    const broken = dep({ id: "broken", createdAt: "not-a-timestamp" });
    expect(attributeDeployment([broken], SHA, CLOSED_AT)).toBeNull();
  });

  it("throws on an unparseable PR closed timestamp (fail-loud, never bind blind)", () => {
    expect(() => attributeDeployment([dep({})], SHA, "garbage")).toThrow(/unparseable/);
  });

  it("returns null on an empty deployment list", () => {
    expect(attributeDeployment([], SHA, CLOSED_AT)).toBeNull();
  });

  // ───── Positive direction ─────

  it("binds a qualifying deployment (sha match + created after close)", () => {
    const d = dep({});
    expect(attributeDeployment([d], SHA, CLOSED_AT)).toBe(d);
  });

  it("binds the EARLIEST qualifying deployment when several match", () => {
    const later = dep({ id: "later", createdAt: "2026-08-30T04:20:00.000Z" });
    const earlier = dep({ id: "earlier", createdAt: "2026-08-30T04:05:00.000Z" });
    expect(attributeDeployment([later, earlier], SHA, CLOSED_AT)?.id).toBe("earlier");
  });

  it("skips pre-existing and wrong-sha entries while binding the real one", () => {
    const preExisting = dep({ id: "old", createdAt: "2026-08-30T03:00:00.000Z" });
    const wrongSha = dep({ id: "wrong", commitHash: OTHER_SHA });
    const real = dep({ id: "real" });
    expect(attributeDeployment([preExisting, wrongSha, real], SHA, CLOSED_AT)?.id).toBe("real");
  });

  it("compares Railway fractional-seconds timestamps against GitHub whole-second ones numerically, not lexically", () => {
    // Lexical comparison of "2026-08-30T04:00:00.500Z" vs "2026-08-30T04:00:00Z" is
    // format-dependent; Date.parse makes 0.5s-after-close qualify.
    const halfSecondAfter = dep({ id: "frac", createdAt: "2026-08-30T04:00:00.500Z" });
    expect(attributeDeployment([halfSecondAfter], SHA, CLOSED_AT)?.id).toBe("frac");
  });
});

const T0 = 1_756_500_000; // window start (deployment SUCCESS), epoch seconds

function group(statusCode: number, samples: Array<[number, number]>): HttpStatusGroup {
  return { statusCode, samples: samples.map(([ts, value]) => ({ ts, value })) };
}

describe("classifyHealthWindow", () => {
  // ───── Trip direction (the non-default verdict gets its planted control — Rule #471) ─────

  it(`trips at ${TRIP_MIN_5XX_BUCKETS} distinct gating 5xx buckets`, () => {
    const groups = [
      group(200, [[T0 + 120, 50]]),
      group(500, [
        [T0 + 120, 1],
        [T0 + 150, 1],
        [T0 + 180, 1],
      ]),
    ];
    const result = classifyHealthWindow(groups, { successAtEpochSec: T0 });
    expect(result.verdict).toBe("trip");
    expect(result.gatingFiveXxBuckets).toBe(3);
    expect(result.detail).toMatch(/sustained 5xx/);
  });

  it(`trips at ${TRIP_MIN_5XX_TOTAL} total gating 5xx even in fewer buckets`, () => {
    const groups = [group(502, [[T0 + 120, 10]])];
    const result = classifyHealthWindow(groups, { successAtEpochSec: T0 });
    expect(result.verdict).toBe("trip");
    expect(result.gatingFiveXxTotal).toBe(10);
    expect(result.gatingFiveXxBuckets).toBe(1);
  });

  it("aggregates 5xx across DIFFERENT 5xx status codes (500 + 503 same bucket count)", () => {
    const groups = [
      group(500, [
        [T0 + 120, 3],
        [T0 + 150, 3],
      ]),
      group(503, [[T0 + 180, 4]]),
    ];
    const result = classifyHealthWindow(groups, { successAtEpochSec: T0 });
    expect(result.verdict).toBe("trip"); // 10 total across 3 buckets — both thresholds met
    expect(result.gatingFiveXxTotal).toBe(10);
    expect(result.gatingFiveXxBuckets).toBe(3);
  });

  // ───── Pass direction ─────

  it("passes a clean window and reports request totals", () => {
    const groups = [
      group(200, [
        [T0 + 60, 100],
        [T0 + 300, 200],
      ]),
      group(404, [[T0 + 300, 5]]),
    ];
    const result = classifyHealthWindow(groups, { successAtEpochSec: T0 });
    expect(result.verdict).toBe("pass");
    expect(result.totalRequests).toBe(305);
    expect(result.gatingFiveXxTotal).toBe(0);
    expect(result.noTraffic).toBe(false);
  });

  it("passes a single-bucket flap below both thresholds", () => {
    const groups = [group(200, [[T0 + 120, 50]]), group(500, [[T0 + 120, 2]])];
    const result = classifyHealthWindow(groups, { successAtEpochSec: T0 });
    expect(result.verdict).toBe("pass");
    expect(result.gatingFiveXxTotal).toBe(2);
    expect(result.gatingFiveXxBuckets).toBe(1);
  });

  it("boot-grace 5xx never gates but IS recorded (§4.2 / #208 boot burst)", () => {
    // A storm entirely inside the first 60s — even huge — must not trip.
    const groups = [
      group(500, [
        [T0 + 10, 500],
        [T0 + 40, 500],
      ]),
      group(200, [[T0 + 300, 10]]),
    ];
    const result = classifyHealthWindow(groups, { successAtEpochSec: T0 });
    expect(result.verdict).toBe("pass");
    expect(result.bootFiveXxTotal).toBe(1000);
    expect(result.gatingFiveXxTotal).toBe(0);
    expect(result.detail).toMatch(/boot-grace/);
  });

  it(`treats a 5xx sample exactly AT the grace boundary (ts = start+${BOOT_GRACE_SECONDS}) as boot, one step later as gating`, () => {
    const atBoundary = classifyHealthWindow([group(500, [[T0 + BOOT_GRACE_SECONDS, 20]])], { successAtEpochSec: T0 });
    expect(atBoundary.verdict).toBe("pass");
    expect(atBoundary.bootFiveXxTotal).toBe(20);

    const justAfter = classifyHealthWindow([group(500, [[T0 + BOOT_GRACE_SECONDS + 1, 20]])], { successAtEpochSec: T0 });
    expect(justAfter.verdict).toBe("trip");
    expect(justAfter.gatingFiveXxTotal).toBe(20);
  });

  it("ignores samples outside the window entirely (fetch over-coverage)", () => {
    const groups = [
      group(500, [
        [T0 - 30, 100], // before SUCCESS — a prior deploy's errors
        [T0 + WINDOW_SECONDS + 30, 100], // after the window closed
      ]),
    ];
    const result = classifyHealthWindow(groups, { successAtEpochSec: T0 });
    expect(result.verdict).toBe("pass");
    expect(result.totalRequests).toBe(0);
    expect(result.noTraffic).toBe(true);
  });

  it("zero-traffic window passes with an explicit no_traffic note (§4.2 residual, #412)", () => {
    const result = classifyHealthWindow([], { successAtEpochSec: T0 });
    expect(result.verdict).toBe("pass");
    expect(result.noTraffic).toBe(true);
    expect(result.detail).toMatch(/no_traffic/);
  });

  it("zero-VALUE samples (empty buckets Railway reports as 0) do not count as traffic", () => {
    const result = classifyHealthWindow([group(200, [[T0 + 120, 0]])], { successAtEpochSec: T0 });
    expect(result.noTraffic).toBe(true);
    expect(result.verdict).toBe("pass");
  });

  it("4xx never gates — a 404 storm passes (stated §4.2 residual)", () => {
    const groups = [
      group(404, [
        [T0 + 120, 500],
        [T0 + 150, 500],
        [T0 + 180, 500],
      ]),
    ];
    const result = classifyHealthWindow(groups, { successAtEpochSec: T0 });
    expect(result.verdict).toBe("pass");
    expect(result.gatingFiveXxTotal).toBe(0);
  });

  it("599 gates as 5xx; 600 does not (boundary of the class)", () => {
    const at599 = classifyHealthWindow([group(599, [[T0 + 120, 10]])], { successAtEpochSec: T0 });
    expect(at599.verdict).toBe("trip");
    const at600 = classifyHealthWindow([group(600, [[T0 + 120, 10]])], { successAtEpochSec: T0 });
    expect(at600.verdict).toBe("pass");
  });
});

// ───────────────────────────── parseUnifiedDiff (extracted from the gate for B2 reuse) ─────────────────────────────
//
// The gate's own suite exercised these only indirectly through evaluate(); the extraction
// makes them a shared classification path (gate + tripwire re-derivation), so they get
// direct tests here.

describe("stripAbPrefix", () => {
  it("strips a/ and b/ prefixes", () => {
    expect(stripAbPrefix("a/src/x.ts")).toBe("src/x.ts");
    expect(stripAbPrefix("b/docs/y.md")).toBe("docs/y.md");
  });

  it("leaves /dev/null intact", () => {
    expect(stripAbPrefix("/dev/null")).toBe("/dev/null");
  });

  it("only strips the leading prefix, never an interior a/ or b/ segment", () => {
    expect(stripAbPrefix("b/lib/a/b/x.ts")).toBe("lib/a/b/x.ts");
  });
});

describe("parseUnifiedDiff", () => {
  it("parses a simple one-file diff with added and removed lines", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "index 111..222 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line",
      " context",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/x.ts");
    expect(files[0].added).toEqual(["new line"]);
    expect(files[0].removed).toEqual(["old line"]);
    expect(files[0].binary).toBe(false);
  });

  it("a deleted file (+++ /dev/null) resolves its path from the --- side", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-goodbye",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/gone.ts");
    expect(files[0].removed).toEqual(["goodbye"]);
  });

  it("marks binary files (no hunks) with binary:true and no content lines", () => {
    const diff = ["diff --git a/img/logo.png b/img/logo.png", "Binary files a/img/logo.png and b/img/logo.png differ"].join(
      "\n",
    );
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("img/logo.png");
    expect(files[0].binary).toBe(true);
    expect(files[0].added).toEqual([]);
  });

  it("does NOT swallow content lines beginning with +++/--- inside hunks (header-zone gate)", () => {
    const diff = [
      "diff --git a/src/c.ts b/src/c.ts",
      "--- a/src/c.ts",
      "+++ b/src/c.ts",
      "@@ -1 +1,2 @@",
      " context",
      "+++counter;", // an added line whose content is `++counter;`
      "---counter;", // a removed line whose content is `--counter;`
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/c.ts");
    expect(files[0].added).toEqual(["++counter;"]);
    expect(files[0].removed).toEqual(["--counter;"]);
  });

  it("splits a multi-file diff into one entry per file", () => {
    const diff = [
      "diff --git a/one.ts b/one.ts",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/two.md b/two.md",
      "--- a/two.md",
      "+++ b/two.md",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["one.ts", "two.md"]);
  });

  it("omits a pure-rename entry (no content hunks) — reconcileFileClasses fail-closes it downstream", () => {
    const diff = [
      "diff --git a/old-name.ts b/new-name.ts",
      "similarity index 100%",
      "rename from old-name.ts",
      "rename to new-name.ts",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toHaveLength(0);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseUnifiedDiff("")).toHaveLength(0);
  });
});

describe("detectWindowContamination", () => {
  // Railway metrics are SERVICE-scoped (codex P1, 2026-08-30 pass 1) — these cases pin
  // exactly which post-window deployment states poison the verdict and which stay clean.
  const bound = { id: "dep-bound", createdAt: "2026-08-30T04:05:00.000Z" };
  const boundDep = dep({ id: "dep-bound" }); // SUCCESS at the bound createdAt by fixture default

  // ── clean cases ──
  it("is clean when the bound deployment is the only one and still SUCCESS", () => {
    expect(detectWindowContamination([boundDep], bound)).toEqual({ contaminated: false });
  });

  it("is clean when a newer deployment FAILED (never took traffic)", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus enum value, not a Postgres enum
    const newerFailed = dep({ id: "dep-newer", status: "FAILED", createdAt: "2026-08-30T04:09:00.000Z" });
    expect(detectWindowContamination([boundDep, newerFailed], bound)).toEqual({ contaminated: false });
  });

  it("is clean when a newer deployment is still building (hasn't taken traffic yet)", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus enum value, not a Postgres enum
    const newerBuilding = dep({ id: "dep-newer", status: "DEPLOYING", createdAt: "2026-08-30T04:09:00.000Z" });
    expect(detectWindowContamination([boundDep, newerBuilding], bound)).toEqual({ contaminated: false });
  });

  it("is clean when an OLDER deployment shows SUCCESS or REMOVED (pre-window history)", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus enum value, not a Postgres enum
    const olderRemoved = dep({ id: "dep-older", status: "REMOVED", createdAt: "2026-08-30T03:50:00.000Z" });
    const olderSuccess = dep({ id: "dep-oldest", createdAt: "2026-08-30T03:30:00.000Z" });
    expect(detectWindowContamination([boundDep, olderRemoved, olderSuccess], bound)).toEqual({ contaminated: false });
  });

  // ── contaminated cases (each names its reason so the escalation carries the mechanism) ──
  it("flags a newer SUCCESS deployment (it is now serving the metrics we read)", () => {
    const newerLive = dep({ id: "dep-newer", createdAt: "2026-08-30T04:09:00.000Z" });
    const result = detectWindowContamination([boundDep, newerLive], bound);
    expect(result.contaminated).toBe(true);
    if (result.contaminated) expect(result.reason).toContain("dep-newer");
  });

  it("flags a newer REMOVED deployment (it served during the window, then was itself replaced)", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus enum value, not a Postgres enum
    const newerRemoved = dep({ id: "dep-newer", status: "REMOVED", createdAt: "2026-08-30T04:09:00.000Z" });
    const result = detectWindowContamination([boundDep, newerRemoved], bound);
    expect(result.contaminated).toBe(true);
    if (result.contaminated) expect(result.reason).toContain("dep-newer");
  });

  it("flags the bound deployment no longer being SUCCESS (displaced mid-window)", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus enum value, not a Postgres enum
    const boundDisplaced = dep({ id: "dep-bound", status: "REMOVED" });
    const result = detectWindowContamination([boundDisplaced], bound);
    expect(result.contaminated).toBe(true);
    if (result.contaminated) expect(result.reason).toContain("REMOVED");
  });

  it("flags the bound deployment being absent from the refetched page", () => {
    const unrelated = dep({ id: "dep-other" });
    const result = detectWindowContamination([unrelated], bound);
    expect(result.contaminated).toBe(true);
    if (result.contaminated) expect(result.reason).toContain("absent");
  });

  it("fails closed on a deployment with an unparseable createdAt (cannot rule it out)", () => {
    const broken = dep({ id: "dep-broken", createdAt: "not-a-timestamp" });
    const result = detectWindowContamination([boundDep, broken], bound);
    expect(result.contaminated).toBe(true);
    if (result.contaminated) expect(result.reason).toContain("dep-broken");
  });

  it("fails closed when the BOUND createdAt itself is unparseable", () => {
    const badBound = { id: "dep-bound", createdAt: "garbage" };
    const result = detectWindowContamination([boundDep], badBound);
    expect(result.contaminated).toBe(true);
    if (result.contaminated) expect(result.reason).toContain("unparseable");
  });

  // ── equal-createdAt tie (codex P1, 2026-08-30 pass 2): a sibling sharing the bound's
  // exact timestamp is not provably older, and service-scoped metrics carry no
  // tie-breaker — SUCCESS/REMOVED at the tie must contaminate, never read as clean ──
  it("flags an equal-createdAt SUCCESS sibling (no tie-breaker proves the bound served the window)", () => {
    const tieLive = dep({ id: "dep-tie", createdAt: bound.createdAt });
    const result = detectWindowContamination([boundDep, tieLive], bound);
    expect(result.contaminated).toBe(true);
    if (result.contaminated) expect(result.reason).toContain("dep-tie");
  });

  it("is clean when an equal-createdAt sibling FAILED (never took traffic, tie or not)", () => {
    // pg-enum-drift-exempt: Railway DeploymentStatus enum value, not a Postgres enum
    const tieFailed = dep({ id: "dep-tie", status: "FAILED", createdAt: bound.createdAt });
    expect(detectWindowContamination([boundDep, tieFailed], bound)).toEqual({ contaminated: false });
  });
});
