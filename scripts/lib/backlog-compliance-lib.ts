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

import { createHash } from "node:crypto";

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
// [^*]+ (not \w+) — mirrors ROW_START_RE: real rule-15 managers include multi-word seats
// ("Creative Director", "General Counsel"), confirmed live in LANES.md 2026-08-17. \w+ silently
// dropped those to manager:null, which read as F2-exempt (codex pass-1 P1, ops-pipeline#151).
const MANAGER_RE = /lane manager \(rule 15\):\s*\*\*([^*]+)\*\*/;
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
      manager: managerMatch ? managerMatch[1].trim() : null,
      briefPath: briefMatch ? briefMatch[0] : null,
      raw: line,
    });
  }
  return rows;
}

/** slug = NFD-normalize + strip combining marks (issue #153 item 3: "Ästhetik Target Universe"
 * -> "asthetik-target-universe", NOT "sthetik-..." — matches the vault's own naming convention,
 * e.g. `coldstarts/asthetik-films-reentry.md`) THEN lowercase, non-alnum runs -> "-", trimmed
 * of leading/trailing "-". Both callers (`laneMarker`'s marker hash-suffix slug and
 * `resolveBriefPath`'s rung-3 default-path slug) change shape for non-ASCII row names — fine
 * ONLY because no per-lane issue exists yet (design doc §2 `per_lane_issues_from` =
 * 2026-08-21); must ship before then. */
function slugify(name: string): string {
  const transliterated = name.normalize("NFD").replace(/\p{M}/gu, ""); // strip combining marks (e.g. Ä -> A + ¨ -> A)
  return transliterated.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

// Optional :SS and .sss — real stamps carry seconds precision (pricing-lane-reentry.md:
// 2026-08-17T06:20:38Z, live 2026-08-17); HH:MM-only rejected those as unparseable (codex
// pass-1 P2, ops-pipeline#151).
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
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
 * Strips ONE trailing balanced parenthetical annotation off a stamp field value — live briefs
 * append human-readable commentary straight after the ISO token, before the next `·` (e.g. Deep
 * River: `2026-08-17T06:42Z (17(g) ack restamp; last rank CHANGE 2026-08-16T20:35Z = item 20
 * added; ranks unchanged since)`) — fold 6a, ops-pipeline#151 (Rule #425: the pre-fold parser
 * strictness read this as unparseable, a false positive, not a real brief defect).
 *
 * Walks backwards from the end tracking paren depth so NESTED parens resolve correctly (the
 * Deep River example above has an inner `(g)` — depth must reach 0 at the OUTER `(`, not the
 * inner one). The matched `(` must sit at index 0 or be preceded by whitespace — a trailing
 * `(...)` glued onto a word with no separating space (`seat(note)`) is not a standalone
 * annotation and is left alone. Unbalanced (`(oops` with no `)`, or an extra stray `)`) or no
 * match at all → returns `v` unchanged; the caller's own validation (`isIso`, etc.) then
 * correctly rejects the still-garbage value rather than this helper silently inventing a cut
 * point.
 */
function stripTrailingParenthetical(v: string): string {
  if (!v.endsWith(")")) return v;
  let depth = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    const ch = v[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) {
        const precededByBoundary = i === 0 || /\s/.test(v[i - 1] ?? "");
        return precededByBoundary ? v.slice(0, i).trimEnd() : v;
      }
    }
  }
  return v; // unbalanced — no matching "(" found for the trailing ")"
}

/**
 * Splits a `ranked-by:` field list on `·`/`|`/`,` — but NOT when that character sits INSIDE a
 * balanced `(...)` span (codex pass-3 P2, ops-pipeline#151, fold-6a follow-up): a trailing
 * parenthetical annotation using ordinary English comma punctuation — `lane 2026-08-17T06:25Z
 * (last re-rank, ranks unchanged) · manager ...` — must not be torn in half by its OWN internal
 * comma before `stripTrailingParenthetical` ever gets a chance to see the whole annotation.
 * Depth-tracked so a nested paren (the live Deep River case, `(17(g) ack restamp; ...)`) doesn't
 * false-close early. Parens themselves stay IN the emitted segments — this only decides where to
 * cut, not what to strip; `stripTrailingParenthetical` does the stripping afterward.
 */
