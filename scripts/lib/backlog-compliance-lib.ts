/**
 * backlog-compliance-lib.ts — pure parse/evaluate/render logic for the backlog-compliance
 * worker (ops-pipeline#151, CTO seat, LANES rule 17(g)). Kevin verbatim (8/17 ~02:20 ET, via
 * CoS): "make sure you're enforcing all sessions to be keeping gittracked backlogs which are
 * first ranked and prioritized by the lane, then the manager, then the cos then kevin." Read
 * the design doc FIRST — this file implements it, it does not restate it:
 * `library/product/2026-08-17-backlog-compliance-leg-design.md` (brain repo). The design doc's
 * §1 grammar is the CANONICAL EXAMPLE, not the only accepted shape — the parser below is
 * deliberately TOLERANT (CoS refinement 2026-08-17, after 13 lanes wrote free-form sections in
 * the rollout's first hour): never force a lane to re-format to match the illustration exactly.
 *
 * Distinct instrument from backlog-staleness-lib.ts (which classifies GitHub issues against
 * per-manager staleness thresholds). This leg classifies `studio-b-ai/brain` LANES.md rows
 * against their OWN git-tracked ranked-backlog section — a lane's brief (`coldstarts/…md` or
 * `library/backlogs/<slug>.md`) must carry a `## Backlog (ranked)` section, a `ranked-by:`
 * stamp line (lane → manager → cos → kevin, in that order), and every item shaped with a
 * tier + owner + clock.
 *
 * Pure (no I/O, no network, no `new Date()`/`Date.now()` — "now" is always passed in as an
 * ISO string, mirrored from backlog-staleness-lib.ts's own contract). All `gh` calls, the
 * LANES.md / brief file reads (Contents API or `--brain-dir` local mode), and the committed-
 * YAML read live in backlog-compliance-worker.ts — this file only turns row text + brief text
 * into structured data, and structured data into findings + rendered issue bodies.
 *
 * ── Row parsing (`parseLanesRows`) ──
 * LANES.md rows are markdown table lines whose FIRST CELL starts `| **<Name>**`. "First cell"
 * = the text between the row's leading `|` and the next `|` — LANES.md treats a row whose
 * prose grows literal table-breaking `|` characters as a hygiene bug to fix at source (see the
 * vault's own "condensed to ~4 KB, table-breaking |T|/|C| pipes" note), not a shape this parser
 * needs to survive; a row that breaks this contract is a LANES.md data problem, not a parser
 * bug. Name = the bold text right after the leading `|` (`[^*]+` so it stops at the first
 * closing `**`, never runs past it — e.g. `**syncCrossReferences cap raise** (TEMP — …)`
 * correctly yields the name `syncCrossReferences cap raise`, not everything up to the last
 * `**` in the row).
 *
 * Class = the FIRST of SEAT|PROJECT|TEMP|ARCHIVED(-DONE)|TOMBSTONED to appear (by position) in
 * the first cell — literally first-by-position, not priority-ordered; a row whose prose reads
 * "(TEMP — **ARCHIVED by Kevin …**)" is class TEMP because that's the token that appears
 * first, even though the row narrates its own later archival. Getting a specific row's class
 * "semantically right" when its author didn't re-order the tokens is a LANES.md hygiene
 * question (rule 9's archive mechanics), not something this parser should second-guess —
 * Rule #4/#238: implement the stated algorithm faithfully, don't infer intent beyond it.
 * Unclassified = PROJECT (LANES rule 10, verbatim).
 *
 * ── Brief path resolution (`resolveBriefPath`) ──
 * Precedence (CoS refinement 2026-08-17, supersedes an earlier row-text-first draft):
 * `config.briefs[name]` (explicit human mapping) FIRST, THEN the row's own
 * `(coldstarts|library/backlogs)/….md` mention, THEN the `library/backlogs/<slug>.md`
 * default. Reason for yaml-first: a row can legitimately mention more than one such path
 * (e.g. a lane's row naming both its current brief and a predecessor it grew out of) — row
 * text alone cannot deterministically pick the right one, so an explicit override always wins
 * when present. `unmatchedBriefKeys` flags yaml keys that don't correspond to any real row
 * (Rule #412: a mapping nobody's row matches should never fail silently).
 *
 * ── Item shape (`parseBacklogSection`) ──
 * `next` is the item's own action text (rule 17(b)) — the design doc's §1 narrative says the
 * checker "requires the item to have prose beyond its tracker handle (a bare `ops#129` line is
 * a shape finding)," but §2's finding-TEXT-shape table only names three buckets
 * (`tier[i,j] owner[k] clock[l]`) — no separate "prose" bucket. This file resolves the tension
 * by NOT inventing a fourth bucket: a bare tracker-handle-only item structurally cannot contain
 * an `owner` token or a clock token either (there's no English text left to match), so it
 * already fails both of the two existing buckets — the "prose beyond the handle" requirement
 * falls out of the owner+clock checks for free. Covered by a dedicated test (a bare `ops#129`
 * item flags BOTH owner and clock) rather than a distinct check.
 *
 * ── Finding status values ──
 * "failed" (not "fail") deliberately, to stay clear of any accidental resemblance to a
 * Postgres enum literal in a codebase-wide lint's eyes — this module has nothing to do with
 * Postgres; "failed"/"pending" read naturally as plain English regardless.
 */

