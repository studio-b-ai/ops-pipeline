/**
 * automerge-classify.ts — pure classification logic for the tiered bug-squasher
 * auto-merge gate (CLAUDE.md Rules #279/#97 amendment, Kevin-approved 2026-07-30).
 *
 * This is the NARROW exception to the never-auto-merge law: a PR merges without a
 * human ONLY when every leg in `gateDecision` passes. ANY doubt anywhere in this file
 * resolves to "code" (fail-closed on classification) or "wait" (fail-closed on the
 * gate) — the PR simply waits for a human, which is #97's default outcome anyway, so
 * failing closed here costs nothing and buys everything.
 *
 * Extracted from the runner (scripts/pr-automerge-gate.ts) so the fail-closed paths
 * get real negative-control tests (Rule #322: an oracle that can't reject a known-bad
 * proves nothing) — see scripts/lib/__tests__/automerge-classify.test.ts.
 */

export type DiffFileClass = "doc" | "comment-only" | "code";

export type GateVerdict = "merge" | "wait";

export interface GateFile {
  path: string;
  fileClass: DiffFileClass;
}

export interface GateInput {
  files: GateFile[];
  totalChangedLines: number;
  author: string;
  labels: string[];
  ciClean: boolean;
  reviewVerdict: "CLEAN" | "FLAG";
}

export interface GateResult {
  decision: GateVerdict;
  reasons: string[];
}

const BUGSQUASHER_AUTHOR = "kbibelhausen";
const BUGSQUASHER_LABEL = "bugsquasher";
const MAX_CHANGED_LINES = 10;

/**
 * Per-language comment markers. A file is "comment-only" iff EVERY changed (+/-)
 * line, trimmed, starts with one of that language's markers. Unknown extensions have
 * no entry here and fall through to "code" in classifyDiffFile (fail-closed — Rule
 * #4: doubt never resolves toward merging).
 */
const CODE_COMMENT_MARKERS: Record<string, string[]> = {
  ts: ["//", "/*", "*", "*/"],
  tsx: ["//", "/*", "*", "*/"],
  js: ["//", "/*", "*", "*/"],
  jsx: ["//", "/*", "*", "*/"],
  mjs: ["//", "/*", "*", "*/"],
  cjs: ["//", "/*", "*", "*/"],
  c: ["//", "/*", "*", "*/"],
  h: ["//", "/*", "*", "*/"],
  hpp: ["//", "/*", "*", "*/"],
  cc: ["//", "/*", "*", "*/"],
  cpp: ["//", "/*", "*", "*/"],
  cs: ["//", "/*", "*", "*/"],
  java: ["//", "/*", "*", "*/"],
  go: ["//", "/*", "*", "*/"],
  swift: ["//", "/*", "*", "*/"],
  kt: ["//", "/*", "*", "*/"],
  rs: ["//", "/*", "*", "*/"],
  php: ["//", "/*", "*", "*/", "#"],
};

const HASH_COMMENT_MARKERS: Record<string, string[]> = {
  py: ["#"],
  sh: ["#"],
  bash: ["#"],
  zsh: ["#"],
  yml: ["#"],
  yaml: ["#"],
  toml: ["#"],
  rb: ["#"],
  pl: ["#"],
};

const HTML_COMMENT_MARKERS: Record<string, string[]> = {
  html: ["<!--", "-->"],
  htm: ["<!--", "-->"],
  xml: ["<!--", "-->"],
  svg: ["<!--", "-->"],
};

const COMMENT_MARKERS: Record<string, string[]> = {
  ...CODE_COMMENT_MARKERS,
  ...HASH_COMMENT_MARKERS,
  ...HTML_COMMENT_MARKERS,
};

