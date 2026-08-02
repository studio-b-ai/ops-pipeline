#!/usr/bin/env tsx
/**
 * pr-automerge-gate.ts — CLAUDE.md Rule #279 amendment (Kevin-approved 2026-07-30),
 * widened to gate v2 (Kevin-approved 2026-08-02): the ONE narrow, explicitly-scoped
 * exception to the never-auto-merge law (#97).
 *
 * Auto-merge fires ONLY for bug-squasher CCR pull requests that pass EVERY leg below.
 * ANY doubt anywhere in this pipeline resolves to "wait" — the PR simply waits for a
 * human, which is the normal, unremarkable outcome (never a red CI run for "waiting").
 *
 * Legs (ALL required):
 *   1. PR is OPEN, `mergeStateStatus === "CLEAN"`, and every CI check is green
 *      (`isRollupClean`) — checked FIRST and cheaply, before any diff fetch or API
 *      spend (Rule #88: probe before committing spend).
 *   2. the PR's file set resolves to EXACTLY ONE PR-level diff class
 *      (`classifyPrDiffClass` — scripts/lib/automerge-classify.ts): docs-comment
 *      (<=10 lines, every file doc|comment-only, unchanged from the original #279
 *      gate), ci-infra (<=40 lines, every file a declarative `.github/{workflows,
 *      actions}/**.y(a)ml` path, no src/**, no dependency/migration files), or
 *      test-only (<=40 lines, every file a test file/setup, zero src/** RUNTIME
 *      files, no dependency/migration files). A mixed-shape diff (e.g. a workflow
 *      file AND a test file together) satisfies no candidate and resolves to `null`
 *      — never a partial/best-effort merge across classes.
 *   3. the resolved class is in THIS CALLER's `--enabled-classes` set (defaults to
 *      `docs-comment` ONLY — a caller that never passes `--enabled-classes` gets
 *      EXACTLY the original #279 gate's scope, unchanged; opting into ci-infra/
 *      test-only is an explicit per-repo choice, not a side effect of this file
 *      changing).
 *   4. author === kbibelhausen
 *   5. label `bugsquasher` present
 *   6. independent review: the ENTIRE raw diff is sent to Claude Sonnet 5, with a
 *      class-aware system prompt (`reviewSystemPromptFor` — test-only adds an extra
 *      assertion-weakening question), which must return exactly the string `CLEAN`
 *      (strict, case-sensitive) or the whole leg is FLAG. ANY API error (network,
 *      auth, rate limit, malformed response) is ALSO FLAG — fail-closed, never
 *      silently treated as clean.
 *
 * Cost discipline: legs 2-5 are cheap (already-fetched PR metadata + a diff parse)
 * and are evaluated BEFORE the paid Anthropic API call. If any of them already fail,
 * the decision is "wait" and the review call never fires.
 *
 * TOCTOU safety: the merge call is SHA-pinned to the `headRefOid` captured at
 * evaluation time (`gh pr merge --match-head-commit`). If the PR's head moves between
 * evaluation and merge (a human pushes, another agent pushes), the merge call FAILS
 * instead of squashing a diff nobody reviewed — that failure is CORRECT behavior, not
 * a bug. The next scheduled/triggered run re-evaluates the new head from scratch.
 *
 * Telemetry (gate v2): every evaluation emits ONE structured `[gate-receipt]` log
 * line (`formatGateReceiptLine` — scripts/lib/automerge-telemetry.ts) to stdout —
 * PR number, resolved class (or "unclassified"), verdict, and on a miss, which leg
 * failed first. Log-based only: no new storage, no Slack, no issues.
 *
 * This script NEVER closes, labels, or edits a PR beyond the merge itself and one
 * machine-readable receipt comment on successful merge. It never retries a failed
 * merge attempt in the same run (composes #109/#161: undiagnosed retries are how one
 * failure becomes a compounded one).
 *
 * Usage: tsx pr-automerge-gate.ts --repo <org/repo> --pr <n>
 *   [--enabled-classes docs-comment,ci-infra,test-only] [--sensitive-path <regex>]...
 * Secrets: GH_TOKEN (gh CLI auth), ANTHROPIC_API_KEY (independent review leg).
 */

import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import {
  classifyPrDiffClass,
  gateDecisionForClass,
  isRollupClean,
  reconcileFileClasses,
  type GateFile,
  type ParsedDiffFile,
  type PrDiffClass,
  type RollupItem,
} from "./lib/automerge-classify.js";
import { reviewSystemPromptFor } from "./lib/automerge-review-prompt.js";
import { formatGateReceiptLine, type GateReceiptLeg } from "./lib/automerge-telemetry.js";

