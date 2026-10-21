import { describe, it, expect } from "vitest";
import {
  classifyRepo,
  killConditionBreached,
  FALLBACK_BOX,
  FALLBACK_HOLD,
} from "../one-key-labels-lib.js";
import { assertLabelDescription } from "../github-issues.js";

describe("classifyRepo", () => {
  it("ok when both one-key labels are present", () => {
    expect(classifyRepo({ repo: "a", archived: false, labels: ["box", "hold", "bug"] })).toEqual({ kind: "ok", repo: "a" });
  });

  it("missing names exactly the absent labels (positive control shape)", () => {
    expect(classifyRepo({ repo: "b", archived: false, labels: ["box"] })).toEqual({ kind: "missing", repo: "b", missing: ["hold"] });
    expect(classifyRepo({ repo: "c", archived: false, labels: [] })).toEqual({ kind: "missing", repo: "c", missing: ["box", "hold"] });
  });

  it("archived repos are skipped AND reported as skipped (negative control)", () => {
    expect(classifyRepo({ repo: "d", archived: true, labels: [] })).toEqual({ kind: "skipped-archived", repo: "d" });
  });

  it("label matching is exact — a 'boxing' label never satisfies 'box'", () => {
    expect(classifyRepo({ repo: "e", archived: false, labels: ["boxing", "hold"] })).toEqual({ kind: "missing", repo: "e", missing: ["box"] });
  });
});

describe("killConditionBreached", () => {
  it("is empty only when no active repo is missing a label", () => {
    expect(
      killConditionBreached([
        { kind: "ok", repo: "a" },
        { kind: "skipped-archived", repo: "d" },
      ]),
    ).toEqual([]);
    expect(
      killConditionBreached([
        { kind: "ok", repo: "a" },
        { kind: "missing", repo: "b", missing: ["hold"] },
      ]),
    ).toEqual(["b"]);
  });
});

describe("fallback specs", () => {
  it("descriptions fit GitHub's 100-char cap (the shared choke point's guard)", () => {
    expect(() => assertLabelDescription(FALLBACK_BOX.description)).not.toThrow();
    expect(() => assertLabelDescription(FALLBACK_HOLD.description)).not.toThrow();
  });

  it("match the canonical ops-pipeline specs verified live 2026-09-18", () => {
    expect(FALLBACK_BOX).toEqual({ name: "box", color: "0033CC", description: "Kevin: merge it" });
    expect(FALLBACK_HOLD.name).toBe("hold");
    expect(FALLBACK_HOLD.color).toBe("B60205");
  });
});
