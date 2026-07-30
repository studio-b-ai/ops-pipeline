import { describe, expect, it } from "vitest";
import { classifyLegacyToken, revocationGate } from "../gateway-token-classify.js";

const CUTOVER = new Date("2026-07-30T00:52:00Z");

describe("classifyLegacyToken", () => {
  // Negative controls FIRST (Rule #322): known-bads must be rejected before positives count.
  it("flags use 1s AFTER cutover as STRAGGLER", () => {
    expect(classifyLegacyToken(new Date("2026-07-30T00:52:01Z"), CUTOVER)).toBe("STRAGGLER");
  });
  it("flags use exactly AT cutover as STRAGGLER (boundary is inclusive)", () => {
    expect(classifyLegacyToken(new Date("2026-07-30T00:52:00Z"), CUTOVER)).toBe("STRAGGLER");
  });
  it("flags use days after cutover as STRAGGLER", () => {
    expect(classifyLegacyToken(new Date("2026-08-04T12:00:00Z"), CUTOVER)).toBe("STRAGGLER");
  });

  it("treats use 1s BEFORE cutover as QUIET (the pre-swap container tail at ~00:49Z)", () => {
    expect(classifyLegacyToken(new Date("2026-07-30T00:51:59Z"), CUTOVER)).toBe("QUIET");
  });
  it("treats June-orphan use as QUIET", () => {
    expect(classifyLegacyToken(new Date("2026-06-10T03:05:00Z"), CUTOVER)).toBe("QUIET");
  });
  it("treats never-used (null) as QUIET", () => {
    expect(classifyLegacyToken(null, CUTOVER)).toBe("QUIET");
  });
});

describe("revocationGate", () => {
  const QUIET_DAYS = 3;
  const gateOpen = new Date("2026-08-02T00:52:00Z"); // cutover + 3d exactly

  // Negative controls: the gate must stay CLOSED when either condition fails.
  it("stays CLOSED with a straggler even after the window elapses", () => {
    expect(revocationGate(1, CUTOVER, QUIET_DAYS, new Date("2026-08-05T00:00:00Z"))).toBe("CLOSED");
  });
  it("stays CLOSED with zero stragglers before the window elapses", () => {
    expect(revocationGate(0, CUTOVER, QUIET_DAYS, new Date("2026-08-01T23:59:59Z"))).toBe("CLOSED");
  });
  it("stays CLOSED 1s before the window boundary", () => {
    expect(revocationGate(0, CUTOVER, QUIET_DAYS, new Date(gateOpen.getTime() - 1000))).toBe("CLOSED");
  });

  it("goes GREEN with zero stragglers exactly at the window boundary", () => {
    expect(revocationGate(0, CUTOVER, QUIET_DAYS, gateOpen)).toBe("GREEN");
  });
  it("goes GREEN with zero stragglers after the window", () => {
    expect(revocationGate(0, CUTOVER, QUIET_DAYS, new Date("2026-08-10T00:00:00Z"))).toBe("GREEN");
  });
});
