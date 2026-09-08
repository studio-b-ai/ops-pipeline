import { describe, expect, it } from "vitest";
import {
  buildTwinPointer,
  buildTwinTitle,
  crossRepoDisposition,
  crossRepoRecallDisposition,
  extractTwinPointer,
  findTwinMatch,
  shortRepoName,
  summarizeCrossRepoDispositions,
  twinExists,
  twinTitlePrefix,
  type CrossRepoDecisionInput,
  type CrossRepoRecallDecisionInput,
  type TwinCandidate,
  twinLabelsFrom,
} from "../needs-human-crossrepo-lib.js";

const ALLOWLIST = new Set([
  "studio-b-ai/bolt-wms",
  "studio-b-ai/studiob",
  "studio-b-ai/studiob-price-sync",
  "studio-b-ai/webhook-router",
  "studio-b-ai/asthetik-trade-theme",
]);

const OWN_REPO = "studio-b-ai/studiob-price-sync";

function base(overrides: Partial<CrossRepoDecisionInput> = {}): CrossRepoDecisionInput {
  return {
    isOpen: true,
    hasRouteReceiptMarker: false,
    probeCommentBody: null,
    hasAuthorizedDisapproval: false,
    ownRepo: OWN_REPO,
    allowlist: ALLOWLIST,
    twinExists: false,
    ...overrides,
  };
}

function trailer(routing: string, needsKevin: "yes" | "no"): string {
  return ["## Culprit hypothesis", "something", "", `ROUTING: ${routing}`, `NEEDS-KEVIN: ${needsKevin}`].join("\n");
}

const CROSS_REPO_BOLT = trailer("cross-repo studio-b-ai/bolt-wms", "no");

// ───────────────────────────── shortRepoName / twinTitlePrefix / buildTwinTitle ─────────────────────────────

describe("shortRepoName", () => {
  it("strips the org prefix", () => {
    expect(shortRepoName("studio-b-ai/bolt-wms")).toBe("bolt-wms");
  });

  it("returns the input unchanged when there's no slash (defensive)", () => {
    expect(shortRepoName("bolt-wms")).toBe("bolt-wms");
  });
});

describe("twinTitlePrefix / buildTwinTitle", () => {
  it("builds the deterministic '[from <short>#<n>]' prefix", () => {
    expect(twinTitlePrefix("studiob-price-sync", 42)).toBe("[from studiob-price-sync#42]");
  });

  it("buildTwinTitle prefixes the (untruncated) origin title for a short title", () => {
    expect(buildTwinTitle("studiob-price-sync", 42, "sync fails on empty SKU list")).toBe(
      "[from studiob-price-sync#42] sync fails on empty SKU list",
    );
  });

  it("buildTwinTitle truncates a long origin title to 80 chars with an ellipsis", () => {
    const longTitle = "x".repeat(120);
    const out = buildTwinTitle("studiob-price-sync", 42, longTitle);
    expect(out.startsWith("[from studiob-price-sync#42] ")).toBe(true);
    const titlePart = out.slice("[from studiob-price-sync#42] ".length);
    expect(titlePart.length).toBe(80);
    expect(titlePart.endsWith("…")).toBe(true);
    expect(titlePart.slice(0, -1)).toBe("x".repeat(79));
  });

  it("buildTwinTitle leaves an exactly-80-char title untouched (boundary, no ellipsis)", () => {
    const exact = "y".repeat(80);
    const out = buildTwinTitle("studiob-price-sync", 42, exact);
    expect(out).toBe(`[from studiob-price-sync#42] ${exact}`);
    expect(out.endsWith("…")).toBe(false);
  });
});

// ───────────────────────────── findTwinMatch / twinExists ─────────────────────────────

