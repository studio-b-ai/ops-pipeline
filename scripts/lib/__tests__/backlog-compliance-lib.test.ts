import { describe, expect, it } from "vitest";
import {
  parseLanesRows,
  resolveBriefPath,
  unmatchedBriefKeys,
  parseStampLine,
  parseBacklogSection,
  evaluate,
  isCompliant,
  renderRollupBody,
  renderLaneBody,
  summaryLine,
  laneMarker,
  decodeContentsResponse,
  ROLLUP_MARKER,
  LABEL,
  COMPLIANCE_CHECKS,
  type ComplianceConfig,
  type LaneRow,
  type LaneComplianceResult,
} from "../backlog-compliance-lib.js";

// ───────────────────────────── fixtures ─────────────────────────────

function config(overrides: Partial<ComplianceConfig> = {}): ComplianceConfig {
  return {
    brain_repo: "studio-b-ai/brain",
    lanes_file: "LANES.md",
    per_lane_issues_from: "2026-08-21T12:00:00Z",
    manager_stamp_enforced_from: "2026-08-19T12:00:00Z",
    cos_stamp_enforced_from: "2026-08-22T12:00:00Z",
    lane_stamp_max_age_days: 7,
    manager_lag_max_hours: 48,
    cos_stamp_max_age_days: 7,
    briefs: {},
    skip: [],
    ...overrides,
  };
}

const NOW_EARLY = "2026-08-17T12:00:00Z"; // before every *_enforced_from date
const NOW_LATE = "2026-08-25T12:00:00Z"; // after every *_enforced_from date

// 6-row LANES.md fixture: SEAT (no manager) · PROJECT (with rule-15 manager) · TEMP ·
// ARCHIVED · TOMBSTONED · a row naming coldstarts/named-brief.md (also PROJECT, distinct from
// the managed row so brief-path resolution tests aren't entangled with manager tests).
const LANES_MD = [
  "# LANES — the live session registry",
  "",
  "| Lane (session title) | Owns | Holds on Kevin | Queued/unread |",
  "|---|---|---|---|",
  "| **TestSeat** (C-suite SEAT, PERMANENT; person = Kevin) | seat stuff | none | none |",
  "| **Pricing** (lane manager (rule 15): **CMO** — report UP to them, not the CoS) (PROJECT) | pricing stuff | none | none |",
  "| **Errand** (TEMP — one-shot, self-registered) | errand stuff | none | none |",
  "| **OldThing** (ARCHIVED 8/01 by Kevin's hand; absent from the active list) | done | none | none |",
  "| **DeadThing** (TOMBSTONED: no standing session; DEAD-ROW 2nd flag) | dead | none | none |",
  "| **NamedBrief** (PROJECT; re-entry `coldstarts/named-brief.md`) | brief stuff | none | none |",
  "| **DoneDone** (ARCHIVED-DONE — archived and swept) | swept | none | none |",
].join("\n");

const ROWS = parseLanesRows(LANES_MD);
function row(name: string): LaneRow {
  const r = ROWS.find((x) => x.name === name);
  if (!r) throw new Error(`fixture row not found: ${name}`);
  return r;
}

function lines(...ls: string[]): string {
  return ls.join("\n");
}

// ───────────────────────────── parseLanesRows ─────────────────────────────

describe("parseLanesRows", () => {
  it("parses exactly the 7 bold-name rows, skipping the title/blurb/header/divider lines", () => {
    expect(ROWS).toHaveLength(7);
    expect(ROWS.map((r) => r.name)).toEqual(["TestSeat", "Pricing", "Errand", "OldThing", "DeadThing", "NamedBrief", "DoneDone"]);
  });

  it("SEAT row: class SEAT, active, no manager", () => {
    const r = row("TestSeat");
    expect(r.class).toBe("SEAT");
    expect(r.active).toBe(true);
    expect(r.manager).toBeNull();
  });

  it("PROJECT row with a rule-15 manager tag: class PROJECT, manager parsed", () => {
    const r = row("Pricing");
    expect(r.class).toBe("PROJECT");
    expect(r.active).toBe(true);
    expect(r.manager).toBe("CMO");
  });

  it("PROJECT row with a MULTI-WORD rule-15 manager (real seats — \"Creative Director\", \"General Counsel\" — confirmed live in LANES.md 2026-08-17): manager captured whole, not truncated to its first word (codex pass-1 P1, ops-pipeline#151)", () => {
    const rows = parseLanesRows("| **Deep River** (lane manager (rule 15): **Creative Director** — report UP to them, not the CoS) (PROJECT) | a | b | c |");
    expect(rows[0].manager).toBe("Creative Director");
  });

  it("TEMP row: class TEMP, active, no manager", () => {
    const r = row("Errand");
    expect(r.class).toBe("TEMP");
    expect(r.active).toBe(true);
    expect(r.manager).toBeNull();
  });

  it("ARCHIVED row: class ARCHIVED, INACTIVE", () => {
    const r = row("OldThing");
    expect(r.class).toBe("ARCHIVED");
    expect(r.active).toBe(false);
  });

  it("TOMBSTONED row: class TOMBSTONED, INACTIVE", () => {
    const r = row("DeadThing");
    expect(r.class).toBe("TOMBSTONED");
    expect(r.active).toBe(false);
  });

  it("a row naming coldstarts/....md: briefPath captured from the row text", () => {
    const r = row("NamedBrief");
    expect(r.briefPath).toBe("coldstarts/named-brief.md");
    expect(r.class).toBe("PROJECT");
  });

  it("ARCHIVED-DONE normalizes to class ARCHIVED, INACTIVE (rule 10's ARCHIVED-DONE variant)", () => {
    const r = row("DoneDone");
    expect(r.class).toBe("ARCHIVED");
    expect(r.active).toBe(false);
  });

  it("unclassified row (no class token at all) defaults to PROJECT (LANES rule 10)", () => {
    const rows = parseLanesRows("| **Plain** (no class token here, just prose) | a | b | c |");
    expect(rows[0].class).toBe("PROJECT");
    expect(rows[0].active).toBe(true);
  });

  it("class = the FIRST token by POSITION, not by severity/priority ordering", () => {
    // "TEMP" appears before "ARCHIVED" in this cell's prose, even though the row narrates its
    // own later archival — Rule #4/#238: implement literally, don't infer intent.
    const rows = parseLanesRows("| **Foo** (TEMP — **ARCHIVED by Kevin** later in the same cell) | a | b | c |");
    expect(rows[0].class).toBe("TEMP");
    expect(rows[0].active).toBe(true);
  });

  it("does NOT parse the header row or the |---| divider as a lane row", () => {
    const rows = parseLanesRows(["| Lane (session title) | Owns | Holds | Queued |", "|---|---|---|---|"].join("\n"));
    expect(rows).toHaveLength(0);
  });

  it("briefPath regex also matches a library/backlogs/....md path named directly in row text", () => {
    const rows = parseLanesRows("| **DirectBacklog** (PROJECT; backlog file `library/backlogs/direct.md`) | a | b | c |");
    expect(rows[0].briefPath).toBe("library/backlogs/direct.md");
  });

  it("name capture stops at the FIRST closing ** (never runs past it into the row's other bold spans)", () => {
    const rows = parseLanesRows("| **Short Name** (PROJECT — **also bold** more text) | a | b | c |");
    expect(rows[0].name).toBe("Short Name");
  });
});

// ───────────────────────────── resolveBriefPath / unmatchedBriefKeys ─────────────────────────────

describe("resolveBriefPath — 3-rung precedence", () => {
  it("rung 1: a yaml briefs[] override wins even when the row ALSO names a path in its own text", () => {
    const r = row("NamedBrief"); // row.briefPath = coldstarts/named-brief.md
    const cfg = config({ briefs: { NamedBrief: "coldstarts/override-wins.md" } });
    expect(resolveBriefPath(r, cfg)).toBe("coldstarts/override-wins.md");
  });

  it("rung 2: row.briefPath used when there is no override", () => {
    const r = row("NamedBrief");
    expect(resolveBriefPath(r, config())).toBe("coldstarts/named-brief.md");
  });

  it("rung 3: library/backlogs/<slug>.md default when neither an override nor row text names a path", () => {
    const r = row("TestSeat");
    expect(resolveBriefPath(r, config())).toBe("library/backlogs/testseat.md");
  });

  it("slug: lowercases, collapses non-alnum runs to a single '-', trims leading/trailing '-'", () => {
    const rows = parseLanesRows("| **Ästhetik Image Studio!!** (PROJECT) | a | b | c |");
    // Leading/trailing non-alnum runs are stripped entirely (not left as a stray "-") — only
    // the interior separators survive as single "-"s. Verified against the real slugify().
    // "Ä" transliterates to "a" (issue #153 item 3 — NFD-normalize + strip combining marks
    // before the ASCII fold), never dropped as a bare non-alnum character.
    expect(resolveBriefPath(rows[0], config())).toBe("library/backlogs/asthetik-image-studio.md");
  });

  it("slug: transliterates diacritics rather than stripping them (issue #153 item 3, verbatim example — a real LANES row name)", () => {
    const rows = parseLanesRows("| **Ästhetik Target Universe** (PROJECT) | a | b | c |");
    expect(resolveBriefPath(rows[0], config())).toBe("library/backlogs/asthetik-target-universe.md");
  });
});

