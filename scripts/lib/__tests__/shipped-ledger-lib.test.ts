import { describe, expect, it } from "vitest";
import {
  AUDIENCES,
  classifyPr,
  classifyWithLabels,
  computeWatermark,
  formatLedgerLine,
  isInternalByConstruction,
  isoWeekLabel,
  ledgerKey,
  lintLedgerLine,
  lintPlan,
  newestDateForRepo,
  parseClassifierResponse,
  parseLedger,
  planAppends,
  renderDryRunTable,
  renderLedgerFile,
  renderStatsTable,
  shortRepoName,
  summarizeTotals,
  utcDateOf,
  WATERMARK_OVERLAP_DAYS,
  type CandidatePr,
  type LedgerEntry,
  type RepoRunStats,
} from "../shipped-ledger-lib.js";

// ───────────────────────────── fixtures ─────────────────────────────

// The REAL studio-b-ai/brain SHIPPED.md's first 42 lines, fetched read-only 2026-08-18
// via `gh api repos/studio-b-ai/brain/contents/SHIPPED.md --jq .content | base64 -d`
// (chip brief step 5's exact instruction). Contains the full blockquote preamble + one
// month section (## 2026-07) with its first 15 data lines, verbatim — including the
// real " · " (U+00B7 MIDDLE DOT) delimiters, an em dash, and both quote styles, so the
// round-trip tests exercise the ACTUAL grammar, not an idealized approximation of it.
const FIXTURE_MD =
  "# SHIPPED — running record of what customers and staff can see\n\n> **Purpose (Kevin, 8/18 ~00:25 ET):** *\"we should be publishing release notes for our customers … or at least a running record of what's been accomplished the CMO can choose to feature as content.\"* This is that record. One line per shipped, HUMAN-VISIBLE change — internal work (CI, guards, refactors, monitors, sync plumbing) is deliberately absent so the CMO never has to sift. Nothing here is public copy: anything the CMO features passes `/claim-law` (and Rule #341 for Studio b.-branded surfaces) on the way out, and publishing is a Rule #97 word.\n>\n> **Line format:** `YYYY-MM-DD · AUDIENCE · surface · plain-English sentence · repo#PR`. Audiences: **TRADE** (Ästhetik trade/wholesale buyers), **DTC** (retail shoppers), **STAFF** (HF/Ästhetik reps + ops tools — the CMO can turn these into \"how we serve you\" stories).\n>\n> **Feeding (deterministic, Rule #279 — never a memory-promise):** (1) every lane appends its shipped lines at `/wrap` (CoS owns the skill step); (2) a weekly ops-pipeline backfill from merged PRs (owner CTO) catches what wraps miss; (3) anyone may append a non-PR win (a launch, a first order, a milestone) with `date · AUDIENCE · surface · line · source`. Newest at the BOTTOM of each month; months in ascending order. Owner: Chief of Staff seat (hub). Consumer: CMO seat.\n>\n> **Seed:** 2026-08-18T05:45Z — harvested by the General Counsel session from merged PRs across the fleet since 2026-07-20 (Sonnet readers per repo, PR titles + bodies; plain-English lines are the readers' descriptions of what each PR shipped — treat as \"what changed\", not as verified-live claims per #355). Coverage of the seed (repo · merged PRs read → human-visible lines kept):\n> - studiob-price-sync since 2026-07-20: 85 merged → 66 kept\n> - webhook-router since 2026-07-20: 66 merged → 30 kept\n> - asthetik-portal since 2026-07-20: 11 merged → 6 kept\n> - b-studio-website since 2026-07-20: 2 merged → 0 kept\n> - bolt-wms 2026-08-01..2026-08-08: 56 merged → 13 kept\n> - bolt-wms 2026-08-09..2026-08-18: 110 merged → 35 kept\n> - asthetik-trade-theme 2026-07-20..2026-08-03: 152 merged → 115 kept\n> - bolt-wms 2026-07-20..2026-07-31: 114 merged → 41 kept\n> - asthetik-trade-theme 2026-08-04..2026-08-18: 261 merged → 206 kept\n> - studiob 2026-07-20..2026-08-18: 125 merged → 50 kept\n>\n> Not covered by the seed: anything before 2026-07-20 (the fleet shipped continuously since June — backfill on warrant); repos outside the seven read (acuops-*, amplify, client-asthetik plugin-side, shuttle) — the weekly backfill picks them up. Granularity is PR-level on purpose; the CMO features THEMES (e.g. \"the trade account got an address book, order tracker, and quotes this month\"), not lines.\n\n> Seed totals: 562 lines — TRADE 124 · DTC 294 · STAFF 144.\n\n## 2026-07\n\n- 2026-07-20 · **STAFF** · trade portal (staff sign-in) · Staff now sign into the portal using only their Microsoft work account — the old email-link login and a hidden admin-override login have been removed. · `asthetik-portal#50`\n- 2026-07-20 · **TRADE** · PDP availability messaging · Signed-in trade customers whose account isn't yet linked now see a clear message to ask their rep to link the account, instead of a confusing sign-in prompt, when checking fabric availability. · `asthetik-trade-theme#1`\n- 2026-07-20 · **STAFF** · Product page (staff view-as) · Staff using the \"view as customer\" tool on a product page now see that customer's real stock availability instead of their own blank result. · `studiob#356`\n- 2026-07-20 · **TRADE** · Address book · Trade customers can edit the shipping addresses saved to their company account. · `studiob#357`\n- 2026-07-20 · **TRADE** · Address book · When a trade customer edits an address, the change now also saves correctly on the storefront, not just in the back office. · `studiob#358`\n- 2026-07-20 · **TRADE** · Company profile page · Fixes a bug that was blocking trade customers from editing their company profile page. · `studiob#359`\n- 2026-07-20 · **TRADE** · Billing page · Trade customers can now view their billing information in their online account. · `studiob#361`\n- 2026-07-20 · **STAFF** · Product page (staff view-as) · Staff can switch their view on a product page to see exactly what a specific trade customer sees, including that customer's price and stock tier. · `studiob#362`\n- 2026-07-20 · **TRADE** · trade portal (asthetik.com customer account) · Trade customers can now view, add, edit, set a default, and remove their own shipping addresses (ship-to locations) right from their account page. · `studiob-price-sync#44`\n- 2026-07-20 · **TRADE** · trade portal (asthetik.com customer account) · Trade customers now see their billing address displayed (view-only) below their list of shipping addresses. · `studiob-price-sync#47`\n- 2026-07-20 · **TRADE** · trade portal (asthetik.com customer account) · Shipping addresses on the account page now show the location's name (like \"Chicago Warehouse\") as the heading instead of just a street address. · `studiob-price-sync#48`\n- 2026-07-20 · **TRADE** · trade portal (asthetik.com customer account) · Special addresses used for finishing partners (like stain-guard or backing facilities) can no longer be edited or deleted by customers, preventing goods from accidentally being shipped unfinished. · `studiob-price-sync#49`\n- 2026-07-20 · **TRADE** · trade portal (asthetik.com customer account) · Fixed a bug that had kept the new shipping-address manager from ever appearing on the account page at all. · `studiob-price-sync#50`\n- 2026-07-21 · **STAFF** · PDP price + rep tools · Staff and reps can now switch into a specific trade customer's view on a product page, see that customer's real price, and place an order on their behalf. · `asthetik-trade-theme#2`\n- 2026-07-21 · **TRADE** · Account sign-in links · Fixed account links so trade customers land on their membership home page instead of the generic native orders page. · `asthetik-trade-theme#3`\n- 2026-07-21 · **TRADE** · Account sign-in links · Fixed a broken 'go to your account' link used in emails and account navigation that was sending customers to a dead page instead of sign-in. · `asthetik-trade-theme#4`";