// ───────────────────────────── constants ─────────────────────────────

/** GitHub label name this leg's own issues (rollup + per-lane) carry. */
export const LABEL = "backlog-compliance";

/** Link every finding table + fix line back to the grammar (Rule #412: state the contract, don't just assert it). */
export const DESIGN_DOC_LINK = "library/product/2026-08-17-backlog-compliance-leg-design.md";

export const LANE_CLASSES = ["SEAT", "PROJECT", "TEMP", "ARCHIVED", "TOMBSTONED"] as const;
export type LaneClass = (typeof LANE_CLASSES)[number];

export const TIERS = ["P0", "P1", "P2", "P3"] as const;
export type Tier = (typeof TIERS)[number];

export const COMPLIANCE_CHECKS = ["P1", "P2", "P3", "F1", "F2", "F3", "S1"] as const;
export type ComplianceCheck = (typeof COMPLIANCE_CHECKS)[number];

const PRESENCE_CHECKS: readonly ComplianceCheck[] = ["P1", "P2", "P3"];
const FRESHNESS_CHECKS: readonly ComplianceCheck[] = ["F1", "F2", "F3"];
const SHAPE_CHECKS: readonly ComplianceCheck[] = ["S1"];

// ───────────────────────────── config shape (mirrors backlog-managers.yaml's compliance: block) ─────────────────────────────

export interface ComplianceConfig {
  brain_repo: string;
  lanes_file: string;
  per_lane_issues_from: string;
  manager_stamp_enforced_from: string;
  cos_stamp_enforced_from: string;
  lane_stamp_max_age_days: number;
  manager_lag_max_hours: number;
  cos_stamp_max_age_days: number;
  /** Row name -> brief path override. Keys and row names are compared NFC-normalized (see `unmatchedBriefKeys`). */
  briefs: Record<string, string>;
  /** Row names (exact) never checked, independent of class. */
  skip: string[];
}

// ───────────────────────────── row parsing ─────────────────────────────

export interface LaneRow {
  name: string;
  class: LaneClass;
  /** `class !== "ARCHIVED" && class !== "TOMBSTONED"`. */
  active: boolean;
  /** Rule-15 manager seat naming this row (`lane manager (rule 15): **<SEAT>**` in the first cell), or null (SEAT rows, unmanaged rows). */
  manager: string | null;
  /** First `(coldstarts|library/backlogs)/....md` path named anywhere in the row, or null. */
  briefPath: string | null;
  /** The full row line, verbatim — for render/debug only, never re-parsed. */
  raw: string;
}

