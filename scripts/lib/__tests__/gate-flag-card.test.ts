import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFlagCard,
  cardMarkerFor,
  doorSentenceFor,
  isCardLeg,
  legacyCardMarkerFor,
} from "../gate-flag-card.js";
import { classifyPrDiffClass } from "../automerge-classify.js";

const SCRIPTS_DIR = join(import.meta.dirname, "..", "..");

/** #302's head at the time Kevin applied `reviewed` (14:59:38Z, after the 14:38:20Z push). */
const HEAD_302 = "49629dbb6adf7c538b081495139007537d06b26e";

/**
 * ops#313 — the defect this file guards. claude-config-plane#302 carried a human
 * `reviewed` on its head and was refused at `class-match`; the card on it promised
 * "a human `reviewed` label on this head lets the next sweep merge", which is only
 * true at the review leg. #412: prose is a claim about scope.
 *
 * 2026-09-15 (RULED "Box is the one key"): ONE human key opens every decision leg —
 * `box`. Every card names the leg that refused and reads "Accept = box" (law 5);
 * `reviewed` is retired as a key and no card ever offers it again (law 2).
 */
describe("the card names the one key that opens THAT leg", () => {
  it("review leg: Accept = box — the one key, sha-pinned, overrides every decision leg", () => {
    const s = doorSentenceFor("review");
    expect(s).toContain("Accept = box");
    expect(s).toContain("`box`");
    expect(s).toContain("`hold` parks it");
    // Law 2: `reviewed` is never offered as a key again.
    expect(s).not.toContain("`reviewed`");
    expect(s).not.toContain("Accept = reviewed");
  });

  it.each(["class-match", "line-cap", "named-checks"] as const)(
    "%s leg: the card names the leg, reads Accept = box, and never offers `reviewed`",
    (leg) => {
      const s = doorSentenceFor(leg);
      expect(s).toContain(`**${leg}** leg`);
      expect(s).toContain("Accept = box");
      expect(s).toContain("`box` label from a merge-authorized human");
      expect(s).toContain("`hold` parks it");
      // Law 2 negative control (#322): the retired key is absent as a promise.
      expect(s).not.toContain("`reviewed`");
      expect(s).not.toContain("Accept = reviewed");
    },
  );

  it("no card of any leg ever promises the retired reviewed door", () => {
    for (const leg of ["review", "class-match", "line-cap", "named-checks"] as const) {
      const { body } = buildFlagCard({ leg, headSha: "a".repeat(40), reasons: ["r"] });
      expect(body).not.toMatch(/A human `reviewed` label on this head lets the next sweep merge/);
      expect(body).not.toContain("Accept = reviewed");
    }
  });
});

describe("card body", () => {
  it("quotes the gate's own refusal reasons verbatim", () => {
    const { body } = buildFlagCard({
      leg: "class-match",
      headSha: "49629dbb6adf7c538b081495139007537d06b26e",
      reasons: ["sensitive path(s) excluded from classification: settings.json"],
    });
    expect(body).toContain("sensitive path(s) excluded from classification: settings.json");
    expect(body).toContain("head `49629db`");
    expect(body).toContain("refused at the `class-match` leg");
  });

  it("leads with its marker so the idempotency search matches its own post", () => {
    const card = buildFlagCard({ leg: "line-cap", headSha: "b".repeat(40), reasons: ["over cap"] });
    expect(card.body.startsWith(card.marker)).toBe(true);
  });

  it("degrades to an explicit placeholder rather than an empty card", () => {
    const { body } = buildFlagCard({ leg: "named-checks", headSha: "c".repeat(40), reasons: ["", "  "] });
    expect(body).toContain("(no reason recorded)");
  });

  it("titles the review leg as a review FLAG (unchanged wording for that leg)", () => {
    const { body } = buildFlagCard({ leg: "review", headSha: "d".repeat(40), reasons: ["votes: FLAG,FLAG,FLAG"] });
    expect(body).toContain("**Release door — review FLAG**");
  });
});

describe("idempotency markers are per (leg, head)", () => {
  it("different legs on the SAME head do not collide", () => {
    const head = "e".repeat(40);
    expect(cardMarkerFor("review", head)).not.toEqual(cardMarkerFor("class-match", head));
  });

  it("the same leg on different heads does not collide (a new head earns a new card)", () => {
    expect(cardMarkerFor("review", "f".repeat(40))).not.toEqual(cardMarkerFor("review", "0".repeat(40)));
  });

  it("the review leg ALSO carries the legacy marker, so pre-#313 cards are not duplicated", () => {
    const head = "836fa56a1822d3339841fb9b5c5fd104272eca83";
    const card = buildFlagCard({ leg: "review", headSha: head, reasons: ["x"] });
    expect(card.legacyMarker).toEqual(legacyCardMarkerFor(head));
    // The real card on cp#302's earlier head used exactly this shape.
    expect(card.legacyMarker).toEqual(`<!-- gate-flag ${head} -->`);
  });

  it("non-review legs have NO legacy marker (they never posted a card before #313)", () => {
    expect(buildFlagCard({ leg: "class-match", headSha: "1".repeat(40), reasons: ["x"] }).legacyMarker).toBeUndefined();
  });

  it("a marker is an HTML comment — invisible in the rendered PR thread", () => {
    expect(cardMarkerFor("review", "2".repeat(40))).toMatch(/^<!--.*-->$/);
  });
});

