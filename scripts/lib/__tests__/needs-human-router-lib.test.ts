import { describe, expect, it } from "vitest";
import {
  FLEET_APP_MARKER_AUTHOR,
  hasAnyRouterReceipt,
  hasAuthorizedDisapproval,
  hasHoldReceipt,
  hasRouteReceipt,
  HOLD_RECEIPT_MARKER,
  isTrustedMarkerAuthor,
  recallDisposition,
  ROUTE_RECEIPT_MARKER,
  routeDisposition,
  summarizeDispositions,
  TRUSTED_MARKER_AUTHOR,
  type RouterDecisionInput,
} from "../needs-human-router-lib.js";

const ALLOWLIST = new Set(["studio-b-ai/bolt-wms", "studio-b-ai/studiob", "studio-b-ai/studiob-price-sync", "studio-b-ai/webhook-router", "studio-b-ai/asthetik-trade-theme"]);

const OWN_REPO = "studio-b-ai/ops-pipeline";

function base(overrides: Partial<RouterDecisionInput> = {}): RouterDecisionInput {
  return {
    isOpen: true,
    hasRouteReceiptMarker: false,
    probeCommentBody: null,
    hasAuthorizedDisapproval: false,
    allowlist: ALLOWLIST,
    ownRepo: OWN_REPO,
    ...overrides,
  };
}

function trailer(routing: string, needsKevin: "yes" | "no"): string {
  return ["## Culprit hypothesis", "something", "", `ROUTING: ${routing}`, `NEEDS-KEVIN: ${needsKevin}`].join("\n");
}

describe("hasRouteReceipt / hasHoldReceipt / hasAnyRouterReceipt", () => {
  // Negative controls first (Rule #322).
  it("false for an ordinary thread with neither marker", () => {
    expect(hasRouteReceipt(["hi", "there"])).toBe(false);
    expect(hasHoldReceipt(["hi", "there"])).toBe(false);
    expect(hasAnyRouterReceipt(["hi", "there"])).toBe(false);
  });

  it("the two markers are distinct — a hold receipt does not read as a route receipt", () => {
    expect(hasRouteReceipt([HOLD_RECEIPT_MARKER])).toBe(false);
    expect(hasHoldReceipt([ROUTE_RECEIPT_MARKER])).toBe(false);
  });

  it("hasAnyRouterReceipt is true for either marker alone", () => {
    expect(hasAnyRouterReceipt([ROUTE_RECEIPT_MARKER])).toBe(true);
    expect(hasAnyRouterReceipt([HOLD_RECEIPT_MARKER])).toBe(true);
  });
});

describe("isTrustedMarkerAuthor (codex pass 1 P1 — forged marker comments)", () => {
  it("true for the real GitHub Actions bot login (verified live against bolt-wms#1466)", () => {
    expect(isTrustedMarkerAuthor("github-actions[bot]")).toBe(true);
    expect(isTrustedMarkerAuthor(TRUSTED_MARKER_AUTHOR)).toBe(true);
  });

  // ops-pipeline#88 codex review pass 1 P1 ("Accept the fleet App bot as a trusted
  // marker author"): the cross-repo sweep posts its own receipts via the minted fleet
  // App token, authored by a DIFFERENT bot identity than github-actions[bot].
  it("true for the fleet App bot login (ops#88 cross-repo sweep's own receipt author)", () => {
    expect(isTrustedMarkerAuthor("studiob-fleet-bot[bot]")).toBe(true);
    expect(isTrustedMarkerAuthor(FLEET_APP_MARKER_AUTHOR)).toBe(true);
  });

  it("false for a human — even the repo owner can't forge a trusted marker", () => {
    expect(isTrustedMarkerAuthor("kbibelhausen")).toBe(false);
  });

  it("false for a look-alike login (no fuzzy/substring match), for EITHER trusted identity", () => {
    expect(isTrustedMarkerAuthor("github-actions")).toBe(false);
    expect(isTrustedMarkerAuthor("github-actions[bot]-fake")).toBe(false);
    expect(isTrustedMarkerAuthor("studiob-fleet-bot")).toBe(false);
    expect(isTrustedMarkerAuthor("studiob-fleet-bot[bot]-fake")).toBe(false);
    expect(isTrustedMarkerAuthor("some-other-app[bot]")).toBe(false);
  });
});