describe("unmatchedBriefKeys", () => {
  it("flags a briefs: key that matches no LANES row name", () => {
    const cfg = config({ briefs: { "Not A Row": "coldstarts/nope.md", Pricing: "coldstarts/pricing.md" } });
    expect(unmatchedBriefKeys(ROWS, cfg)).toEqual(["Not A Row"]);
  });

  it("does NOT flag a key that matches (byte-exact)", () => {
    const cfg = config({ briefs: { Pricing: "coldstarts/pricing.md" } });
    expect(unmatchedBriefKeys(ROWS, cfg)).toHaveLength(0);
  });

  it("NFD-decomposed row name vs NFC-composed briefs key are treated as the SAME name", () => {
    const source = "\u00C4sthetik Studio"; // one canonical (NFC) source literal
    const nfdName = source.normalize("NFD"); // "A" + combining diaeresis (2 codepoints)
    const nfcName = source.normalize("NFC"); // precomposed (1 codepoint) — equal to `source` itself here
    expect(nfdName).not.toBe(nfcName); // sanity: genuinely different byte sequences
    const rows: LaneRow[] = [{ name: nfdName, class: "PROJECT", active: true, manager: null, briefPath: null, raw: "" }];
    const cfg = config({ briefs: { [nfcName]: "coldstarts/asthetik.md" } });
    expect(unmatchedBriefKeys(rows, cfg)).toHaveLength(0);
    expect(resolveBriefPath(rows[0], cfg)).toBe("coldstarts/asthetik.md");
  });
});

// ───────────────────────────── parseStampLine ─────────────────────────────

