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
 * THE CONTRACT. `reviewed` substitutes for the MODEL's vote; it is not a class override.
 * The only label that overrides a DECISION leg (class-match / line-cap / named-checks /
 * review) is `queued`, via `evaluateQueuedOverride` — sha-pinned, roster-attributed,
 * `hold` winning first. So the card names the door that actually opens THAT leg:
 *   - review      → `reviewed` (the human receipt stands in for the model) or `queued`
 *   - class-match / line-cap / named-checks → `queued` ONLY (`reviewed` cannot reach them)
 * Every card still names `hold` as the park, and stays idempotent per head sha.
 *
 * Pure — no gh, no network, no clock. The gate owns the I/O; this owns the words.
 */

/** The refusal legs that can carry a card. Mirrors gate-enroll's DECISION_LEGS: a
 *  machinery leg (truncation, held, eligibility, head-moved) is not a human's to clear. */
export type CardLeg = "review" | "class-match" | "line-cap" | "named-checks";

const CARD_LEGS: ReadonlySet<string> = new Set<CardLeg>(["review", "class-match", "line-cap", "named-checks"]);

/** True when `leg` is a refusal a human label can clear — i.e. one that earns a card. */
export function isCardLeg(leg: string): leg is CardLeg {
  return CARD_LEGS.has(leg);
}

/**
 * The per-leg door sentence. `reviewed` appears ONLY for the review leg, because that is
 * the only leg whose predicate reads it (pr-automerge-gate.ts `humanReviewReceipt`).
 */
export function doorSentenceFor(leg: CardLeg): string {
  if (leg === "review") {
    return (
      "_A human `reviewed` label on this head lets the next sweep merge " +
      "(it stands in for the model's vote); `queued` also merges it; `hold` parks it. " +
      "This is a blue card on the glass._"
    );
  }
  const what =
    leg === "class-match"
      ? "the diff did not resolve to an enabled class"
      : leg === "line-cap"
        ? "the diff is over this class's line cap"
        : "a named required check is not satisfied";
  return (
    `_This refusal is a **${leg}** leg — ${what}, so \`reviewed\` does NOT clear it ` +
    "(`reviewed` substitutes for the model's vote, which this PR never reached). " +
    "Only a `queued` label from a merge-authorized human overrides a decision leg; `hold` parks it. " +
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