describe("findTwinMatch / twinExists (Rule #322 — both directions)", () => {
  const built = buildTwinTitle("studiob-price-sync", 42, "sync fails on empty SKU list");

  it("negative control: empty candidate list never matches", () => {
    expect(twinExists([], "studiob-price-sync", 42)).toBe(false);
    expect(findTwinMatch([], "studiob-price-sync", 42)).toBeUndefined();
  });

  it("finds the exact deterministic title", () => {
    const candidates: TwinCandidate[] = [{ number: 7, title: built }];
    expect(twinExists(candidates, "studiob-price-sync", 42)).toBe(true);
    expect(findTwinMatch(candidates, "studiob-price-sync", 42)?.number).toBe(7);
  });

  it("title-drift tolerant: matches on the prefix even after a human retitles the twin", () => {
    const candidates: TwinCandidate[] = [{ number: 7, title: "[from studiob-price-sync#42] a completely different, human-edited title" }];
    expect(twinExists(candidates, "studiob-price-sync", 42)).toBe(true);
  });

  it("negative control: a DIFFERENT issue number's twin does not match", () => {
    const candidates: TwinCandidate[] = [{ number: 7, title: buildTwinTitle("studiob-price-sync", 43, "unrelated issue") }];
    expect(twinExists(candidates, "studiob-price-sync", 42)).toBe(false);
  });

  it("negative control: a DIFFERENT origin repo's twin does not match", () => {
    const candidates: TwinCandidate[] = [{ number: 7, title: buildTwinTitle("bolt-wms", 42, "same number, different repo") }];
    expect(twinExists(candidates, "studiob-price-sync", 42)).toBe(false);
  });

  it("negative control: an unrelated issue title (no bracket prefix at all) does not match", () => {
    const candidates: TwinCandidate[] = [{ number: 7, title: "totally unrelated issue about DNS" }];
    expect(twinExists(candidates, "studiob-price-sync", 42)).toBe(false);
  });

  it("finds the right candidate among several", () => {
    const candidates: TwinCandidate[] = [
      { number: 5, title: "unrelated" },
      { number: 6, title: buildTwinTitle("bolt-wms", 42, "wrong repo") },
      { number: 7, title: built },
    ];
    expect(findTwinMatch(candidates, "studiob-price-sync", 42)?.number).toBe(7);
  });
});

// ───────────────────────────── crossRepoDisposition ─────────────────────────────