function candidatePr(overrides: Partial<CandidatePr> = {}): CandidatePr {
  return {
    repo: "studio-b-ai/bolt-wms",
    number: 9001,
    title: "trade: fix backorder ETA rounding",
    body: "Backorder ETAs were off by one day for staff viewing the Procurement Hub.",
    labels: [],
    mergedAt: "2026-08-19T14:00:00Z",
    url: "https://github.com/studio-b-ai/bolt-wms/pull/9001",
    author: "kbibelhausen",
    ...overrides,
  };
}

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    date: "2026-08-19",
    audience: "STAFF",
    surface: "Procurement Hub",
    sentence: "Backorder ETAs now round to the correct day.",
    key: "bolt-wms#9001",
    ...overrides,
  };
}

function repoRunStats(overrides: Partial<RepoRunStats> = {}): RepoRunStats {
  return {
    repo: "studio-b-ai/bolt-wms",
    watermark: "2026-08-11T05:45:00Z",
    read: 10,
    kept: 3,
    skippedDedup: 5,
    skippedInternal: 2,
    classifierMalformed: 0,
    unclassified: 0,
    limitHit: false,
    readError: null,
    ...overrides,
  };
}

// ───────────────────────────── parseLedger (round trip on the real fixture) ─────────────────────────────

describe("parseLedger — round trip on a REAL ledger fixture (first 42 lines of studio-b-ai/brain SHIPPED.md, fetched 2026-08-18)", () => {
  it("captures the blockquote preamble as header, verbatim, stopping before the first month heading", () => {
    const parsed = parseLedger(FIXTURE_MD);
    expect(parsed.header).toContain("# SHIPPED — running record of what customers and staff can see");
    expect(parsed.header).toContain("Seed totals: 562 lines");
    expect(parsed.header).not.toContain("## 2026-07");
  });

  it("finds exactly one month section with all 16 fixture data lines, in file order", () => {
    const parsed = parseLedger(FIXTURE_MD);
    expect(parsed.months).toEqual(["2026-07"]);
    const lines = parsed.sections.get("2026-07");
    expect(lines).toHaveLength(16);
    expect(lines?.[0]).toContain("`asthetik-portal#50`");
    expect(lines?.[15]).toContain("`asthetik-trade-theme#4`");
  });

  it("extracts every key from the fixture into the dedup set (bare repo#PR, no org prefix)", () => {
    const parsed = parseLedger(FIXTURE_MD);
    expect(parsed.keys.has("asthetik-portal#50")).toBe(true);
    expect(parsed.keys.has("studiob-price-sync#50")).toBe(true);
    expect(parsed.keys.has("asthetik-trade-theme#4")).toBe(true);
    expect(parsed.keys.size).toBe(16);
    // Negative control: the org-qualified form must NOT be how keys are stored.
    expect(parsed.keys.has("studio-b-ai/bolt-wms#356")).toBe(false);
  });
});

