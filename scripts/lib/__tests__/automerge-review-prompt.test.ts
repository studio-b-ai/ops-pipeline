import { describe, expect, it } from "vitest";
import { BASE_REVIEW_SYSTEM, reviewSystemPromptFor } from "../automerge-review-prompt.js";

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
