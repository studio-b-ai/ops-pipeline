import { describe, it, expect } from "vitest";
import { gateDecision, type GateInput } from "../automerge-classify";

// Kevin 9/13 "door fix": `fleet-internal` is an eligibility label alongside `bugsquasher`.
// Both directions (#322/#471): the known-good must PASS the label leg; the known-bad must be REFUSED at it.
const base: Omit<GateInput, "labels"> = {
  files: [{ path: "docs/x.md", fileClass: "docs" } as GateInput["files"][number]],
  totalChangedLines: 3,
  author: "kbibelhausen",
  ciClean: true,
  reviewVerdict: "CLEAN",
};
const labelReasons = (labels: string[]) => gateDecision({ ...base, labels }).reasons.filter((r) => r.includes("eligibility label"));

describe("eligibility label — both directions", () => {
  it("known-good: fleet-internal alone clears the label leg", () => expect(labelReasons(["fleet-internal"])).toEqual([]));
  it("known-good: bugsquasher alone still clears it", () => expect(labelReasons(["bugsquasher"])).toEqual([]));
  it("known-bad: neither label is refused at the label leg", () => {
    const r = gateDecision({ ...base, labels: ["lane:mechanic"] });
    expect(r.reasons.some((x) => x.startsWith("missing an eligibility label"))).toBe(true);
    expect(r.decision).not.toBe("merge");
  });
});