function extensionOf(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Classify one changed file from its path + the raw content of its added/removed
 * diff lines (WITHOUT the leading +/- marker).
 *
 * - `opts.binary === true` → ALWAYS "code", regardless of path — checked FIRST,
 *   before the doc-path shortcut. A binary diff ("Binary files a/x and b/x differ")
 *   has no reviewable text content; without this the `.md`/`docs/` path rule would
 *   wave through a binary asset swap under `docs/` as "doc" (codex P2 finding,
 *   2026-07-30 review). The unconditional path-based doc rule below is otherwise
 *   intentional per the #279 amendment's "docs/comment-class" spec — this is the
 *   one case that must override it.
 * - `*.md` or anything under `docs/` → "doc" (path-based, content not otherwise
 *   inspected — matches the #279 amendment's "docs/comment-class" language
 *   literally).
 * - Otherwise "comment-only" iff every changed line (trimmed; blank lines pass
 *   through as harmless) starts with a comment marker for the file's extension.
 * - Unknown extension, OR zero changed lines to inspect (e.g. a pure rename with no
 *   content diff — nothing to positively classify as safe), OR any line that isn't a
 *   recognized comment prefix → "code". Fail-closed by construction.
 */
export function classifyDiffFile(
  path: string,
  addedLines: string[],
  removedLines: string[],
  opts?: { binary?: boolean },
): DiffFileClass {
  if (opts?.binary) return "code";
  if (/\.md$/i.test(path) || /^docs\//.test(path)) return "doc";

  const ext = extensionOf(path);
  const markers = ext ? COMMENT_MARKERS[ext] : undefined;
  if (!markers) return "code"; // unknown extension (or no extension) — fail-closed

  const changed = [...addedLines, ...removedLines];
  if (changed.length === 0) return "code"; // nothing to positively verify as safe

  const allCommentOrBlank = changed.every((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return true;
    return isStrictCommentLine(trimmed, markers);
  });

  return allCommentOrBlank ? "comment-only" : "code";
}

function countOccurrences(s: string, needle: string): number {
  let n = 0;
  for (let i = s.indexOf(needle); i !== -1; i = s.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Strict full-line comment shapes only (codex P2 fix, 2026-07-31): the previous
 * `startsWith(marker)` check waved through executable code after block-comment
 * delimiters — `/* x *​/ doEvil()`, `*​/ doEvil()`, and generator methods like
 * `*method() {}` (bare-`*` prefix) all classified as comment-only. Rules:
 * - hash family: line starts with `#`.
 * - c-like family: `//…`; OR exactly `*​/`; OR a continuation line `*` / `* …`
 *   (star followed by whitespace/end — `*method()` fails) or an opener `/*…`,
 *   where in both cases a closing `*​/` may appear ONLY as the line's final
 *   characters, at most once. Multi-block lines (`/* a *​/ x /* b *​/`) fail even
 *   when they end with a closer — fail-closed to the human queue.
 * - html family: `<!--…` with `-->` only as the (single) line suffix; or exactly `-->`.
 */
function isStrictCommentLine(trimmed: string, markers: string[]): boolean {
  // `#!` is a shebang, not a comment (codex pass-4 P2, 2026-07-31): swapping
  // `#!/usr/bin/env python3` for `#!/bin/sh` is a behavioral change. Reject before
  // the generic `#` accept.
  if (markers.includes("#") && trimmed.startsWith("#")) return !trimmed.startsWith("#!");
  if (markers.includes("//")) {
    if (trimmed.startsWith("//")) return true;
    // ONLY complete single-line blocks: `/* ... */` with exactly one closer, as the
    // suffix. Block-comment INTERIOR shapes (`* continuation`, bare `*/`, unclosed
    // `/* opener`) are deliberately NOT accepted (codex pass-3 P1, 2026-07-31): a
    // spaced generator method `* method() {}` is byte-identical to a JSDoc
    // continuation line, and this classifier sees isolated diff lines with no
    // surrounding block context — ANY interior acceptance is contextless guessing.
    // Multi-line JSDoc edits therefore queue for a human — including the shape of
    // the historically-proven squasher PR studiob#401, a deliberate narrowing: that
    // class now costs one human click instead of any guessing (#412: this comment
    // states the trade so nobody 'fixes' it back).
    if (trimmed.startsWith("/*")) {
      const closes = countOccurrences(trimmed.slice(2), "*/");
      return closes === 1 && trimmed.endsWith("*/");
    }
    return false;
  }
  if (markers.includes("<!--")) {
    // Same single-complete-line rule as c-like blocks.
    if (trimmed.startsWith("<!--")) {
      const closes = countOccurrences(trimmed.slice(4), "-->");
      return closes === 1 && trimmed.endsWith("-->");
    }
    return false;
  }
  return false;
}

// ───────────────────────────── file-list reconciliation ─────────────────────────────

export interface ParsedDiffFile {
  path: string;
  added: string[];
  removed: string[];
  binary?: boolean;
}

/**
 * Reconciles the AUTHORITATIVE list of changed file paths (the PR's own file list,
 * e.g. `gh pr view --json files`) against the diff-parsed per-file content, and
 * classifies each authoritative path.
 *
 * Why this exists (codex P1 finding, 2026-07-30 review): a diff-only file list can
 * OMIT files with no content hunks — a pure rename ("rename from x" / "rename to y",
 * no `---`/`+++` lines) or a mode-only change (`old mode` / `new mode`, no content
 * diff) produces zero parsed lines and, without reconciliation, simply never appears
 * in the classified set. `gateDecision`'s "every file classifies doc|comment-only"
 * leg can then vacuously pass over a file it never saw. Any authoritative path with
 * NO matching parsed entry is fail-closed to "code" — Rule #4: doubt never resolves
 * toward a lower-scrutiny class.
 */
export function reconcileFileClasses(authoritativePaths: string[], parsedFiles: ParsedDiffFile[]): GateFile[] {
  const byPath = new Map(parsedFiles.map((f) => [f.path, f]));
  return authoritativePaths.map((path) => {
    const parsed = byPath.get(path);
    if (!parsed) {
      return { path, fileClass: "code" as DiffFileClass };
    }
    return { path, fileClass: classifyDiffFile(path, parsed.added, parsed.removed, { binary: parsed.binary }) };
  });
}

/**
 * All legs required for "merge" — any single failure produces "wait" (never a
 * partial-merge or best-effort path). Reasons are collected regardless of order so a
 * multi-leg failure is fully visible in the PR receipt comment.
 */
export function gateDecision(input: GateInput): GateResult {
  const reasons: string[] = [];

  if (input.author !== BUGSQUASHER_AUTHOR) {
    reasons.push(`author '${input.author}' !== '${BUGSQUASHER_AUTHOR}'`);
  }
  if (!input.labels.includes(BUGSQUASHER_LABEL)) {
    reasons.push(`missing '${BUGSQUASHER_LABEL}' label (has: ${input.labels.length ? input.labels.join(", ") : "none"})`);
  }

  const codeFiles = input.files.filter((f) => f.fileClass === "code").map((f) => f.path);
  if (codeFiles.length > 0) {
    reasons.push(`code-class file(s) present: ${codeFiles.join(", ")}`);
  }

  if (input.totalChangedLines > MAX_CHANGED_LINES) {
    reasons.push(`totalChangedLines ${input.totalChangedLines} > ${MAX_CHANGED_LINES}`);
  }

  if (!input.ciClean) {
    reasons.push("CI not clean");
  }

  if (input.reviewVerdict !== "CLEAN") {
    reasons.push(`independent review verdict '${input.reviewVerdict}' !== 'CLEAN'`);
  }

  return { decision: reasons.length === 0 ? "merge" : "wait", reasons };
}

// ───────────────────────────── CI-rollup classification ─────────────────────────────

export interface RollupItem {
  /** Legacy commit-status shape (older `contexts`): "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" */
  state?: string;
  /** Check-run shape: "COMPLETED" | "IN_PROGRESS" | "QUEUED" | "WAITING" | "PENDING" | ... */
  status?: string;
  /** Check-run shape, only meaningful once status is COMPLETED */
  conclusion?: string | null;
}

// ALLOWLISTS, not denylists (codex P1 finding, 2026-07-30 review): the original
// denylist form treated any legacy `state` value OUTSIDE its known-bad set — an
// unrecognized future GitHub value included — as clean by falling through, and
// treated a COMPLETED check run with a `null`/missing `conclusion` as clean because
// `item.conclusion && ...` short-circuits false on falsy conclusions without ever
// reaching the "return false" branch. Both are exactly the fail-open shape Rule #4
// forbids. An allowlist has no such fallthrough: anything not explicitly known-good
// is unclean.
// SUCCESS only (codex pass-3 P2, 2026-07-31): GitHub's StatusState docs distinguish
// EXPECTED ("Status is expected") from SUCCESS — an expected-but-never-reported
// status must not satisfy the CI leg. https://docs.github.com/graphql/reference/enums#statusstate
const CLEAN_LEGACY_STATES = new Set(["SUCCESS"]);
const CLEAN_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * `gh pr view --json statusCheckRollup` mixes two shapes: legacy commit statuses
 * (`state`) and modern check runs (`status`/`conclusion`). Clean means EVERY item is
 * either a legacy SUCCESS/EXPECTED state, or a COMPLETED check run whose conclusion is
 * SUCCESS/NEUTRAL/SKIPPED. Anything still running, anything failed, any missing or
 * unrecognized conclusion/state value, and any unrecognized item shape is unclean —
 * fail-closed (a rollup format or value this function doesn't recognize must never
 * read as "clean").
 */
export function isRollupClean(rollup: RollupItem[]): boolean {
  // Empty rollup = NOT clean (codex P3 fix, 2026-07-31): "full CI green" requires
  // CI to exist. A caller repo with zero checks — or an unexpectedly-empty rollup
  // response — must queue for a human, not vacuously pass the CI leg. Repos without
  // CI never auto-merge; that is deliberate policy, not a bug.
  if (rollup.length === 0) return false;
  for (const item of rollup) {
    if (item.state !== undefined) {
      if (!CLEAN_LEGACY_STATES.has(item.state)) return false;
      continue;
    }
    if (item.status !== undefined) {
      if (item.status !== "COMPLETED") return false; // still running/queued
      if (!item.conclusion || !CLEAN_CONCLUSIONS.has(item.conclusion)) return false;
      continue;
    }
    // Unrecognized item shape — fail-closed rather than silently treating as clean.
    return false;
  }
  return true;
}
