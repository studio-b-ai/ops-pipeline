import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateSensitivePaths } from "../automerge-classify.js";
import { buildFlagCard, isCardLeg } from "../gate-flag-card.js";
import { isDecisionLeg } from "../gate-enroll.js";

// ───────────────────── crew-357 NEW-1 (2026-09-15): the sensitive-path FLOOR ─────────────────────
//
// THE DEFECT. Kevin's ruling (§1): "sensitive paths stay the floor his key never
// lowers." The deployed door checked sensitive paths ONLY inside classifyPrDiffClass
// — the class-match DECISION leg, which `queued` overrides via evaluateQueuedOverride
// — and the fleet registry passed sensitive_path_patterns BLANK on every train entry.
// asthetik-portal#80 merged over a `.github/**` denylist hit under a hand-applied
// `queued` (job 104211935034: "denylist hit(s): .github/workflows/..."). The floor did
// not exist; the copy claimed it did.
//
// THE FIX. The matcher is hoisted (evaluateSensitivePaths) so ONE predicate backs the
// class-match leg AND a new floor leg that runs BEFORE evaluateQueuedOverride on the
// squasher path and on the train path. `queued` never lowers it.
//
// THE CONTROLS (Rule #471 — plant the verdict the guard does NOT default to). A floor
// that refuses EVERYTHING passes the known-bad case for the wrong reason; the
// known-GOOD half is load-bearing. Both directions below run through the SAME
// evaluateSensitivePaths the live gate calls (#223 — not a re-implementation).

const PORTAL_PATTERNS = ["^\\.github/actions/"];

describe("sensitive-path floor — known-BAD (the refusal that was missing)", () => {
  it("refuses a diff that touches a declared sensitive path", () => {
    const verdict = evaluateSensitivePaths(["src/app.tsx", ".github/actions/deploy/action.yml"], PORTAL_PATTERNS);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.hits).toEqual([".github/actions/deploy/action.yml"]);
  });

  it("the real asthetik-portal#80 shape: a `.github/**` path in a queued PR is a hit", () => {
    // ops#413-class registry: the ops-pipeline entry's own denylist.
    const opsPatterns = ["(^|/)squasher-fleet\\.json$|(^|/)label-authority\\.ts$|(^|/)\\.github/workflows/"];
    const verdict = evaluateSensitivePaths([".github/workflows/rep-access-silence-monitor.yml"], opsPatterns);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.hits).toHaveLength(1);
  });

  it("a malformed caller pattern is a REFUSAL (ok:false), never a silent pass", () => {
    const verdict = evaluateSensitivePaths(["src/app.tsx"], ["(unclosed["]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.error.length).toBeGreaterThan(0);
  });
});

describe("sensitive-path floor — known-GOOD (must keep merging)", () => {
  it("passes a diff with no sensitive path", () => {
    const verdict = evaluateSensitivePaths(["src/app.tsx", "src/lib/util.ts"], PORTAL_PATTERNS);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.hits).toEqual([]);
  });

  it("is INERT when the caller declared no patterns (every pre-NEW-1 caller unchanged)", () => {
    for (const patterns of [undefined, [] as string[]]) {
      const verdict = evaluateSensitivePaths([".github/workflows/ci.yml"], patterns);
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) throw new Error("unreachable");
      expect(verdict.hits).toEqual([]);
    }
  });

  it("is narrow: ONE sensitive path among many safe paths hits only that path", () => {
    const verdict = evaluateSensitivePaths(
      ["src/a.ts", "src/b.ts", ".github/actions/x/action.yml", "docs/readme.md"],
      PORTAL_PATTERNS,
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.hits).toEqual([".github/actions/x/action.yml"]);
  });
});

describe("the refusal is surfaced (card + decision leg, so a human sees it)", () => {
  it("sensitive-paths is a card leg and a decision leg", () => {
    expect(isCardLeg("sensitive-paths")).toBe(true);
    expect(isDecisionLeg("sensitive-paths")).toBe(true);
  });

  it("the card for the refusal says `queued` does NOT lower it — never promises the key", () => {
    const card = buildFlagCard({
      leg: "sensitive-paths",
      headSha: "a".repeat(40),
      reasons: ["sensitive path(s) on the floor — `queued` never lowers them: .github/actions/x/action.yml"],
    });
    expect(card.body).toContain(".github/actions/x/action.yml");
    // The door sentence for this leg states the law: no label — `queued` included —
    // clears the floor. The wrong-door promise must be absent (#412 / #322 negative).
    expect(card.body).toContain("NO label (`queued` included) clears it");
    expect(card.body).not.toMatch(/`reviewed` label on this head lets the next sweep merge/);
  });
});

// ───────────────────────────── wiring guards (#464: called, not merely present) ─────────────────────────────
//
// Pure controls alone are worthless if the live gate never calls the floor, or calls
// it AFTER the override it exists to stand above. These assert against the gate source.

const SCRIPTS_DIR = join(import.meta.dirname, "..", "..");
const gate = readFileSync(join(SCRIPTS_DIR, "pr-automerge-gate.ts"), "utf8");

describe("pr-automerge-gate.ts wires the sensitive-path floor ABOVE the queued override", () => {
  it("the floor calls the shared matcher", () => {
    expect(gate).toMatch(/evaluateSensitivePaths\(/);
  });

  it("the floor runs BEFORE evaluateQueuedOverride (the whole law of NEW-1)", () => {
    const floorAt = gate.indexOf("sensitive-paths floor");
    const overrideAt = gate.indexOf("evaluateQueuedOverride(repo, pr, prJson, labels)");
    expect(floorAt).toBeGreaterThan(-1);
    expect(overrideAt).toBeGreaterThan(-1);
    expect(floorAt).toBeLessThan(overrideAt);
  });

  it("emits the sensitive-paths leg on a refusal", () => {
    expect(gate).toMatch(/leg: "sensitive-paths"/);
  });

  it("cards the refusal so it reaches the glass", () => {
    expect(gate).toMatch(/postFlagCard\(repo, pr, "sensitive-paths",/);
  });

  it("runs the floor on the TRAIN path too, reading the injected patterns", () => {
    expect(gate).toMatch(/opts\.sensitivePathPatterns/);
    // The train path's floor call sits inside evaluateTrainReadyInner, before its
    // review spend (a refusal must never pay for the model).
    const trainFloorAt = gate.indexOf("opts.sensitivePathPatterns");
    const trainReviewAt = gate.indexOf("TRAIN_READY_REVIEW_SYSTEM)");
    expect(trainFloorAt).toBeGreaterThan(-1);
    expect(trainReviewAt).toBeGreaterThan(-1);
    expect(trainFloorAt).toBeLessThan(trainReviewAt);
  });

  it("main() threads the parsed patterns into evaluateTrainReady", () => {
    const callAt = gate.indexOf("await evaluateTrainReady(repo, pr, {");
    expect(callAt).toBeGreaterThan(-1);
    expect(gate.slice(callAt, callAt + 200)).toContain("sensitivePathPatterns");
  });
});