describe("hasAuthorizedDisapproval (Rule #398 — a reaction is origin-signed, not authorized)", () => {
  it("false with zero reactions (negative control)", () => {
    expect(hasAuthorizedDisapproval([], new Set(["kbibelhausen"]))).toBe(false);
  });

  it("true for an org member's 👎", () => {
    expect(hasAuthorizedDisapproval([{ content: "-1", login: "kbibelhausen" }], new Set(["kbibelhausen"]))).toBe(true);
  });

  // The #398 test, named per the chip prompt: a 👎 that really happened (origin-signed) but from
  // a NON-org-member is ignored — treated identically to no reaction at all, not merely "weaker".
  it("#398: a 👎 from a NON-member is ignored, treated as no reaction", () => {
    expect(hasAuthorizedDisapproval([{ content: "-1", login: "some-rando" }], new Set(["kbibelhausen"]))).toBe(false);
  });

  it("a 👍 never counts, even from an org member — only -1 is the brake", () => {
    expect(hasAuthorizedDisapproval([{ content: "+1", login: "kbibelhausen" }], new Set(["kbibelhausen"]))).toBe(false);
  });

  it("mixed reactors: the one authorized 👎 among several unauthorized ones still trips it", () => {
    const reactors = [
      { content: "-1", login: "some-rando" },
      { content: "+1", login: "kbibelhausen" },
      { content: "-1", login: "kbibelhausen" },
    ];
    expect(hasAuthorizedDisapproval(reactors, new Set(["kbibelhausen"]))).toBe(true);
  });
});

describe("routeDisposition — main per-issue pass", () => {
  // Negative controls first.

  it("no probe comment yet -> no-probe (counted, never mutated)", () => {
    expect(routeDisposition(base())).toEqual({ kind: "no-probe" });
  });

  it("not open (defensive guard — the caller only ever enumerates open issues) -> skip-already-routed", () => {
    expect(routeDisposition(base({ isOpen: false, probeCommentBody: trailer("same-repo", "no") }))).toEqual({ kind: "skip-already-routed" });
  });

  // Step 1: receipt marker present -> skip, UNCONDITIONALLY (even with a fresh 👎 sitting right
  // there — that is the RECALL pass's job, never this function's, so it must not act on it here).
  it("receipt marker present -> skip-already-routed, even with an authorized 👎 also present", () => {
    const out = routeDisposition(base({ hasRouteReceiptMarker: true, hasAuthorizedDisapproval: true, probeCommentBody: trailer("same-repo", "no") }));
    expect(out).toEqual({ kind: "skip-already-routed" });
  });

  // Step 2: the brake, pre-routing.
  it("authorized 👎 pre-routing -> close-rejected, even though a probe comment (with same-repo) exists", () => {
    const out = routeDisposition(base({ hasAuthorizedDisapproval: true, probeCommentBody: trailer("same-repo", "no") }));
    expect(out).toEqual({ kind: "close-rejected" });
  });

  // Step 4: legacy default. Realistic fixture (codex pass 4): a genuinely legacy comment always
  // has "## Confidence + what would falsify this" verbatim, since that section predates the
  // trailer requirement — see needs-human-probe-lib.ts's looksLikeAttemptedTrailer, which
  // treats a MISSING final-mandated-heading as "looks truncated", not legacy.
  it("legacy null-parse (no trailer at all) -> route-same-repo (the documented default)", () => {
    const legacyBody = ["## Culprit hypothesis", "the sync filter", "## NEEDS-KEVIN", "no", "## Confidence + what would falsify this", "high"].join("\n");
    expect(routeDisposition(base({ probeCommentBody: legacyBody }))).toEqual({ kind: "route-same-repo" });
  });

  // Kevin ruling 2026-09-05 (issue #317, "default to WORK"): a malformed trailer attempt no
  // longer holds — it still routes, but with `probeTrailerUnparsed: true` so the caller can
  // surface the format bug via a `probe-trailer-unparsed` label. A hold requires a PARSED
  // `NEEDS-KEVIN: yes`, never a broken-trailer default. Supersedes the pass-2 (2026-08-14)
  // "malformed → hold" behavior.
  it("malformed trailer attempt (stray trailing text) -> route-same-repo w/ probeTrailerUnparsed (Kevin ruling 2026-09-05)", () => {
    const body = ["ROUTING: same-repo", "NEEDS-KEVIN: no", "Let me know if you need anything else!"].join("\n");
    expect(routeDisposition(base({ probeCommentBody: body }))).toEqual({ kind: "route-same-repo", probeTrailerUnparsed: true });
  });

  it("malformed trailer attempt (corrupted ROUTING line) -> route-same-repo w/ probeTrailerUnparsed", () => {
    const body = ["ROUTING same-repo (missing colon)", "NEEDS-KEVIN: no"].join("\n");
    expect(routeDisposition(base({ probeCommentBody: body }))).toEqual({ kind: "route-same-repo", probeTrailerUnparsed: true });
  });

  // Positive control: a genuinely-legacy null-parse (no attempted trailer at all) routes WITHOUT
  // the probeTrailerUnparsed flag — the format-bug label is scoped to the attempted-but-broken
  // case, not fired for every legacy comment.
  it("legacy null-parse routes without probeTrailerUnparsed (only the attempted-but-broken case carries the flag)", () => {
    const legacyBody = ["## Culprit hypothesis", "the sync filter", "## NEEDS-KEVIN", "no", "## Confidence + what would falsify this", "high"].join("\n");
    const out = routeDisposition(base({ probeCommentBody: legacyBody }));
    expect(out.kind).toBe("route-same-repo");
    expect(out).not.toHaveProperty("probeTrailerUnparsed", true);
  });

  it("same-repo trailer, needs-kevin no -> route-same-repo (no probeTrailerUnparsed on a clean parse)", () => {
    expect(routeDisposition(base({ probeCommentBody: trailer("same-repo", "no") }))).toEqual({ kind: "route-same-repo" });
  });

  // NEEDS-KEVIN:yes always wins, regardless of ROUTING value — never relabels.
  it("needs-kevin yes on a SAME-repo trailer -> hold-needs-kevin, never route-same-repo (never relabels)", () => {
    expect(routeDisposition(base({ probeCommentBody: trailer("same-repo", "yes") }))).toEqual({ kind: "hold-needs-kevin" });
  });

  it("needs-kevin yes on a CROSS-repo trailer -> hold-needs-kevin too, not hold-cross-repo", () => {
    expect(routeDisposition(base({ probeCommentBody: trailer("cross-repo studio-b-ai/bolt-wms", "yes") }))).toEqual({ kind: "hold-needs-kevin" });
  });

  it("cross-repo target ON the allowlist -> hold-cross-repo with targetAllowed:true (v1 has no fleet token — holds are correct either way)", () => {
    const out = routeDisposition(base({ probeCommentBody: trailer("cross-repo studio-b-ai/bolt-wms", "no") }));
    expect(out).toEqual({ kind: "hold-cross-repo", target: "studio-b-ai/bolt-wms", targetAllowed: true });
  });

  it("cross-repo target OFF the allowlist -> hold-cross-repo with targetAllowed:false (flagged, never an action against the named repo)", () => {
    const out = routeDisposition(base({ probeCommentBody: trailer("cross-repo studio-b-ai/some-unknown-repo", "no") }));
    expect(out).toEqual({ kind: "hold-cross-repo", target: "studio-b-ai/some-unknown-repo", targetAllowed: false });
  });

  it("cross-repo target equal to the caller's OWN repo normalizes to route-same-repo (degenerate self-reference)", () => {
    const out = routeDisposition(base({ probeCommentBody: trailer(`cross-repo ${OWN_REPO}`, "no"), ownRepo: OWN_REPO }));
    expect(out).toEqual({ kind: "route-same-repo" });
  });
});