// ───────────────────────────── isInternalByConstruction ─────────────────────────────

describe("isInternalByConstruction", () => {
  // Negative control first (Rule #322).
  it("does NOT exclude an ordinary feat PR", () => {
    expect(isInternalByConstruction(candidatePr({ title: "feat(theme): new PDP swatch strip" }))).toBe(false);
  });
  it("excludes chore(deps) dependency bumps", () => {
    expect(isInternalByConstruction(candidatePr({ title: "chore(deps): bump vitest from 2.1.0 to 2.1.1" }))).toBe(true);
  });
  it("excludes ci: prefixed titles", () => {
    expect(isInternalByConstruction(candidatePr({ title: "ci: add a required status check" }))).toBe(true);
  });
  it("excludes test: prefixed titles", () => {
    expect(isInternalByConstruction(candidatePr({ title: "test: cover the new webhook handler" }))).toBe(true);
  });
  it("excludes build: prefixed titles", () => {
    expect(isInternalByConstruction(candidatePr({ title: "build: pin node to 20.x" }))).toBe(true);
  });
  it("excludes a literal [machinery] tag anywhere in the title", () => {
    expect(isInternalByConstruction(candidatePr({ title: "rotate credential [machinery]" }))).toBe(true);
  });
  it("excludes a dependabot-authored PR regardless of title", () => {
    expect(isInternalByConstruction(candidatePr({ title: "Bump lodash from 4.17.20 to 4.17.21", author: "dependabot[bot]" }))).toBe(true);
  });
  it("excludes a renovate-authored PR", () => {
    expect(isInternalByConstruction(candidatePr({ author: "renovate[bot]" }))).toBe(true);
  });
  it("excludes when every changed file is under .github/", () => {
    expect(isInternalByConstruction(candidatePr({ title: "tighten the required checks", files: [".github/workflows/ci.yml"] }))).toBe(true);
  });
  it("excludes when every changed file is under a __tests__ directory", () => {
    expect(isInternalByConstruction(candidatePr({ title: "cover the new handler", files: ["src/lib/__tests__/foo.test.ts"] }))).toBe(true);
  });
  it("does NOT exclude on files when at least one file is outside .github/__tests__ (mixed diff)", () => {
    expect(isInternalByConstruction(candidatePr({ title: "add a feature with tests", files: ["src/feature.ts", "src/__tests__/feature.test.ts"] }))).toBe(false);
  });
  it("does NOT exclude on files when the file list is unavailable (undefined, not empty — missing data never counts as a match)", () => {
    expect(isInternalByConstruction(candidatePr({ title: "a real feature", files: undefined }))).toBe(false);
  });
});

