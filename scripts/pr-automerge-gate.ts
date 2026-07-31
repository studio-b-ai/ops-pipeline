#!/usr/bin/env tsx
/**
 * pr-automerge-gate.ts — CLAUDE.md Rule #279 amendment (Kevin-approved 2026-07-30):
 * the ONE narrow, explicitly-scoped exception to the never-auto-merge law (#97).
 *
 * Auto-merge fires ONLY for bug-squasher CCR pull requests that pass EVERY leg below.
 * ANY doubt anywhere in this pipeline resolves to "wait" — the PR simply waits for a
 * human, which is the normal, unremarkable outcome (never a red CI run for "waiting").
 *
 * Legs (ALL required — scripts/lib/automerge-classify.ts `gateDecision`):
 *   1. PR is OPEN, `mergeStateStatus === "CLEAN"`, and every CI check is green
 *      (`isRollupClean`) — checked FIRST and cheaply, before any diff fetch or API
 *      spend (Rule #88: probe before committing spend).
 *   2. author === kbibelhausen
 *   3. label `bugsquasher` present
 *   4. every changed file classifies doc|comment-only (`classifyDiffFile` — fail-
 *      closed on unknown extensions, binary files, and zero-content diffs)
 *   5. total changed lines (additions+deletions, GitHub's own count) <= 10
 *   6. independent review: the ENTIRE raw diff is sent to Claude Sonnet 5, which must
 *      return exactly the string `CLEAN` (strict, case-sensitive) or the whole leg is
 *      FLAG. ANY API error (network, auth, rate limit, malformed response) is ALSO
 *      FLAG — fail-closed, never silently treated as clean.
 *
 * Cost discipline: legs 2-5 are cheap (already-fetched PR metadata + a diff parse) and
 * are evaluated BEFORE the paid Anthropic API call. If any of them already fail, the
 * decision is "wait" and the review call never fires — there is no point paying for a
 * review of a PR that cannot merge for other reasons.
 *
 * TOCTOU safety: the merge call is SHA-pinned to the `headRefOid` captured at
 * evaluation time (`gh pr merge --match-head-commit`). If the PR's head moves between
 * evaluation and merge (a human pushes, another agent pushes), the merge call FAILS
 * instead of squashing a diff nobody reviewed — that failure is CORRECT behavior, not
 * a bug. The next scheduled/triggered run re-evaluates the new head from scratch.
 *
 * This script NEVER closes, labels, or edits a PR beyond the merge itself and one
 * machine-readable receipt comment on successful merge. It never retries a failed
 * merge attempt in the same run (composes #109/#161: undiagnosed retries are how one
 * failure becomes a compounded one).
 *
 * Usage: tsx pr-automerge-gate.ts --repo <org/repo> --pr <n>
 * Secrets: GH_TOKEN (gh CLI auth), ANTHROPIC_API_KEY (independent review leg).
 */

import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import {
  gateDecision,
  isRollupClean,
  reconcileFileClasses,
  type GateFile,
  type ParsedDiffFile,
  type RollupItem,
} from "./lib/automerge-classify.js";

const REVIEW_MODEL = "claude-sonnet-5";
const REVIEW_MAX_TOKENS = 512;

// ───────────────────────────── CLI args ─────────────────────────────

interface Args {
  repo: string;
  pr: number;
}

function parseArgs(argv: string[]): Args {
  let repo: string | undefined;
  let pr: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--pr") pr = Number(argv[++i]);
  }
  if (!repo) throw new Error("--repo <org/repo> is required");
  if (!pr || !Number.isFinite(pr) || pr <= 0) throw new Error("--pr <n> is required");
  return { repo, pr };
}

// ───────────────────────────── gh helpers ─────────────────────────────

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

interface PrAuthor {
  login: string;
}

interface PrLabel {
  name: string;
}

interface PrFile {
  path: string;
}

interface PrJson {
  author: PrAuthor;
  labels: PrLabel[];
  state: string; // OPEN | CLOSED | MERGED
  mergeStateStatus: string; // CLEAN | BEHIND | BLOCKED | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE
  additions: number;
  deletions: number;
  headRefOid: string;
  baseRefName: string;
  statusCheckRollup: RollupItem[];
  files: PrFile[];
}

function fetchPr(repo: string, pr: number): PrJson {
  const out = gh([
    "pr", "view", String(pr), "--repo", repo,
    "--json", "author,labels,state,mergeStateStatus,additions,deletions,headRefOid,baseRefName,statusCheckRollup,files",
  ]);
  return JSON.parse(out) as PrJson;
}

/**
 * Fetch the diff BY PINNED SHA, not by PR number (codex P1 ABA fix, 2026-07-31):
 * `gh pr diff <n>` resolves the PR's CURRENT head at call time — an attacker could
 * push benign commit B (which gets reviewed), then force-push evaluated commit A
 * back before the `--match-head-commit A` merge: A merges having had B reviewed.
 * Deriving the diff from `compare/<base>...<headRefOid>` makes the reviewed bytes a
 * pure function of the SAME sha the merge is pinned to — the race is closed by
 * construction, not by timing.
 */