function splitStampFields(s: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "·" || ch === "|" || ch === ",")) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * Parses one `ranked-by: lane <ISO> · manager <seat> <ISO>|<seat> —|— · cos <ISO>|— · kevin
 * <ISO>|—` line (tolerant of `**`/backtick/blockquote/bullet wrapping, and of `·`/`|`/`,` as
 * the field separator — except inside a balanced parenthetical, `splitStampFields`). Returns
 * null when the (stripped) line doesn't start `ranked-by:`, or `lane` is missing/unparseable
 * (the one REQUIRED field — everything else may legitimately read "—"). Unknown extra fields
 * are parsed into nothing usable and silently ignored.
 */
export function parseStampLine(rawLine: string): Stamp | null {
  const trimmed = stripStampDecoration(rawLine);
  const prefixMatch = /^ranked-by:\s*(.*)$/.exec(trimmed);
  if (!prefixMatch) return null;

  const fields: Record<string, string> = {};
  for (const segment of splitStampFields(prefixMatch[1]).map((s) => s.trim()).filter(Boolean)) {
    const sp = segment.indexOf(" ");
    if (sp === -1) continue; // a bare key with no value — defensively ignored, not fatal
    const key = segment.slice(0, sp).trim().toLowerCase();
    const value = stripTrailingParenthetical(segment.slice(sp + 1).trim());
    fields[key] = value;
  }

  if (!fields.lane) return null;
  // `lane [<label>] <ISO>` — issue #153 item 2: a leading label token before the ISO is
  // tolerated (real briefs, 2026-08-17: CMO `lane CMO 2026-08-17T06:23Z`, COO `lane COO-seat
  // 2026-08-17T07:24:31Z`, Creative Director `lane CD 2026-08-17T06:25Z`). The ISO is always
  // the LAST whitespace token — the same trick the `manager` field already uses via
  // lastIndexOf(" ") below, since an ISO never itself contains a space. A last token that
  // still isn't a valid ISO fails the whole stamp (P3) — garbage is never silently accepted,
  // label or not.
  const laneSpaceIdx = fields.lane.lastIndexOf(" ");
  const laneIso = laneSpaceIdx === -1 ? fields.lane : fields.lane.slice(laneSpaceIdx + 1).trim();
  if (!isIso(laneIso)) return null;

  let manager: StampManager | null = null;
  if (fields.manager && !UNSTAMPED_RE.test(fields.manager)) {
    // lastIndexOf, not indexOf — a multi-word seat ("Creative Director") must stay intact; the
    // ISO-or-dash trailing token never itself contains a space, so it's always the LAST one
    // (codex pass-1 P1, ops-pipeline#151).
    const sp = fields.manager.lastIndexOf(" ");
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

  return { lane: laneIso, manager, cos, kevin };
}

// ───────────────────────────── item / section parsing ─────────────────────────────

export interface ParsedItem {
  /** 1-based absolute line number in the brief's full text — the "(line numbers)" the S1 finding
   * text cites. Always the item's FIRST line, even when continuation lines were joined in (fold
   * 9, ops-pipeline#155). */
  line: number;
  /** Item text after stripping the leading `N.`/`Nb.`/`-`/`•` marker, single-space-joined with
   * any immediately-following indented continuation lines (fold 9, ops-pipeline#155 — briefs
   * hard-wrap at ~72 cols and an item's `owner … · next: … · <date>` tail routinely lands 1-3
   * lines below the marker line). See `collectContinuationLines`. */
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

// ───────────────────────────── table-row items (issue #153 item 1) ─────────────────────────────
//
// Three real lanes (Pricing, CFO, HubSpot Platform) wrote their ranked backlog as a markdown
// TABLE with the four contract fields as COLUMNS instead of numbered/bulleted lines — the
// existing item scanner below (bullets/numbered only) read every one of them as "0 item(s) —
// no items and no marker", a false S1. This block recognizes an item-table header (by CELL
// NAMES, not fixed column positions — the three real shapes disagree on whether a leading `#`
// row-number column exists) and turns each following data row into a `ParsedItem`, using the
// SAME tier/owner/clock primitives (`TIER_RE`/`OWNER_RE`/`UNCLOCKED_RE`/`CLOCK_DATE_RE`) the
// bulleted-item path already uses — never a forked notion of what a valid tier/owner/clock is.

/** Column indexes resolved from a detected item-table header row (0-based, into the array
 * `splitRowCells` returns for that table's rows). `itemIdx`/`clockIdx` may be absent (null) —
 * `parseTableRowItem` falls back to scanning the whole row when either is. */
interface TableColumns {
  tierIdx: number;
  itemIdx: number | null;
  ownerIdx: number;
  clockIdx: number | null;
}

/** Splits a markdown table row into trimmed cell strings — drops the leading empty segment
 * from the row's opening `|` and, when present, the trailing empty segment from a closing `|`
 * (a row with no trailing pipe just keeps its last real cell as-is). Returns `[]` for a line
 * that doesn't start with `|` after trimming — never treated as a table row at all. Does not
 * handle `\|`-escaped pipes — not a shape any real brief needs this parser to survive yet. */
function splitRowCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  const parts = trimmed.split("|").slice(1);
  if (parts.length > 0 && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.map((c) => c.trim());
}

/** A markdown table separator row — every cell only `-`/`:` characters (`---`, `:---`, `:-:`, …). */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Recognizes an item-table header row per the design doc's tolerant-parse grammar (issue #153
 * item 1): cells (decoration-stripped, lower-cased, trimmed) include one EXACT match for
 * `p`/`tier`/`priority` (the tier column) AND one EXACT match for `owner` (the owner column) —
 * both required, or this isn't a header this parser understands at all (`null`, never a
 * partial guess — a `|`-line that fails this check is left for the caller to treat as plain,
 * unflagged prose, same as any other non-item line). The item column (loosely, any header cell
 * whose text CONTAINS "item" — covers "item", "Item", "item (see Queue for detail)") and the
 * clock column (`date`/`clock`/`when`, exact) are both optional — `parseTableRowItem` falls
 * back to whole-row scans when either is absent.
 */
