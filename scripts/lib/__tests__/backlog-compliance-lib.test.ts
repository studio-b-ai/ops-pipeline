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
    expect(resolveBriefPath(rows[0], config())).toBe("library/backlogs/sthetik-image-studio.md");
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