const REVIEW_MODEL = "claude-sonnet-5";
const REVIEW_MAX_TOKENS = 512;

// ───────────────────────────── CLI args ─────────────────────────────

const ALL_PR_DIFF_CLASSES: PrDiffClass[] = ["docs-comment", "ci-infra", "test-only"];

interface Args {
  repo: string;
  pr: number;
  /** Defaults to ["docs-comment"] — a caller that never passes this flag (e.g.
   *  studiob's existing, unmodified caller workflow) gets EXACTLY the original #279
   *  gate's scope. Opting into ci-infra/test-only is explicit, per repo. */
  enabledClasses: PrDiffClass[];
  /** Forwarded verbatim to classifyPrDiffClass's sensitivePathPatterns — for callers
   *  whose branch-protection gates aren't independently verifiable from
   *  statusCheckRollup (see the bolt-wms canary caller). */
  sensitivePathPatterns: string[];
}

function parseArgs(argv: string[]): Args {
  let repo: string | undefined;
  let pr: number | undefined;
  let enabledClassesRaw: string | undefined;
  const sensitivePathPatterns: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--pr") pr = Number(argv[++i]);
    else if (argv[i] === "--enabled-classes") enabledClassesRaw = argv[++i];
    else if (argv[i] === "--sensitive-path") sensitivePathPatterns.push(argv[++i]);
  }
  if (!repo) throw new Error("--repo <org/repo> is required");
  if (!pr || !Number.isFinite(pr) || pr <= 0) throw new Error("--pr <n> is required");

  let enabledClasses: PrDiffClass[];
  if (enabledClassesRaw === undefined || enabledClassesRaw.trim() === "") {
    enabledClasses = ["docs-comment"];
  } else {
    const requested = enabledClassesRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const invalid = requested.filter((c) => !ALL_PR_DIFF_CLASSES.includes(c as PrDiffClass));
    if (invalid.length > 0) {
      throw new Error(`--enabled-classes contains unknown class(es): ${invalid.join(", ")} (valid: ${ALL_PR_DIFF_CLASSES.join(", ")})`);
    }
    enabledClasses = requested as PrDiffClass[];
  }

  return { repo, pr, enabledClasses, sensitivePathPatterns };
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