function detectTableHeader(cells: string[]): TableColumns | null {
  const lower = cells.map((c) => c.replace(/\*\*/g, "").replace(/`/g, "").trim().toLowerCase());
  const tierIdx = lower.findIndex((c) => c === "p" || c === "tier" || c === "priority");
  const ownerIdx = lower.findIndex((c) => c === "owner");
  if (tierIdx === -1 || ownerIdx === -1) return null;
  const itemIdx = lower.findIndex((c) => c.includes("item"));
  const clockIdx = lower.findIndex((c) => c === "date" || c === "clock" || c === "when");
  return { tierIdx, itemIdx: itemIdx === -1 ? null : itemIdx, ownerIdx, clockIdx: clockIdx === -1 ? null : clockIdx };
}

/**
 * Turns one data row's cells into a `ParsedItem` under an already-detected table header, or
 * `null` for a merged/struck row the grammar skips outright (design doc: "a row whose tier
 * cell is `—`/`-`/empty AND item cell starts with `(` … is skipped" — the real CFO shape `| 0d
 * | — | (merged into 0c: …) | | | |`). tier comes from the tier cell via the SAME `TIER_RE`
 * bullet/numbered items use (`\bP([0-3])\b` already tolerates `**P1 · now**` / `P1 (clocked)`
 * decoration for free — the word-boundary either side of "P1" holds regardless of what
 * surrounds it, so no extra stripping is needed here). owner/clock each prefer their OWN
 * column when non-empty, else fall back to the existing token/date-like detection scanned over
 * the whole row (design doc: "else an `owner <name>` token" / "else the existing date-like/
 * `unclocked (…)` detection over the whole row") — this is how a row with a genuinely blank
 * owner/clock cell still gets a real true/false verdict instead of a fixed guess.
 */
function parseTableRowItem(cells: string[], cols: TableColumns, lineNo: number): ParsedItem | null {
  const tierCell = cells[cols.tierIdx] ?? "";
  const itemCell = cols.itemIdx !== null ? (cells[cols.itemIdx] ?? "") : "";
  const ownerCell = cells[cols.ownerIdx] ?? "";
  const clockCell = cols.clockIdx !== null ? (cells[cols.clockIdx] ?? "") : "";

  const tierIsEmptyish = tierCell === "" || UNSTAMPED_RE.test(tierCell);
  if (tierIsEmptyish && itemCell.startsWith("(")) return null; // merged/struck row — skipped, not a finding

  const tierMatch = TIER_RE.exec(tierCell);
  const tier = tierMatch ? (`P${tierMatch[1]}` as Tier) : null;

  // A dash-only cell (—/-, same placeholder UNSTAMPED_RE already treats as an absent tier two
  // lines above) means "unassigned"/"unclocked", NOT "present" — codex review (ops-pipeline#151
  // follow-up, issue #153): a literal "—" has length > 0, so a bare-length check would wrongly
  // read it as compliant. Falls through to the whole-row scan exactly like an empty cell would.
  const ownerCellIsEmptyish = ownerCell === "" || UNSTAMPED_RE.test(ownerCell);
  const clockCellIsEmptyish = clockCell === "" || UNSTAMPED_RE.test(clockCell);

  const wholeRow = cells.join(" ");
  const hasOwner = !ownerCellIsEmptyish || OWNER_RE.test(wholeRow);
  const hasClock = !clockCellIsEmptyish || UNCLOCKED_RE.test(wholeRow) || CLOCK_DATE_RE.test(wholeRow);

  return { line: lineNo, text: itemCell || wholeRow, tier, hasOwner, hasClock };
}

function isTierHeaderLine(trimmedLine: string): boolean {
  if (ITEM_START_RE.test(trimmedLine)) return false; // items win over header detection (inline-tier items look like this too)
  return /^\*\*P[0-3]\b/.test(trimmedLine) || /^P[0-3]\b/.test(trimmedLine);
}

function isFullyStruck(itemText: string): boolean {
  return /^~~[\s\S]*~~$/.test(itemText.trim());
}

/** True when a continuation CANDIDATE line (the RAW line, not trimmed) is indented per the
 * fold-9 grammar (ops-pipeline#155): a leading tab, or at least 2 leading spaces. Anything else
 * (0-1 leading spaces, no tab) is the next item, a fresh heading, or prose that ends the item. */
function isContinuationIndented(rawLine: string): boolean {
  return rawLine.startsWith("\t") || /^ {2,}/.test(rawLine);
}

/**
 * Collects an item's hard-wrap continuation lines (fold 9, ops-pipeline#155 — post first live
 * firing, brain#136: briefs hard-wrap at ~72 cols with indented continuation lines, and the
 * item's `owner … · next: … · <date>` tail routinely lands 1-3 lines below the numbered/bulleted
 * marker line, where the pre-fold parser never looked — evaluating tier/owner/clock over the
 * first line only produced a false S1 on Chief of Staff/Faire/Acumatica). Walks forward from
 * `itemLineIdx + 1`, consuming each line that is indented (`isContinuationIndented` — so an
 * indented sub-bullet like `   - foo` counts too; it's a continuation of its parent, never a
 * separate item), non-blank after trimming, and does not (after trimming) start with `#`
 * (heading), `|` (table row), `<details` (details block), or `<!--` (HTML comment). Any of those
 * five conditions — plus hitting `stampIdx` (the stamp line is never body content, wherever it
 * falls) — ends the scan WITHOUT consuming that line: the outer loop's own next iteration picks
 * it up and applies its normal heading/table/details/prose handling, unchanged.
 *
 * Returns the trimmed continuation texts (for the caller's single-space join) and the index of
 * the LAST line consumed (`itemLineIdx` itself when nothing was consumed) — the caller advances
 * the outer loop's `i` to that index so these lines are never re-scanned as their own
 * items/prose/tier-headers. This happens unconditionally, before the caller checks
 * `isFullyStruck` on the item's first-line text — a struck item's continuation lines are still
 * consumed-and-discarded, never left for the next iteration to misread as fresh content (e.g. an
 * indented `   - foo` sub-bullet would otherwise be picked up as its own top-level item, since
 * `ITEM_START_RE` matches against TRIMMED text).
 */
function collectContinuationLines(
  lines: string[],
  itemLineIdx: number,
  endIdx: number,
  stampIdx: number,
): { texts: string[]; lastIdx: number } {
  const texts: string[] = [];
  let lastIdx = itemLineIdx;
  for (let j = itemLineIdx + 1; j < endIdx; j++) {
    if (j === stampIdx) break; // never consume the stamp line, wherever it falls (existing invariant)
    const raw = lines[j];
    const trimmed = raw.trim();
    if (trimmed.length === 0) break; // blank line ends the item
    if (!isContinuationIndented(raw)) break; // non-indented line ends the item (next item marker or prose)
    if (trimmed.startsWith("#") || trimmed.startsWith("|") || trimmed.startsWith("<details") || trimmed.startsWith("<!--")) break;
    texts.push(trimmed);
    lastIdx = j;
  }
  return { texts, lastIdx };
}

/** Removes `` `…` `` inline-code spans entirely (backticks AND their content) — fold 7a heading
 * discovery ONLY. A heading whose sole mention of the phrase is inside a backtick-quoted
 * cross-reference (e.g. `# §4 Next milestones (... the backlog is `## Backlog (ranked)` just
 * below ...)`) is a forward-reference to the real section, not the section's own heading — the
 * quoted content is disowned entirely, unlike `stripStampDecoration`, which deletes backtick
 * CHARACTERS but keeps their content (correct for a stamp value the line legitimately owns).
 */
function stripInlineCodeSpans(s: string): string {
  return s.replace(/`[^`]*`/g, "");
}

/** An optional leading `§4.`/`§4 `/`4.`/`4 ` numbering prefix on a heading's own text. */
const HEADING_NUMBERING_RE = /^§?\d+\.?\s*/;

/**
 * Finds the REAL `## Backlog (ranked)` section heading — fold 7a, ops-pipeline#151 (live-vault
 * bug: Deep River's `# §4 Next milestones (... the backlog is `## Backlog (ranked)` just below
 * ...)` heading, 12 lines above the true one, matched FIRST under the old plain-substring test
 * and hijacked the whole section — its own stamp/items were never reached). Two-stage: (1)
 * candidates = headings whose text, AFTER stripping inline-code spans, still contains the
 * phrase (a backticked mention alone disqualifies a heading); (2) among candidates, prefer the
 * FIRST whose (inline-code-stripped, hash-prefix-stripped) text — after an optional leading
 * `§4.`-style numbering — STARTS WITH the phrase, i.e. the section's OWN heading; if none
 * qualifies, fall back to the first remaining candidate by document order (keeps prior
 * tolerance for `## Ranked Backlog (ranked) — …`-style variants, where the phrase appears but
 * not at the very start). Returns -1 when there are no candidates at all.
 */
function findBacklogHeadingIndex(lines: string[]): number {
  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]) && stripInlineCodeSpans(lines[i]).includes("Backlog (ranked)")) {
      candidates.push(i);
    }
  }
  for (const i of candidates) {
    const prefixLen = HEADING_RE.exec(lines[i])![0].length;
    const content = stripInlineCodeSpans(lines[i]).slice(prefixLen).replace(HEADING_NUMBERING_RE, "");
    if (content.startsWith("Backlog (ranked)")) return i;
  }
  return candidates.length > 0 ? candidates[0] : -1;
}