const ROW_START_RE = /^\s*\|\s*\*\*([^*]+)\*\*/;
/** ARCHIVED-DONE must be tried before ARCHIVED in the alternation — both can start matching at
 * the same position, and regex alternation picks the first alternative that matches, so the
 * longer/more-specific form has to come first or it never gets a chance to win. */
const CLASS_TOKEN_RE = /\b(SEAT|PROJECT|TEMP|ARCHIVED-DONE|ARCHIVED|TOMBSTONED)\b/;
const MANAGER_RE = /lane manager \(rule 15\):\s*\*\*(\w+)\*\*/;
const BRIEF_PATH_RE = /(?:coldstarts|library\/backlogs)\/[\w\-./]+\.md/;

/** Text between the row's leading `|` and the next `|` (see module header re: table-breaking pipes). */
function firstCell(line: string): string {
  const parts = line.split("|");
  return parts.length > 1 ? parts[1] : "";
}

function classifyRow(cellText: string): LaneClass {
  const m = CLASS_TOKEN_RE.exec(cellText);
  if (!m) return "PROJECT"; // LANES rule 10: unclassified = PROJECT
  return m[1] === "ARCHIVED-DONE" ? "ARCHIVED" : (m[1] as LaneClass);
}

/**
 * Parses every LANES.md table row into a `LaneRow`. Lines that aren't rows (the header row,
 * the `|---|---|---|---|` divider, plain prose) simply don't match `ROW_START_RE` and are
 * skipped — no error, no finding; this function only ever describes rows that exist.
 */
export function parseLanesRows(md: string): LaneRow[] {
  const rows: LaneRow[] = [];
  for (const line of md.split("\n")) {
    const nameMatch = ROW_START_RE.exec(line);
    if (!nameMatch) continue;
    const cell = firstCell(line);
    const managerMatch = MANAGER_RE.exec(cell);
    const briefMatch = BRIEF_PATH_RE.exec(line); // whole row, not just the first cell
    const cls = classifyRow(cell);
    rows.push({
      name: nameMatch[1].trim(),
      class: cls,
      active: cls !== "ARCHIVED" && cls !== "TOMBSTONED",
      manager: managerMatch ? managerMatch[1] : null,
      briefPath: briefMatch ? briefMatch[0] : null,
      raw: line,
    });
  }
  return rows;
}

/** slug = lowercase name, non-alnum runs -> "-", trimmed of leading/trailing "-". */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function nfc(s: string): string {
  return s.normalize("NFC");
}

/** config.briefs[name] override -> row.briefPath -> the library/backlogs/<slug>.md default (see module header for the precedence rationale). */
export function resolveBriefPath(row: LaneRow, config: Pick<ComplianceConfig, "briefs">): string {
  const overrideKey = Object.keys(config.briefs).find((k) => nfc(k) === nfc(row.name));
  if (overrideKey) return config.briefs[overrideKey];
  if (row.briefPath) return row.briefPath;
  return `library/backlogs/${slugify(row.name)}.md`;
}

/** `config.briefs` keys that match no row's name (NFC-compared) — a WARN, never silent (Rule #412). */
export function unmatchedBriefKeys(rows: LaneRow[], config: Pick<ComplianceConfig, "briefs">): string[] {
  const rowNames = new Set(rows.map((r) => nfc(r.name)));
  return Object.keys(config.briefs).filter((k) => !rowNames.has(nfc(k)));
}

// ───────────────────────────── stamp parsing ─────────────────────────────

export interface StampManager {
  seat: string;
  /** ISO 8601, or null when the seat is named but not yet stamped (`manager <SEAT> —`). */
  at: string | null;
}

