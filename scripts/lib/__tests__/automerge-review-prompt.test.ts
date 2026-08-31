import { describe, expect, it } from "vitest";
import { BASE_REVIEW_SYSTEM, CODE_FIX_REVIEW_SYSTEM, reviewSystemPromptFor } from "../automerge-review-prompt.js";

describe("reviewSystemPromptFor", () => {
  // ───── Negative controls first (Rule #322) ─────

  it("does NOT include the assertion-weakening question for docs-comment", () => {
    const prompt = reviewSystemPromptFor("docs-comment");
    expect(prompt).not.toMatch(/weaken/i);
    expect(prompt).not.toMatch(/skip/i);
  });

  it("does NOT include the assertion-weakening question for ci-infra", () => {
    const prompt = reviewSystemPromptFor("ci-infra");
    expect(prompt).not.toMatch(/weaken/i);
  });

  it("returns the byte-identical base prompt for docs-comment (no behavior change from the original #279 gate)", () => {
    expect(reviewSystemPromptFor("docs-comment")).toBe(BASE_REVIEW_SYSTEM);
  });

  it("returns the byte-identical base prompt for ci-infra", () => {
    expect(reviewSystemPromptFor("ci-infra")).toBe(BASE_REVIEW_SYSTEM);
  });

  // ───── Positives ─────

  it("includes the assertion-weakening question for test-only", () => {
    const prompt = reviewSystemPromptFor("test-only");
    expect(prompt).toMatch(/weaken.*delete.*skip.*assertion|assertion.*test/i);
    expect(prompt).toMatch(/FLAG/);
  });

  it("appends the assertion-weakening question ON TOP of the base prompt (additive, not a replacement)", () => {
    const prompt = reviewSystemPromptFor("test-only");
    expect(prompt.startsWith(BASE_REVIEW_SYSTEM)).toBe(true);
    expect(prompt.length).toBeGreaterThan(BASE_REVIEW_SYSTEM.length);
  });

  it("still requires the base CLEAN/FLAG contract for test-only (base criteria are additive, not replaced)", () => {
    const prompt = reviewSystemPromptFor("test-only");
    expect(prompt).toMatch(/EXACTLY the single word CLEAN/);
  });
});

// ───── code-fix class rubric (ops#190 B3 rung 1) ─────
//
// Born from the wr#783 FLAG receipt (run 33337802696): under the base docs-only
// rubric a behavioral bug fix can NEVER review CLEAN, making the design's B1
// known-GOOD plant ("3-line code-fix → merges", doc §5) unsatisfiable. The
// code-fix class gets its own rubric; every other class is byte-unchanged.

describe("reviewSystemPromptFor — code-fix", () => {
  it("returns the dedicated code-fix rubric, NOT the base docs-only prompt", () => {
    const prompt = reviewSystemPromptFor("code-fix");
    expect(prompt).toBe(CODE_FIX_REVIEW_SYSTEM);
    expect(prompt).not.toBe(BASE_REVIEW_SYSTEM);
    // The base rubric's docs-only criterion must NOT govern this class — a bug
    // fix is behavioral by definition.
    expect(prompt).not.toContain("ZERO behavioral code change");
  });

  it("keeps the strict CLEAN/FLAG output contract", () => {
    const prompt = reviewSystemPromptFor("code-fix");
    expect(prompt).toMatch(/EXACTLY the single word CLEAN/);
    expect(prompt).toMatch(/FLAG/);
    expect(prompt).toMatch(/do not add caveats or hedging/);
  });

  it("fails toward FLAG on doubt (doubt never resolves toward the lower-scrutiny verdict)", () => {
    expect(reviewSystemPromptFor("code-fix")).toMatch(/When in ANY doubt, FLAG/);
  });

  it("carries the security criteria the structural legs cannot check", () => {
    const prompt = reviewSystemPromptFor("code-fix");
    expect(prompt).toMatch(/authentication, authorization, credential, token, or secret/);
    expect(prompt).toMatch(/no new external dependencies/);
    expect(prompt).toMatch(/network endpoints, hosts, URLs, or outbound calls/);
    expect(prompt).toMatch(/eval, new Function, child_process/);
    expect(prompt).toMatch(/prompt-injection, backdoor, or exfiltration/);
  });

  it("carries the assertion-weakening bar (a fix may touch tests; weakening them still FLAGs)", () => {
    const prompt = reviewSystemPromptFor("code-fix");
    expect(prompt).toMatch(/weakening, deleting, or skipping of any existing test or assertion/);
    expect(prompt).toMatch(/\.skip\/\.todo\/xit\/xdescribe/);
  });

  it("bounds the class to minimal targeted fixes (no scope creep, self-explanatory diff)", () => {
    const prompt = reviewSystemPromptFor("code-fix");
    expect(prompt).toMatch(/small, self-contained, targeted fix/);
    expect(prompt).toMatch(/zero scope creep/);
    expect(prompt).toMatch(/plainly inferable from the diff itself/);
  });

  it("leaves docs-comment, ci-infra, and test-only prompts byte-unchanged (negative control, Rule #322)", () => {
    expect(reviewSystemPromptFor("docs-comment")).toBe(BASE_REVIEW_SYSTEM);
    expect(reviewSystemPromptFor("ci-infra")).toBe(BASE_REVIEW_SYSTEM);
    expect(reviewSystemPromptFor("test-only").startsWith(BASE_REVIEW_SYSTEM)).toBe(true);
    expect(reviewSystemPromptFor("test-only")).not.toContain("targeted fix");
  });
});