describe("isCardLeg admits exactly the decision legs", () => {
  it.each(["review", "class-match", "line-cap", "named-checks"])("%s earns a card", (leg) => {
    expect(isCardLeg(leg)).toBe(true);
  });

  // Machinery refusals are not a human's to clear — carding them would be noise a
  // label cannot answer (the mirror of the #313 defect).
  it.each(["truncation", "held", "eligibility", "head-moved", "box", "ci-rollup", "other"])(
    "%s does NOT earn a card",
    (leg) => {
      expect(isCardLeg(leg)).toBe(false);
    },
  );
});

/**
 * The wiring guard. The pure copy above is worthless if the gate still hardcodes the
 * old sentence at one site — this is the #464 leg: the fix must be CALLED, not merely
 * present. Asserts against the gate source on disk.
 */
describe("pr-automerge-gate.ts actually wires the card at every decision leg", () => {
  const src = readFileSync(join(SCRIPTS_DIR, "pr-automerge-gate.ts"), "utf8");

  it("imports the shared card builder", () => {
    expect(src).toMatch(/from "\.\/lib\/gate-flag-card\.js"/);
  });

  it("no longer hardcodes the review-only door sentence inline", () => {
    expect(src).not.toContain("A human `reviewed` label on this head lets the next sweep merge");
  });

  it("routes every decision-leg refusal through one carding helper", () => {
    // Call sites: the classification refusal (carries class-match AND line-cap via its
    // resolved `leg`), the not-enabled-class refusal, named-checks, review, merge-ready (2 sites) — 6 total.
    const calls = src.match(/^\s*postFlagCard\(/gm) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it("cards the review leg AND at least one pre-review decision leg", () => {
    // The #313 defect in one assertion: carding only the review leg is what left a
    // class-match refusal sitting under a `reviewed`-promising card.
    expect(src).toMatch(/postFlagCard\(repo, pr, "review",/);
    expect(src).toMatch(/postFlagCard\(repo, pr, "class-match",/);
    expect(src).toMatch(/postFlagCard\(repo, pr, "named-checks",/);
    expect(src).toMatch(/postFlagCard\(repo, pr, "merge-ready",/);
    // The classification site passes the resolved leg variable (class-match | line-cap).
    expect(src).toMatch(/postFlagCard\(repo, pr, leg,/);
  });

  it("the carding helper applies needs-human alongside the comment", () => {
    const start = src.indexOf("function postFlagCard");
    expect(start).toBeGreaterThan(-1);
    const helper = src.slice(start, start + 2000);
    expect(helper).toContain("needs-human");
    expect(helper).toContain("commentOnPr");
  });

  it("the carding helper never throws — a card failure cannot crash the gate", () => {
    const start = src.indexOf("function postFlagCard");
    const helper = src.slice(start, start + 2000);
    expect(helper).toContain("try {");
    expect(helper).toMatch(/catch \(e\)/);
  });
});

// ───────────── the live regression, through the REAL classifier ─────────────
//
// The copy tests above prove the card SAYS the right thing. This block proves the
// refusal it describes is the one claude-config-plane#302 actually got — by calling
// classifyPrDiffClass() on #302's real file list with claude-config-plane's real
// registry entry (#223: a probe that re-assembles its own verdict tests only itself).
// Without this, a future change to the sensitive-path leg could move #302 to a
// different leg and every copy test above would still pass.

describe("claude-config-plane#302 refuses at class-match, and the card matches", () => {
  // #302's authoritative file list (gh pr view 302 --json files, head 49629db).
  const files = [
    { path: "settings.json", fileClass: "code" as const },
    { path: "shift-runner/opencode-seat/opencode.jsonc", fileClass: "code" as const },
  ];
  // Verbatim from scripts/squasher-fleet.json, claude-config-plane entry.
  const registry = {
    sensitivePathPatterns: ["(^|/)(settings\\.json|shift-runner/shifts\\.yaml|config-push/)"],
    safePathGlobs: ["bin/**", "shift-runner/**", "skills/**", ".gitignore"],
  };

  it("the refusal was CORRECT — settings.json is deliberately sensitive", () => {
    const res = classifyPrDiffClass({ files, totalChangedLines: 42, additions: 42, ...registry });
    expect(res.prClass).toBeNull();
    expect(res.failureLeg).toBe("class-match");
    expect(res.reasons.join(" ")).toContain("settings.json");
  });

  it("the card for that refusal reads Accept = box, never the retired reviewed door Kevin acted on", () => {
    const res = classifyPrDiffClass({ files, totalChangedLines: 42, additions: 42, ...registry });
    const card = buildFlagCard({ leg: "class-match", headSha: HEAD_302, reasons: res.reasons });
    expect(card.body).not.toMatch(/`reviewed` label on this head lets the next sweep merge/);
    expect(card.body).toContain("Accept = box");
    expect(card.body).toContain("settings.json");
  });

  // Positive control (#322/#471): the same registry entry on an in-glob, non-sensitive
  // diff still resolves a class — proving the sensitive-path leg is narrow, not a
  // blanket refusal that would make the test above pass for the wrong reason.
  it("positive control: an in-glob non-sensitive diff still classifies as code-fix", () => {
    const res = classifyPrDiffClass({
      files: [{ path: "shift-runner/opencode-seat/opencode.jsonc", fileClass: "code" as const }],
      totalChangedLines: 12,
      additions: 12,
      ...registry,
    });
    expect(res.failureLeg).toBeNull();
    expect(res.prClass).toBe("code-fix");
  });
});
