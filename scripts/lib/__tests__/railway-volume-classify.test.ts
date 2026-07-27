import { describe, it, expect } from "vitest";
import { classifyUsage, computeTransition, WARN_THRESHOLD_PCT, CRITICAL_THRESHOLD_PCT } from "../railway-volume-classify.js";

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

describe("computeTransition", () => {
  it("no change → unchanged, direction none", () => {
    expect(computeTransition("OK", "OK")).toEqual({ changed: false, direction: "none" });
    expect(computeTransition("WARN", "WARN")).toEqual({ changed: false, direction: "none" });
    expect(computeTransition("CRITICAL", "CRITICAL")).toEqual({ changed: false, direction: "none" });
  });

  it.each([
    ["OK", "WARN"],
    ["OK", "CRITICAL"],
    ["WARN", "CRITICAL"],
  ] as const)("%s → %s is an escalation", (prev, curr) => {
    expect(computeTransition(prev, curr)).toEqual({ changed: true, direction: "escalate" });
  });

  it.each([
    ["WARN", "OK"],
    ["CRITICAL", "OK"],
    ["CRITICAL", "WARN"],
  ] as const)("%s → %s is a recovery", (prev, curr) => {
    expect(computeTransition(prev, curr)).toEqual({ changed: true, direction: "recover" });
  });

  it("a first-ever WARN alerts (caller passes prev='OK' for an unseen volume)", () => {
    // Documents the contract the main script relies on: state.get(key) ?? "OK".
    expect(computeTransition("OK", "WARN").changed).toBe(true);
  });

  it.each(["OK", "WARN", "CRITICAL"] as const)(
    "%s → PROBE_FAILED is an escalation (project-level fetch-failure dedup, mirrors credential-expiry-monitor's PROBE_FAILED)",
    (prev) => {
      expect(computeTransition(prev, "PROBE_FAILED")).toEqual({ changed: true, direction: "escalate" });
    },
  );

  it("PROBE_FAILED → OK is a recovery (the project's fetch started working again)", () => {
    expect(computeTransition("PROBE_FAILED", "OK")).toEqual({ changed: true, direction: "recover" });
  });

  it("PROBE_FAILED → PROBE_FAILED is unchanged (never re-alert every run while still broken)", () => {
    expect(computeTransition("PROBE_FAILED", "PROBE_FAILED")).toEqual({ changed: false, direction: "none" });
  });
});