function fetchDiffBySha(repo: string, baseRefName: string, headRefOid: string): string {
  return gh([
    "api", `repos/${repo}/compare/${encodeURIComponent(baseRefName)}...${headRefOid}`,
    "-H", "Accept: application/vnd.github.diff",
  ]);
}

function mergePr(repo: string, pr: number, headRefOid: string): void {
  gh(["pr", "merge", String(pr), "--repo", repo, "--squash", "--match-head-commit", headRefOid]);
}

function commentOnPr(repo: string, pr: number, body: string): void {
  gh(["pr", "comment", String(pr), "--repo", repo, "--body", body]);
}

// ───────────────────────────── diff parsing ─────────────────────────────

function stripAbPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/**
 * Parses a unified diff (as produced by `gh pr diff`) into one entry per file, each
 * carrying the raw content of every added/removed line (leading +/- stripped).
 *
 * Binary files ("Binary files a/x and b/x differ" — no +++/--- hunk lines) are
 * captured with `binary: true` and no content lines. `classifyDiffFile` (via
 * `reconcileFileClasses`) checks that flag FIRST and always returns "code" for it,
 * regardless of path — a binary diff must never silently pass as doc/comment-only
 * just because it happens to live under `docs/` (codex P2 finding, 2026-07-30
 * review).
 *
 * This function does NOT itself decide which files "count" — a pure rename or
 * mode-only change produces zero hunks and is simply absent from the returned list.
 * `reconcileFileClasses` in the caller closes that gap by reconciling against the
 * PR's own AUTHORITATIVE file list (`gh pr view --json files`) and fail-closing any
 * path missing from this parse to "code" (codex P1 finding, 2026-07-30 review).
 */
function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let added: string[] = [];
  let removed: string[] = [];
  let binary = false;

  function flush(): void {
    const path = newPath && newPath !== "/dev/null" ? newPath : oldPath;
    if (path && path !== "/dev/null") {
      files.push({ path, added, removed, binary });
    }
    oldPath = null;
    newPath = null;
    added = [];
    removed = [];
    binary = false;
  }

  // Header-zone tracking (codex P2 fix, 2026-07-31): `---`/`+++` lines are file
  // headers ONLY between a `diff --git` line and that file's first `@@` hunk. Inside
  // hunks, a changed content line can legitimately begin with those bytes (an added
  // `++counter;` renders as `+++counter;`) — without the zone gate such lines were
  // swallowed as phantom headers and vanished from classification (fail-open).
  let inHeaderZone = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      inHeaderZone = true;
      continue;
    }
    if (line.startsWith("@@")) {
      inHeaderZone = false;
      continue;
    }
    if (inHeaderZone && line.startsWith("--- ")) {
      oldPath = stripAbPrefix(line.slice(4).trim());
      continue;
    }
    if (inHeaderZone && line.startsWith("+++ ")) {
      newPath = stripAbPrefix(line.slice(4).trim());
      continue;
    }
    const binaryMatch = /^Binary files (.+) and (.+) differ$/.exec(line);
    if (binaryMatch) {
      newPath = stripAbPrefix(binaryMatch[2].trim());
      binary = true;
      continue;
    }
    if (line.startsWith("+")) {
      added.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      removed.push(line.slice(1));
      continue;
    }
  }
  flush();
  return files;
}

// ───────────────────────────── independent review leg ─────────────────────────────

type ReviewVerdict = "CLEAN" | "FLAG";

const REVIEW_SYSTEM = [
  "You are the FINAL automated review gate for a proposed auto-merge. You do not merge anything yourself — you only classify.",
  "You will be given the complete raw unified diff of a pull request.",
  "",
  "Respond with EXACTLY the single word CLEAN on the first line, and NOTHING else, if and ONLY if:",
  "  - every changed line is purely documentation (.md files, docs/ content), a code COMMENT, or user-visible copy/text, AND",
  "  - there is ZERO behavioral code change: no logic changes, no control-flow changes, no changed identifiers, function signatures, API/schema/config values, or anything that could change what the program DOES at runtime.",
  "",
  "Otherwise respond with FLAG on the first line, followed by one or more brief reasons on subsequent lines naming exactly what is not purely documentation/comment/copy.",
  "",
  "Do not merge, do not ask questions, do not add caveats or hedging — output only CLEAN, or FLAG plus reasons.",
].join("\n");

