import { describe, expect, it } from "vitest";
import { formatGateReceiptLine } from "../automerge-telemetry.js";

describe("formatGateReceiptLine", () => {
  // ───── Negative controls first (Rule #322): every miss shape carries its leg ─────

  it("defaults to leg=other (fail-closed) when verdict is missed and no leg is supplied", () => {
    const line = formatGateReceiptLine({ repo: "studio-b-ai/bolt-wms", pr: 42, prClass: "unclassified", verdict: "missed" });
    expect(line).toContain("leg=other");
  });

  it("emits leg=ci-rollup on a ci-rollup miss (class never resolved — 'unclassified')", () => {
    const line = formatGateReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      pr: 42,
      prClass: "unclassified",
      verdict: "missed",
      leg: "ci-rollup",
    });
    expect(line).toContain("pr=42");
    expect(line).toContain("class=unclassified");
    expect(line).toContain("verdict=missed");
    expect(line).toContain("leg=ci-rollup");
  });

  it("emits leg=class-match on a classification miss", () => {
    const line = formatGateReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      pr: 43,
      prClass: "unclassified",
      verdict: "missed",
      leg: "class-match",
      reasons: ["docs-comment: code-class file(s): src/foo.ts"],
    });
    expect(line).toContain("leg=class-match");
    expect(line).toContain('reasons="docs-comment: code-class file(s): src/foo.ts"');
  });

  it("emits leg=line-cap on a line-cap miss", () => {
    const line = formatGateReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      pr: 44,
      prClass: "unclassified",
      verdict: "missed",
      leg: "line-cap",
      reasons: ["ci-infra: totalChangedLines 41 > 40"],
    });
    expect(line).toContain("leg=line-cap");
  });

  it("emits leg=review with a resolved class on a review-verdict miss", () => {
    const line = formatGateReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      pr: 45,
      prClass: "test-only",
      verdict: "missed",
      leg: "review",
      reasons: ["independent review verdict 'FLAG' !== 'CLEAN'"],
    });
    expect(line).toContain("class=test-only");
    expect(line).toContain("leg=review");
  });

  it("emits leg=other with a resolved class on an author/label miss", () => {
    const line = formatGateReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      pr: 46,
      prClass: "ci-infra",
      verdict: "missed",
      leg: "other",
      reasons: ["missing 'bugsquasher' label (has: none)"],
    });
    expect(line).toContain("class=ci-infra");
    expect(line).toContain("leg=other");
  });

  it("escapes embedded double quotes in reasons so the reasons field stays one token", () => {
    const line = formatGateReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      pr: 47,
      prClass: "unclassified",
      verdict: "missed",
      leg: "class-match",
      reasons: [`weird "quoted" path`],
    });
    expect(line).not.toMatch(/reasons="weird "quoted" path"/);
    expect(line).toContain(`reasons="weird 'quoted' path"`);
  });

  it("omits the reasons field entirely when none are supplied", () => {
    const line = formatGateReceiptLine({ repo: "studio-b-ai/bolt-wms", pr: 48, prClass: "unclassified", verdict: "missed", leg: "ci-rollup" });
    expect(line).not.toContain("reasons=");
  });

  // ───── Positives ─────

  it("omits leg and reasons entirely on a qualified verdict", () => {
    const line = formatGateReceiptLine({ repo: "studio-b-ai/bolt-wms", pr: 50, prClass: "ci-infra", verdict: "qualified" });
    expect(line).toBe("[gate-receipt] repo=studio-b-ai/bolt-wms pr=50 class=ci-infra verdict=qualified");
  });

  it("emits the exact structured shape for a qualified test-only PR", () => {
    const line = formatGateReceiptLine({ repo: "studio-b-ai/studiob", pr: 100, prClass: "test-only", verdict: "qualified" });
    expect(line).toBe("[gate-receipt] repo=studio-b-ai/studiob pr=100 class=test-only verdict=qualified");
  });
});