describe("crossRepoDisposition", () => {
  // Negative controls first (Rule #322).

  it("not open (defensive guard) -> skip", () => {
    expect(crossRepoDisposition(base({ isOpen: false, probeCommentBody: CROSS_REPO_BOLT }))).toEqual({ kind: "skip" });
  });

  it("already-routed marker (ROUTE_RECEIPT_MARKER present) -> skip, UNCONDITIONALLY, even with an authorized 👎 and a cross-repo trailer present", () => {
    const out = crossRepoDisposition(
      base({ hasRouteReceiptMarker: true, hasAuthorizedDisapproval: true, probeCommentBody: CROSS_REPO_BOLT, twinExists: true }),
    );
    expect(out).toEqual({ kind: "skip" });
  });

  it("no probe comment yet -> skip", () => {
    expect(crossRepoDisposition(base())).toEqual({ kind: "skip" });
  });

  it("legacy/unparseable trailer (parseProbeRouting -> null) -> skip (the same-repo router owns the legacy default, not this sweep)", () => {
    const legacyBody = ["## Culprit hypothesis", "the sync filter", "## NEEDS-KEVIN", "no", "## Confidence + what would falsify this", "high"].join(
      "\n",
    );
    expect(crossRepoDisposition(base({ probeCommentBody: legacyBody }))).toEqual({ kind: "skip" });
  });

  it("malformed trailer attempt -> skip too (same reasoning as legacy — this sweep never guesses from a broken signal)", () => {
    const body = ["ROUTING: cross-repo studio-b-ai/bolt-wms", "NEEDS-KEVIN: no", "Thanks!"].join("\n");
    expect(crossRepoDisposition(base({ probeCommentBody: body }))).toEqual({ kind: "skip" });
  });

  it("same-repo trailer -> skip (not this sweep's job)", () => {
    expect(crossRepoDisposition(base({ probeCommentBody: trailer("same-repo", "no") }))).toEqual({ kind: "skip" });
  });

  it("needs-kevin yes on an otherwise-clean cross-repo trailer -> skip (never acts on a NEEDS-KEVIN issue)", () => {
    expect(crossRepoDisposition(base({ probeCommentBody: trailer("cross-repo studio-b-ai/bolt-wms", "yes") }))).toEqual({ kind: "skip" });
  });

  it("cross-repo target equal to the caller's own repo -> skip (degenerate self-reference)", () => {
    const out = crossRepoDisposition(base({ probeCommentBody: trailer(`cross-repo ${OWN_REPO}`, "no"), ownRepo: OWN_REPO }));
    expect(out).toEqual({ kind: "skip" });
  });

  // The real cross-repo path.

  it("clean cross-repo trailer, needs-kevin no, target on allowlist, no twin yet -> file-cross-repo", () => {
    expect(crossRepoDisposition(base({ probeCommentBody: CROSS_REPO_BOLT }))).toEqual({
      kind: "file-cross-repo",
      target: "studio-b-ai/bolt-wms",
    });
  });

  it("off-allowlist target -> hold-invalid-target (never an action against the named repo)", () => {
    const out = crossRepoDisposition(base({ probeCommentBody: trailer("cross-repo studio-b-ai/some-unknown-repo", "no") }));
    expect(out).toEqual({ kind: "hold-invalid-target", target: "studio-b-ai/some-unknown-repo" });
  });

  it("twin already exists for an on-allowlist target -> skip-twin-exists (never files a second twin)", () => {
    const out = crossRepoDisposition(base({ probeCommentBody: CROSS_REPO_BOLT, twinExists: true }));
    expect(out).toEqual({ kind: "skip-twin-exists", target: "studio-b-ai/bolt-wms" });
  });

  // Authorized vs unauthorized 👎 (Rule #398 — the #398 test, both directions).

  it("unauthorized 👎 is ignored — treated as absent, falls through to file-cross-repo normally", () => {
    // hasAuthorizedDisapproval is pre-resolved by the CALLER (only true for an org-member/
    // allowlisted reactor's -1); the lib never re-derives authorization, so passing false
    // here IS the "unauthorized 👎 present but ignored" case from the caller's perspective.
    const out = crossRepoDisposition(base({ probeCommentBody: CROSS_REPO_BOLT, hasAuthorizedDisapproval: false }));
    expect(out).toEqual({ kind: "file-cross-repo", target: "studio-b-ai/bolt-wms" });
  });

  it("authorized 👎, no twin yet -> close-rejected with twinExists:false", () => {
    const out = crossRepoDisposition(base({ probeCommentBody: CROSS_REPO_BOLT, hasAuthorizedDisapproval: true, twinExists: false }));
    expect(out).toEqual({ kind: "close-rejected", target: "studio-b-ai/bolt-wms", twinExists: false });
  });

  it("authorized 👎 AND a twin already on record (prior partial run) -> close-rejected with twinExists:true (caller closes the twin too)", () => {
    const out = crossRepoDisposition(base({ probeCommentBody: CROSS_REPO_BOLT, hasAuthorizedDisapproval: true, twinExists: true }));
    expect(out).toEqual({ kind: "close-rejected", target: "studio-b-ai/bolt-wms", twinExists: true });
  });

  it("authorized 👎 pre-empts an off-allowlist target too -> close-rejected, not hold-invalid-target", () => {
    const out = crossRepoDisposition(
      base({ probeCommentBody: trailer("cross-repo studio-b-ai/some-unknown-repo", "no"), hasAuthorizedDisapproval: true }),
    );
    expect(out).toEqual({ kind: "close-rejected", target: "studio-b-ai/some-unknown-repo", twinExists: false });
  });
});

// ───────────────────────────── summarizeCrossRepoDispositions ─────────────────────────────

describe("summarizeCrossRepoDispositions (Rule #465 — always all five kinds, including zeros)", () => {
  it("empty issue set -> no actions, every kind at 0", () => {
    expect(summarizeCrossRepoDispositions([])).toEqual({
      skip: 0,
      "close-rejected": 0,
      "file-cross-repo": 0,
      "skip-twin-exists": 0,
      "hold-invalid-target": 0,
    });
  });

  it("counts each kind, including a kind that never fired this run staying at 0 (not omitted)", () => {
    const out = summarizeCrossRepoDispositions([
      { kind: "file-cross-repo", target: "studio-b-ai/bolt-wms" },
      { kind: "file-cross-repo", target: "studio-b-ai/studiob" },
      { kind: "skip" },
      { kind: "hold-invalid-target", target: "studio-b-ai/some-unknown-repo" },
    ]);
    expect(out).toEqual({
      skip: 1,
      "close-rejected": 0,
      "file-cross-repo": 2,
      "skip-twin-exists": 0,
      "hold-invalid-target": 1,
    });
  });
});

// ───────────────────────────── buildTwinPointer / extractTwinPointer (codex pass 1 P1) ─────────────────────────────

