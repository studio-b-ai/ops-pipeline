import { describe, expect, it } from "vitest";
import { codeFixLabelFlap, CODE_FIX_FLAP_THRESHOLD, type AuthorityTimelineItem } from "../label-authority.js";
import { isDecisionLeg } from "../gate-enroll.js";
import { formatGateReceiptLine } from "../automerge-telemetry.js";

// ───────────── code-fix label flap circuit-breaker (bolt-wms#2120, 2026-09-06) ─────────────
//
// Both verdicts are planted (Rule #471). A guard tested only against known-BAD input
// looks healthy from its refusals alone while quietly refusing everything, so the
// known-GOOD cases below are the load-bearing half: they prove the guard still lets a
// normal code-fix PR through.

const MERGE_LABEL = "automerge:code-fix";

function commitAt(position: number): AuthorityTimelineItem {
  return { type: "PULL_REQUEST_COMMIT", position };
}
function labeled(label: string, position: number, actorLogin = "kbibelhausen"): AuthorityTimelineItem {
  return { type: "LABELED", label, actorLogin, position };
}
function unlabeled(label: string, position: number, actorLogin = "kbibelhausen"): AuthorityTimelineItem {
  return { type: "UNLABELED", label, actorLogin, position };
}

/** One cycle = the gate adds the label, its own revalidate deltas, it removes it. */
function flapCycles(n: number, startPosition: number): AuthorityTimelineItem[] {
  const items: AuthorityTimelineItem[] = [];
  for (let i = 0; i < n; i += 1) {
    items.push(labeled(MERGE_LABEL, startPosition + i * 2));
    items.push(unlabeled(MERGE_LABEL, startPosition + i * 2 + 1));
  }
  return items;
}

describe("codeFixLabelFlap — known-GOOD (the guard must not block a healthy PR)", () => {
  it("passes a normal PR: commits, a human review label, one merge-label add", () => {
    const verdict = codeFixLabelFlap(
      {
        timeline: [
          commitAt(1),
          commitAt(2),
          labeled("reviewed", 3),
          labeled(MERGE_LABEL, 4, "studiob-fleet-bot[bot]"),
        ],
        truncated: false,
      },
      MERGE_LABEL,
    );
    expect(verdict.flapping).toBe(false);
    expect(verdict.addsSinceHeadMove).toBe(1);
  });

  it("passes an empty timeline — zero adds is the opposite of a flap", () => {
    expect(codeFixLabelFlap({ timeline: [], truncated: false }, MERGE_LABEL)).toEqual({
      flapping: false,
      addsSinceHeadMove: 0,
    });
  });

  it("resets on a push: a new head is a new subject, so an old flap cannot block it", () => {
    const verdict = codeFixLabelFlap(
      { timeline: [commitAt(1), ...flapCycles(6, 2), commitAt(100)], truncated: false },
      MERGE_LABEL,
    );
    expect(verdict.flapping).toBe(false);
    expect(verdict.addsSinceHeadMove).toBe(0);
  });

  it("resets on a force-push exactly as it does on a commit", () => {
    const verdict = codeFixLabelFlap(
      {
        timeline: [...flapCycles(6, 1), { type: "HEAD_REF_FORCE_PUSHED", position: 100 }, ...flapCycles(1, 101)],
        truncated: false,
      },
      MERGE_LABEL,
    );
    expect(verdict.flapping).toBe(false);
    expect(verdict.addsSinceHeadMove).toBe(1);
  });

  it("counts ONLY the merge label — churn on an unrelated label never blocks a merge", () => {
    const otherChurn: AuthorityTimelineItem[] = [];
    for (let i = 0; i < 10; i += 1) {
      otherChurn.push(labeled("candidate", 2 + i * 2));
      otherChurn.push(unlabeled("candidate", 3 + i * 2));
    }
    const verdict = codeFixLabelFlap({ timeline: [commitAt(1), ...otherChurn], truncated: false }, MERGE_LABEL);
    expect(verdict.flapping).toBe(false);
    expect(verdict.addsSinceHeadMove).toBe(0);
  });

  it("counts ADDS only — the removals between them are not double-counted", () => {
    const verdict = codeFixLabelFlap({ timeline: [commitAt(1), ...flapCycles(2, 2)], truncated: false }, MERGE_LABEL);
    expect(verdict.flapping).toBe(false);
    expect(verdict.addsSinceHeadMove).toBe(2);
  });

  it("keeps the threshold above 1 — a single legitimate add must never trip the guard", () => {
    expect(CODE_FIX_FLAP_THRESHOLD).toBeGreaterThan(1);
  });
});