export interface Stamp {
  /** ISO 8601 — required. */
  lane: string;
  /** null when the field reads "—" (not yet stamped, or no rule-15 manager applies). */
  manager: StampManager | null;
  /** ISO 8601, or null when the field reads "—". */
  cos: string | null;
  /** ISO 8601, or null when the field reads "—". */
  kevin: string | null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}Z)?$/;
const UNSTAMPED_RE = /^[—-]+$/; // em dash (—) primarily; a bare "-"/"--" tolerated defensively

function isIso(s: string): boolean {
  return ISO_RE.test(s);
}

/**
 * Strips markdown decoration a stamp line may be wrapped in — CoS refinement 2026-08-17: lanes
 * wrote their stamp inside **bold**, `code`, a `> ` blockquote, or as a `-`/`•` bullet. Only a
 * LEADING blockquote/bullet marker is stripped (one level; the field content itself may
 * legitimately contain a literal "-" later in the line, e.g. a date), but `**`/backtick
 * wrapping is stripped everywhere since those are pure emphasis, never field content.
 */
function stripStampDecoration(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^[>\-•]+\s*/, "");
  s = s.replace(/\*\*/g, "").replace(/`/g, "");
  return s.trim();
}

function looksLikeRankedByLine(rawLine: string): boolean {
  return /^ranked-by:/.test(stripStampDecoration(rawLine));
}

/**
 * Parses one `ranked-by: lane <ISO> · manager <seat> <ISO>|<seat> —|— · cos <ISO>|— · kevin
 * <ISO>|—` line (tolerant of `**`/backtick/blockquote/bullet wrapping, and of `·`/`|`/`,` as
 * the field separator). Returns null when the (stripped) line doesn't start `ranked-by:`, or
 * `lane` is missing/unparseable (the one REQUIRED field — everything else may legitimately
 * read "—"). Unknown extra fields are parsed into nothing usable and silently ignored.
 */
export function parseStampLine(rawLine: string): Stamp | null {
  const trimmed = stripStampDecoration(rawLine);
  const prefixMatch = /^ranked-by:\s*(.*)$/.exec(trimmed);
  if (!prefixMatch) return null;

  const fields: Record<string, string> = {};
  for (const segment of prefixMatch[1].split(/[·|,]/).map((s) => s.trim()).filter(Boolean)) {
    const sp = segment.indexOf(" ");
    if (sp === -1) continue; // a bare key with no value — defensively ignored, not fatal
    const key = segment.slice(0, sp).trim().toLowerCase();
    const value = segment.slice(sp + 1).trim();
    fields[key] = value;
  }

  if (!fields.lane || !isIso(fields.lane)) return null;

  let manager: StampManager | null = null;
  if (fields.manager && !UNSTAMPED_RE.test(fields.manager)) {
    const sp = fields.manager.indexOf(" ");
    if (sp === -1) {
      manager = { seat: fields.manager.trim(), at: null }; // a bare seat name, nothing else — treat as named-but-unstamped
    } else {
      const seat = fields.manager.slice(0, sp).trim();
      const rest = fields.manager.slice(sp + 1).trim();
      if (UNSTAMPED_RE.test(rest)) manager = { seat, at: null };
      else if (isIso(rest)) manager = { seat, at: rest };
      // else: garbage after the seat name (neither "—" nor a valid ISO) — leave manager null;
      // an unparseable value is treated the same as absent, never trusted as-is.
    }
  }

  const cos = fields.cos && !UNSTAMPED_RE.test(fields.cos) && isIso(fields.cos) ? fields.cos : null;
  const kevin = fields.kevin && !UNSTAMPED_RE.test(fields.kevin) && isIso(fields.kevin) ? fields.kevin : null;

  return { lane: fields.lane, manager, cos, kevin };
}

// ───────────────────────────── item / section parsing ─────────────────────────────

export interface ParsedItem {
  /** 1-based absolute line number in the brief's full text — the "(line numbers)" the S1 finding text cites. */
  line: number;
  /** Item text after stripping the leading `N.`/`Nb.`/`-`/`•` marker. */
  text: string;
  tier: Tier | null;
  hasOwner: boolean;
  hasClock: boolean;
}

export interface ParsedSection {
  found: boolean;
  /** Raw text of the found `#…Backlog (ranked)…` heading line, or null when no such heading exists. */
  headingLine: string | null;
  stamp: Stamp | null;
  /** Raw text of the identified stamp line (whether or not it went on to parse), or null when no line within the lookahead window looked like a stamp attempt at all. */
  stampLine: string | null;
  items: ParsedItem[];
  /** Whether the literal `(empty — nothing ranked)` marker appears in the section body. */
  emptyMarker: boolean;
}