/**
 * Finds the real `## Backlog (ranked)` section heading (`findBacklogHeadingIndex` — a
 * backticked cross-reference to the section doesn't count as the section itself), the
 * `ranked-by:` stamp line within the next `STAMP_LOOKAHEAD_LINES` non-blank, non-comment lines
 * under it (if any — tolerant of `**`/backtick/blockquote/bullet wrapping), and every item
 * between the heading and the next same-or-shallower heading (a deeper sub-heading, e.g. `###`
 * under a `##` backlog heading, stays IN the section) — skipping `<details>…</details>` blocks
 * and struck-through (`~~…~~`) items per the grammar. Lines before/around a stamp that isn't
 * literally the first line are still scanned for headers/items (only the stamp line itself is
 * excluded from the body). Items are numbered/bulleted lines OR rows of a detected item TABLE
 * (issue #153 item 1, `detectTableHeader`/`parseTableRowItem`) — a section may mix both, e.g. a
 * table followed later by a plain bulleted addendum.
 */
export function parseBacklogSection(md: string): ParsedSection {
  const lines = md.split("\n");
  const headingIdx = findBacklogHeadingIndex(lines);
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
  // fold 7b, ops-pipeline#151 (live-vault bug: Ästhetik Films' real stamp sat 11 lines below its
  // heading, behind a 10-line `<!-- … -->` note — the note alone burned the whole budget before
  // the scanner ever reached the stamp). A line inside/comprising an HTML comment (including
  // the line that opens it and the line that closes it, and a line that opens+closes on itself)
  // never counts toward the budget; counting resumes on the line after the closing `-->`. Do NOT
  // raise STAMP_LOOKAHEAD_LINES — real prose between a heading and its stamp still budgets at 6.
  let insideComment = false;
  for (let i = headingIdx + 1; i < endIdx && nonBlankSeen < STAMP_LOOKAHEAD_LINES; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;

    if (insideComment) {
      if (line.includes("-->")) insideComment = false;
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) insideComment = true; // else: opens+closes on itself — still skipped, state unchanged
      continue;
    }

    nonBlankSeen++;
    if (looksLikeRankedByLine(line)) {
      stampIdx = i;
      stamp = parseStampLine(line); // may still come back null (malformed) — that's a P3 finding, not "no stamp line found"
      break;
    }
  }
  const stampLine = stampIdx !== -1 ? lines[stampIdx] : null;

  const items: ParsedItem[] = [];
  let currentTier: Tier | null = null;
  let inDetails = false;
  let emptyMarker = false;
  let tableCols: TableColumns | null = null; // non-null while scanning rows of an already-detected item table
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
    if (trimmed.length === 0) {
      tableCols = null; // grammar: a table block ends at a blank line
      continue;
    }

    if (trimmed.startsWith("|")) {
      const cells = splitRowCells(line);
      if (tableCols === null) {
        const headerCols = detectTableHeader(cells);
        if (headerCols !== null && i + 1 < endIdx && isSeparatorRow(splitRowCells(lines[i + 1]))) {
          tableCols = headerCols;
          i++; // also consume the |---| separator row on this pass (loop's own i++ lands on the first data row)
        }
        continue; // the header row itself, or an unrecognized "|" line, is never an item
      }
      const item = parseTableRowItem(cells, tableCols, i + 1);
      if (item) items.push(item);
      continue;
    }
    tableCols = null; // a non-"|" content line also ends the current table block (bullets/numbered items keep working after it)

    if (isTierHeaderLine(trimmed)) {
      const m = TIER_RE.exec(trimmed);
      if (m) currentTier = `P${m[1]}` as Tier;
      continue;
    }

    const itemMatch = ITEM_START_RE.exec(trimmed);
    if (!itemMatch) continue; // prose line — not an item, not counted, not flagged

    const firstLineIdx = i;
    const firstLineText = trimmed.slice(itemMatch[0].length).trim();

    // fold 9 (ops-pipeline#155): join hard-wrapped continuation lines BEFORE evaluating
    // tier/owner/clock — consumed (and `i` advanced past) regardless of whether the item turns
    // out to be struck below, so they're never re-scanned as their own items/prose.
    const { texts: continuationTexts, lastIdx } = collectContinuationLines(lines, firstLineIdx, endIdx, stampIdx);
    i = lastIdx;

    if (isFullyStruck(firstLineText)) continue; // struck item (first-line text only) — skipped per the grammar

    const itemText = [firstLineText, ...continuationTexts].join(" ");

    const inlineTierMatch = TIER_RE.exec(itemText);
    const tier = inlineTierMatch ? (`P${inlineTierMatch[1]}` as Tier) : currentTier;
    const hasOwner = OWNER_RE.test(itemText);
    const hasClock = UNCLOCKED_RE.test(itemText) || CLOCK_DATE_RE.test(itemText);

    items.push({ line: firstLineIdx + 1, text: itemText, tier, hasOwner, hasClock });
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