describe("parseStampLine", () => {
  it("parses the canonical form: all four fields, · separated", () => {
    const s = parseStampLine("ranked-by: lane 2026-08-17T07:05Z · manager CTO 2026-08-17T07:40Z · cos — · kevin —");
    expect(s).toEqual({ lane: "2026-08-17T07:05Z", manager: { seat: "CTO", at: "2026-08-17T07:40Z" }, cos: null, kevin: null });
  });

  it("manager tri-state: '<seat> <ISO>' / '<seat> —' (unstamped) / '—' (no manager at all)", () => {
    expect(parseStampLine("ranked-by: lane 2026-08-17 · manager CTO 2026-08-17 · cos — · kevin —")!.manager).toEqual({
      seat: "CTO",
      at: "2026-08-17",
    });
    expect(parseStampLine("ranked-by: lane 2026-08-17 · manager CTO — · cos — · kevin —")!.manager).toEqual({ seat: "CTO", at: null });
    expect(parseStampLine("ranked-by: lane 2026-08-17 · manager — · cos — · kevin —")!.manager).toBeNull();
  });

  it("ISO stamps with seconds/milliseconds precision parse (real: pricing-lane-reentry.md's lane stamp is 2026-08-17T06:20:38Z — codex pass-1 P2, ops-pipeline#151)", () => {
    expect(parseStampLine("ranked-by: lane 2026-08-17T06:20:38Z · manager — · cos — · kevin —")!.lane).toBe("2026-08-17T06:20:38Z");
    expect(parseStampLine("ranked-by: lane 2026-08-17T06:20:38.123Z · manager — · cos — · kevin —")!.lane).toBe("2026-08-17T06:20:38.123Z");
  });

  it("manager MULTI-WORD seat ('Creative Director', 'General Counsel' — real, live 2026-08-17) stays intact, both stamped and unstamped (codex pass-1 P1, ops-pipeline#151)", () => {
    expect(parseStampLine("ranked-by: lane 2026-08-17 · manager Creative Director 2026-08-17 · cos — · kevin —")!.manager).toEqual({
      seat: "Creative Director",
      at: "2026-08-17",
    });
    expect(parseStampLine("ranked-by: lane 2026-08-17 · manager General Counsel — · cos — · kevin —")!.manager).toEqual({
      seat: "General Counsel",
      at: null,
    });
  });

  it("returns null when the line doesn't start 'ranked-by:' (even after stripping decoration)", () => {
    expect(parseStampLine("this is not a stamp line")).toBeNull();
  });

  it("returns null when lane is missing or unparseable — the one REQUIRED field", () => {
    expect(parseStampLine("ranked-by: manager CTO 2026-08-17 · cos — · kevin —")).toBeNull();
    expect(parseStampLine("ranked-by: lane not-a-date · manager — · cos — · kevin —")).toBeNull();
  });

  it("date-only ISO (no time) parses fine — freshness math anchors it at 00:00Z", () => {
    const s = parseStampLine("ranked-by: lane 2026-08-17 · manager — · cos 2026-08-16 · kevin —");
    expect(s!.lane).toBe("2026-08-17");
    expect(new Date(s!.lane).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("tolerates **bold**/`code` wrapping and a leading blockquote/bullet marker", () => {
    expect(parseStampLine("**ranked-by: lane 2026-08-17 · manager — · cos — · kevin —**")).toEqual({
      lane: "2026-08-17",
      manager: null,
      cos: null,
      kevin: null,
    });
    expect(parseStampLine("> `ranked-by: lane 2026-08-17 · manager — · cos — · kevin —`")).toEqual({
      lane: "2026-08-17",
      manager: null,
      cos: null,
      kevin: null,
    });
    expect(parseStampLine("- ranked-by: lane 2026-08-17 · manager — · cos — · kevin —")).toEqual({
      lane: "2026-08-17",
      manager: null,
      cos: null,
      kevin: null,
    });
  });

  it("accepts ·, |, and , interchangeably as the field separator", () => {
    const expected = { lane: "2026-08-17", manager: { seat: "CTO", at: "2026-08-17" }, cos: null, kevin: null };
    expect(parseStampLine("ranked-by: lane 2026-08-17 | manager CTO 2026-08-17 | cos — | kevin —")).toEqual(expected);
    expect(parseStampLine("ranked-by: lane 2026-08-17, manager CTO 2026-08-17, cos —, kevin —")).toEqual(expected);
  });

  it("unknown extra fields are parsed harmlessly and ignored", () => {
    const s = parseStampLine("ranked-by: lane 2026-08-17 · manager — · cos — · kevin — · extra something-else");
    expect(s!.lane).toBe("2026-08-17");
  });

  it("tolerates a trailing parenthetical annotation after the lane ISO — real Ästhetik Films line (fold 6a, ops-pipeline#151)", () => {
    const s = parseStampLine("ranked-by: lane 2026-08-17T06:25Z (last lane re-rank) · manager CD 2026-08-17T06:25Z · cos — · kevin —");
    expect(s).toEqual({ lane: "2026-08-17T06:25Z", manager: { seat: "CD", at: "2026-08-17T06:25Z" }, cos: null, kevin: null });
  });

  it("tolerates a NESTED parenthetical annotation after the lane ISO — real Deep River line (fold 6a, ops-pipeline#151)", () => {
    const s = parseStampLine(
      "ranked-by: lane 2026-08-17T06:42Z (17(g) ack restamp; last rank CHANGE 2026-08-16T20:35Z = item 20 added; ranks unchanged since) · manager CD 2026-08-17T06:25Z · cos — · kevin —",
    );
    expect(s).toEqual({ lane: "2026-08-17T06:42Z", manager: { seat: "CD", at: "2026-08-17T06:25Z" }, cos: null, kevin: null });
  });

  it("an UNBALANCED trailing paren (no closing ')') is left unchanged, so isIso correctly rejects it — garbage is never silently accepted (fold 6a)", () => {
    expect(parseStampLine("ranked-by: lane 2026-08-17T06:25Z (oops")).toBeNull();
  });

  it("a comma INSIDE the trailing parenthetical does not split the field early (codex pass 3 P2, ops-pipeline#151)", () => {
    const s = parseStampLine("ranked-by: lane 2026-08-17T06:25Z (last re-rank, ranks unchanged) · manager CD 2026-08-17T06:25Z · cos — · kevin —");
    expect(s).toEqual({ lane: "2026-08-17T06:25Z", manager: { seat: "CD", at: "2026-08-17T06:25Z" }, cos: null, kevin: null });
  });

  it("a comma inside a NESTED parenthetical also doesn't split early", () => {
    const s = parseStampLine("ranked-by: lane 2026-08-17T06:25Z (note (sub-note, with a comma) continues) · manager — · cos — · kevin —");
    expect(s!.lane).toBe("2026-08-17T06:25Z");
  });
});

// ───────────────────────────── parseStampLine — lane [<label>] <ISO> (issue #153 item 2) ─────────────────────────────

describe("parseStampLine — lane [<label>] <ISO> tolerates a leading label token before the ISO", () => {
  it("CMO (verbatim, coldstarts/cmo-seat-reentry.md): 'lane CMO <ISO>' — the label is ignored, the ISO is the LAST token", () => {
    const s = parseStampLine(
      "**ranked-by:** lane CMO 2026-08-17T06:23Z · manager CMO 2026-08-17T06:23Z (seat self-ranks; LANES rule 17(g)) · cos — · kevin —",
    );
    expect(s).toEqual({ lane: "2026-08-17T06:23Z", manager: { seat: "CMO", at: "2026-08-17T06:23Z" }, cos: null, kevin: null });
  });

  it("COO (verbatim, coldstarts/coo-seat-reentry.md): 'lane COO-seat <ISO>' — a hyphenated label", () => {
    const s = parseStampLine("ranked-by: lane COO-seat 2026-08-17T07:24:31Z · manager COO 2026-08-17T07:24:31Z · cos — · kevin —");
    expect(s).toEqual({ lane: "2026-08-17T07:24:31Z", manager: { seat: "COO", at: "2026-08-17T07:24:31Z" }, cos: null, kevin: null });
  });

  it("Creative Director (verbatim, coldstarts/2026-08-05-creative-director-seat.md): 'lane CD <ISO>', backtick-wrapped whole line", () => {
    const s = parseStampLine("`ranked-by: lane CD 2026-08-17T06:25Z · manager CD 2026-08-17T06:25Z · cos — · kevin —`");
    expect(s).toEqual({ lane: "2026-08-17T06:25Z", manager: { seat: "CD", at: "2026-08-17T06:25Z" }, cos: null, kevin: null });
  });

  it("plain 'lane <ISO>' (no label at all) keeps working — the last-whitespace-token rule is a no-op with only one token", () => {
    expect(parseStampLine("ranked-by: lane 2026-08-17T06:05Z · manager — · cos — · kevin —")!.lane).toBe("2026-08-17T06:05Z");
  });

  it("'lane foo' with no ISO anywhere is still unparseable — a label never rescues garbage", () => {
    expect(parseStampLine("ranked-by: lane foo · manager — · cos — · kevin —")).toBeNull();
  });

  it("a label followed by a near-miss (not a real ISO) still fails — not just a bare single word", () => {
    expect(parseStampLine("ranked-by: lane CMO not-a-date · manager — · cos — · kevin —")).toBeNull();
  });
});

// ───────────────────────────── parseBacklogSection ─────────────────────────────

describe("parseBacklogSection — heading + stamp detection", () => {
  it("found: false when no heading contains 'Backlog (ranked)'", () => {
    const section = parseBacklogSection(lines("# Some doc", "", "Nothing here."));
    expect(section.found).toBe(false);
    expect(section.headingLine).toBeNull();
  });

  it("matches any #-level heading whose text CONTAINS the phrase, not just an exact '## Backlog (ranked)'", () => {
    const section = parseBacklogSection(
      lines(
        "## 3. Backlog (ranked) — LANES rule 17 (Kevin word); RE-PULL AT BOOT",
        "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      ),
    );
    expect(section.found).toBe(true);
    expect(section.headingLine).toContain("Backlog (ranked)");
  });

  it("section ends at the next SAME-OR-SHALLOWER heading; a deeper sub-heading (### under ##) stays IN the section", () => {
    const md = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —", // 2
      "", // 3
      "### Notes", // 4 — deeper heading, must stay inside
      "1. item under the sub-heading — owner CTO · by 2026-08-20", // 5
      "", // 6
      "## Next section", // 7 — same-level heading, ends the section
      "1. NOT in the backlog section — owner X · by 2026-08-21", // 8
    );
    const section = parseBacklogSection(md);
    expect(section.items).toHaveLength(1);
    expect(section.items[0].line).toBe(5);
  });

  it("stamp search looks within the next 6 non-blank lines, not just the literal first line — tolerates an intro paragraph before it", () => {
    const md = lines(
      "## Backlog (ranked)", // 1
      "Grammar note: this section is ranked lane -> manager -> cos -> kevin.", // 2 (non-blank #1)
      "Cross-repo items are filed in their own repo and mirrored here.", // 3 (non-blank #2)
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —", // 4 (non-blank #3) — the stamp
      "", // 5
      "1. real item — owner CTO · by 2026-08-20", // 6
    );
    const section = parseBacklogSection(md);
    expect(section.stamp).toEqual({ lane: "2026-08-17", manager: null, cos: null, kevin: null });
    expect(section.stampLine).toContain("ranked-by:");
    // the two intro prose lines are neither items nor the stamp — simply not counted
    expect(section.items).toHaveLength(1);
  });

  it("gives up after 6 non-blank lines with none matching — stamp null (P3 territory), but earlier real content is still scanned as items/headers", () => {
    const nonMatchingFiller = Array.from({ length: 6 }, (_, i) => `filler line ${i + 1}, not a stamp`);
    const md = lines("## Backlog (ranked)", ...nonMatchingFiller, "1. late item — owner CTO · by 2026-08-20");
    const section = parseBacklogSection(md);
    expect(section.stamp).toBeNull();
    expect(section.stampLine).toBeNull();
  });

  it("first non-blank line under the heading being real content (no stamp at all) is NOT swallowed — it's still scanned as a header/item", () => {
    const md = lines(
      "## Backlog (ranked)", // 1
      "**P1**", // 2 — this is real content, not a stamp attempt; must not be silently dropped
      "1. thing — owner CTO · by 2026-08-20", // 3
    );
    const section = parseBacklogSection(md);
    expect(section.stamp).toBeNull();
    expect(section.items).toHaveLength(1);
    expect(section.items[0].tier).toBe("P1"); // proves the P1 header line was actually processed, not skipped as a false stamp
  });

  it("emptyMarker: true when the literal '(empty — nothing ranked)' text appears in the body", () => {
    const section = parseBacklogSection(
      lines("## Backlog (ranked)", "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —", "", "(empty — nothing ranked)"),
    );
    expect(section.emptyMarker).toBe(true);
    expect(section.items).toHaveLength(0);
  });

  // fold 7c, ops-pipeline#151 — fixtures copied VERBATIM from the real briefs that surfaced the
  // two discovery bugs on the 2026-08-17 real-vault dry run (folds 7a/7b).

  it("Deep River (verbatim, coldstarts/2026-08-13-asthetik-rail-deep-river-lane-reentry.md lines ~115-129): the decoy '# §4 Next milestones (... `## Backlog (ranked)` just below ...)' heading is skipped — the REAL heading + stamp are found (fold 7a)", () => {
    const md = lines(
      "# §4 Next milestones (SUMMARY ONLY — the ranked backlog of record is `## Backlog (ranked)` just below; on conflict the backlog wins)",
      "- **Late Sept:** fire S8 (craft-school c3 landscape — the only queued",
      "  spike) · dealer-city overlay (needs dealer list by city) · draft the",
      "  one-page charter spec + rendering for Tier-2 pricing probes.",
      "- **Post-Oct-17 (the armed November sequence, order in program-doc",
      "  checklist):** Willetts → Parks/Menzies → Ozark (band now closed; standing",
      "  order \"call us first\") → Amtrak Special Moves (NYC boarding on 79/80;",
      "  invited-vs-public) → NCTM + City of HP → Tier-2 pricing probes →",
      "  Halloway call → book the April '27 charter.",
      "- **G1 (year-end):** 2 credible cars · charter contracted · Market-week",
      "  scenario selected · Special Moves answers.",
      "",
      "## Backlog (ranked) — LANES rule 17 (Kevin 8/16 ~4 PM ET: \"every lane and owner needs to do a better job of managing the backlog. things shouldn't be lost and should be ranked and prioritized to keep work moving forward. ask me when you need guidance\"). THE ONE backlog of record for this lane (vault-only lane, no repo → this section). Every item = owner · next action · date or \"unclocked (WHY)\"; the LANES row-38 NEXT annotation = #1. Re-rank at every touch and whenever a Kevin word lands; P0/P1 > 2 d or P2 > 14 d without movement → re-rank or escalate to the CD (my lane manager) with a rec. Dormant-by-design between milestones — a dormant lane still ranks its holds; sleeping-until-a-date is NOT a stall. Last re-rank: 2026-08-16 20:05Z (16:05 ET).",
      "",
      "`ranked-by: lane 2026-08-17T06:42Z (17(g) ack restamp; last rank CHANGE 2026-08-16T20:35Z = item 20 added; ranks unchanged since) · manager CD 2026-08-17T06:25Z · cos — · kevin —`",
    );
    const section = parseBacklogSection(md);
    expect(section.found).toBe(true);
    expect(section.headingLine).toMatch(/^## Backlog \(ranked\) — LANES rule 17/); // the REAL heading, not the "# §4" decoy
    expect(section.stamp).toEqual({ lane: "2026-08-17T06:42Z", manager: { seat: "CD", at: "2026-08-17T06:25Z" }, cos: null, kevin: null });
  });

  it("Ästhetik Films (verbatim, coldstarts/asthetik-films-reentry.md lines ~281-293): a 10-line <!-- … --> note between the heading and the stamp doesn't exhaust the lookahead budget (fold 7b)", () => {
    const md = lines(
      "## Backlog (ranked)",
      "<!-- §5. THE ONE BACKLOG OF RECORD for this non-repo lane (LANES rule 17, Kevin's word",
      "     8/16: \"things shouldn't be lost and should be ranked and prioritized to keep work",
      "     moving forward. ask me when you need guidance\"). Every item = priority · owner ·",
      "     next action · date or \"unclocked (WHY)\". The LANES row's NEXT cell = item #1.",
      "     Manager (rule 15) = Creative Director, session local_60d49c0a-654b-4e2d-a941-d26c9697edc6;",
      "     census (open · P0/P1 · top-3 · stale · blocked-on-Kevin) goes to them.",
      "     Stale thresholds (rule 17d): P0/P1 > 2 days · P2 > 14 days without movement.",
      "     Nothing lost (17c): anything surfaced and not executed same-turn is FILED here",
      "     before the turn ends. Old \"§5 OPEN THREADS\" folded in 8/16 (its items 1 + 2 = the",
      "     closed receipts at the bottom). -->",
      "",
      "`ranked-by: lane 2026-08-17T06:25Z (last lane re-rank) · manager CD 2026-08-17T06:25Z · cos — · kevin —`",
    );
    const section = parseBacklogSection(md);
    expect(section.found).toBe(true);
    expect(section.headingLine).toBe("## Backlog (ranked)");
    expect(section.stamp).toEqual({ lane: "2026-08-17T06:25Z", manager: { seat: "CD", at: "2026-08-17T06:25Z" }, cos: null, kevin: null });
  });

  it("negative: a heading whose ONLY mention of the phrase is inside backticks is NOT a false hit — no section at all (fold 7a)", () => {
    const md = lines(
      "# §4 Next milestones (the ranked backlog of record is `## Backlog (ranked)` just below; on conflict the backlog wins)",
      "- some other content, no real section anywhere in this doc",
    );
    const section = parseBacklogSection(md);
    expect(section.found).toBe(false);
    expect(section.headingLine).toBeNull();
  });
});

describe("parseBacklogSection — item shape", () => {
  it("tier: inline P0-P3 on the item wins over an inherited header tier", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P1**",
      "1. **P3** overridden inline — owner CTO · by 2026-08-20",
    );
    expect(parseBacklogSection(md).items[0].tier).toBe("P3");
  });

  it("tier: inherited from the nearest preceding **P2 (roadmap)** header when no inline tier", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P2 (roadmap)**",
      "1. no inline tier here — owner CTO · unclocked (why: low priority)",
    );
    expect(parseBacklogSection(md).items[0].tier).toBe("P2");
  });

  it("tier header also recognized in the plain (non-bold) form 'P2 — roadmap'", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "P2 — roadmap",
      "1. thing — owner CTO · unclocked (why: reason)",
    );
    expect(parseBacklogSection(md).items[0].tier).toBe("P2");
  });

  it("tier: null when there's neither an inline tier nor any preceding header — a shape finding via evaluate()", () => {
    const md = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —", // 2
      "1. no tier anywhere — owner CTO · by 2026-08-20", // 3
    );
    const items = parseBacklogSection(md).items;
    expect(items[0].tier).toBeNull();
    expect(items[0].line).toBe(3);
  });

  it("item numbering: bare 'N.', lettered 'Nb.' (e.g. 12b.), '-' bullets, and '•' bullets all recognized", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P1**",
      "1. numbered — owner CTO · by 2026-08-20",
      "12b. lettered — owner CTO · by 2026-08-21",
      "- dashed — owner CTO · by 2026-08-22",
      "• bulleted — owner CTO · by 2026-08-23",
    );
    const items = parseBacklogSection(md).items;
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.tier === "P1")).toBe(true);
  });

  it("owner: the literal token 'owner' (any case) marks hasOwner true; absent = false", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P1**",
      "1. has it — Owner: CTO · by 2026-08-20",
      "2. missing it — next: do the thing · by 2026-08-21",
    );
    const items = parseBacklogSection(md).items;
    expect(items[0].hasOwner).toBe(true);
    expect(items[1].hasOwner).toBe(false);
  });

  it("clock: date-like tokens (ISO, M/D, weekday, wk N, by, >=, AM/PM) OR the literal 'unclocked'", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P1**",
      "1. iso — owner CTO · 2026-08-21",
      "2. md — owner CTO · 8/21",
      "3. weekday — owner CTO · Fri 8/21",
      "4. wk — owner CTO · wk 8/24",
      "5. by — owner CTO · by Tue 8/19",
      "6. gte — owner CTO · ≥ 8/24",
      "7. ampm — owner CTO · Mon 8 PM ET",
      "8. unclocked — owner CTO · unclocked (why: below P1/P2 clocks)",
      "9. neither — owner CTO · next: figure it out",
    );
    const items = parseBacklogSection(md).items;
    for (let i = 0; i <= 7; i++) expect(items[i].hasClock).toBe(true);
    expect(items[8].hasClock).toBe(false);
  });

  it("a bare tracker-handle-only item ('1. ops#129') has no owner and no clock — both buckets fail, satisfying the 'prose beyond the handle' requirement without a 4th bucket", () => {
    const md = lines("## Backlog (ranked)", "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —", "**P1**", "1. ops#129");
    const item = parseBacklogSection(md).items[0];
    expect(item.hasOwner).toBe(false);
    expect(item.hasClock).toBe(false);
  });

  it("struck-through items (~~...~~ wrapping the ENTIRE item text) are skipped — not counted, not flagged", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P1**",
      "1. ~~fully dead, no longer relevant~~",
      "2. real item — owner CTO · by 2026-08-20",
    );
    const items = parseBacklogSection(md).items;
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("real item");
  });

  it("a PARTIALLY struck item (strike wraps only part of the text, real content follows) is NOT skipped — the CTO-brief item-7 shape", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P2 (roadmap)**",
      "7. **~~ops#136 — old title~~** DONE, superseded by the new leg — owner CTO · by 2026-08-19",
    );
    const items = parseBacklogSection(md).items;
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe("P2");
    expect(items[0].hasOwner).toBe(true);
    expect(items[0].hasClock).toBe(true);
  });

  it("<details>...</details> blocks are skipped entirely, including bullets inside that would otherwise look like items", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P1**",
      "<details><summary>old stuff</summary>",
      "- old bullet with no owner or clock — must be ignored",
      "- another old one",
      "</details>",
      "1. the only real item — owner CTO · by 2026-08-20",
    );
    const section = parseBacklogSection(md);
    expect(section.items).toHaveLength(1);
    expect(section.items[0].text).toContain("the only real item");
  });

  it("a same-line <details>...</details> (open+close on one line) is skipped as a single line, never enters a stuck skip-state", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "**P1**",
      "<details><summary>x</summary>inline</details>",
      "1. after — owner CTO · by 2026-08-20",
    );
    expect(parseBacklogSection(md).items).toHaveLength(1);
  });
});