const HEADING_RE = /^(#{1,6})\s/;
const ITEM_START_RE = /^(\d+[a-z]?\.|[-•])\s+/;
const TIER_RE = /\bP([0-3])\b/;
const CLOCK_DATE_RE = new RegExp(
  [
    "\\d{4}-\\d{2}-\\d{2}", // 2026-08-21
    "\\b\\d{1,2}/\\d{1,2}\\b", // 8/21
    "\\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\b", // Fri 8/21
    "\\bwk \\d", // wk 8/24
    "\\bby \\b", // by Tue 8/19
    "≥ ?\\d", // ≥ 8/24
    "\\d{1,2}(:\\d{2})? ?(AM|PM)", // Mon 8 PM ET
  ].join("|"),
);
const UNCLOCKED_RE = /\bunclocked\b/i;
const OWNER_RE = /\bowner\b/i;
const EMPTY_MARKER_TEXT = "(empty — nothing ranked)";
/** How many non-blank lines below the heading the stamp search looks through before giving up (CoS refinement 2026-08-17). */
const STAMP_LOOKAHEAD_LINES = 6;

function isTierHeaderLine(trimmedLine: string): boolean {
  if (ITEM_START_RE.test(trimmedLine)) return false; // items win over header detection (inline-tier items look like this too)
  return /^\*\*P[0-3]\b/.test(trimmedLine) || /^P[0-3]\b/.test(trimmedLine);
}

function isFullyStruck(itemText: string): boolean {
  return /^~~[\s\S]*~~$/.test(itemText.trim());
}

/**
 * Finds the first heading (any `#`-level) whose text contains "Backlog (ranked)", the
 * `ranked-by:` stamp line within the next `STAMP_LOOKAHEAD_LINES` non-blank lines under it (if
 * any — tolerant of `**`/backtick/blockquote/bullet wrapping), and every item between the
 * heading and the next same-or-shallower heading (a deeper sub-heading, e.g. `###` under a
 * `##` backlog heading, stays IN the section) — skipping `<details>…</details>` blocks and
 * struck-through (`~~…~~`) items per the grammar. Lines before/around a stamp that isn't
 * literally the first line are still scanned for headers/items (only the stamp line itself is
 * excluded from the body).
 */
export function parseBacklogSection(md: string): ParsedSection {
  const lines = md.split("\n");
  const headingIdx = lines.findIndex((l) => HEADING_RE.test(l) && l.includes("Backlog (ranked)"));
  if (headingIdx === -1) {
    return { found: false, headingLine: null, stamp: null, stampLine: null, items: [], emptyMarker: false };
  }
  const headingHashes = HEADING_RE.exec(lines[headingIdx])![1].length;

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[1].length <= headingHashes) {
      endIdx = i;
      break;
    }
  }

  let stampIdx = -1;
  let stamp: Stamp | null = null;
  let nonBlankSeen = 0;
  for (let i = headingIdx + 1; i < endIdx && nonBlankSeen < STAMP_LOOKAHEAD_LINES; i++) {
    if (lines[i].trim().length === 0) continue;
    nonBlankSeen++;
    if (looksLikeRankedByLine(lines[i])) {
      stampIdx = i;
      stamp = parseStampLine(lines[i]); // may still come back null (malformed) — that's a P3 finding, not "no stamp line found"
      break;
    }
  }
  const stampLine = stampIdx !== -1 ? lines[stampIdx] : null;

  const items: ParsedItem[] = [];
  let currentTier: Tier | null = null;
  let inDetails = false;
  let emptyMarker = false;
  for (let i = headingIdx + 1; i < endIdx; i++) {
    if (i === stampIdx) continue; // the stamp line itself is never body content, wherever it fell

    const line = lines[i];
    if (line.includes(EMPTY_MARKER_TEXT)) emptyMarker = true;

    if (inDetails) {
      if (/<\/details>/i.test(line)) inDetails = false;
      continue;
    }
    if (/<details/i.test(line)) {
      inDetails = !/<\/details>/i.test(line); // same-line open+close never enters skip state
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (isTierHeaderLine(trimmed)) {
      const m = TIER_RE.exec(trimmed);
      if (m) currentTier = `P${m[1]}` as Tier;
      continue;
    }

    const itemMatch = ITEM_START_RE.exec(trimmed);
    if (!itemMatch) continue; // prose line — not an item, not counted, not flagged

    const itemText = trimmed.slice(itemMatch[0].length).trim();
    if (isFullyStruck(itemText)) continue; // struck item — skipped per the grammar

    const inlineTierMatch = TIER_RE.exec(itemText);
    const tier = inlineTierMatch ? (`P${inlineTierMatch[1]}` as Tier) : currentTier;
    const hasOwner = OWNER_RE.test(itemText);
    const hasClock = UNCLOCKED_RE.test(itemText) || CLOCK_DATE_RE.test(itemText);

    items.push({ line: i + 1, text: itemText, tier, hasOwner, hasClock });
  }

  return { found: true, headingLine: lines[headingIdx], stamp, stampLine, items, emptyMarker };
}