// ───────────────────────────── classifyWithLabels ─────────────────────────────

describe("classifyWithLabels", () => {
  it("no signal when neither label is present (negative control)", () => {
    expect(classifyWithLabels(candidatePr({ labels: ["bug"] }))).toBeUndefined();
  });
  it("'human-visible' label wins to visible", () => {
    expect(classifyWithLabels(candidatePr({ labels: ["human-visible"] }))).toBe("visible");
  });
  it("'internal' label wins to internal", () => {
    expect(classifyWithLabels(candidatePr({ labels: ["internal"] }))).toBe("internal");
  });
  it("matches case-insensitively", () => {
    expect(classifyWithLabels(candidatePr({ labels: ["Human-Visible"] }))).toBe("visible");
  });
  it("a contradiction (both labels present) resolves to internal — the conservative default", () => {
    expect(classifyWithLabels(candidatePr({ labels: ["human-visible", "internal"] }))).toBe("internal");
  });
});

// ───────────────────────────── parseClassifierResponse ─────────────────────────────

describe("parseClassifierResponse", () => {
  // Negative control first (Rule #322): non-JSON prose.
  it("returns null for non-JSON prose", () => {
    expect(parseClassifierResponse("I think this PR is probably visible to customers.")).toBeNull();
  });
  it("parses a clean visible response", () => {
    const got = parseClassifierResponse(
      '{"visible": true, "audience": "TRADE", "surface": "Checkout", "sentence": "Trade customers can now save a note on their order."}',
    );
    expect(got).toEqual({ visible: true, audience: "TRADE", surface: "Checkout", sentence: "Trade customers can now save a note on their order." });
  });
  it("parses a clean internal response", () => {
    expect(parseClassifierResponse('{"visible": false}')).toEqual({ visible: false });
  });
  it("tolerates a markdown code fence wrapped around the JSON", () => {
    expect(parseClassifierResponse('```json\n{"visible": false}\n```')).toEqual({ visible: false });
  });
  it("rejects syntactically malformed JSON", () => {
    expect(parseClassifierResponse('{"visible": true, "audience": "TRADE"')).toBeNull();
  });
  it("rejects a bare JSON array (not an object)", () => {
    expect(parseClassifierResponse("[1,2,3]")).toBeNull();
  });
  it("rejects an audience outside the fixed TRADE/DTC/STAFF enum", () => {
    expect(parseClassifierResponse('{"visible": true, "audience": "B2B", "surface": "x", "sentence": "y"}')).toBeNull();
  });
  it("rejects a sentence over 200 chars", () => {
    const long = "x".repeat(201);
    expect(parseClassifierResponse(`{"visible": true, "audience": "STAFF", "surface": "x", "sentence": "${long}"}`)).toBeNull();
  });
  it("rejects a sentence containing a literal |", () => {
    expect(parseClassifierResponse('{"visible": true, "audience": "STAFF", "surface": "x", "sentence": "a | b"}')).toBeNull();
  });
  // codex review (2026-08-18, ops-pipeline#162 PR pass 1, P3): surface renders into the same
  // markdown tables sentence does — a literal | there is exactly as table-breaking.
  it("rejects a surface containing a literal |", () => {
    expect(parseClassifierResponse('{"visible": true, "audience": "STAFF", "surface": "PDP | checkout", "sentence": "y"}')).toBeNull();
  });
  it("rejects visible:true missing the required text fields", () => {
    expect(parseClassifierResponse('{"visible": true}')).toBeNull();
  });
});