async function independentReview(diff: string, systemPrompt: string): Promise<{ verdict: ReviewVerdict; detail: string }> {
  try {
    const client = new Anthropic(); // resolves ANTHROPIC_API_KEY from env
    const response = await client.messages.create({
      model: REVIEW_MODEL,
      max_tokens: REVIEW_MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: systemPrompt,
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

async function evaluate(repo: string, pr: number, enabledClasses: PrDiffClass[], sensitivePathPatterns: string[]): Promise<void> {
  const prJson = fetchPr(repo, pr);
  const author = prJson.author.login;
  const labels = prJson.labels.map((l) => l.name);
  const totalChangedLines = prJson.additions + prJson.deletions;
  const ciClean = isRollupClean(prJson.statusCheckRollup);

  // ── Leg "ci-rollup" (cheap, no diff fetch, no API spend): state + CI + merge readiness ──
  if (prJson.state !== "OPEN" || !ciClean || prJson.mergeStateStatus !== "CLEAN") {
    const detail = `state=${prJson.state} ciClean=${ciClean} mergeStateStatus=${prJson.mergeStateStatus}`;
    console.log(`[wait] pr-automerge-gate ${repo}#${pr}: short-circuit — ${detail}. No diff fetch, no review call.`);
    console.log(
      formatGateReceiptLine({ repo, pr, prClass: "unclassified", verdict: "missed", leg: "ci-rollup", reasons: [detail] }),
    );
    return;
  }

  // ── Diff fetch + per-file classification (unchanged mechanics) — BEFORE any API spend ──
  const diff = fetchDiffBySha(repo, prJson.baseRefName, prJson.headRefOid);
  const parsed = parseUnifiedDiff(diff);
  // Reconcile against the PR's own AUTHORITATIVE file list (prJson.files), not just
  // whatever the diff parser happened to find hunks for — a pure rename or mode-only
  // change has no content hunks and would otherwise silently vanish from `files`
  // instead of fail-closing to "code" (codex P1 finding, 2026-07-30 review).
  const authoritativePaths = prJson.files.map((f) => f.path);
  const files: GateFile[] = reconcileFileClasses(authoritativePaths, parsed);

  // ── Leg "class-match"/"line-cap": resolve the PR-level diff class ──
  const classification = classifyPrDiffClass({ files, totalChangedLines, sensitivePathPatterns });
  if (classification.prClass === null) {
    const leg: GateReceiptLeg = classification.failureLeg ?? "other";
    console.log(`[wait] pr-automerge-gate ${repo}#${pr}: no diff class resolved (${leg}) — ` + classification.reasons.join("; "));
    console.log(
      formatGateReceiptLine({ repo, pr, prClass: "unclassified", verdict: "missed", leg, reasons: classification.reasons }),
    );
    return;
  }
  const prClass = classification.prClass;

  if (!enabledClasses.includes(prClass)) {
    const reason = `class '${prClass}' resolved but is not in this caller's --enabled-classes set (${enabledClasses.join(", ")})`;
    console.log(`[wait] pr-automerge-gate ${repo}#${pr}: ${reason}`);
    console.log(
      formatGateReceiptLine({ repo, pr, prClass: "unclassified", verdict: "missed", leg: "class-match", reasons: [reason] }),
    );
    return;
  }

  // ── Cheap universal legs (author/label) — BEFORE any API spend ──
  const cheapCheck = gateDecisionForClass({
    prClass,
    author,
    labels,
    ciClean,
    reviewVerdict: "CLEAN", // best-case placeholder — the ONLY leg not yet evaluated
  });

  if (cheapCheck.decision === "wait") {
    console.log(
      `[wait] pr-automerge-gate ${repo}#${pr}: cheap legs failed (review NOT invoked — no spend): ` + cheapCheck.reasons.join("; "),
    );
    console.log(formatGateReceiptLine({ repo, pr, prClass, verdict: "missed", leg: "other", reasons: cheapCheck.reasons }));
    return;
  }

  // ── Paid leg: independent review — every other leg already passes, class-aware prompt ──
  const review = await independentReview(diff, reviewSystemPromptFor(prClass));

  const finalCheck = gateDecisionForClass({
    prClass,
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
    console.log(formatGateReceiptLine({ repo, pr, prClass, verdict: "missed", leg: "review", reasons: finalCheck.reasons }));
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
    // No [gate-receipt] line here: the gate itself QUALIFIED (every leg passed) — this
    // is an operational merge-attempt failure, not a gate miss, and the original
    // #279 gate never emitted a receipt for it either (no PR comment on this path).
    return;
  }

  const receipt = [
    `**squasher auto-merge gate — MERGED** (class: \`${prClass}\`; gate v2, Kevin-approved 2026-08-02)`,
    "",
    "| Leg | Result |",
    "|---|---|",
    `| diff class | ✅ \`${prClass}\` |`,
    `| author === kbibelhausen | ✅ (${author}) |`,
    `| label \`bugsquasher\` present | ✅ (${labels.join(", ")}) |`,
    `| totalChangedLines | ✅ (${totalChangedLines}) |`,
    `| CI clean | ✅ |`,
    `| independent review (Claude Sonnet 5) | ✅ CLEAN |`,
    "",
    `Evaluated sha: \`${prJson.headRefOid}\` (merge was SHA-pinned via \`--match-head-commit\`).`,
  ].join("\n");

  commentOnPr(repo, pr, receipt);
  console.log(formatGateReceiptLine({ repo, pr, prClass, verdict: "qualified" }));
  console.log(`[merged] pr-automerge-gate ${repo}#${pr}: all legs passed, squash-merged at ${prJson.headRefOid}.`);
}

/**
 * Fail-closed safety net (gate v2): ANY unexpected error thrown during evaluation
 * (a malformed --sensitive-path regex slipping past classifyPrDiffClass's own
 * internal guard, a `gh`/API call throwing, anything unforeseen) emits ONE
 * `[gate-receipt] ... verdict=missed leg=other` line BEFORE the error propagates and
 * the process exits non-zero — the telemetry contract holds even on a crash: a
 * `[gate-receipt]` line NEVER reads `verdict=qualified` unless the gate actually
 * merged the PR. The loud non-zero exit is preserved (this is a genuine
 * misconfiguration/bug worth a red CI run), not swallowed into a silent "wait".
 */
async function main(): Promise<void> {
  const { repo, pr, enabledClasses, sensitivePathPatterns } = parseArgs(process.argv.slice(2));
  try {
    await evaluate(repo, pr, enabledClasses, sensitivePathPatterns);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      formatGateReceiptLine({ repo, pr, prClass: "unclassified", verdict: "missed", leg: "other", reasons: [`unexpected error: ${message}`] }),
    );
    throw err;
  }
}

main().catch((err) => {
  console.error(`pr-automerge-gate failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