// ───────────────────────────── evaluate (findings) ─────────────────────────────

export interface Finding {
  check: ComplianceCheck;
  /** Verbatim per the design doc §2 table's "Finding text shape" column. */
  text: string;
  /** F2/F3 report "pending" (not a failure) before their `*_enforced_from` dates (design doc §2). Every other check is always "failed" when it fires. */
  status: "failed" | "pending";
}

function daysBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (24 * 60 * 60 * 1000);
}

function hoursBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (60 * 60 * 1000);
}

function buildShapeFindingText(missingTier: number[], missingOwner: number[], missingClock: number[]): string {
  const n = new Set([...missingTier, ...missingOwner, ...missingClock]).size;
  const parts: string[] = [];
  if (missingTier.length > 0) parts.push(`tier[${missingTier.join(",")}]`);
  if (missingOwner.length > 0) parts.push(`owner[${missingOwner.join(",")}]`);
  if (missingClock.length > 0) parts.push(`clock[${missingClock.join(",")}]`);
  return `${n} item(s) missing: ${parts.join(" ")}`;
}

/**
 * Runs P1-P3 (presence) / F1-F3 (freshness) / S1 (shape) against one row + its (already
 * fetched) brief, per the design doc §2 table — check text is verbatim that table's "Finding
 * text shape" column, PLUS the two F2 refinements the CoS ratified 2026-08-17 (seat-mismatch
 * finding; SEAT-class rows are their own manager and never get an F2 finding at all). P1
 * short-circuits (no brief, nothing else is checkable); P2 short-circuits (no section, no
 * stamp or items to find); P3 does NOT short-circuit S1 (item shape is independent of whether
 * the stamp line parsed). This function does not know about `row.active` or `config.skip` —
 * the worker filters to active, non-skipped rows before calling this (design doc §2: "per
 * ACTIVE row").
 */