describe("buildTwinPointer / extractTwinPointer", () => {
  it("round-trips: extract(build(x)) === x", () => {
    const marker = buildTwinPointer("studio-b-ai/bolt-wms", 1234);
    expect(extractTwinPointer(marker)).toEqual({ target: "studio-b-ai/bolt-wms", number: 1234 });
  });

  it("finds the pointer embedded inside a full receipt body, not just a bare marker string", () => {
    const body = [
      "<!-- needs-human-router:v1 -->",
      buildTwinPointer("studio-b-ai/studiob-price-sync", 42),
      "🌐 **Cross-repo routed** — filed as `studiob-price-sync#42`.",
    ].join("\n");
    expect(extractTwinPointer(body)).toEqual({ target: "studio-b-ai/studiob-price-sync", number: 42 });
  });

  // Negative control (Rule #322): a same-repo route's receipt shares ROUTE_RECEIPT_MARKER
  // but NEVER embeds a twin pointer, since it never files a twin — this is the exact
  // disambiguation the recall pass depends on.
  it("negative control: a plain receipt with no pointer returns null", () => {
    expect(extractTwinPointer("<!-- needs-human-router:v1 -->\n🧭 Auto-routed to this repo's lane backlog.")).toBeNull();
  });

  it("negative control: an ordinary comment with no marker at all returns null", () => {
    expect(extractTwinPointer("just a regular comment, nothing special here")).toBeNull();
  });
});

// ───────────────────────────── crossRepoRecallDisposition (codex pass 1 P1) ─────────────────────────────

describe("crossRepoRecallDisposition — post-routing 👎 pass (mirrors needs-human-router-lib.ts's recallDisposition)", () => {
  function recallBase(overrides: Partial<CrossRepoRecallDecisionInput> = {}): CrossRepoRecallDecisionInput {
    return { hasCrossRepoRouteReceipt: false, hasAuthorizedDisapproval: false, ...overrides };
  }

  it("no receipt, no disapproval -> none (negative control)", () => {
    expect(crossRepoRecallDisposition(recallBase())).toEqual({ kind: "none" });
  });

  it("receipt present but no authorized 👎 -> none (nothing to recall)", () => {
    expect(crossRepoRecallDisposition(recallBase({ hasCrossRepoRouteReceipt: true }))).toEqual({ kind: "none" });
  });

  it("authorized 👎 present but NO cross-repo route receipt -> none (not this sweep's issue to recall — could be a same-repo-routed issue, or nothing routed at all)", () => {
    expect(crossRepoRecallDisposition(recallBase({ hasAuthorizedDisapproval: true }))).toEqual({ kind: "none" });
  });

  it("cross-repo route receipt + authorized 👎 -> close-rejected", () => {
    expect(crossRepoRecallDisposition(recallBase({ hasCrossRepoRouteReceipt: true, hasAuthorizedDisapproval: true }))).toEqual({
      kind: "close-rejected",
    });
  });
});


describe("twinLabelsFrom (2026-09-06 — twins inherit the origin's routing labels)", () => {
  it("known-GOOD (the live theme#586 / price-sync#163 shape): bug + zoom-intake + P1 travel to the twin", () => {
    expect(twinLabelsFrom([{ name: "bug" }, { name: "zoom-intake" }, { name: "P1" }, { name: "needs-human" }])).toEqual(["bug", "zoom-intake", "P1"]);
  });

  it("known-BAD: routing-STATE labels never travel (needs-human, lane:*, train state, decisions)", () => {
    expect(twinLabelsFrom([{ name: "needs-human" }, { name: "lane:engineer" }, { name: "queued" }, { name: "reviewed" }, { name: "underway" }, { name: "candidate" }, { name: "hold" }, { name: "veto" }, { name: "wontfix" }])).toEqual([]);
  });

  it("control: no labels / undefined / empty names → [] (an unlabeled origin files an unlabeled twin, as before)", () => {
    expect(twinLabelsFrom(undefined)).toEqual([]);
    expect(twinLabelsFrom([])).toEqual([]);
    expect(twinLabelsFrom([{ name: "" }, { name: null }])).toEqual([]);
  });

  it("control: accepts plain strings and de-duplicates", () => {
    expect(twinLabelsFrom(["bug", "bug", "P2"])).toEqual(["bug", "P2"]);
  });
});
