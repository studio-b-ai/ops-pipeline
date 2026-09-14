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

const SCRIPTS_DIR = join(import.meta.dirname, "..", "..");

/**
 * ops#313 — the defect this file guards. claude-config-plane#302 carried a human
 * `reviewed` on its head and was refused at `class-match`; the card on it promised
 * "a human `reviewed` label on this head lets the next sweep merge", which is only
 * true at the review leg. #412: prose is a claim about scope.
 */
describe("the card names the door that actually opens THAT leg", () => {
  it("review leg: `reviewed` is offered (it substitutes for the model's vote)", () => {
    const s = doorSentenceFor("review");
    expect(s).toContain("`reviewed`");
    expect(s).toContain("stands in for the model");
    expect(s).toContain("`hold` parks it");
  });

  it.each(["class-match", "line-cap", "named-checks"] as const)(
    "%s leg: the card says `reviewed` does NOT clear it, and names `queued` instead",
    (leg) => {
      const s = doorSentenceFor(leg);
      // The NEGATIVE control for this instrument (#322): the wrong-door promise must be
      // absent as a promise. `reviewed` may only appear inside the explicit denial.
      expect(s).toContain("does NOT clear it");
      expect(s).toContain("`queued`");
      expect(s).not.toContain("lets the next sweep merge");
      expect(s).toContain("`hold` parks it");
    },
  );

  it("no non-review card ever promises the reviewed door", () => {
    for (const leg of ["class-match", "line-cap", "named-checks"] as const) {
      const { body } = buildFlagCard({ leg, headSha: "a".repeat(40), reasons: ["r"] });
      expect(body).not.toMatch(/A human `reviewed` label on this head lets the next sweep merge/);
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
  it.each(["truncation", "held", "eligibility", "head-moved", "queued", "ci-rollup", "other"])(
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
    // resolved `leg`), the not-enabled-class refusal, named-checks, review — 4 total.
    const calls = src.match(/^\s*postFlagCard\(/gm) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("cards the review leg AND at least one pre-review decision leg", () => {
    // The #313 defect in one assertion: carding only the review leg is what left a
    // class-match refusal sitting under a `reviewed`-promising card.
    expect(src).toMatch(/postFlagCard\(repo, pr, "review",/);
    expect(src).toMatch(/postFlagCard\(repo, pr, "class-match",/);
    expect(src).toMatch(/postFlagCard\(repo, pr, "named-checks",/);
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