// ───────────────────────────── formatLedgerLine + lintLedgerLine ─────────────────────────────

describe("lintLedgerLine", () => {
  // Negative control first: a well-formed line must pass clean.
  it("a well-formed rendered line passes clean", () => {
    expect(lintLedgerLine(formatLedgerLine(ledgerEntry()))).toEqual([]);
  });
  it("a REAL line copied verbatim from the ledger fixture passes clean", () => {
    const realLine =
      "- 2026-07-20 · **STAFF** · trade portal (staff sign-in) · Staff now sign into the portal using only their Microsoft work account — the old email-link login and a hidden admin-override login have been removed. · `asthetik-portal#50`";
    expect(lintLedgerLine(realLine)).toEqual([]);
  });
  it("fails on a missing backtick key", () => {
    const errors = lintLedgerLine(formatLedgerLine(ledgerEntry()).replace("`bolt-wms#9001`", "bolt-wms#9001"));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("key"))).toBe(true);
  });
  it("fails on a wrong-shape date", () => {
    const errors = lintLedgerLine(formatLedgerLine(ledgerEntry({ date: "26-08-19" })));
    expect(errors.some((e) => e.includes("date"))).toBe(true);
  });
  it("fails on a nonexistent calendar date", () => {
    const errors = lintLedgerLine(formatLedgerLine(ledgerEntry({ date: "2026-02-30" })));
    expect(errors.some((e) => e.includes("calendar date"))).toBe(true);
  });
  it("fails on a sentence over the 200-char cap", () => {
    const errors = lintLedgerLine(formatLedgerLine(ledgerEntry({ sentence: "x".repeat(201) })));
    expect(errors.some((e) => e.includes("200-char"))).toBe(true);
  });
  it("fails on a literal | in the sentence", () => {
    const errors = lintLedgerLine(formatLedgerLine(ledgerEntry({ sentence: "a | b" })));
    expect(errors.some((e) => e.includes("|"))).toBe(true);
  });
  // codex review (2026-08-18, ops-pipeline#162 PR pass 1, P3): mirrors the sentence-pipe case —
  // surface is a " · "-delimited table segment too.
  it("fails on a literal | in the surface", () => {
    const errors = lintLedgerLine(formatLedgerLine(ledgerEntry({ surface: "PDP | checkout" })));
    expect(errors.some((e) => e.includes("surface") && e.includes("|"))).toBe(true);
  });
  it("fails on an audience outside TRADE/DTC/STAFF", () => {
    const errors = lintLedgerLine("- 2026-08-19 · **VIP** · x · y · `bolt-wms#1`");
    expect(errors.some((e) => e.includes("audience"))).toBe(true);
  });
});

// ───────────────────────────── planAppends ─────────────────────────────

describe("planAppends", () => {
  it("a candidate whose key is already in the ledger is skipped, never appended (negative control)", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [ledgerEntry({ key: "asthetik-portal#50", date: "2026-07-20" })]);
    expect(plan.dedupSkipped).toEqual(["asthetik-portal#50"]);
    expect(plan.appendsBySection.size).toBe(0);
  });

  it("appends a genuinely new PR into its existing month section", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [ledgerEntry({ key: "bolt-wms#9001", date: "2026-07-25" })]);
    expect(plan.dedupSkipped).toEqual([]);
    expect(plan.appendsBySection.get("2026-07")).toHaveLength(1);
    expect(plan.appendsBySection.get("2026-07")?.[0]?.key).toBe("bolt-wms#9001");
  });

  it("creates a brand-new month section for a PR outside every existing month", () => {
    const parsed = parseLedger(FIXTURE_MD); // fixture only has 2026-07
    const plan = planAppends(parsed, [ledgerEntry({ key: "bolt-wms#9002", date: "2026-09-01" })]);
    expect(plan.appendsBySection.has("2026-09")).toBe(true);
    expect(plan.appendsBySection.get("2026-09")).toHaveLength(1);
  });

  it("sorts multiple new entries within a section ascending by date — newest at the bottom", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [
      ledgerEntry({ key: "bolt-wms#2", date: "2026-07-30" }),
      ledgerEntry({ key: "bolt-wms#1", date: "2026-07-22" }),
    ]);
    const keys = (plan.appendsBySection.get("2026-07") ?? []).map((e) => e.key);
    expect(keys).toEqual(["bolt-wms#1", "bolt-wms#2"]);
  });
});