export function evaluate(row: LaneRow, brief: { exists: boolean; text: string }, config: ComplianceConfig, now: string): Finding[] {
  const briefPath = resolveBriefPath(row, config);
  const findings: Finding[] = [];

  if (!brief.exists) {
    findings.push({ check: "P1", text: `no brief/backlog file — expected ${briefPath}`, status: "failed" });
    return findings;
  }

  const section = parseBacklogSection(brief.text);
  if (!section.found) {
    findings.push({ check: "P2", text: `no "## Backlog (ranked)" section in ${briefPath}`, status: "failed" });
    return findings;
  }

  if (!section.stamp) {
    findings.push({ check: "P3", text: "stamp block missing/unparseable under the heading", status: "failed" });
  } else {
    const laneDays = daysBetween(section.stamp.lane, now);
    if (laneDays > config.lane_stamp_max_age_days) {
      findings.push({
        check: "F1",
        text: `lane stamp ${section.stamp.lane} is ${Math.floor(laneDays)} d old (max ${config.lane_stamp_max_age_days})`,
        status: "failed",
      });
    }

    // F2 — only when a rule-15 manager exists on this row (a DIFFERENT seat manages it). A
    // row with no rule-15 manager (this covers SEAT rows) is its own manager by the CoS's
    // 2026-08-17 ruling — no F2 check applies to it at all, regardless of what its manager
    // field says.
    if (row.manager) {
      const enforced = now >= config.manager_stamp_enforced_from;
      const mgr = section.stamp.manager;
      if (mgr && mgr.seat !== row.manager) {
        findings.push({
          check: "F2",
          text: `manager stamp names ${mgr.seat}, row names ${row.manager}`,
          status: enforced ? "failed" : "pending",
        });
      } else if (!mgr || mgr.at === null) {
        findings.push({
          check: "F2",
          text: `manager stamp required (rule-15 manager = ${row.manager}) but "—"`,
          status: enforced ? "failed" : "pending",
        });
      } else {
        const lagHours = hoursBetween(mgr.at, section.stamp.lane);
        if (lagHours > config.manager_lag_max_hours) {
          findings.push({
            check: "F2",
            text: `manager ${row.manager} stamp behind lane by ${Math.floor(lagHours)} h (max ${config.manager_lag_max_hours})`,
            status: enforced ? "failed" : "pending",
          });
        }
      }
    }

    const enforcedCos = now >= config.cos_stamp_enforced_from;
    const cosAgeDays = section.stamp.cos ? daysBetween(section.stamp.cos, now) : Number.POSITIVE_INFINITY;
    if (section.stamp.cos === null || cosAgeDays > config.cos_stamp_max_age_days) {
      findings.push({
        check: "F3",
        text: `cos stamp ${section.stamp.cos ?? "—"} older than ${config.cos_stamp_max_age_days} d`,
        status: enforcedCos ? "failed" : "pending",
      });
    }
  }

  const missingTier: number[] = [];
  const missingOwner: number[] = [];
  const missingClock: number[] = [];
  for (const item of section.items) {
    if (!item.tier) missingTier.push(item.line);
    if (!item.hasOwner) missingOwner.push(item.line);
    if (!item.hasClock) missingClock.push(item.line);
  }
  if (section.items.length === 0 && !section.emptyMarker) {
    findings.push({ check: "S1", text: `0 item(s) — no items and no "${EMPTY_MARKER_TEXT}" marker`, status: "failed" });
  } else if (missingTier.length > 0 || missingOwner.length > 0 || missingClock.length > 0) {
    findings.push({ check: "S1", text: buildShapeFindingText(missingTier, missingOwner, missingClock), status: "failed" });
  }

  return findings;
}

// ───────────────────────────── render ─────────────────────────────

export interface LaneComplianceResult {
  row: LaneRow;
  briefPath: string;
  findings: Finding[];
}

export function isCompliant(result: LaneComplianceResult): boolean {
  return !result.findings.some((f) => f.status === "failed");
}

function findingCell(findings: Finding[]): string {
  if (findings.length === 0) return "_none_";
  return findings.map((f) => `**${f.check}**${f.status === "pending" ? " (pending)" : ""}: ${f.text}`).join("<br>");
}

