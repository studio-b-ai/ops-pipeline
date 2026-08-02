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
// ───────────────────────────── PR-level diff-class resolution (gate v2) ─────────────────────────────
//
// Widens the #279 gate with TWO new mutually-exclusive classes beyond the original
// docs-comment class (Kevin-approved 2026-08-02): ci-infra and test-only. Approved
// terms, exactly. `classifyPrDiffClass` resolves AT MOST ONE class per PR — a diff
// whose files don't ALL match one class's shape resolves to `prClass: null` (never a
// partial/best-effort merge across classes). docs-comment is checked FIRST and is
// completely UNCHANGED from the original #279 gate (same `classifyDiffFile`
// per-file result, same <=10-line cap) — this function only ADDS two more candidates
// evaluated after it, so every existing docs-comment decision is byte-identical to
// before.

export type PrDiffClass = "docs-comment" | "ci-infra" | "test-only";

const DOCS_COMMENT_LINE_CAP = MAX_CHANGED_LINES; // 10, unchanged
const CI_INFRA_LINE_CAP = 40;
const TEST_ONLY_LINE_CAP = 40;

// Allowlist, not a denylist — same rationale as CLEAN_LEGACY_STATES/CLEAN_CONCLUSIONS
// above: only these path shapes count as CI infrastructure, so an unrecognized
// CI-adjacent path never guesses its way into a lower-scrutiny class. Deliberately
// scoped to DECLARATIVE workflow/action YAML only (`.ya?ml$`) — a JS/TS/shell file
// inside `.github/actions/**` is executable code, not config, and must NOT qualify
// even though it lives under the same directory tree.
const CI_INFRA_DIR_PATTERNS: RegExp[] = [/^\.github\/workflows\//, /^\.github\/actions\//];

function isCiInfraPath(path: string): boolean {
  if (!/\.ya?ml$/i.test(path)) return false;
  return CI_INFRA_DIR_PATTERNS.some((re) => re.test(path));
}

// Test-file allowlist — mirrors this repo's own vitest convention
// (scripts/lib/__tests__/*.test.ts) plus the other dominant JS test-naming family
// (*.spec.*) so the class isn't accidentally scoped to just this repo's style. A
// path under any `__tests__/` directory counts regardless of its own extension
// (fixtures/mocks living alongside spec files are test-scoped code, never shipped
// runtime code) — this is also what makes `src/__tests__/**` correctly read as TEST
// or a `src/**` runtime file, per the mission spec's own worked example.
const TEST_FILE_PATTERNS: RegExp[] = [/(^|\/)__tests__\//, /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/];

const TEST_CONFIG_BASENAMES = new Set([
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
  "vitest.setup.ts",
  "vitest.setup.js",
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "jest.setup.ts",
  "jest.setup.js",
  "setupTests.ts",
  "setupTests.js",
]);

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function isTestFilePath(path: string): boolean {
  if (TEST_CONFIG_BASENAMES.has(basenameOf(path))) return true;
  return TEST_FILE_PATTERNS.some((re) => re.test(path));
}

function isUnderSrc(path: string): boolean {
  return path === "src" || path.startsWith("src/");
}

// Any dependency-change signal disqualifies BOTH new classes — neither class reasons
// about dependency safety, so any manifest/lockfile file present is fail-closed out
// of scope for them (Rule #289's bump-PR class is a SEPARATE, unrelated concern).
const PACKAGE_MANIFEST_OR_LOCKFILE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

function isPackageManifestOrLockfile(path: string): boolean {
  return PACKAGE_MANIFEST_OR_LOCKFILE_BASENAMES.has(basenameOf(path));
}

// Broad and case-insensitive ON PURPOSE: fail-closed means erring toward EXCLUDING a
// file from these classes, never including one — a generous match here only ever
// costs "this PR waits for a human" (migrations are append-only and load-bearing;
// neither new class is equipped to reason about migration safety).
function isMigrationPath(path: string): boolean {
  return /migrat/i.test(path);
}

interface CandidateEval {
  prClass: PrDiffClass;
  /** Every file/dependency/migration shape requirement EXCEPT the line cap. */
  shapeOk: boolean;
  lineCapOk: boolean;
  cap: number;
  shapeReasons: string[];
}

function evalDocsComment(files: GateFile[], totalChangedLines: number): CandidateEval {
  const nonDocComment = files.filter((f) => f.fileClass !== "doc" && f.fileClass !== "comment-only");
  const shapeOk = nonDocComment.length === 0;
  return {
    prClass: "docs-comment",
    shapeOk,
    lineCapOk: totalChangedLines <= DOCS_COMMENT_LINE_CAP,
    cap: DOCS_COMMENT_LINE_CAP,
    shapeReasons: shapeOk ? [] : [`docs-comment: code-class file(s): ${nonDocComment.map((f) => f.path).join(", ")}`],
  };
}

function evalCiInfra(files: GateFile[], totalChangedLines: number): CandidateEval {
  const nonCiInfra = files.filter((f) => !isCiInfraPath(f.path));
  // `srcFiles` is structurally redundant with `nonCiInfra` today (no `.github/**`
  // path can also start with `src/`) — kept as an explicit, independent check per
  // spec anyway: a defense-in-depth backstop that survives even if
  // CI_INFRA_DIR_PATTERNS is ever loosened to a broader glob later.
  const srcFiles = files.filter((f) => isUnderSrc(f.path));
  const packageFiles = files.filter((f) => isPackageManifestOrLockfile(f.path));
  const migrationFiles = files.filter((f) => isMigrationPath(f.path));
  const shapeOk = nonCiInfra.length === 0 && srcFiles.length === 0 && packageFiles.length === 0 && migrationFiles.length === 0;
  const shapeReasons: string[] = [];
  if (nonCiInfra.length > 0) shapeReasons.push(`ci-infra: non-CI-infra file(s): ${nonCiInfra.map((f) => f.path).join(", ")}`);
  if (srcFiles.length > 0) shapeReasons.push(`ci-infra: file(s) under src/**: ${srcFiles.map((f) => f.path).join(", ")}`);
  if (packageFiles.length > 0) shapeReasons.push(`ci-infra: package manifest/lockfile change(s): ${packageFiles.map((f) => f.path).join(", ")}`);
  if (migrationFiles.length > 0) shapeReasons.push(`ci-infra: migration file(s): ${migrationFiles.map((f) => f.path).join(", ")}`);
  return { prClass: "ci-infra", shapeOk, lineCapOk: totalChangedLines <= CI_INFRA_LINE_CAP, cap: CI_INFRA_LINE_CAP, shapeReasons };
}

function evalTestOnly(files: GateFile[], totalChangedLines: number): CandidateEval {
  const nonTestFiles = files.filter((f) => !isTestFilePath(f.path));
  // `srcRuntimeFiles` ⊆ `nonTestFiles` always (any src/** file that isn't a test file
  // is already a non-test file) — kept as an explicit, independently-named check
  // because the mission spec calls out "ZERO src/** runtime files" as its own
  // requirement distinct from "every file is a test file", and because it gives the
  // ci-infra/test-only telemetry reasons a src/**-specific string to point at.
  const srcRuntimeFiles = files.filter((f) => isUnderSrc(f.path) && !isTestFilePath(f.path));
  const packageFiles = files.filter((f) => isPackageManifestOrLockfile(f.path));
  const migrationFiles = files.filter((f) => isMigrationPath(f.path));
  const shapeOk = nonTestFiles.length === 0 && srcRuntimeFiles.length === 0 && packageFiles.length === 0 && migrationFiles.length === 0;
  const shapeReasons: string[] = [];
  if (nonTestFiles.length > 0) shapeReasons.push(`test-only: non-test file(s): ${nonTestFiles.map((f) => f.path).join(", ")}`);
  if (srcRuntimeFiles.length > 0) shapeReasons.push(`test-only: src/** runtime file(s): ${srcRuntimeFiles.map((f) => f.path).join(", ")}`);
  if (packageFiles.length > 0) shapeReasons.push(`test-only: package manifest/lockfile change(s): ${packageFiles.map((f) => f.path).join(", ")}`);
  if (migrationFiles.length > 0) shapeReasons.push(`test-only: migration file(s): ${migrationFiles.map((f) => f.path).join(", ")}`);
  return { prClass: "test-only", shapeOk, lineCapOk: totalChangedLines <= TEST_ONLY_LINE_CAP, cap: TEST_ONLY_LINE_CAP, shapeReasons };
}

export interface ClassifyPrDiffClassInput {
  /** Every changed file's path AND its existing doc|comment-only|code file class
   *  (from classifyDiffFile/reconcileFileClasses) — reused as-is for the unchanged
   *  docs-comment candidate so its behavior stays byte-identical to before this
   *  file existed. */
  files: GateFile[];
  totalChangedLines: number;
  /** Caller-supplied regex sources (matched against each file's path) for paths this
   *  repo considers sensitive enough to require a human regardless of shape/line-cap
   *  fit — e.g. a repo whose "Require review label" branch-protection gate is NOT
   *  independently verifiable from `statusCheckRollup` (composition can't be
   *  guaranteed fail-closed per-check) excludes those paths from classification
   *  entirely here instead. ANY file matching ANY pattern forces `prClass: null`
   *  with `failureLeg: "class-match"`, no matter how small or otherwise-qualifying
   *  the rest of the diff is. Optional; omitted/empty = no additional exclusion
   *  (byte-identical to before this field existed).
   */
  sensitivePathPatterns?: string[];
}

export interface ClassifyPrDiffClassResult {
  prClass: PrDiffClass | null;
  /** Populated only when prClass is null: which telemetry bucket the failure belongs
   *  to. "class-match" = no candidate's file/path/dependency/migration SHAPE matched
   *  at all (includes fully mixed diffs, e.g. a workflow file AND a test file
   *  together — neither candidate's "every file matches" requirement survives that).
   *  "line-cap" = at least one candidate's shape fully matched but its line cap was
   *  exceeded. Never both — line-cap is reported only when class-match would NOT
   *  have fired. */
  failureLeg: "class-match" | "line-cap" | null;
  reasons: string[];
}

/**
 * Resolves which (if any) of the THREE mutually-exclusive PR-level diff classes a
 * PR's file set qualifies for. Exactly one class per PR: a diff spanning two
 * classes' file shapes (e.g. a workflow file AND a test file together) satisfies
 * NEITHER candidate's "every file matches" requirement and resolves to `prClass:
 * null` — never a best-effort partial match, and never two classes at once.
 *
 * Candidates are evaluated in priority order [docs-comment, ci-infra, test-only] and
 * the FIRST fully-qualifying one (shape AND line cap) wins — in practice at most one
 * candidate can ever fully qualify for a given file set, since the three shape rules
 * are mutually exclusive by construction (docs-comment requires content-classified
 * doc|comment-only; ci-infra requires `.github/{workflows,actions}/**.y(a)ml` paths;
 * test-only requires test-file paths) with one narrow overlap: a comment-only-content
 * `.yml` change under `.github/workflows/` can shape-match BOTH docs-comment and
 * ci-infra — priority order picks docs-comment when it ALSO fits under 10 lines,
 * otherwise ci-infra can still win up to 40 lines. This is intentional: the smaller,
 * longest-proven class gets first refusal.
 */
export function classifyPrDiffClass(input: ClassifyPrDiffClassInput): ClassifyPrDiffClassResult {
  const { files, totalChangedLines, sensitivePathPatterns } = input;

  if (files.length === 0) {
    return { prClass: null, failureLeg: "class-match", reasons: ["no changed files"] };
  }

  if (sensitivePathPatterns && sensitivePathPatterns.length > 0) {
    // A malformed regex source (caller misconfiguration) must NEVER throw out of this
    // function and must NEVER be silently ignored (treating a broken pattern as "no
    // exclusion" would defeat the exact fail-closed guarantee this parameter exists
    // for) — it fails closed exactly like a real sensitive-path hit: prClass: null.
    let sensitiveRes: RegExp[];
    try {
      sensitiveRes = sensitivePathPatterns.map((src) => new RegExp(src));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        prClass: null,
        failureLeg: "class-match",
        reasons: [`invalid sensitivePathPatterns regex (fail-closed): ${message}`],
      };
    }
    const sensitiveFiles = files.filter((f) => sensitiveRes.some((re) => re.test(f.path)));
    if (sensitiveFiles.length > 0) {
      return {
        prClass: null,
        failureLeg: "class-match",
        reasons: [`sensitive path(s) excluded from classification: ${sensitiveFiles.map((f) => f.path).join(", ")}`],
      };
    }
  }

  const candidates: CandidateEval[] = [
    evalDocsComment(files, totalChangedLines),
    evalCiInfra(files, totalChangedLines),
    evalTestOnly(files, totalChangedLines),
  ];

  const fullMatch = candidates.find((c) => c.shapeOk && c.lineCapOk);
  if (fullMatch) {
    return { prClass: fullMatch.prClass, failureLeg: null, reasons: [] };
  }

  const reasons: string[] = [];
  let anyShapeMatched = false;
  for (const c of candidates) {
    if (!c.shapeOk) {
      reasons.push(...c.shapeReasons);
      continue;
    }
    anyShapeMatched = true;
    reasons.push(`${c.prClass}: totalChangedLines ${totalChangedLines} > ${c.cap}`);
  }

  return { prClass: null, failureLeg: anyShapeMatched ? "line-cap" : "class-match", reasons };
}

// ───────────────────────────── class-aware gate decision (gate v2) ─────────────────────────────

export interface GateInputV2 {
  prClass: PrDiffClass;
  author: string;
  labels: string[];
  ciClean: boolean;
  reviewVerdict: "CLEAN" | "FLAG";
}

/**
 * The universal legs that apply to EVERY class identically — author, label, CI
 * clean, independent review — exactly as `gateDecision` enforces them today. The
 * file-shape and line-cap legs are NOT re-checked here: `classifyPrDiffClass` already
 * enforces them as a PRECONDITION of `prClass` being non-null, so re-checking a
 * generic "files" list here would either duplicate that work or (worse) require
 * reconstructing per-class file predicates a second time. `gateDecision` (the
 * original, file-based function above) is UNCHANGED and still fully exported/tested
 * for the record — this is a parallel, class-aware entry point, not a replacement.
 */
export function gateDecisionForClass(input: GateInputV2): GateResult {
  const reasons: string[] = [];

  if (input.author !== BUGSQUASHER_AUTHOR) {
    reasons.push(`author '${input.author}' !== '${BUGSQUASHER_AUTHOR}'`);
  }
  if (!input.labels.includes(BUGSQUASHER_LABEL)) {
    reasons.push(`missing '${BUGSQUASHER_LABEL}' label (has: ${input.labels.length ? input.labels.join(", ") : "none"})`);
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
