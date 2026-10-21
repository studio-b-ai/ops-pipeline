import { describe, it, expect } from "vitest";
import { ELIGIBLE_PR_AUTHORS, gateDecision, gateDecisionForClass, isEligiblePrAuthor, type GateInput, type GateInputV2 } from "../automerge-classify.js";

// Go-native Phase A, PR-A2 item 1: the studiob-fleet-bot App is an eligible PR author alongside kbibelhausen.
// Rule #223: every case calls the REAL gateDecision / gateDecisionForClass (the two author legs) and asserts on what they return.
// Rule #322/#471: both directions — the accepted forms must clear the author leg, every look-alike must be REFUSED at it.
//
// The three live forms of the App's login (probed read-only on chassis#977, gh 2.100.0):
//   gh pr view --json author  → "app/studiob-fleet-bot"        (what pr-automerge-gate.ts reads)
//   REST GET /pulls/977       → "studiob-fleet-bot[bot]"
//   GraphQL author.login      → "studiob-fleet-bot" (+ __typename Bot) — NOT accepted: a bare name is a legal USER login.

const v1 = (author: string): GateInput => ({
  files: [{ path: "docs/x.md", fileClass: "doc" }],
  totalChangedLines: 3,
  author,
  labels: ["bugsquasher"],
  ciClean: true,
  reviewVerdict: "CLEAN",
});
const v2 = (author: string): GateInputV2 => ({ prClass: "ci-infra", author, labels: ["bugsquasher"], ciClean: true, reviewVerdict: "CLEAN" });
const authorReasons = (reasons: string[]) => reasons.filter((r) => r.startsWith("author '"));

const ACCEPTED = ["kbibelhausen", "app/studiob-fleet-bot", "studiob-fleet-bot[bot]"];
const REFUSED = [
  "studiob-fleet-bot", // bare GraphQL form — registrable as a user, never accepted
  "app/studiob-fleet-bot-evil",
  "app/studiob-fleet-bo",
  "xapp/studiob-fleet-bot",
  "studiob-fleet-bot[bot]x",
  "app/acuops-agent", // another org App — a separate decision, not part of PR-A2
  "app/github-actions",
  "github-actions[bot]",
  "dependabot[bot]",
  "KBIBELHAUSEN",
  "kbibelhausen ",
  "",
];

describe("eligible PR author — known-good: every accepted form clears the author leg on BOTH gate entry points", () => {
  it.each(ACCEPTED)("%s", (author) => {
    expect(isEligiblePrAuthor(author)).toBe(true);
    const a = gateDecision(v1(author));
    const b = gateDecisionForClass(v2(author));
    expect(authorReasons(a.reasons)).toEqual([]);
    expect(authorReasons(b.reasons)).toEqual([]);
    // every other leg is green in these fixtures, so the author leg is the only thing that could have refused
    expect(a.decision).toBe("merge");
    expect(b.decision).toBe("merge");
  });
});

describe("eligible PR author — known-bad: every look-alike is refused at the author leg on BOTH gate entry points", () => {
  it.each(REFUSED)("%j", (author) => {
    expect(isEligiblePrAuthor(author)).toBe(false);
    const a = gateDecision(v1(author));
    const b = gateDecisionForClass(v2(author));
    expect(authorReasons(a.reasons)).toHaveLength(1);
    expect(authorReasons(b.reasons)).toHaveLength(1);
    expect(a.decision).toBe("wait");
    expect(b.decision).toBe("wait");
  });

  it("the refusal names the eligible set so the receipt is self-explaining", () => {
    const [reason] = authorReasons(gateDecision(v1("someone-else")).reasons);
    for (const a of ELIGIBLE_PR_AUTHORS) expect(reason).toContain(`'${a}'`);
  });

  it("an eligible author does NOT bypass the other legs (CI red still waits)", () => {
    const r = gateDecision({ ...v1("app/studiob-fleet-bot"), ciClean: false });
    expect(r.decision).toBe("wait");
    expect(authorReasons(r.reasons)).toEqual([]);
    expect(r.reasons).toContain("CI not clean");
  });
});