// ───────────────────────────── parseBacklogSection — table-row items (issue #153 item 1) ─────────────────────────────
//
// Three real lanes wrote their ranked backlog as a markdown TABLE (P/tier/priority + owner as
// COLUMNS) instead of numbered/bulleted lines — before this fix every one of them read as a
// false "0 item(s) — no items and no marker" (S1). Fixtures below are copied VERBATIM
// (`sed -n` on the vault paths, read-only) from the real briefs that surfaced this gap.

describe("parseBacklogSection — table-row items (issue #153 item 1)", () => {
  it("Pricing (verbatim, coldstarts/pricing-lane-reentry.md lines 112-128): no leading '#' column; tier-cell decoration ('**P1 · now**', 'P1 (clocked)') resolves; a `<!-- … -->` comment between the stamp and the table doesn't break table detection", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17T06:20:38Z · manager CFO 2026-08-17T05:50Z · cos — · kevin —",
      "",
      "<!-- LANES rule 17(g). Section inserted by the CFO (rule-15 manager) 8/17 05:50Z while Pricing's inbound queue was wedged; Pricing re-ranked + restamped `lane` 06:20Z (same sitting). The \"Queue\" list below carries the detail; this table is the ranked backlog of record. Order = clock first (rule 18): the DTC watch fires 07:32Z, before Mon AM. -->",
      "",
      "| P | item (see Queue for detail) | owner | next action | date |",
      "|---|---|---|---|---|",
      "| **P1 · now** | 0 — bolt PR #1829 (`>=` fix, #1828): merge on CI green (JSON-bucket gate) → deploy SUCCESS → live probe `portal-today-price-probe.mts` → 40071 STANDARD = 15.95 → receipt to CFO/CoS/CMO/Shopify | Pricing | in flight | 8/17 |",
      "| P1 | 6a — DTC RETAIL WATCH: 07:40Z storefront still 5995/6995 (old MSRPs); RESOLVED direction = the sanctioned nightly integrity leg writes base←MSRP (rows-before-bases, one cap) — CoS ruling pending (default let it run); still stale after the 8/18 07:23Z run → hand to Shopify lane | Pricing | 8/18 AM re-probe | 8/18 |",
      "| P1 | 1 — Cheyenne EXCLUSIVE→N flip + G3 re-fire, close #1737/#1775 | Pricing | Mon AM | 8/17 |",
      "| P1 | 6b — DIRECT `syncSalesPrices` pass for the 588 after 00:00Z 8/18 (Dakota rows ride along) + one-night `SHOPIFY_PRICE_INTEGRITY_MAX_FIXES` raise (Shopify env via CoS); then G3 03:40Z + price-sync 07:23Z receipts | Pricing | 00:0xZ 8/18 dry → fire | 8/18 |",
      "| P1 | 2 — joint CFO+Pricing grid-AXES proposal (construction × base cloth) | Pricing + CFO | Tue night | 8/18 |",
      "| P1 | 3 — ACCOUNT × PATTERN review build + WS-* classes + inert TARGETRAIL spec (Kevin gate: nothing promotes for 1/1 before his read) | Pricing (+CFO volume/$ side) | Wed build → Kevin Thu/Fri | 8/19 |",
      "| P1 | 4 — RESELLER segment + rail in the segment→catalog map v1 · MAP-letter mechanics · House Fabric first case | Pricing | with the map | 8/18 |",
      "| P2 | 5 — Warren/Parkhill R&T MAP enforcement · #362 MSRP set · #321 sweep sequencing · CFO holds c/d | Pricing | after 3 | 8/21 |",
      "| P1 (clocked) | 6 — 9/1 trade level-up first cron (REPORT-ONLY) → present the \"arm 10/1?\" fork with the report | Pricing | 9/1 14:00Z | 9/1 |",
      "| P2/P3 | 7 — follow-ups bolt#1752 · #1736 · #1763 · #1775 · #1807 (repo P-labels are the trackers) | Pricing | rolling | — |",
    );
    const section = parseBacklogSection(md);
    expect(section.stamp).toEqual({ lane: "2026-08-17T06:20:38Z", manager: { seat: "CFO", at: "2026-08-17T05:50Z" }, cos: null, kevin: null });
    expect(section.items).toHaveLength(10);
    // item 9 (line 17, "7 — follow-ups …") has a literal "—" date cell, not a real date/"unclocked
    // (why)" — codex review (ops-pipeline#151 follow-up, issue #153): a dash placeholder is
    // "unassigned", not "present" (same UNSTAMPED_RE semantics the tier cell already had). Every
    // OTHER row keeps both.
    expect(section.items.every((i, idx) => i.hasOwner && (i.hasClock || idx === 9))).toBe(true);
    expect(section.items[9].hasClock).toBe(false);
    expect(section.items[0].tier).toBe("P1"); // from "**P1 · now**"
    expect(section.items[0].text).toContain("bolt PR #1829");
    expect(section.items[8].tier).toBe("P1"); // from "P1 (clocked)"
    expect(section.items[8].text).toContain("trade level-up");

    // end-to-end: fully shaped table -> zero shape/presence/freshness FAILURES except the one
    // genuine dash-date row above (only the not-yet-enforced F3 "cos" pending finding otherwise
    // survives) — "S1 only where cells are genuinely empty [or dash-placeholder]" (issue #153).
    const findings = evaluate(row("TestSeat"), { exists: true, text: md }, config(), NOW_EARLY);
    expect(findings.filter((f) => f.status === "failed")).toEqual([{ check: "S1", text: "1 item(s) missing: clock[17]", status: "failed" }]);
  });

  it("CFO (verbatim, coldstarts/2026-08-05-cfo-seat.md lines 145-157): leading '#' row-number column; the merged/struck '0d' row (tier '—' + item cell starting '(') is SKIPPED, not a finding", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17T05:45Z · manager CFO 2026-08-17T05:45Z · cos — · kevin —",
      "",
      "<!-- LANES rule 17(g): git-tracked ranked backlog (born 8/16 ~20:15Z; refresh every tick; NEXT cell of the LANES row = #1; the seat is its own lane and its own manager) -->",
      "",
      "Priority law: **P0** live money/customer/outage · **P1** dated commitment or Kevin word in flight · **P2** roadmap · **P3** hygiene. Every item = owner · next action · date or \"unclocked (why)\". Blocked-on-Kevin items are ASKED, not parked.",
      "",
      "| # | P | item | owner | next action | date |",
      "|---|---|---|---|---|---|",
      "| 0a | P1 | **ACCOUNT × PATTERN INCREASE REVIEW** (Kevin 8/16: per account per pattern current → 1/1 price · % · $ on T12M · account total, worst-first; nothing promotes / no letters until he reads) — build with Pricing | CFO + Pricing | data join Mon–Tue; sheet with grid v1 Wed 8/19 → Kevin Thu/Fri | **8/19** |",
      "| 0b | P1 | **GRID AXES proposal (construction × base cloth × content × GSM)** — joint with Pricing before the Wed build; BASE/GROUND attribute = CD mint | CFO + Pricing (+CD) | draft Tue 8/18 night | **8/18** |",
      "| 0c | P1 | **Print/dye (Express) program — CFO PLANNING leg (Kevin 8/17 ~04:2xZ: \"the dyeing machine is a big part of that, too… I'm ok to work on this now. it just doesn't have to be executed until we're ready\" → PLANNING NOW, execution on his \"ready\"; canon `library/decisions/2026-08-17-print-program-two-lanes-drop-plus-express-capability.md`):** (1) capex-vs-toll frame for TWO machines — Epson ML-8000 (COO dealer RFQ) + one-bolt HT lab dye jet + dye kitchen + dryer/heat-set — vs toll print (ADT ~$50 strike-off, 50-yd min, ~2 wk) + a Carolina commission dye house; payback by expressions/yr; failure modes (utilization · shade rejects · effluent/permitting · operator) · (2) WHITE-POOL working-capital frame (white pool must be SMALLER than the finished-color pile it replaces; before = EXIT $243.1K + KEEP $93.6K; cotton 220 first) · (3) cost layers for base-white + expression items (white + print/dye conversion + finishing + labor) = the floor for Pricing's express rails · INPUTS on disk: COO's `library/product/2026-08-17-one-bolt-dye-capability-decision-sheet.md` (bridge = NC State ZTE pilot plant 45–100 kg + Metro Dyeing NY per-lot; machine class 40–60 kg HT soft-flow jet — quotes only; lab kit · finishing · utilities · POTW/effluent permitting; the two deciding ratios = lots/mo × per-lot bridge cost vs amortized owned line + operator, and sell-before-dye WC release vs today's solid-color inventory; D1 rec = bridge at ZTE first) + the ML-8000 shortlist; plus the earlier print-economics leg (upfront yards/color from PO history; margins by ground; grid rows) | CFO (CD owns strategy; COO owns RFQs) | frames on a sibling `library/finance/` doc; Thu 8/20 with the print brief if RFQ inputs allow, else the honest date | **8/20 (frames)** |",
      "| 0d | — | (merged into 0c: the ML-8000 capex model is the print half of the two-machine frame) | | | |",
    );
    const section = parseBacklogSection(md);
    expect(section.items).toHaveLength(3); // 0a, 0b, 0c — NOT 0d
    expect(section.items.map((i) => i.tier)).toEqual(["P1", "P1", "P1"]);
    expect(section.items.some((i) => i.text.includes("merged into 0c"))).toBe(false);

    const findings = evaluate(row("TestSeat"), { exists: true, text: md }, config(), NOW_EARLY);
    expect(findings.filter((f) => f.status === "failed")).toEqual([]);
  });

  it("HubSpot Platform (verbatim, coldstarts/hubspot-platform-reentry.md lines 26-34): a '#' cell carrying extra annotation ('1 `next`') is not mistaken for the tier cell", () => {
    const md = lines(
      "## Backlog (ranked) — LANES rule 17 · labels: P0 live customer/money/outage · P1 dated commitment or Kevin word in flight · P2 roadmap · P3 hygiene",
      "**ranked-by:** lane 2026-08-17T04:55Z · manager CMO 2026-08-17T06:23Z (reviewed at tick — ACCEPTED as-is; notes: #23 stays wk-of-8/17 pending the lead-capture sitting · #26a rides Kevin's ruled string · #6 + R2–R9 Kevin-class on the CoS board) · cos — · kevin —",
      "(Rule 17(g), Kevin 8/17 ~02:20 ET: git-tracked ranked backlog, ranked lane → manager → CoS → Kevin. Lane restamps at every ranking sitting + /wrap; DONE rows keep their receipt one wake, then move to the design docs' execution logs.)",
      "Every row: **owner · next action · date or \"unclocked (why)\"**. `next` = #1 (exactly one). Blocked-on-Kevin rows carry the staged ask verbatim.",
      "",
      "| # | P | Item | Owner | Next action | Date |",
      "|---|---|---|---|---|---|",
      "| 1 `next` | P1 | **Phase-1 B1 live canary** — prove key-first UPDATE-not-CREATE on the first sync pass with customers>0 (Monitor `bigp1xcal` fires; else check Mon AM) | lane | read the pass; assert no NEW company for an existing key + `acumatica_last_synced` advanced on the keyed row (C000079 → merged id 57535183234) | Mon 8/17 AM (natural traffic) |",
      "| 2 | P1 | **Phase-1 B2 — merge the remaining 73 dup groups / 86 rows** (plan v2 `scratchpad/phase1/dedup-plan-v2.json` regenerated post-B3 — REGENERATE again at B2 time: the 4 V-groups now key on `acumatica_vendor_id`; scratchpad dies at boot) | lane | after #1: dry-run diff → 5-group batch → all; verify 1,066 C-keys ↔ 1,066 companies (+24 V-rows → 20 after V-group merges); log every merge (old ids → new id) | Mon 8/17 (gated on #1) |",
    );
    const section = parseBacklogSection(md);
    expect(section.stamp).toEqual({ lane: "2026-08-17T04:55Z", manager: { seat: "CMO", at: "2026-08-17T06:23Z" }, cos: null, kevin: null });
    expect(section.items).toHaveLength(2);
    expect(section.items[0].tier).toBe("P1");
    expect(section.items[0].text).toContain("Phase-1 B1 live canary");
    expect(section.items[0].hasOwner).toBe(true); // owner cell = "lane", non-empty

    const findings = evaluate(row("TestSeat"), { exists: true, text: md }, config(), NOW_EARLY);
    expect(findings.filter((f) => f.status === "failed")).toEqual([]);
  });

  it("a table whose header has NO 'owner'-named column at all is not recognized as an item table — 0 items, whole-section S1 (never a per-row guess)", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17T07:20Z · manager — · cos — · kevin —",
      "",
      "| P | item | date |",
      "|---|---|---|",
      "| P1 | something real | 8/19 |",
    );
    expect(parseBacklogSection(md).items).toHaveLength(0);
    const findings = evaluate(row("TestSeat"), { exists: true, text: md }, config(), NOW_EARLY);
    expect(findings.filter((f) => f.check === "S1")).toEqual([
      { check: "S1", text: '0 item(s) — no items and no "(empty — nothing ranked)" marker', status: "failed" },
    ]);
  });

  it("a table WITH an owner column whose per-row cells are blank (and no fallback 'owner' token anywhere in the row) flags EACH row under S1 — one finding, every offending line cited", () => {
    const md = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17T07:20Z · manager — · cos — · kevin —", // 2
      "", // 3
      "| P | item | owner | date |", // 4
      "|---|---|---|---|", // 5
      "| P1 | thing one, no assignee named | | 8/19 |", // 6
      "| P1 | thing two, still nobody named | | 8/20 |", // 7
    );
    const section = parseBacklogSection(md);
    expect(section.items).toHaveLength(2);
    expect(section.items.every((i) => !i.hasOwner)).toBe(true);
    const findings = evaluate(row("TestSeat"), { exists: true, text: md }, config(), NOW_EARLY);
    expect(findings.filter((f) => f.check === "S1")).toEqual([{ check: "S1", text: "2 item(s) missing: owner[6,7]", status: "failed" }]);
  });

  it("a table WITH an owner/date column whose per-row cells hold dash placeholders ('—'/'-', not blank) ALSO flags EACH row under S1 — dash means unassigned, not present (codex review, ops-pipeline#151 follow-up)", () => {
    const md = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17T07:20Z · manager — · cos — · kevin —", // 2
      "", // 3
      "| P | item | owner | date |", // 4
      "|---|---|---|---|", // 5
      "| P1 | thing one, dash placeholders both cells | — | — |", // 6
      "| P1 | thing two, single-hyphen placeholders | - | - |", // 7
    );
    const section = parseBacklogSection(md);
    expect(section.items).toHaveLength(2);
    expect(section.items.every((i) => !i.hasOwner && !i.hasClock)).toBe(true);
    const findings = evaluate(row("TestSeat"), { exists: true, text: md }, config(), NOW_EARLY);
    expect(findings.filter((f) => f.check === "S1")).toEqual([
      { check: "S1", text: "2 item(s) missing: owner[6,7] clock[6,7]", status: "failed" },
    ]);
  });

  it("a table row's dash-only owner cell still resolves true via the whole-row fallback when a real 'owner X' token sits elsewhere in the row", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17T07:20Z · manager — · cos — · kevin —",
      "",
      "| P | item | owner | date |",
      "|---|---|---|---|",
      "| P1 | something real (owner CFO, chasing Tue) | — | 8/19 |",
    );
    const section = parseBacklogSection(md);
    expect(section.items).toHaveLength(1);
    expect(section.items[0].hasOwner).toBe(true); // dash cell, but "owner CFO" fallback-matches over the whole row
  });

  it("a merged/struck row's fallback ISN'T triggered just by an empty tier cell alone — only tier-empty AND item-starts-with-'(' together skip it", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17T07:20Z · manager — · cos — · kevin —",
      "",
      "| P | item | owner | date |",
      "|---|---|---|---|",
      "| — | not a merge note, just missing its tier | CTO | 8/19 |",
    );
    const items = parseBacklogSection(md).items;
    expect(items).toHaveLength(1); // NOT skipped — the item cell doesn't start with "("
    expect(items[0].tier).toBeNull(); // still correctly flagged as tier-less
  });

  it("a section may mix a table block and plain bulleted/numbered items — issue #153 item 1: 'Bulleted/numbered items keep working; a section may mix both'", () => {
    const md = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17 · manager — · cos — · kevin —",
      "",
      "| P | item | owner | date |",
      "|---|---|---|---|",
      "| P1 | table row | CTO | 2026-08-20 |",
      "",
      "**P2**",
      "1. a plain bulleted item after the table — owner CTO · by 2026-08-21",
    );
    const items = parseBacklogSection(md).items;
    expect(items).toHaveLength(2);
    expect(items[0].tier).toBe("P1");
    expect(items[0].text).toBe("table row");
    expect(items[1].tier).toBe("P2");
    expect(items[1].text).toContain("plain bulleted item");
  });
});