describe("codeFixLabelFlap — known-BAD (the guard must refuse the live #2120 shape)", () => {
  it("refuses three add/remove cycles against one head", () => {
    const verdict = codeFixLabelFlap({ timeline: [commitAt(1), ...flapCycles(3, 2)], truncated: false }, MERGE_LABEL);
    expect(verdict.flapping).toBe(true);
    expect(verdict.addsSinceHeadMove).toBe(3);
    if (!verdict.flapping) throw new Error("fixture setup bug: expected a flapping verdict");
    expect(verdict.detail).toContain(MERGE_LABEL);
    expect(verdict.detail).toContain("3 times");
  });

  it("is not off by one: passes at threshold-1, refuses at exactly threshold", () => {
    expect(codeFixLabelFlap({ timeline: [commitAt(1), ...flapCycles(2, 2)], truncated: false }, MERGE_LABEL).flapping).toBe(false);
    expect(codeFixLabelFlap({ timeline: [commitAt(1), ...flapCycles(3, 2)], truncated: false }, MERGE_LABEL).flapping).toBe(true);
  });

  it("refuses a run of adds with no removals between them", () => {
    const verdict = codeFixLabelFlap(
      { timeline: [commitAt(1), labeled(MERGE_LABEL, 2), labeled(MERGE_LABEL, 3), labeled(MERGE_LABEL, 4)], truncated: false },
      MERGE_LABEL,
    );
    expect(verdict.flapping).toBe(true);
  });

  it("fails closed on a truncated window, reporting the count as UNKNOWN rather than zero", () => {
    const verdict = codeFixLabelFlap({ timeline: [commitAt(1)], truncated: true }, MERGE_LABEL);
    expect(verdict.flapping).toBe(true);
    expect(verdict.addsSinceHeadMove).toBeNull();
    if (!verdict.flapping) throw new Error("fixture setup bug: expected a flapping verdict");
    expect(verdict.detail).toContain("truncated");
  });
});

describe("codeFixLabelFlap — instrument hygiene", () => {
  it("does not trust the caller's array order; it reads `position`", () => {
    // The same items as the resets-on-a-push case, shuffled: the latest commit sits
    // last in position but not last in the array.
    const verdict = codeFixLabelFlap(
      { timeline: [...flapCycles(6, 2), commitAt(100), commitAt(1)], truncated: false },
      MERGE_LABEL,
    );
    expect(verdict.flapping).toBe(false);
  });

  it("throws on a nonsense threshold rather than silently admitting everything", () => {
    expect(() => codeFixLabelFlap({ timeline: [], truncated: false }, MERGE_LABEL, 0)).toThrow(/positive integer/);
    expect(() => codeFixLabelFlap({ timeline: [], truncated: false }, MERGE_LABEL, 1.5)).toThrow(/positive integer/);
  });
});

describe("flap-guard wiring", () => {
  it("is a DECISION leg — a flapping PR cannot clear itself, so it must reach a human", () => {
    expect(isDecisionLeg("flap-guard")).toBe(true);
  });

  it("renders in a gate receipt as a missed leg with its reasons", () => {
    const line = formatGateReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      pr: 2120,
      prClass: "code-fix",
      verdict: "missed",
      leg: "flap-guard",
      reasons: ["applied 3 times against the current head"],
    });
    expect(line).toContain("leg=flap-guard");
    expect(line).toContain("verdict=missed");
    expect(line).toContain("pr=2120");
  });
});
