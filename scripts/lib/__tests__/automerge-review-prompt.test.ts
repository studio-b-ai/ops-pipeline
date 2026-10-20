import { describe, expect, it } from "vitest";
import { BASE_REVIEW_SYSTEM, CODE_FIX_REVIEW_SYSTEM, CREW_CHANGE_REVIEW_SYSTEM, reviewSystemPromptFor } from "../automerge-review-prompt.js";
import { ALL_PR_DIFF_CLASSES } from "../automerge-classify.js";

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

// ───── crew rubric (door policy, row 928 — Kevin 10/20) ─────
//
// The code-fix rubric asks "is this a small targeted bug fix?". 14 of 40 sampled parked PRs died on it
// with "behavioral logic change" / "introduces a new module". The crew rubric judges four things —
// CORRECT, SAFE, SCOPED, PROVEN — and allows new modules, new behaviour and size.

describe("reviewSystemPromptFor — crew rubric (CORRECT / SAFE / SCOPED / PROVEN)", () => {
  const crew = CREW_CHANGE_REVIEW_SYSTEM;

  it("the crew-change class always gets the crew rubric", () => {
    expect(reviewSystemPromptFor("crew-change")).toBe(crew);
    expect(reviewSystemPromptFor("crew-change", true)).toBe(crew);
  });

  it("names all four criteria and says out loud that new modules, new behaviour and size are allowed", () => {
    for (const k of ["CORRECT", "SAFE", "SCOPED", "PROVEN"]) expect(crew).toContain(`  ${k} — `);
    expect(crew).toMatch(/New modules, new behaviour and features are ALLOWED/);
    expect(crew).toMatch(/NOT a 'small bug fix' test/);
    expect(crew).toMatch(/size, a new module, or new behaviour are not defects/);
  });

  it("the old small-fix questions are GONE from it (that is the defect being fixed)", () => {
    expect(crew).not.toContain("small, self-contained, targeted fix");
    expect(crew).not.toMatch(/zero scope creep/);
    expect(crew).not.toContain("ZERO behavioral code change");
    expect(crew).not.toMatch(/no new features/);
  });

  it("keeps the aggregator's output contract: EXACTLY the word CLEAN, else FLAG on the first line", () => {
    expect(crew).toMatch(/Respond with EXACTLY the single word CLEAN on the first line, and NOTHING else/);
    expect(crew).toMatch(/Otherwise respond with FLAG on the first line/);
    expect(crew).toMatch(/do not add caveats or hedging — output only CLEAN, or FLAG plus reasons/);
  });

  it("a FLAG must name which of the four failed", () => {
    expect(crew).toMatch(/`CORRECT: …`, `SAFE: …`, `SCOPED: …` or `PROVEN: …`/);
    expect(crew).toMatch(/one line per failed criterion that begins with its name/);
  });

  it("SAFE carries every named bar: secrets, auth weakening, destructive ops, unbounded writes, pricing, the gate itself, CI permissions", () => {
    for (const re of [
      /secret, token, key or credential/,
      /weakening of authentication or authorization/,
      /destructive data operation/,
      /unbounded external writes/,
      /pricing or price-sync/,
      /auto-merge gate, label authority or door itself/,
      /CI\/workflow permission escalation/,
      /prompt-injection, backdoor or exfiltration/,
    ]) {
      expect(crew).toMatch(re);
    }
  });

  it("PROVEN: tests/checks in the diff, or docs/config with no behaviour; weakening a test is never proven", () => {
    expect(crew).toMatch(/contains tests or checks that exercise the new or changed behaviour/);
    expect(crew).toMatch(/documentation, configuration or a comment with no runtime behaviour/);
    expect(crew).toMatch(/Weakening, deleting or skipping an existing test or assertion/);
  });

  it("SAFE doubt FLAGs; the other three FLAG only for a concrete defect (so the vote cannot re-create the 100% flag)", () => {
    expect(crew).toMatch(/On SAFE, any doubt is a FLAG/);
    expect(crew).toMatch(/FLAG only for a concrete defect you can name from the diff/);
  });

  // ── who gets it (the bugsquasher lane is NOT changed) ──

  it("a CREW PR in code-fix or fleet-internal gets the crew rubric", () => {
    expect(reviewSystemPromptFor("code-fix", true)).toBe(crew);
    expect(reviewSystemPromptFor("fleet-internal", true)).toBe(crew);
  });

  it("NEGATIVE CONTROL (bugsquasher lane): a non-crew code-fix keeps the code-fix rubric BYTE-FOR-BYTE", () => {
    expect(reviewSystemPromptFor("code-fix")).toBe(CODE_FIX_REVIEW_SYSTEM);
    expect(reviewSystemPromptFor("code-fix", false)).toBe(CODE_FIX_REVIEW_SYSTEM);
    expect(CODE_FIX_REVIEW_SYSTEM).toMatch(/small, self-contained, targeted fix/);
  });

  it("NEGATIVE CONTROL: a non-crew fleet-internal keeps the base prompt (unchanged)", () => {
    expect(reviewSystemPromptFor("fleet-internal")).toBe(BASE_REVIEW_SYSTEM);
  });

  it("NEGATIVE CONTROL: the doc/comment/test/vault classes never get the crew rubric, crew or not", () => {
    for (const c of ["docs-comment", "ci-infra", "vault-doc"] as const) {
      expect(reviewSystemPromptFor(c, true)).toBe(BASE_REVIEW_SYSTEM);
    }
    expect(reviewSystemPromptFor("test-only", true).startsWith(BASE_REVIEW_SYSTEM)).toBe(true);
    expect(reviewSystemPromptFor("test-only", true)).not.toContain("CORRECT —");
  });

  it("every class resolves to SOME non-empty prompt (no class falls off the end)", () => {
    for (const c of ALL_PR_DIFF_CLASSES) {
      expect(reviewSystemPromptFor(c).length).toBeGreaterThan(100);
      expect(reviewSystemPromptFor(c, true).length).toBeGreaterThan(100);
    }
  });
});