// ───────────────────────────── evaluate — both directions (Rule #322/#471) ─────────────────────────────

describe("evaluate — the fully compliant fixture (known-good, zero FAILED findings)", () => {
  const compliantBrief = lines(
    "# Pricing lane",
    "",
    "## Backlog (ranked)",
    "ranked-by: lane 2026-08-17T08:00Z · manager CMO 2026-08-17T09:00Z · cos 2026-08-16T20:00Z · kevin —",
    "",
    "**P1**",
    "1. **ops#1 — do the thing** — owner CMO · by 2026-08-20",
  );

  it("zero findings for the managed PROJECT row (Pricing/CMO)", () => {
    const findings = evaluate(row("Pricing"), { exists: true, text: compliantBrief }, config(), NOW_EARLY);
    expect(findings).toHaveLength(0);
  });

  it("zero findings for the SEAT row too (manager field content is irrelevant — SEAT rows are never F2-checked)", () => {
    const seatBrief = compliantBrief.replace("manager CMO 2026-08-17T09:00Z", "manager —");
    const findings = evaluate(row("TestSeat"), { exists: true, text: seatBrief }, config(), NOW_EARLY);
    expect(findings).toHaveLength(0);
  });
});

describe("evaluate — one fixture per finding class (known-bad, Rule #322/#471 both directions)", () => {
  it("P1 — brief does not exist", () => {
    const findings = evaluate(row("TestSeat"), { exists: false, text: "" }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "P1", text: 'no brief/backlog file — expected library/backlogs/testseat.md', status: "failed" }]);
  });

  it("P2 — brief exists but has no 'Backlog (ranked)' section", () => {
    const findings = evaluate(row("TestSeat"), { exists: true, text: "# Just a doc\n\nNothing here." }, config(), NOW_EARLY);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe("P2");
    expect(findings[0].text).toContain('no "## Backlog (ranked)" section in');
    expect(findings[0].status).toBe("failed");
  });

  it("P3 — section exists but the stamp is missing/unparseable (S1 STILL evaluated — P3 does not short-circuit shape)", () => {
    const brief = lines("## Backlog (ranked)", "**P1**", "1. real item — owner CTO · by 2026-08-20");
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toHaveLength(1); // P3 only — the item itself is fully shaped, so S1 doesn't ALSO fire
    expect(findings[0]).toEqual({ check: "P3", text: "stamp block missing/unparseable under the heading", status: "failed" });
  });

  it("F1 — lane stamp 9 days old (max 7)", () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-08T12:00Z · manager — · cos 2026-08-16T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CTO · by 2026-08-20",
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "F1", text: "lane stamp 2026-08-08T12:00Z is 9 d old (max 7)", status: "failed" }]);
  });

  it("F2 — manager stamp behind lane by 60h (max 48), enforced", () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-24T12:00Z · manager CMO 2026-08-22T00:00Z · cos 2026-08-24T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CMO · by 2026-08-26",
    );
    const findings = evaluate(row("Pricing"), { exists: true, text: brief }, config(), NOW_LATE);
    expect(findings).toEqual([{ check: "F2", text: "manager CMO stamp behind lane by 60 h (max 48)", status: "failed" }]);
  });

  it('F2 — manager "—" where required (rule-15 manager exists on the row), enforced', () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-24T12:00Z · manager — · cos 2026-08-24T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CMO · by 2026-08-26",
    );
    const findings = evaluate(row("Pricing"), { exists: true, text: brief }, config(), NOW_LATE);
    expect(findings).toEqual([{ check: "F2", text: 'manager stamp required (rule-15 manager = CMO) but "—"', status: "failed" }]);
  });

  it('F2 — manager seat NAMED but unstamped ("manager CMO —") is the SAME finding as bare "—"', () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-24T12:00Z · manager CMO — · cos 2026-08-24T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CMO · by 2026-08-26",
    );
    const findings = evaluate(row("Pricing"), { exists: true, text: brief }, config(), NOW_LATE);
    expect(findings).toEqual([{ check: "F2", text: 'manager stamp required (rule-15 manager = CMO) but "—"', status: "failed" }]);
  });

  it("F2 — a DIFFERENT seat than the row's rule-15 manager stamped it", () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-24T12:00Z · manager COO 2026-08-24T06:00Z · cos 2026-08-24T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CMO · by 2026-08-26",
    );
    const findings = evaluate(row("Pricing"), { exists: true, text: brief }, config(), NOW_LATE);
    expect(findings).toEqual([{ check: "F2", text: "manager stamp names COO, row names CMO", status: "failed" }]);
  });

  const creativeDirectorRow: LaneRow = {
    name: "Deep River",
    class: "PROJECT",
    active: true,
    manager: "Creative Director",
    briefPath: null,
    raw: "| **Deep River** (lane manager (rule 15): **Creative Director** — report UP to them, not the CoS) (PROJECT) | a | b | c |",
  };

  it('F2 — manager stamped the ABBREVIATION "CD" against a row naming "Creative Director" is NOT a mismatch (fold 6b, ops-pipeline#151, Rule #425)', () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-24T12:00Z · manager CD 2026-08-24T06:00Z · cos 2026-08-24T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CMO · by 2026-08-26",
    );
    const findings = evaluate(creativeDirectorRow, { exists: true, text: brief }, config(), NOW_LATE);
    expect(findings.filter((f) => f.check === "F2")).toEqual([]);
  });

  it('F2 — manager stamped "CFO" against a row naming "Creative Director" IS a real mismatch, alias or not (fold 6b)', () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-24T12:00Z · manager CFO 2026-08-24T06:00Z · cos 2026-08-24T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CMO · by 2026-08-26",
    );
    const findings = evaluate(creativeDirectorRow, { exists: true, text: brief }, config(), NOW_LATE);
    expect(findings).toEqual([{ check: "F2", text: "manager stamp names CFO, row names Creative Director", status: "failed" }]);
  });

  it("F2 pending — before manager_stamp_enforced_from, the same violation reports 'pending' not 'failed'", () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17T08:00Z · manager — · cos 2026-08-16T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CMO · by 2026-08-20",
    );
    const findings = evaluate(row("Pricing"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "F2", text: 'manager stamp required (rule-15 manager = CMO) but "—"', status: "pending" }]);
  });

  it("F3 — cos missing ('—'), enforced", () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-24T12:00Z · manager — · cos — · kevin —",
      "**P1**",
      "1. thing — owner CTO · by 2026-08-26",
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_LATE);
    expect(findings).toEqual([{ check: "F3", text: "cos stamp — older than 7 d", status: "failed" }]);
  });

  it("F3 — cos stamped but stale (an actual old ISO beyond the max age)", () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-24T12:00Z · manager — · cos 2026-08-10T00:00Z · kevin —",
      "**P1**",
      "1. thing — owner CTO · by 2026-08-26",
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_LATE);
    expect(findings).toEqual([{ check: "F3", text: "cos stamp 2026-08-10T00:00Z older than 7 d", status: "failed" }]);
  });

  it("F3 pending — before cos_stamp_enforced_from, reports 'pending'", () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17T08:00Z · manager — · cos — · kevin —",
      "**P1**",
      "1. thing — owner CTO · by 2026-08-20",
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "F3", text: "cos stamp — older than 7 d", status: "pending" }]);
  });

  it("S1 — item missing tier (no header, no inline)", () => {
    const brief = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17T08:00Z · manager — · cos 2026-08-16T00:00Z · kevin —", // 2
      "1. no tier — owner CTO · by 2026-08-20", // 3
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "S1", text: "1 item(s) missing: tier[3]", status: "failed" }]);
  });

  it("S1 — item missing owner", () => {
    const brief = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17T08:00Z · manager — · cos 2026-08-16T00:00Z · kevin —", // 2
      "**P1**", // 3
      "1. next: figure out who's on it — by 2026-08-20", // 4 (deliberately avoids the literal word "owner")
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "S1", text: "1 item(s) missing: owner[4]", status: "failed" }]);
  });

  it("S1 — item missing clock", () => {
    const brief = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17T08:00Z · manager — · cos 2026-08-16T00:00Z · kevin —", // 2
      "**P1**", // 3
      "1. no clock here — owner CTO", // 4
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "S1", text: "1 item(s) missing: clock[4]", status: "failed" }]);
  });

  it("S1 — a bare tracker-handle item is missing BOTH owner and clock (tier still inherited)", () => {
    const brief = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17T08:00Z · manager — · cos 2026-08-16T00:00Z · kevin —", // 2
      "**P1**", // 3
      "1. ops#129", // 4
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "S1", text: "1 item(s) missing: owner[4] clock[4]", status: "failed" }]);
  });

  it("S1 — zero items and no '(empty — nothing ranked)' marker", () => {
    const brief = lines("## Backlog (ranked)", "ranked-by: lane 2026-08-17T08:00Z · manager — · cos 2026-08-16T00:00Z · kevin —");
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toEqual([{ check: "S1", text: '0 item(s) — no items and no "(empty — nothing ranked)" marker', status: "failed" }]);
  });

  it("S1 — zero items WITH the explicit empty marker is compliant (no finding)", () => {
    const brief = lines(
      "## Backlog (ranked)",
      "ranked-by: lane 2026-08-17T08:00Z · manager — · cos 2026-08-16T00:00Z · kevin —",
      "(empty — nothing ranked)",
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toHaveLength(0);
  });

  it("S1 — multiple items missing different things bucket by line number under their own key", () => {
    const brief = lines(
      "## Backlog (ranked)", // 1
      "ranked-by: lane 2026-08-17T08:00Z · manager — · cos 2026-08-16T00:00Z · kevin —", // 2
      "**P1**", // 3
      "1. no assignee tag — by 2026-08-20", // 4 (deliberately avoids the literal word "owner")
      "2. missing clock only — owner CTO", // 5
      "3. missing both — bare text with no markers", // 6
    );
    const findings = evaluate(row("TestSeat"), { exists: true, text: brief }, config(), NOW_EARLY);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe("S1");
    expect(findings[0].text).toBe("3 item(s) missing: owner[4,6] clock[5,6]");
  });
});

