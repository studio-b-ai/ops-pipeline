import { describe, expect, it } from "vitest";
import { buildSeverityTitle, parseSeverityTitle, reconcileSeverity } from "../severity-issue-reconcile.js";

describe("reconcileSeverity", () => {
  // Negative controls first (Rule #322): known-clear / already-handled cases must not act.
  it("does NOT open when clear and nothing is open", () => {
    expect(reconcileSeverity("OK", null)).toBe("none");
  });
  it("does NOT re-open/retitle when the same alert status is already open (dedup by open issue)", () => {
    expect(reconcileSeverity("WARN", "WARN")).toBe("none");
    expect(reconcileSeverity("CRITICAL", "CRITICAL")).toBe("none");
  });

  it("opens on a new alert-worthy status with nothing open", () => {
    expect(reconcileSeverity("WARN", null)).toBe("open");
    expect(reconcileSeverity("CRITICAL", null)).toBe("open");
    expect(reconcileSeverity("DEAD", null)).toBe("open");
  });
  it("closes when the status clears back to OK with an issue open", () => {
    expect(reconcileSeverity("OK", "WARN")).toBe("close");
    expect(reconcileSeverity("OK", "CRITICAL")).toBe("close");
  });
  it("retitles (comment + retitle) when severity changes while the issue is open — escalation", () => {
    expect(reconcileSeverity("CRITICAL", "WARN")).toBe("retitle");
  });
  it("retitles on de-escalation too (still alert-worthy, but the open title would otherwise lie about current severity)", () => {
    expect(reconcileSeverity("WARN", "CRITICAL")).toBe("retitle");
  });
  it("retitles across composite tiers (credential-monitor's WARN-<threshold> tightening)", () => {
    expect(reconcileSeverity("WARN-7", "WARN-14")).toBe("retitle");
    expect(reconcileSeverity("WARN-1", "WARN-7")).toBe("retitle");
  });
});

describe("buildSeverityTitle / parseSeverityTitle round-trip", () => {
  it("round-trips a simple entity/status pair", () => {
    const title = buildSeverityTitle("volume-monitor", "aesthetik-production/Postgres/pg-data", "CRITICAL");
    expect(title).toBe("[volume-monitor] aesthetik-production/Postgres/pg-data — CRITICAL");
    const parsed = parseSeverityTitle("volume-monitor", title);
    expect(parsed?.entity).toBe("aesthetik-production/Postgres/pg-data");
    expect(parsed?.status).toBe("CRITICAL");
  });

  it("round-trips a composite status (credential-monitor WARN-<threshold>)", () => {
    const title = buildSeverityTitle("credential-monitor", "npm-publish-token", "WARN-7");
    const parsed = parseSeverityTitle("credential-monitor", title);
    expect(parsed?.entity).toBe("npm-publish-token");
    expect(parsed?.status).toBe("WARN-7");
  });

  // Negative controls: titles that don't belong to this label/shape must not false-positive parse.
  it("returns null for a title with a different label prefix", () => {
    expect(parseSeverityTitle("volume-monitor", "[credential-monitor] foo — WARN")).toBeNull();
  });
  it("returns null for a title missing the ' — ' separator", () => {
    expect(parseSeverityTitle("volume-monitor", "[volume-monitor] no separator here")).toBeNull();
  });
  it("returns null for an unrelated title (e.g. a token-watch straggler issue)", () => {
    expect(parseSeverityTitle("volume-monitor", "[token-watch] straggler: foo (minted 2026-07-30)")).toBeNull();
  });
});
