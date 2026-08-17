import { describe, it, expect } from "vitest";
import { classify, daysBetweenUTC, type ProbeResult } from "../credential-classify.js";

// Pinned clock so the bands don't decay (Rule #256).
const NOW = new Date("2026-06-07T12:00:00Z");

const alive = (expiry: string | null = null, extra: Partial<ProbeResult> = {}): ProbeResult => ({
  alive: true,
  expiry,
  source: expiry ? "probe" : "recorded",
  ...extra,
});

describe("daysBetweenUTC", () => {
  it("is 0 for same UTC day regardless of wall-clock time", () => {
    expect(daysBetweenUTC(NOW, new Date("2026-06-07T23:59:00Z"))).toBe(0);
  });
  it("counts whole calendar days forward and backward", () => {
    expect(daysBetweenUTC(NOW, new Date("2026-06-21T00:00:00Z"))).toBe(14);
    expect(daysBetweenUTC(NOW, new Date("2026-06-05T00:00:00Z"))).toBe(-2);
  });
});

describe("classify — precedence", () => {
  it("PROBE_FAILED when the probe errored (even if alive)", () => {
    const c = classify({ probe: { alive: true, expiry: null, source: "probe", error: "boom" } }, NOW);
    expect(c.status).toBe("PROBE_FAILED");
  });

  it("DEAD when the aliveness probe says dead — ignores any recorded expiry", () => {
    const c = classify({ recordedExpiry: "2027-01-01", probe: { alive: false, expiry: null, source: "recorded" } }, NOW);
    expect(c.status).toBe("DEAD");
  });

  it("prefers the active-probe expiry over the recorded date", () => {
    const c = classify({ recordedExpiry: "2026-12-31", probe: alive("2026-06-10T00:00:00Z") }, NOW);
    expect(c.status).toBe("WARN");
    expect(c.threshold).toBe(7); // 3 days out
    expect(c.expirySource).toBe("probe");
  });

  it("NO_EXPIRY when alive but no expiry from either source", () => {
    const c = classify({ recordedExpiry: null, probe: alive(null) }, NOW);
    expect(c.status).toBe("NO_EXPIRY");
  });

  it("NO_EXPIRY (never silently OK) when alive + flagged non-expiring — monitor tailors the message", () => {
    const c = classify({ recordedExpiry: null, probe: alive(null, { nonExpiring: true }) }, NOW);
    expect(c.status).toBe("NO_EXPIRY");
  });

  it("PROBE_FAILED when the effective expiry is unparseable", () => {
    const c = classify({ probe: alive("not-a-date") }, NOW);
    expect(c.status).toBe("PROBE_FAILED");
  });
});

describe("classify — WARN bands (recorded expiry)", () => {
  const band = (expiry: string) => classify({ recordedExpiry: expiry, probe: alive(null) }, NOW);

  it("OK beyond 14 days", () => {
    const c = band("2026-07-31");
    expect(c.status).toBe("OK");
    expect(c.daysToExpiry).toBe(54);
    expect(c.expirySource).toBe("recorded");
  });

  it.each([
    ["2026-06-21", 14, 14],
    ["2026-06-19", 12, 14],
    ["2026-06-14", 7, 7],
    ["2026-06-12", 5, 7],
    ["2026-06-08", 1, 1],
    ["2026-06-07", 0, 1],
  ])("WARN %s → %i days, threshold %i", (expiry, days, threshold) => {
    const c = band(expiry);
    expect(c.status).toBe("WARN");
    expect(c.daysToExpiry).toBe(days);
    expect(c.threshold).toBe(threshold);
  });

  it("overdue collapses to WARN@1 with negative days", () => {
    const c = band("2026-06-05");
    expect(c.status).toBe("WARN");
    expect(c.threshold).toBe(1);
    expect(c.daysToExpiry).toBe(-2);
  });
});

describe("classify — declaredNonExpiring (manifest `non_expiring: true`, ladder rung 2 — decision 2026-08-17)", () => {
  it("OK when alive + no expiry from either source (the daily aliveness probe IS the monitoring)", () => {
    const c = classify({ probe: alive(), declaredNonExpiring: true }, NOW);
    expect(c.status).toBe("OK");
    expect(c.expiry).toBeNull();
    expect(c.daysToExpiry).toBeNull();
  });

  it("still DEAD when the aliveness probe fails — the declaration never masks a revoked token", () => {
    const c = classify({ probe: { alive: false, expiry: null, source: "recorded" }, declaredNonExpiring: true }, NOW);
    expect(c.status).toBe("DEAD");
  });

  it("still PROBE_FAILED when the probe errored", () => {
    const c = classify({ probe: { alive: true, expiry: null, source: "probe", error: "op CLI not found on PATH" }, declaredNonExpiring: true }, NOW);
    expect(c.status).toBe("PROBE_FAILED");
  });

  it("PROBE_FAILED on the manifest contradiction: declared non-expiring but a recorded_expiry is set", () => {
    const c = classify({ recordedExpiry: "2026-09-07", probe: alive(), declaredNonExpiring: true }, NOW);
    expect(c.status).toBe("PROBE_FAILED");
    expect(c.expiry).toBe("2026-09-07");
  });

  it("PROBE_FAILED on the contradiction from the PROBE side too (probe read a real expiry)", () => {
    const c = classify({ probe: alive("2027-01-01T00:00:00Z"), declaredNonExpiring: true }, NOW);
    expect(c.status).toBe("PROBE_FAILED");
  });

  it("false/undefined leaves the existing NO_EXPIRY behaviour untouched (negative control)", () => {
    expect(classify({ probe: alive(), declaredNonExpiring: false }, NOW).status).toBe("NO_EXPIRY");
    expect(classify({ probe: alive() }, NOW).status).toBe("NO_EXPIRY");
  });
});