// ───────────────────────────── isCompliant / render / summaryLine ─────────────────────────────

describe("isCompliant", () => {
  it("true when every finding is 'pending' (no FAILED findings)", () => {
    const result: LaneComplianceResult = {
      row: row("Pricing"),
      briefPath: "coldstarts/pricing.md",
      findings: [{ check: "F2", text: "…", status: "pending" }],
    };
    expect(isCompliant(result)).toBe(true);
  });

  it("false when any finding is 'failed'", () => {
    const result: LaneComplianceResult = {
      row: row("Pricing"),
      briefPath: "coldstarts/pricing.md",
      findings: [{ check: "F1", text: "…", status: "failed" }],
    };
    expect(isCompliant(result)).toBe(false);
  });
});

describe("renderRollupBody / renderLaneBody / laneMarker", () => {
  const clean: LaneComplianceResult = { row: row("TestSeat"), briefPath: "library/backlogs/testseat.md", findings: [] };
  const dirty: LaneComplianceResult = {
    row: row("Pricing"),
    briefPath: "coldstarts/pricing.md",
    findings: [{ check: "F1", text: "lane stamp … is 9 d old (max 7)", status: "failed" }],
  };

  it("rollup body carries the rollup marker, lists EVERY lane (clean and dirty), and links the design doc", () => {
    const body = renderRollupBody([clean, dirty], NOW_EARLY);
    expect(body.startsWith(ROLLUP_MARKER)).toBe(true);
    expect(body).toContain("TestSeat");
    expect(body).toContain("Pricing");
    expect(body).toContain("lane stamp");
    expect(body).toContain("backlog-compliance-leg-design.md");
  });

  it("lane body carries the per-lane marker (slugified name) and the findings table", () => {
    const body = renderLaneBody(dirty, NOW_EARLY);
    expect(body.startsWith(laneMarker("Pricing"))).toBe(true);
    expect(body).toContain("F1");
    expect(body).toContain("lane stamp");
  });

  it("a compliant lane's body says so explicitly rather than rendering an empty table", () => {
    const body = renderLaneBody(clean, NOW_EARLY);
    expect(body).toContain("compliant");
    expect(body).not.toContain("| Check | Status | Detail |");
  });

  it("laneMarker: names that slugify identically produce DIFFERENT markers (hash suffix), and the same name is stable across calls", () => {
    const a = laneMarker("Zoom Workspace");
    const b = laneMarker("Zoom-Workspace");
    expect(a).not.toBe(b);
    expect(laneMarker("Zoom Workspace")).toBe(a);
    expect(laneMarker("Zoom-Workspace")).toBe(b);
  });
});