// ───────────────────────────── lintPlan ─────────────────────────────

describe("lintPlan", () => {
  it("an empty plan lints clean (negative control)", () => {
    const parsed = parseLedger(FIXTURE_MD);
    expect(lintPlan(planAppends(parsed, []))).toEqual([]);
  });
  it("a well-formed candidate lints clean", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [ledgerEntry({ key: "bolt-wms#9001", date: "2026-07-25" })]);
    expect(lintPlan(plan)).toEqual([]);
  });
  it("surfaces a lint error prefixed with the offending key", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [ledgerEntry({ key: "bolt-wms#9001", date: "2026-07-25", sentence: "x".repeat(201) })]);
    const errors = lintPlan(plan);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("bolt-wms#9001");
  });
});

// ───────────────────────────── renderLedgerFile — Rule #263 (byte-identical existing lines) ─────────────────────────────

describe("renderLedgerFile", () => {
  it("reproduces every pre-existing line as its EXACT original string (Rule #263 — never reconstructed)", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [ledgerEntry({ key: "bolt-wms#9001", date: "2026-07-25" })]);
    const rendered = renderLedgerFile(parsed, plan);
    for (const line of parsed.sections.get("2026-07") ?? []) {
      expect(rendered).toContain(line);
    }
  });

  it("appends the new line at the BOTTOM of its month section, after every pre-existing line", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [
      ledgerEntry({ key: "bolt-wms#9001", date: "2026-07-25", surface: "Test surface", sentence: "Test sentence." }),
    ]);
    const rendered = renderLedgerFile(parsed, plan);
    const lastOriginal = (parsed.sections.get("2026-07") ?? []).at(-1) as string;
    expect(rendered.indexOf("`bolt-wms#9001`")).toBeGreaterThan(rendered.indexOf(lastOriginal));
  });

  it("round-trips: re-parsing the rendered output finds the new key and the section count grows by exactly 1", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [ledgerEntry({ key: "bolt-wms#9001", date: "2026-07-25" })]);
    const reparsed = parseLedger(renderLedgerFile(parsed, plan));
    expect(reparsed.keys.has("bolt-wms#9001")).toBe(true);
    expect(reparsed.sections.get("2026-07")).toHaveLength(17); // 16 original + 1 new
  });

  it("a plan with zero appends is a structural no-op — re-parsing yields the identical key set and section content", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const reparsed = parseLedger(renderLedgerFile(parsed, planAppends(parsed, [])));
    expect(reparsed.keys).toEqual(parsed.keys);
    expect(reparsed.sections.get("2026-07")).toEqual(parsed.sections.get("2026-07"));
  });

  it("creates a brand-new month section, correctly ordered after existing months", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [ledgerEntry({ key: "bolt-wms#9002", date: "2026-09-01" })]);
    const rendered = renderLedgerFile(parsed, plan);
    expect(rendered.indexOf("## 2026-07")).toBeLessThan(rendered.indexOf("## 2026-09"));
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false); // exactly one trailing newline, per the real file's convention
  });
});

// ───────────────────────────── renderDryRunTable ─────────────────────────────

describe("renderDryRunTable", () => {
  it("renders a 'none' row for an empty plan", () => {
    const parsed = parseLedger(FIXTURE_MD);
    expect(renderDryRunTable(planAppends(parsed, []))).toContain("none");
  });
  it("renders one row per planned entry, grouped in month order", () => {
    const parsed = parseLedger(FIXTURE_MD);
    const plan = planAppends(parsed, [
      ledgerEntry({ key: "bolt-wms#1", date: "2026-07-25", sentence: "First." }),
      ledgerEntry({ key: "bolt-wms#2", date: "2026-09-01", sentence: "Second." }),
    ]);
    const table = renderDryRunTable(plan);
    expect(table).toContain("bolt-wms#1");
    expect(table).toContain("bolt-wms#2");
    expect(table.indexOf("bolt-wms#1")).toBeLessThan(table.indexOf("bolt-wms#2"));
  });
});

// ───────────────────────────── classifyPr — orchestration precedence ─────────────────────────────

