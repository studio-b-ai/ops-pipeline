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
 * - `*.md` or anything under `docs/` → "doc" (path-based, content not inspected —
 *   matches the #279 amendment's "docs/comment-class" language literally).
 * - Otherwise "comment-only" iff every changed line (trimmed; blank lines pass
 *   through as harmless) starts with a comment marker for the file's extension.
 * - Unknown extension, OR zero changed lines to inspect (e.g. a pure rename with no
 *   content diff — nothing to positively classify as safe), OR any line that isn't a
 *   recognized comment prefix → "code". Fail-closed by construction.
 */
export function classifyDiffFile(path: string, addedLines: string[], removedLines: string[]): DiffFileClass {
  if (/\.md$/i.test(path) || /^docs\//.test(path)) return "doc";

  const ext = extensionOf(path);
  const markers = ext ? COMMENT_MARKERS[ext] : undefined;
  if (!markers) return "code"; // unknown extension (or no extension) — fail-closed

  const changed = [...addedLines, ...removedLines];
  if (changed.length === 0) return "code"; // nothing to positively verify as safe

  const allCommentOrBlank = changed.every((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return true;
    return markers.some((marker) => trimmed.startsWith(marker));
  });

  return allCommentOrBlank ? "comment-only" : "code";
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

const UNCLEAN_LEGACY_STATES = new Set(["FAILURE", "ERROR", "PENDING"]);
const UNCLEAN_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

/**
 * `gh pr view --json statusCheckRollup` mixes two shapes: legacy commit statuses
 * (`state`) and modern check runs (`status`/`conclusion`). Clean means EVERY item is
 * either a legacy SUCCESS/EXPECTED state, or a COMPLETED check run whose conclusion is
 * SUCCESS/NEUTRAL/SKIPPED. Anything still running, anything failed, and any
 * unrecognized shape is unclean — fail-closed (a rollup format this function doesn't
 * recognize must never read as "clean").
 */
export function isRollupClean(rollup: RollupItem[]): boolean {
  for (const item of rollup) {
    if (item.state !== undefined) {
      if (UNCLEAN_LEGACY_STATES.has(item.state)) return false;
      continue;
    }
    if (item.status !== undefined) {
      if (item.status !== "COMPLETED") return false; // still running/queued
      if (item.conclusion && UNCLEAN_CONCLUSIONS.has(item.conclusion)) return false;
      continue;
    }
    // Unrecognized item shape — fail-closed rather than silently treating as clean.
    return false;
  }
  return true;
}