describe("summaryLine", () => {
  it("counts lanes/active/compliant and buckets FAILED findings into presence/freshness/shape — pending findings never count", () => {
    const results: LaneComplianceResult[] = [
      { row: row("TestSeat"), briefPath: "x", findings: [] }, // compliant
      { row: row("Pricing"), briefPath: "y", findings: [{ check: "F1", text: "…", status: "failed" }] },
      { row: row("Errand"), briefPath: "z", findings: [{ check: "P2", text: "…", status: "failed" }] },
    ];
    const line = summaryLine(ROWS, results); // ROWS has 7 total, 4 active (3 inactive: OldThing, DeadThing, DoneDone)
    expect(line).toBe("[backlog-compliance] lanes=7 active=4 compliant=1 presence=1 freshness=1 shape=0");
  });

  it("a pending finding does not reduce the compliant count and does not add to any bucket", () => {
    const results: LaneComplianceResult[] = [{ row: row("Pricing"), briefPath: "y", findings: [{ check: "F3", text: "…", status: "pending" }] }];
    const line = summaryLine(ROWS, results);
    expect(line).toContain("compliant=1");
    expect(line).toContain("presence=0 freshness=0 shape=0");
  });
});

// ───────────────────────────── module-level sanity ─────────────────────────────

describe("exported constants", () => {
  it("LABEL is the fixed GitHub label name", () => {
    expect(LABEL).toBe("backlog-compliance");
  });

  it("COMPLIANCE_CHECKS names exactly the 7 documented checks", () => {
    expect([...COMPLIANCE_CHECKS].sort()).toEqual(["F1", "F2", "F3", "P1", "P2", "P3", "S1"].sort());
  });
});