describe("classifyPr", () => {
  it("no classifier available (null) and nothing else resolves it -> unclassified, never guessed (negative control)", async () => {
    expect(await classifyPr(candidatePr(), null)).toEqual({ verdict: "unclassified", source: "no_classifier", entry: null });
  });

  it("the exclusion list short-circuits BEFORE any classify call, even when one is provided", async () => {
    let called = false;
    const classify = async () => {
      called = true;
      return '{"visible": true, "audience": "STAFF", "surface": "x", "sentence": "y"}';
    };
    const outcome = await classifyPr(candidatePr({ title: "chore(deps): bump x" }), classify);
    expect(outcome).toEqual({ verdict: "internal", source: "exclusion", entry: null });
    expect(called).toBe(false);
  });

  it("an 'internal' label short-circuits BEFORE any classify call", async () => {
    let called = false;
    const classify = async () => {
      called = true;
      return '{"visible": true, "audience": "STAFF", "surface": "x", "sentence": "y"}';
    };
    const outcome = await classifyPr(candidatePr({ labels: ["internal"] }), classify);
    expect(outcome).toEqual({ verdict: "internal", source: "label", entry: null });
    expect(called).toBe(false);
  });

  it("no label: the model's own visible:true verdict + fields build the entry, source='model'", async () => {
    const classify = async () => '{"visible": true, "audience": "DTC", "surface": "Homepage", "sentence": "The homepage hero now plays a video."}';
    const outcome = await classifyPr(candidatePr(), classify);
    expect(outcome).toEqual({
      verdict: "visible",
      source: "model",
      entry: { date: "2026-08-19", audience: "DTC", surface: "Homepage", sentence: "The homepage hero now plays a video.", key: "bolt-wms#9001" },
    });
  });

  it("no label: the model's own visible:false verdict is internal, source='model'", async () => {
    const outcome = await classifyPr(candidatePr(), async () => '{"visible": false}');
    expect(outcome).toEqual({ verdict: "internal", source: "model", entry: null });
  });

  it("'human-visible' label AND the model independently agreeing -> source='label' (label wins the source tag even on agreement)", async () => {
    const classify = async () => '{"visible": true, "audience": "TRADE", "surface": "Checkout", "sentence": "A trade customer can now do X."}';
    const outcome = await classifyPr(candidatePr({ labels: ["human-visible"] }), classify);
    expect(outcome).toEqual({
      verdict: "visible",
      source: "label",
      entry: { date: "2026-08-19", audience: "TRADE", surface: "Checkout", sentence: "A trade customer can now do X.", key: "bolt-wms#9001" },
    });
  });

  it("'human-visible' label overriding a model that (per its own instructions) returned bare {visible:false} with no text — no line can be built, so this is model_malformed, NEVER a guessed line", async () => {
    const outcome = await classifyPr(candidatePr({ labels: ["human-visible"] }), async () => '{"visible": false}');
    expect(outcome).toEqual({ verdict: "internal", source: "model_malformed", entry: null });
  });

  it("a throwing classify function is model_error, never a crash", async () => {
    const outcome = await classifyPr(
      candidatePr(),
      async () => {
        throw new Error("network blip");
      },
    );
    expect(outcome).toEqual({ verdict: "internal", source: "model_error", entry: null });
  });

  it("a malformed (non-JSON) model response is model_malformed, never a crash or a guessed line", async () => {
    const outcome = await classifyPr(candidatePr(), async () => "I am not sure, maybe?");
    expect(outcome).toEqual({ verdict: "internal", source: "model_malformed", entry: null });
  });
});

// ───────────────────────────── watermark ─────────────────────────────

describe("newestDateForRepo", () => {
  it("returns null for a repo with no ledgered lines (negative control — the fixture has no bolt-wms lines)", () => {
    expect(newestDateForRepo(parseLedger(FIXTURE_MD), "bolt-wms")).toBeNull();
  });
  it("returns the MAX date across that repo's ledgered lines", () => {
    const parsed = parseLedger(FIXTURE_MD);
    expect(newestDateForRepo(parsed, "studiob-price-sync")).toBe("2026-07-20");
    expect(newestDateForRepo(parsed, "asthetik-trade-theme")).toBe("2026-07-21"); // #1 is 07-20; #2/#3/#4 are 07-21
  });
});