async function independentReview(diff: string): Promise<{ verdict: ReviewVerdict; detail: string }> {
  try {
    const client = new Anthropic(); // resolves ANTHROPIC_API_KEY from env
    const response = await client.messages.create({
      model: REVIEW_MODEL,
      max_tokens: REVIEW_MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: REVIEW_SYSTEM,
      // pg-enum-drift-exempt: this is the Anthropic Messages API request role
      // ("user" | "assistant" per the Claude API), not a Postgres wms_role column.
      messages: [{ role: "user", content: diff }],
    });

    if (response.stop_reason === "refusal") {
      return { verdict: "FLAG", detail: "review model refused (stop_reason: refusal) — fail-closed" };
    }

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const raw = (textBlock?.text ?? "").trim();

    // Strict parse (per spec): the ENTIRE trimmed response must be EXACTLY the string
    // "CLEAN" — not "CLEAN" as a prefix, not "CLEAN" plus trailing reasons on later
    // lines, not lowercase, not punctuated. Anything else is FLAG (codex P2 finding,
    // 2026-07-30 review: a prior version only checked the first line, which would
    // have accepted "CLEAN\n<unsolicited extra text>" as clean).
    if (raw === "CLEAN") {
      return { verdict: "CLEAN", detail: "CLEAN" };
    }
    return { verdict: "FLAG", detail: raw || "(empty response from review model)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { verdict: "FLAG", detail: `review API error (fail-closed): ${message}` };
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const { repo, pr } = parseArgs(process.argv.slice(2));

  const prJson = fetchPr(repo, pr);
  const author = prJson.author.login;
  const labels = prJson.labels.map((l) => l.name);
  const totalChangedLines = prJson.additions + prJson.deletions;
  const ciClean = isRollupClean(prJson.statusCheckRollup);

  // ── Leg 1 (cheap, no diff fetch, no API spend): state + CI + merge readiness ──
  if (prJson.state !== "OPEN" || !ciClean || prJson.mergeStateStatus !== "CLEAN") {
    console.log(
      `[wait] pr-automerge-gate ${repo}#${pr}: short-circuit — ` +
        `state=${prJson.state} ciClean=${ciClean} mergeStateStatus=${prJson.mergeStateStatus}. ` +
        `No diff fetch, no review call.`,
    );
    return;
  }

  // ── Cheap legs 2-5, computed from already-fetched data — BEFORE any API spend ──
  const diff = fetchDiffBySha(repo, prJson.baseRefName, prJson.headRefOid);
  const parsed = parseUnifiedDiff(diff);
  // Reconcile against the PR's own AUTHORITATIVE file list (prJson.files), not just
  // whatever the diff parser happened to find hunks for — a pure rename or mode-only
  // change has no content hunks and would otherwise silently vanish from `files`
  // instead of fail-closing to "code" (codex P1 finding, 2026-07-30 review).
  const authoritativePaths = prJson.files.map((f) => f.path);
  const files: GateFile[] = reconcileFileClasses(authoritativePaths, parsed);

  const cheapCheck = gateDecision({
    files,
    totalChangedLines,
    author,
    labels,
    ciClean,
    reviewVerdict: "CLEAN", // best-case placeholder — the ONLY leg not yet evaluated
  });

  if (cheapCheck.decision === "wait") {
    console.log(
      `[wait] pr-automerge-gate ${repo}#${pr}: cheap legs failed (review NOT invoked — no spend): ` +
        cheapCheck.reasons.join("; "),
    );
    return;
  }

  // ── Leg 6 (paid): independent review — every other leg already passes ──
  const review = await independentReview(diff);

  const finalCheck = gateDecision({
    files,
    totalChangedLines,
    author,
    labels,
    ciClean,
    reviewVerdict: review.verdict,
  });

  if (finalCheck.decision === "wait") {
    console.log(
      `[wait] pr-automerge-gate ${repo}#${pr}: review verdict ${review.verdict} — ` +
        finalCheck.reasons.join("; ") + ` | review detail: ${review.detail}`,
    );
    return;
  }

  // ── All legs pass — attempt the SHA-pinned merge ──
  try {
    mergePr(repo, pr, prJson.headRefOid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `[no-op] pr-automerge-gate ${repo}#${pr}: all legs passed but the merge call failed — ` +
        `most likely the head moved between evaluation and merge (TOCTOU race, --match-head-commit ` +
        `correctly rejected it) or a branch-protection rule blocked it. This is NOT retried in this ` +
        `run (Rules #109/#161) — the next scheduled/triggered run re-evaluates the current head. ` +
        `Underlying error: ${message}`,
    );
    return;
  }

  const receipt = [
    "**squasher auto-merge gate — MERGED** (Rule #279 amendment, Kevin-approved 2026-07-30)",
    "",
    "| Leg | Result |",
    "|---|---|",
    `| author === kbibelhausen | ✅ (${author}) |`,
    `| label \`bugsquasher\` present | ✅ (${labels.join(", ")}) |`,
    `| every file doc\\|comment-only | ✅ (${files.map((f) => `${f.path}:${f.fileClass}`).join(", ")}) |`,
    `| totalChangedLines <= 10 | ✅ (${totalChangedLines}) |`,
    `| CI clean | ✅ |`,
    `| independent review (Claude Sonnet 5) | ✅ CLEAN |`,
    "",
    `Evaluated sha: \`${prJson.headRefOid}\` (merge was SHA-pinned via \`--match-head-commit\`).`,
  ].join("\n");

  commentOnPr(repo, pr, receipt);
  console.log(`[merged] pr-automerge-gate ${repo}#${pr}: all legs passed, squash-merged at ${prJson.headRefOid}.`);
}

main().catch((err) => {
  console.error(`pr-automerge-gate failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