describe("decodeContentsResponse", () => {
  it("decodes a well-formed file/base64 response", () => {
    const text = "## Backlog (ranked)\nhello";
    const json = JSON.stringify({ type: "file", encoding: "base64", size: text.length, content: Buffer.from(text, "utf-8").toString("base64") });
    expect(decodeContentsResponse(json, "coldstarts/x.md")).toBe(text);
  });

  it("throws — never silently mis-decodes — on a non-file type (e.g. a directory listing)", () => {
    const json = JSON.stringify({ type: "dir", encoding: "base64", size: 0, content: "" });
    expect(() => decodeContentsResponse(json, "coldstarts/x.md")).toThrow(/type=dir/);
  });

  it("throws on encoding !== base64 (e.g. an oversized file the API declines to inline)", () => {
    const json = JSON.stringify({ type: "file", encoding: "none", size: 999999, content: undefined });
    expect(() => decodeContentsResponse(json, "coldstarts/x.md")).toThrow(/encoding=none/);
  });

  it("throws on a missing/non-string content field", () => {
    const json = JSON.stringify({ type: "file", encoding: "base64", size: 12 });
    expect(() => decodeContentsResponse(json, "coldstarts/x.md")).toThrow(/coldstarts\/x\.md/);
  });

  it("the thrown message never contains the isNotFoundError substrings, so a shape mismatch can never be misread as an absent file", () => {
    const json = JSON.stringify({ type: "dir", encoding: "base64", size: 0, content: "" });
    try {
      decodeContentsResponse(json, "coldstarts/x.md");
      throw new Error("expected decodeContentsResponse to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("HTTP 404");
      expect(msg).not.toContain("Not Found");
    }
  });
});