describe("computeWatermark", () => {
  it("uses seed_cutoff minus overlap when no ledgered date exists for the repo", () => {
    const got = computeWatermark("2026-08-18T05:45:00Z", null, 7);
    expect(got).toBe(new Date(Date.parse("2026-08-18T05:45:00Z") - 7 * 86400000).toISOString());
  });
  it("uses the newest ledgered date (end of day) minus overlap when it is LATER than seed_cutoff", () => {
    const got = computeWatermark("2026-07-01T00:00:00Z", "2026-08-10", 7);
    expect(got).toBe(new Date(Date.parse("2026-08-10T23:59:59Z") - 7 * 86400000).toISOString());
  });
  it("seed_cutoff wins when it is LATER than the newest ledgered date (e.g. a repo just added to config)", () => {
    const got = computeWatermark("2026-08-18T05:45:00Z", "2026-07-01", 7);
    expect(got).toBe(new Date(Date.parse("2026-08-18T05:45:00Z") - 7 * 86400000).toISOString());
  });
  it("defaults the overlap to WATERMARK_OVERLAP_DAYS when omitted", () => {
    const got = computeWatermark("2026-08-18T05:45:00Z", null);
    expect(got).toBe(new Date(Date.parse("2026-08-18T05:45:00Z") - WATERMARK_OVERLAP_DAYS * 86400000).toISOString());
  });
});

// ───────────────────────────── isoWeekLabel / shortRepoName / ledgerKey / utcDateOf ─────────────────────────────

describe("isoWeekLabel", () => {
  // Both values independently verified against Python's `date(...).isocalendar()`.
  it("2026-08-18 -> 2026-W34", () => {
    expect(isoWeekLabel("2026-08-18T12:00:00Z")).toBe("2026-W34");
  });
  it("2026-08-11 -> 2026-W33", () => {
    expect(isoWeekLabel("2026-08-11T00:00:00Z")).toBe("2026-W33");
  });
});

describe("shortRepoName / ledgerKey / utcDateOf", () => {
  it("strips the org prefix", () => {
    expect(shortRepoName("studio-b-ai/bolt-wms")).toBe("bolt-wms");
  });
  it("passes a bare name through unchanged (negative control — no slash to strip)", () => {
    expect(shortRepoName("bolt-wms")).toBe("bolt-wms");
  });
  it("builds a bare repo#PR key", () => {
    expect(ledgerKey({ repo: "studio-b-ai/bolt-wms", number: 1856 })).toBe("bolt-wms#1856");
  });
  it("takes the UTC calendar date directly from an ISO timestamp", () => {
    expect(utcDateOf("2026-08-18T07:29:02Z")).toBe("2026-08-18");
  });
});

// ───────────────────────────── stats rendering ─────────────────────────────

describe("renderStatsTable / summarizeTotals", () => {
  it("renders a row per repo, naming every bucket including 0 (Rule #412)", () => {
    const table = renderStatsTable([repoRunStats()]);
    expect(table).toContain("bolt-wms");
    expect(table).toMatch(/\| 10 \| 3 \| 5 \| 2 \(0 malformed\)|10 \| 3 \| 5 \| 2/);
  });
  it("flags a read error visibly, never silently", () => {
    const table = renderStatsTable([
      repoRunStats({ repo: "studio-b-ai/amplify", read: 0, kept: 0, skippedDedup: 0, skippedInternal: 0, readError: "HTTP 403" }),
    ]);
    expect(table).toContain("403");
  });
  it("sums totals across every repo, including the read-error count", () => {
    const line = summarizeTotals([
      repoRunStats(),
      repoRunStats({ repo: "studio-b-ai/amplify", read: 0, kept: 0, skippedDedup: 0, skippedInternal: 0, readError: "HTTP 403" }),
    ]);
    expect(line).toContain("read=10");
    expect(line).toContain("kept=3");
    expect(line).toContain("read-errors=1");
  });
});

// ───────────────────────────── AUDIENCES ─────────────────────────────

describe("AUDIENCES", () => {
  it("is exactly TRADE/DTC/STAFF, in that order", () => {
    expect(AUDIENCES).toEqual(["TRADE", "DTC", "STAFF"]);
  });
});