describe("recallDisposition — post-routing 👎 pass (issues found via reaction search, not label)", () => {
  it("no receipt marker, no disapproval -> none (negative control)", () => {
    expect(recallDisposition({ hasReceiptMarker: false, hasAuthorizedDisapproval: false })).toEqual({ kind: "none" });
  });

  it("receipt marker present but no authorized 👎 -> none (nothing to recall)", () => {
    expect(recallDisposition({ hasReceiptMarker: true, hasAuthorizedDisapproval: false })).toEqual({ kind: "none" });
  });

  it("authorized 👎 present but NO receipt marker -> none (that's the MAIN pass's job, not recall's — the issue was never routed)", () => {
    expect(recallDisposition({ hasReceiptMarker: false, hasAuthorizedDisapproval: true })).toEqual({ kind: "none" });
  });

  it("receipt marker + authorized 👎 -> close-rejected", () => {
    expect(recallDisposition({ hasReceiptMarker: true, hasAuthorizedDisapproval: true })).toEqual({ kind: "close-rejected" });
  });
});

describe("summarizeDispositions (Rule #465 — always all six kinds, including zeros)", () => {
  it("empty issue set -> no actions, every kind at 0", () => {
    expect(summarizeDispositions([])).toEqual({
      "skip-already-routed": 0,
      "close-rejected": 0,
      "hold-needs-kevin": 0,
      "route-same-repo": 0,
      "hold-cross-repo": 0,
      "no-probe": 0,
    });
  });

  it("counts each kind, including a kind that never fired this run staying at 0 (not omitted)", () => {
    const out = summarizeDispositions([
      { kind: "route-same-repo" },
      { kind: "route-same-repo" },
      { kind: "no-probe" },
      { kind: "hold-cross-repo", target: "studio-b-ai/bolt-wms", targetAllowed: true },
    ]);
    expect(out).toEqual({
      "skip-already-routed": 0,
      "close-rejected": 0,
      "hold-needs-kevin": 0,
      "route-same-repo": 2,
      "hold-cross-repo": 1,
      "no-probe": 1,
    });
  });
});
