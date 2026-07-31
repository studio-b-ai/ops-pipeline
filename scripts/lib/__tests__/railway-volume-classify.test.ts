import { describe, it, expect } from "vitest";
import { classifyUsage, WARN_THRESHOLD_PCT, CRITICAL_THRESHOLD_PCT } from "../railway-volume-classify.js";

describe("classifyUsage", () => {
  it("throws when sizeMB is not > 0 (caller must filter first — spec: only sizeMB > 0 volumes)", () => {
    expect(() => classifyUsage(10, 0)).toThrow(/sizeMB > 0/);
    expect(() => classifyUsage(10, -5)).toThrow(/sizeMB > 0/);
  });

  it("OK below the WARN threshold", () => {
    const c = classifyUsage(100, 500); // 20%
    expect(c.status).toBe("OK");
    expect(c.usagePct).toBeCloseTo(20, 5);
  });

  it("WARN at exactly the WARN threshold", () => {
    const c = classifyUsage(75, 100); // 75%
    expect(c.status).toBe("WARN");
    expect(c.usagePct).toBeCloseTo(WARN_THRESHOLD_PCT, 5);
  });

  it("WARN just below CRITICAL", () => {
    const c = classifyUsage(89.9, 100);
    expect(c.status).toBe("WARN");
  });

  it("CRITICAL at exactly the CRITICAL threshold", () => {
    const c = classifyUsage(90, 100);
    expect(c.status).toBe("CRITICAL");
    expect(c.usagePct).toBeCloseTo(CRITICAL_THRESHOLD_PCT, 5);
  });

  it("CRITICAL at 100% (the actual 2026-07-27 incident shape — a full volume)", () => {
    const c = classifyUsage(500, 500);
    expect(c.status).toBe("CRITICAL");
    expect(c.usagePct).toBeCloseTo(100, 5);
  });

  it("CRITICAL can exceed 100% momentarily (a raced write mid-classification)", () => {
    const c = classifyUsage(505, 500);
    expect(c.status).toBe("CRITICAL");
    expect(c.usagePct).toBeCloseTo(101, 5);
  });
});

// `computeTransition`/`MonitorStatus`/`Transition` were removed in the v2 (issues-as-alert-state)
// conversion — the open/closed GitHub issue (via lib/severity-issue-reconcile.ts's
// `reconcileSeverity`, tested in severity-issue-reconcile.test.ts) is the dedup now, not a
// prev-vs-curr transition computation. See railway-volume-classify.ts's file header.