const REMEDY_LINE =
  "Fix: add/restamp the `## Backlog (ranked)` section per the grammar (heading -> `ranked-by: lane <ISO> · manager <seat> <ISO>|— · cos <ISO>|— · kevin <ISO>|—` -> items with tier + owner + clock-or-unclocked-why). Full grammar: " +
  DESIGN_DOC_LINK +
  ".";

export const ROLLUP_MARKER = "<!-- backlog-compliance:rollup -->";

export function laneMarker(name: string): string {
  return `<!-- backlog-compliance:lane=${slugify(name)} -->`;
}

/**
 * ONE fleet rollup issue body (used before `per_lane_issues_from`) — a full checklist of every
 * ACTIVE lane, not just the non-compliant ones (design doc §2: "so the CoS census has a
 * checklist"), so a clean lane's compliance is visible too, not just silence.
 */
export function renderRollupBody(results: LaneComplianceResult[], now: string): string {
  const lines: string[] = [];
  lines.push(ROLLUP_MARKER);
  lines.push(`Backlog-compliance rollup — LANES rule 17(g) (ops-pipeline#151). Run ${now}.`);
  lines.push("");
  lines.push("| Lane | Class | Brief | Compliant | Findings |");
  lines.push("|---|---|---|---|---|");
  const sorted = [...results].sort((a, b) => a.row.name.localeCompare(b.row.name));
  for (const r of sorted) {
    lines.push(`| ${r.row.name} | ${r.row.class} | \`${r.briefPath}\` | ${isCompliant(r) ? "✅" : "❌"} | ${findingCell(r.findings)} |`);
  }
  lines.push("");
  lines.push(REMEDY_LINE);
  lines.push("");
  lines.push(
    "One rollup issue until `per_lane_issues_from` (design doc §2) — after that date, findings move to one issue per non-compliant lane and this rollup closes.",
  );
  return lines.join("\n");
}

/** ONE lane's issue body (used from `per_lane_issues_from` onward). */
export function renderLaneBody(result: LaneComplianceResult, now: string): string {
  const lines: string[] = [];
  lines.push(laneMarker(result.row.name));
  lines.push(`Backlog-compliance findings for **${result.row.name}** (${result.row.class}) — LANES rule 17(g) (ops-pipeline#151). Run ${now}.`);
  lines.push("");
  lines.push(`Brief: \`${result.briefPath}\``);
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("_No findings this run — compliant._");
  } else {
    lines.push("| Check | Status | Detail |");
    lines.push("|---|---|---|");
    for (const f of result.findings) {
      lines.push(`| ${f.check} | ${f.status} | ${f.text} |`);
    }
  }
  lines.push("");
  lines.push(REMEDY_LINE);
  return lines.join("\n");
}

/**
 * `[backlog-compliance] lanes=<M> active=<A> compliant=<C> presence=<n> freshness=<n>
 * shape=<n>` — `allRows` supplies M/A (inactive rows are never evaluated at all, so `results`
 * alone can't recover the total); `presence`/`freshness`/`shape` count FAILED findings only
 * (pending findings are informational, not counted as violations yet).
 */
export function summaryLine(allRows: LaneRow[], results: LaneComplianceResult[]): string {
  const active = allRows.filter((r) => r.active).length;
  const compliant = results.filter(isCompliant).length;
  const countFailed = (checks: readonly ComplianceCheck[]): number =>
    results.reduce((sum, r) => sum + r.findings.filter((f) => f.status === "failed" && checks.includes(f.check)).length, 0);
  return `[backlog-compliance] lanes=${allRows.length} active=${active} compliant=${compliant} presence=${countFailed(PRESENCE_CHECKS)} freshness=${countFailed(FRESHNESS_CHECKS)} shape=${countFailed(SHAPE_CHECKS)}`;
}
