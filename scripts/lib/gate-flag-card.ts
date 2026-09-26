/**
 * The blue card's COPY — one truthful sentence per refusal leg (ops#313, 2026-09-14).
 *
 * WHY THIS FILE EXISTS. The FLAG→card leg (ops#407/#413, "door pens", 2026-09-13) posts a
 * PR comment + `needs-human` so a refusal a human can clear becomes a blue card on the
 * glass instead of a dead end. It shipped wired at ONE refusal site — the `review` leg —
 * with copy hardcoded to that leg's door:
 *
 *     "A human `reviewed` label on this head lets the next sweep merge; `hold` parks it."
 *
 * That sentence is TRUE on the review leg and FALSE everywhere else, because
 * `humanReviewReceipt()` is consulted only at the review leg — which sits AFTER
 * class-match, line-cap and named-checks in `evaluate()`. A PR refused at class-match
 * never reaches the line that reads `reviewed`, so the label Kevin applies on the card's
 * instruction changes nothing and the PR sits with the card still promising it will move.
 *
 * LIVE COST (the stint that bought this file). claude-config-plane#302 carried
 * `reviewed` (kbibelhausen, 14:59:38Z, after the head) + `needs-human` + `fleet-internal`,
 * CLEAN/MERGEABLE, and the 15:24Z sweep (run 34861917273) refused it anyway:
 *
 *     [wait] ...#302: no diff class resolved (class-match) — sensitive path(s)
 *            excluded from classification: settings.json
 *     [gate-receipt] ... class=unclassified verdict=missed leg=class-match
 *
 * The card on that PR was written against head 836fa56 by the review leg; Kevin read its
 * promise, applied `reviewed` to head 49629db, and the next sweep refused at a leg that
 * cannot see the label. The refusal itself is CORRECT (settings.json is deliberately
 * sensitive — `sensitive_path_patterns` in squasher-fleet.json); the PROSE was the defect.
 * Rule #412: an alert's prose is a write-time claim about scope — it drifts from its
 * signal, and here the signal was one leg while the prose spoke for all of them.
 *
 * THE CONTRACT (2026-09-15, RULED "Box is the one key" — supersedes the two-word door
 * this file was born to explain). ONE human key opens every DECISION leg (class-match /
 * line-cap / named-checks / review): `box`, via `evaluateQueuedOverride` — sha-pinned,
 * roster-attributed, `hold` winning first. `box` is `queued` renamed (the old spelling
 * reads as an alias for the transition week); `reviewed` is RETIRED as a key — it stays
 * honored as the review-leg RECEIPT for the same week (pr-automerge-gate.ts
 * `humanReviewReceipt`), but no card ever says "Accept = reviewed" again (law 2). So the
 * card names the leg from the door's own receipt and the one key that opens it:
 *   - review / class-match / line-cap / named-checks → `box` (Accept = box)
 * Every card still names `hold` as the park, and stays idempotent per head sha.
 *
 * Pure — no gh, no network, no clock. The gate owns the I/O; this owns the words.
 */

/** The refusal legs that can carry a card. Mirrors gate-enroll's DECISION_LEGS: a
 *  machinery leg (truncation, held, eligibility, head-moved) is not a human's to clear. */
export type CardLeg = "review" | "class-match" | "line-cap" | "named-checks" | "stacked";

const CARD_LEGS: ReadonlySet<string> = new Set<CardLeg>(["review", "class-match", "line-cap", "named-checks", "stacked"]);

/** True when `leg` is a refusal a human label can clear — i.e. one that earns a card. */
export function isCardLeg(leg: string): leg is CardLeg {
  return CARD_LEGS.has(leg);
}

/**
 * The per-leg door sentence (2026-09-15, "Box is the one key" law 5): every card names
 * the leg that refused and reads "Accept = box" — the ONE key opens every decision leg,
 * so no leg ever names a different word again. `reviewed` is never offered (law 2).
 */
export function doorSentenceFor(leg: CardLeg): string {
  if (leg === "review") {
    return (
      "_**Accept = box.** A human `box` label on this head lets the next sweep merge " +
      "(sha-pinned, it overrides every decision leg, this one included); `hold` parks it. " +
      "This is a blue card on the glass._"
    );
  }
  const what =
    leg === "class-match"
      ? "the diff did not resolve to an enabled class"
      : leg === "line-cap"
        ? "the diff is over this class's line cap"
        : leg === "stacked"
          ? "the PR's base branch is not main — stacked PRs are never auto-merged"
          : "a named required check is not satisfied";
  return (
    `_This refusal is a **${leg}** leg — ${what}. **Accept = box.** ` +
    "A `box` label from a merge-authorized human on this head overrides a decision leg and lets the next sweep merge; `hold` parks it. " +
    "This is a blue card on the glass._"
  );
}

/** Per-head idempotency marker. One card per (leg, head) — a re-run must not re-post. */
export function cardMarkerFor(leg: CardLeg, headSha: string): string {
  return `<!-- gate-flag ${leg} ${headSha} -->`;
}

/**
 * The legacy review-leg marker (`<!-- gate-flag <sha> -->`, no leg segment). Cards posted
 * before ops#313 carry it; the review leg must still recognize them or every already-carded
 * PR gets a duplicate on the next sweep.
 */
export function legacyCardMarkerFor(headSha: string): string {
  return `<!-- gate-flag ${headSha} -->`;
}

/**
 * Every marker a flag-card search on (leg, head) must match — the card's own marker plus
 * (review leg only) the pre-#313 legacy form. Shared by postFlagCard's idempotency search
 * AND the gate's sticky-flag probe (stint #724, 2026-09-18): a review FLAG on a head PARKS
 * the PR, so the probe must see exactly the cards the poster wrote — one vocabulary, two
 * call sites, never two marker spellings drifting apart.
 */
export function flagCardMarkersFor(leg: CardLeg, headSha: string): string[] {
  return leg === "review" ? [cardMarkerFor(leg, headSha), legacyCardMarkerFor(headSha)] : [cardMarkerFor(leg, headSha)];
}

export interface FlagCard {
  /** Idempotency marker to search for AND to embed as the body's first line. */
  marker: string;
  /** Legacy marker to ALSO search for (review leg only) — undefined elsewhere. */
  legacyMarker?: string;
  /** The full comment body. */
  body: string;
}

/**
 * Builds the card for a refusal. `reasons` is the gate's own refusal text (the same
 * strings that ride the decision line), quoted verbatim so the card carries WHY.
 */
export function buildFlagCard(input: { leg: CardLeg; headSha: string; reasons: readonly string[] }): FlagCard {
  const { leg, headSha, reasons } = input;
  const marker = cardMarkerFor(leg, headSha);
  const title = leg === "review" ? "review FLAG" : `refused at the \`${leg}\` leg`;
  const detail = reasons.filter((r) => r.trim().length > 0).join("\n\n") || "(no reason recorded)";
  const body = [
    marker,
    `**Release door — ${title}** (head \`${headSha.slice(0, 7)}\`)`,
    "",
    detail,
    "",
    doorSentenceFor(leg),
  ].join("\n");
  return leg === "review" ? { marker, legacyMarker: legacyCardMarkerFor(headSha), body } : { marker, body };
}