const SEAT_ALIASES: Record<string, string> = {
  cd: "Creative Director",
  "creative director": "Creative Director",
  cos: "Chief of Staff",
  "chief of staff": "Chief of Staff",
  gc: "General Counsel",
  "general counsel": "General Counsel",
  cto: "CTO",
  cfo: "CFO",
  cmo: "CMO",
  coo: "COO",
};

/**
 * Normalizes a rule-15 seat name for the F2 mismatch COMPARISON only — fold 6b, ops-pipeline#151
 * (Rule #425: a manager stamp abbreviating "CD" against a row spelling out "Creative Director"
 * is the SAME seat, not a mismatch; the pre-fold exact-string compare false-positived on every
 * lane whose manager stamps the short form). Case-insensitive; anything outside the alias map
 * passes through trimmed as-is, so an already-exact match still works with no alias needed. The
 * finding TEXT always quotes the RAW (un-normalized) names — this function backs the compare,
 * never the message.
 */
function canonicalSeat(name: string): string {
  return SEAT_ALIASES[name.trim().toLowerCase()] ?? name.trim();
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
      if (mgr && canonicalSeat(mgr.seat) !== canonicalSeat(row.manager)) {
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
  const hash = createHash("sha1").update(name.normalize("NFC")).digest("hex").slice(0, 8);
  return `<!-- backlog-compliance:lane=${slugify(name)}-${hash} -->`;
}

/**
 * Validates + decodes a GitHub Contents-API response (`{type,encoding,size,content}`, fetched
 * via `--jq '{type,encoding,size,content}'`) into the file's text. Pure — no I/O; the network
 * round trip lives in the worker's `apiContentsRaw`. Rule #465: the API's own declared shape is
 * part of the receipt — a directory listing, submodule ref, or symlink response all 200 with a
 * DIFFERENT `type`, and an oversized file arrives with `content` omitted entirely — silently
 * decoding whatever `.content` happens to hold (the pre-fold-5 shape) would base64-decode
 * garbage or crash opaquely instead of naming the mismatch. The thrown message deliberately
 * avoids the substrings "HTTP 404"/"Not Found" so `isNotFoundError` can never misclassify a
 * shape mismatch as an absent file — a real 404 never reaches this function; `gh` throws at the
 * API-call layer before any JSON exists to validate.
 */
export function decodeContentsResponse(json: string, path: string): string {
  const parsed = JSON.parse(json) as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown };
  if (parsed.type !== "file" || parsed.encoding !== "base64" || typeof parsed.content !== "string") {
    throw new Error(
      `contents API returned type=${String(parsed.type)} encoding=${String(parsed.encoding)} size=${String(parsed.size)} for ${path} — refusing to interpret as text (Rule #465)`,
    );
  }
  return Buffer.from(parsed.content, "base64").toString("utf-8");
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
