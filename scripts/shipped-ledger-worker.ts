#!/usr/bin/env tsx
/**
 * shipped-ledger-worker.ts — ops-pipeline#162 (SHIPPED.md weekly PR-derived backfill,
 * CoS -> CTO 2026-08-18, Kevin's word via the GC: "a running record of what's been
 * accomplished the CMO can choose to feature as content"). Thin I/O glue around
 * scripts/lib/shipped-ledger-lib.ts — read THAT file's header first; no parse/classify/
 * plan/render decision lives here. This leg is the SAFETY NET: SHIPPED.md is fed
 * same-turn by every lane's `/wrap` step; this worker catches merged PRs that wraps miss.
 *
 * ── What this run does, every time ──
 *   1. Load `shipped-ledger-repos.yaml` (committed config — never written by this file).
 *   2. Read `studio-b-ai/brain`'s SHIPPED.md fresh from `main` via the Contents API
 *      (never a cached copy — Rule #238, the deploy/live state is truth, not a stale read).
 *   3. Per configured repo: derive that repo's watermark (`computeWatermark` — max of the
 *      config's seed cutoff and the newest date already ledgered for that repo, minus a
 *      7-day overlap), `gh pr list --state merged --search "merged:>=<watermark>"`, then
 *      per candidate PR: skip if already ledgered (dedup BEFORE spending a classifier
 *      call — cost discipline, Rule #88), else `classifyPr` (exclusion list -> PR labels
 *      -> Sonnet model, see the lib header for the full precedence).
 *   4. `planAppends` + `lintPlan` across every repo's kept entries. A non-empty lint
 *      result is FATAL regardless of dry-run/apply (issue #162: "the run fails LOUD if
 *      any appended line fails lint") — this worker never proposes or writes a
 *      grammar-invalid line.
 *   5. `--dry-run` (real reads throughout, Rule #376): prints the stats table + the
 *      proposed-additions table to stdout and (when set) `$GITHUB_STEP_SUMMARY`. ZERO
 *      writes anywhere.
 *   6. Apply (the default when `--dry-run` is omitted — mirrors repo-hygiene-worker.ts's
 *      own CLI convention): create-or-update `shipped-ledger/<YYYY-Www>` on
 *      `studio-b-ai/brain` via the Git Data + Contents APIs, then open-or-comment the PR
 *      (Rule #182: re-probe for an existing open PR on that branch before creating —
 *      NEVER a duplicate). This worker NEVER merges (#97) and NEVER writes anywhere other
 *      than that one branch on that one repo.
 *
 * ── Token dependency (today's real gap — see README) ──
 * The fleet App (`studiob-fleet-bot`) is minted with `issues:write` + `metadata:read`
 * only as of this writing. Reading merged PRs needs `pull_requests: read`; writing the
 * branch/file/PR on `studio-b-ai/brain` needs `contents: write` + `pull_requests: write`
 * GRANTED ON THAT REPO specifically (ops-pipeline#104 / #135, Kevin-gated). Per-repo READ
 * failures (403/404 today) are NOT fatal to the run — `processRepo` catches them, records
 * `readError`, and continues to the next repo; the stats table names every blind repo by
 * exact HTTP status (Rule #412 — no silent caps). Until brain's own write grant lands,
 * `--apply` runs will fail at `applyToLedgerRepo` (the branch/PUT/PR calls) with a loud,
 * named 403 — never a silent no-op.
 *
 * ── Commit sha vs blob sha (the one Git Data API gotcha worth flagging loudly) ──
 * `git/ref/heads/<branch>`'s `.object.sha` is the branch's COMMIT sha — the only thing
 * `git/refs` ref-creation accepts as its `sha` field. `contents/<path>?ref=<branch>`'s
 * `.sha` is that FILE's BLOB sha at that ref — the only thing the Contents API's PUT
 * accepts as ITS `sha` field (the optimistic-concurrency check). These are two different
 * SHAs of two different object types; `getBranchCommitSha` and `readLedgerContents` are
 * named and commented to keep that distinction impossible to blur at a call site.
 *
 * ── Local dry-run controls (`--since`) ──
 * `--since <ISO>` overrides EVERY repo's computed watermark with one fixed value — dry-run
 * ONLY (refused when combined with an apply run; see `parseArgs`). It exists solely so a
 * local control run can manufacture case (a) from the ship gate (Rules #464/#471: a known
 * human-visible PR not yet in the ledger) even when everything genuinely new since the
 * real watermark has already been swept.
 */

import { anthropicCredentialMode } from "./lib/anthropic-credentials.js";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import Anthropic from "@anthropic-ai/sdk";
import {
  parseLedger,
  classifyPr,
  planAppends,
  lintPlan,
  renderLedgerFile,
  renderDryRunTable,
  renderStatsTable,
  summarizeTotals,
  newestDateForRepo,
  computeWatermark,
  shortRepoName,
  ledgerKey,
  isoWeekLabel,
  buildClassifierSystemPrompt,
  buildClassifierPrompt,
  type ParsedLedger,
  type AppendPlan,
  type CandidatePr,
  type LedgerEntry,
  type RepoRunStats,
  type ClassifyFn,
} from "./lib/shipped-ledger-lib.js";
// Reused, not forked (Rule #283) — the SAME Contents-API response validation
// (type==="file" && encoding==="base64", Rule #465) backlog-compliance-worker.ts already
// established for reading studio-b-ai/brain over the Contents API; a second, subtly
// different copy here would be exactly the class of drift Rule #283 exists to prevent.
import { decodeContentsResponse } from "./lib/backlog-compliance-lib.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "shipped-ledger-repos.yaml");

/** Sonnet-class — chips/probes/classifiers are Sonnet, per Rules #87/#469. */
const CLASSIFIER_MODEL = "claude-sonnet-5";
const CLASSIFIER_MAX_TOKENS = 500;
/** One classifier call is one PR's title+body+labels — nowhere near this cap in practice; bounded defensively regardless (Rule #88 cost discipline). */
const CLASSIFY_MAX_RETRIES = 2;

/**
 * Safety bound, not a paging mechanism (Rule #331) — hitting it exactly makes `processRepo`
 * SKIP the repo entirely for this run (see the codex-review comment there) rather than act on
 * a page that isn't guaranteed complete. 500, not 200: this feature's own seed research found
 * asthetik-trade-theme alone with 261 merged PRs in a comparable window, so 200 was already
 * realistically too low for the busiest repo in the fleet (codex review, 2026-08-18 pass 1, P2).
 */
const PR_LIST_LIMIT = 500;

/**
 * Contents-API sanity bound on the base64 payload — fail-loud far past any plausible ledger
 * (~30MB raw text) but before shipping something structurally absurd to the API. This is NOT
 * an argv bound anymore: the first real apply run (33216855975, 2026-08-28) died `spawnSync gh
 * E2BIG` because Linux caps a SINGLE argv entry at 128KiB (MAX_ARG_STRLEN) — a per-argument
 * limit the old 500KB "under any realistic ARG_MAX" bound was blind to (ARG_MAX ~2MB is the
 * TOTAL; each argument is capped separately). All large payloads now travel via temp file
 * (`-F content=@<file>` / `--body-file`), so argv stays small at any ledger size.
 */
const MAX_CONTENT_B64_BYTES = 40_000_000;

/**
 * GitHub hard-caps issue/PR/comment bodies at 65,536 characters — a heavy week's proposed-
 * additions table (2026-W35: 203 rows ≈ 45KB) gets uncomfortably close. Bodies over this
 * budget get the table truncated HONESTLY (Rule #412: the dropped count is named, never a
 * silent cap) rather than letting the create/comment call 422 and fail the whole apply.
 */
const MAX_PR_BODY_CHARS = 60_000;

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

function isNotFoundError(err: unknown): boolean {
  const detail = err instanceof Error ? `${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}\n${err.message}` : String(err);
  return detail.includes("HTTP 404") || detail.includes("Not Found");
}

/** The HTTP status out of a failed `gh api`/`gh pr list` call's stderr, or `"error"` when none is found (network failure, timeout, etc. — still reported, never swallowed). */
function httpStatusOf(err: unknown): string {
  const detail = err instanceof Error ? `${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""} ${err.message}` : String(err);
  return detail.match(/HTTP (\d\d\d)/)?.[1] ?? "error";
}

// ───────────────────────────── config ─────────────────────────────

interface LedgerConfig {
  ledger: { repo: string; path: string; branch_prefix: string; label: string };
  watermark: { seed_cutoff: string };
  repos: string[];
}

function loadConfig(): LedgerConfig {
  const raw = parseYaml(readFileSync(CONFIG_FILE, "utf-8")) as Partial<LedgerConfig> | null;
  const ledger = raw?.ledger;
  if (!ledger?.repo || !ledger.path || !ledger.branch_prefix || !ledger.label) {
    throw new Error(`${CONFIG_FILE} malformed: "ledger" block incomplete (need repo, path, branch_prefix, label)`);
  }
  if (!raw?.watermark?.seed_cutoff) throw new Error(`${CONFIG_FILE} malformed: "watermark.seed_cutoff" missing`);
  if (Number.isNaN(Date.parse(raw.watermark.seed_cutoff))) {
    throw new Error(`${CONFIG_FILE} malformed: "watermark.seed_cutoff" is not a parseable ISO timestamp: ${raw.watermark.seed_cutoff}`);
  }
  if (!Array.isArray(raw?.repos) || raw.repos.length === 0) throw new Error(`${CONFIG_FILE} malformed: "repos" must be a non-empty array`);
  return { ledger, watermark: raw.watermark, repos: raw.repos };
}

// ───────────────────────────── ledger reads (Contents API) ─────────────────────────────

/** `ref` omitted -> GitHub's default-branch semantics; this worker always passes it explicitly (`"main"` for the baseline read, a PR branch name when checking that branch's current file state) so which ref is in play is never ambiguous at a call site. */
function readLedgerContents(repo: string, path: string, ref: string): { text: string; blobSha: string } {
  const raw = gh(["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, "--jq", "{type,encoding,size,content,sha}"]);
  const text = decodeContentsResponse(raw, path);
  const blobSha = (JSON.parse(raw) as { sha: string }).sha;
  return { text, blobSha };
}

// ───────────────────────────── merged-PR reads (per repo) ─────────────────────────────

interface GhPrListRow {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  mergedAt: string | null;
  url: string;
  author: { login: string } | null;
  files?: Array<{ path: string }>;
}

interface PrFetchResult {
  rows: GhPrListRow[];
  hitLimit: boolean;
  filesAvailable: boolean;
}

/**
 * Two-tier fetch: try WITH `files` first (the strongest signal `isInternalByConstruction`
 * has), retry WITHOUT it on ANY failure of that call rather than failing the whole repo —
 * per the issue's own hedge ("if files isn't available cheaply, skip it and rely on
 * title/body/labels"). Live-verified 2026-08-18 against studio-b-ai/asthetik-trade-theme:
 * `--json number,title,body,labels,mergedAt,url,author,files` returns real
 * `{path,additions,deletions,changeType}` rows, and `--search "merged:>=<full-ISO-8601>"`
 * genuinely narrows the result set (not just accepted syntactically) — so the with-files
 * path is expected to succeed in the common case; the fallback exists for repos/PRs where
 * it doesn't (large file lists, API quirks) rather than for a documented universal gap.
 */
function listMergedPrsSince(repo: string, watermarkIso: string, limit: number): PrFetchResult {
  const baseArgs = ["pr", "list", "--repo", repo, "--state", "merged", "--search", `merged:>=${watermarkIso}`, "--limit", String(limit)];
  try {
    const raw = gh([...baseArgs, "--json", "number,title,body,labels,mergedAt,url,author,files"]);
    const rows = JSON.parse(raw) as GhPrListRow[];
    return { rows, hitLimit: rows.length === limit, filesAvailable: true };
  } catch (err) {
    console.warn(`[shipped-ledger] ${repo}: files-inclusive PR list failed, retrying without files (title/body/labels only): ${err instanceof Error ? err.message : String(err)}`);
    const raw = gh([...baseArgs, "--json", "number,title,body,labels,mergedAt,url,author"]);
    const rows = JSON.parse(raw) as GhPrListRow[];
    return { rows, hitLimit: rows.length === limit, filesAvailable: false };
  }
}

function toCandidatePr(repo: string, row: GhPrListRow, filesAvailable: boolean): CandidatePr {
  if (!row.mergedAt) throw new Error(`${repo}#${row.number}: state=merged PR with a null mergedAt — refusing to guess a date.`);
  return {
    repo,
    number: row.number,
    title: row.title,
    body: row.body ?? "",
    labels: row.labels.map((l) => l.name),
    mergedAt: row.mergedAt,
    url: row.url,
    author: row.author?.login ?? "unknown",
    files: filesAvailable ? row.files?.map((f) => f.path) : undefined,
  };
}

// ───────────────────────────── classifier (real Anthropic call, injected as a ClassifyFn) ─────────────────────────────

/** Jittered backoff across up to `CLASSIFY_MAX_RETRIES` retries (3 attempts total) — mirrors the brief's "retries ≤2 with jitter"; a final throw is caught by `classifyPr` itself and turned into `source: "model_error"`, never a crash (see the lib header). */
async function callClassifierWithRetry(anthropic: Anthropic, pr: CandidatePr): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= CLASSIFY_MAX_RETRIES; attempt++) {
    try {
      const resp = await anthropic.messages.create({
        model: CLASSIFIER_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        system: buildClassifierSystemPrompt(),
        // pg-enum-drift-exempt: Anthropic Messages API role field, not a Postgres column
        messages: [{ role: "user", content: buildClassifierPrompt(pr) }],
      });
      return resp.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    } catch (err) {
      lastErr = err;
      if (attempt < CLASSIFY_MAX_RETRIES) {
        const jitterMs = (250 + Math.floor(Math.random() * 500)) * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * `ANTHROPIC_API_KEY` is read PASSIVELY from whatever's already in the environment — this
 * worker never searches 1Password/Railway/anywhere else for it (chip-brief-forbidden,
 * mirrors Rule #363/#259). Its absence is not an error: `classify: null` flows into
 * `classifyPr`, which resolves anything the exclusion list/labels didn't already settle
 * to `verdict: "unclassified"` rather than guessing or crashing (see the lib header).
 */
function buildClassifyFn(): { classify: ClassifyFn | null; mode: "real" | "skipped" } {
  if (anthropicCredentialMode() === "none") return { classify: null, mode: "skipped" }; // api-key or federation (WIF 9/06)
  const anthropic = new Anthropic();
  return { classify: (pr: CandidatePr) => callClassifierWithRetry(anthropic, pr), mode: "real" };
}

// ───────────────────────────── per-repo processing ─────────────────────────────

async function processRepo(
  repo: string,
  seedCutoff: string,
  parsedLedger: ParsedLedger,
  classify: ClassifyFn | null,
  sinceOverride: string | undefined,
): Promise<{ stats: RepoRunStats; visibleEntries: LedgerEntry[] }> {
  const shortName = shortRepoName(repo);
  const watermark = sinceOverride ?? computeWatermark(seedCutoff, newestDateForRepo(parsedLedger, shortName));

  const stats: RepoRunStats = {
    repo,
    watermark,
    read: 0,
    kept: 0,
    skippedDedup: 0,
    skippedInternal: 0,
    classifierMalformed: 0,
    unclassified: 0,
    limitHit: false,
    readError: null,
  };

  let fetch: PrFetchResult;
  try {
    fetch = listMergedPrsSince(repo, watermark, PR_LIST_LIMIT);
  } catch (err) {
    stats.readError = `HTTP ${httpStatusOf(err)} — needs pull_requests:read on the fleet App (ops-pipeline#104/#135)`;
    console.warn(`[shipped-ledger] ${repo}: read FAILED — ${stats.readError}`);
    return { stats, visibleEntries: [] };
  }

  stats.read = fetch.rows.length;
  stats.limitHit = fetch.hitLimit;

  // codex review (2026-08-18, ops-pipeline#162 PR pass 1, P2): a capped page's rows are NOT
  // guaranteed to be the window's newest N — `gh pr list --search`'s sort order is not a
  // documented, load-bearing contract this worker can rely on. Proceeding to classify/append
  // from a possibly-truncated, possibly-unordered page risks `newestDateForRepo` computing the
  // NEXT run's watermark from whatever the truncated page happened to contain, silently
  // skipping any PR outside that page FOREVER — falsifying this comment's own prior claim
  // that a cap hit merely "delays" ledgering by a week. It does not, without this guard.
  //
  // Fail safe instead: a capped repo contributes ZERO appends and makes ZERO classifier calls
  // this run (no cost spent classifying rows we can't trust the completeness of, Rule #88),
  // and the watermark is left untouched so next run retries the SAME window — loudly, every
  // run, until either volume drops below PR_LIST_LIMIT or a human raises it. This guarantees
  // no PR is ever silently lost, only ever delayed with a visible ⚠️ signal (the stats table's
  // `limitHit` column, already rendered per-repo by `renderStatsTable`/`renderDryRunTable`).
  if (fetch.hitLimit) {
    console.warn(
      `[shipped-ledger] ${repo}: hit the ${PR_LIST_LIMIT}-PR fetch cap — SKIPPING this repo entirely this run (0 classified, 0 appended). The page is not guaranteed complete or newest-first, so acting on it risks the next watermark silently skipping unswept PRs. Raise PR_LIST_LIMIT or investigate why this repo has >${PR_LIST_LIMIT} merged PRs since ${watermark}.`,
    );
    return { stats, visibleEntries: [] };
  }

  const visibleEntries: LedgerEntry[] = [];
  for (const row of fetch.rows) {
    const pr = toCandidatePr(repo, row, fetch.filesAvailable);
    const key = ledgerKey(pr);
    if (parsedLedger.keys.has(key)) {
      // Dedup BEFORE calling the classifier — never spend an API call classifying a PR
      // that's about to be discarded anyway (Rule #88 cost discipline). `planAppends`
      // below re-checks this as defense-in-depth, not as the primary gate.
      stats.skippedDedup += 1;
      continue;
    }
    const outcome = await classifyPr(pr, classify);
    if (outcome.verdict === "visible" && outcome.entry) {
      stats.kept += 1;
      visibleEntries.push(outcome.entry);
    } else if (outcome.verdict === "unclassified") {
      stats.unclassified += 1;
    } else {
      stats.skippedInternal += 1;
      if (outcome.source === "model_malformed" || outcome.source === "model_error") stats.classifierMalformed += 1;
    }
  }

  return { stats, visibleEntries };
}

// ───────────────────────────── apply (branch + Contents API PUT + PR create/update) ─────────────────────────────

/** `git/ref/heads/<branch>`'s `.object.sha` — the branch's COMMIT sha (see file header's commit-vs-blob note). `null` on a confirmed 404 (branch doesn't exist yet); rethrows anything else. */
function getBranchCommitSha(repo: string, branch: string): string | null {
  try {
    const sha = gh(["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"]).trim();
    return sha.length > 0 ? sha : null;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

function createBranch(repo: string, branch: string, fromCommitSha: string): void {
  gh(["api", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${fromCommitSha}`]);
}

/**
 * The ledger label must exist on the TARGET repo before `gh pr create --label` runs —
 * a missing label fails the ENTIRE create ("could not add label: 'x' not found"), which
 * killed run 33219060614 at the last step, after the branch write had already landed
 * (Rule #159: the missing-label failure class becomes a code guard). Idempotent: an
 * "already exists" response is success; any other failure still propagates.
 */
function ensureLabel(repo: string, label: string): void {
  try {
    gh(["label", "create", label, "--repo", repo, "--color", "0e8a16", "--description", "Automated weekly SHIPPED.md ledger PRs (ops-pipeline shipped-ledger-worker)"]);
    console.log(`[shipped-ledger] created label "${label}" on ${repo}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(msg)) return;
    throw err;
  }
}

/**
 * Writes `text` to a fresh private temp file and hands its path to `use`, removing the temp
 * dir afterward regardless of outcome. Every large payload handed to `gh` goes through here
 * so argv stays small at any ledger size — Linux caps a SINGLE argv entry at 128KiB
 * (MAX_ARG_STRLEN), which the 2026-W35 apply run's inline base64 exceeded (`spawnSync gh
 * E2BIG`, run 33216855975).
 */
function withTempFile<T>(prefix: string, text: string, use: (filePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const filePath = join(dir, "payload");
  writeFileSync(filePath, text, "utf-8");
  try {
    return use(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Preamble + table, truncated to GitHub's body cap when needed — whole rows only, dropped count named in the body (Rule #412; the branch diff always carries the complete set). */
function bodyWithinGithubCap(preamble: string, table: string): string {
  const full = `${preamble}\n\n${table}`;
  if (full.length <= MAX_PR_BODY_CHARS) return full;
  const footerBudget = 250;
  const tableBudget = MAX_PR_BODY_CHARS - preamble.length - footerBudget;
  const lines = table.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > tableBudget) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  return `${preamble}\n\n${kept.join("\n")}\n\n_…table truncated at GitHub's 65,536-char body cap — ${dropped} more line(s) not shown; the branch's SHIPPED.md diff carries the complete set._`;
}

/** `currentBlobSha` is THAT FILE's blob sha at `branch` (see file header's commit-vs-blob note) — the Contents API's optimistic-concurrency check; a stale value 409s loudly rather than silently overwriting someone else's concurrent commit. The base64 payload travels via `-F content=@<tmpfile>` (gh reads the field's value from the file), NEVER inline argv — see `withTempFile`. */
function putFileContents(repo: string, path: string, branch: string, text: string, currentBlobSha: string, message: string): void {
  const contentB64 = Buffer.from(text, "utf-8").toString("base64");
  if (contentB64.length > MAX_CONTENT_B64_BYTES) {
    throw new Error(
      `${path} base64-encodes to ${contentB64.length} bytes, over the ${MAX_CONTENT_B64_BYTES}-byte Contents-API sanity bound — a ledger this size means something upstream broke (or it is time for the Git Data API blob+tree path).`,
    );
  }
  withTempFile("shipped-ledger-put-", contentB64, (b64File) => {
    gh([
      "api", "--method", "PUT", `repos/${repo}/contents/${path}`,
      "-f", `message=${message}`,
      "-F", `content=@${b64File}`,
      "-f", `sha=${currentBlobSha}`,
      "-f", `branch=${branch}`,
    ]);
  });
}

interface OpenPrRow {
  number: number;
  url: string;
}

/** Rule #182: re-probe for an existing open PR on this exact head branch immediately before deciding create-vs-comment — never opens a duplicate. */
function findOpenPrForBranch(repo: string, branch: string): OpenPrRow | null {
  const raw = gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url"]);
  const rows = JSON.parse(raw) as OpenPrRow[];
  return rows[0] ?? null;
}

/**
 * Creates-or-updates `shipped-ledger/<YYYY-Www>` on `config.ledger.repo` and opens-or-
 * comments its PR. The rendered file content is ALWAYS recomputed from `parsedLedger`
 * (read fresh from `main` at the top of `main()`) + this run's full `plan` — a full
 * recompute, not an incremental append onto whatever the branch already holds. This is
 * deliberate: it makes a same-week re-run idempotent and self-healing (a PR left open
 * from Monday's run and refreshed by a Wednesday re-dispatch reflects Wednesday's best
 * current classification of the SAME candidate set, never an accumulation of
 * possibly-differently-classified duplicates across runs) at the cost of the branch's
 * diff changing shape between runs until it merges — an acceptable tradeoff for a PR
 * that is explicitly a living, CoS/Kevin-reviewed DRAFT the whole time it's open (#97).
 */
async function applyToLedgerRepo(config: LedgerConfig, parsedLedger: ParsedLedger, plan: AppendPlan, table: string): Promise<void> {
  const { repo, path, branch_prefix, label } = config.ledger;
  const week = isoWeekLabel(new Date().toISOString());
  const branch = `${branch_prefix}${week}`;

  console.log(`[shipped-ledger] APPLY: target branch ${branch} on ${repo}`);

  const existingCommitSha = getBranchCommitSha(repo, branch);
  const rendered = renderLedgerFile(parsedLedger, plan);

  if (existingCommitSha === null) {
    const mainCommitSha = getBranchCommitSha(repo, "main");
    if (mainCommitSha === null) throw new Error(`${repo}: could not resolve the commit sha of refs/heads/main — refusing to create ${branch} against an unknown base.`);
    createBranch(repo, branch, mainCommitSha);
    console.log(`[shipped-ledger] created ${branch} @ ${mainCommitSha}`);
  } else {
    console.log(`[shipped-ledger] ${branch} already exists @ ${existingCommitSha} — updating its file in place (never a duplicate branch).`);
  }

  // Freshly re-read the file's blob sha ON THE TARGET BRANCH regardless of whether it was
  // just created (byte-identical to main the instant a branch is cut, but a DIFFERENT ref
  // going forward) or already existed — this is the PUT's own concurrency token, never
  // reused from the earlier `main`-scoped read.
  const { text: currentText, blobSha: currentBlobSha } = readLedgerContents(repo, path, branch);
  // codex review (2026-08-18, ops-pipeline#164 manager pass, P2): a same-week re-run whose
  // full recompute renders BYTE-IDENTICAL content to what the branch already holds must not
  // PUT again — an unchanged-content Contents API update is at best a pointless empty commit
  // and at worst a 422 that fails the run BEFORE the comment/create step below (the
  // "idempotent same-week re-run" promise in this function's header would be broken by its
  // own write). Compare against the branch's CURRENT text (read fresh above), skip the write
  // when equal, and still fall through to the PR comment/create leg so the receipt lands.
  if (currentText === rendered) {
    console.log(`[shipped-ledger] ${path} on ${branch} is already byte-identical to this run's render — skipping the write (idempotent re-run).`);
  } else {
    putFileContents(repo, path, branch, rendered, currentBlobSha, `shipped-ledger: weekly PR-derived backfill ${week}`);
    console.log(`[shipped-ledger] wrote ${path} on ${branch}.`);
  }

  const existingPr = findOpenPrForBranch(repo, branch);
  if (existingPr) {
    const body = bodyWithinGithubCap("Updated by this run.", table);
    withTempFile("shipped-ledger-body-", body, (bodyFile) => {
      gh(["pr", "comment", String(existingPr.number), "--repo", repo, "--body-file", bodyFile]);
    });
    console.log(`[shipped-ledger] commented on existing PR ${repo}#${existingPr.number} (never opened a duplicate).`);
  } else {
    const body = bodyWithinGithubCap(
      "Automated weekly backfill (ops-pipeline#162). Never auto-merged (#97) — a human (CoS/Kevin) reviews and merges.",
      table,
    );
    ensureLabel(repo, label);
    withTempFile("shipped-ledger-body-", body, (bodyFile) => {
      gh([
        "pr", "create", "--repo", repo, "--base", "main", "--head", branch,
        "--label", label,
        "--title", `SHIPPED.md — weekly PR-derived backfill ${week}`,
        "--body-file", bodyFile,
      ]);
    });
    console.log(`[shipped-ledger] opened a new PR for ${branch} on ${repo}.`);
  }
}

// ───────────────────────────── args ─────────────────────────────

function parseArgs(argv: string[]): { dryRun: boolean; since: string | undefined } {
  const dryRun = argv.includes("--dry-run");
  const sinceIdx = argv.indexOf("--since");
  if (sinceIdx !== -1 && !argv[sinceIdx + 1]) throw new Error("--since requires an ISO timestamp");
  const since = sinceIdx !== -1 ? argv[sinceIdx + 1] : undefined;
  if (since !== undefined) {
    if (Number.isNaN(Date.parse(since))) throw new Error(`--since "${since}" is not a parseable ISO timestamp`);
    if (!dryRun) throw new Error("--since overrides the watermark for LOCAL DRY-RUN CONTROLS ONLY (it exists to manufacture a control case) — refusing to combine it with a live (non---dry-run) run.");
  }
  return { dryRun, since };
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const { dryRun, since } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const { classify, mode: classifierMode } = buildClassifyFn();

  console.log(
    `=== shipped-ledger-worker${dryRun ? " --dry-run (real reads, NO ledger/branch/PR mutations)" : ` --apply (LIVE: will branch/PUT/PR on ${config.ledger.repo})`} · classifier: ${classifierMode}${since ? ` · --since ${since} (OVERRIDE — dry-run control only)` : ""} ===`,
  );

  const { text: ledgerText } = readLedgerContents(config.ledger.repo, config.ledger.path, "main");
  const parsedLedger = parseLedger(ledgerText);
  console.log(`[shipped-ledger] read ${config.ledger.repo}/${config.ledger.path} @ main: ${parsedLedger.months.length} month section(s), ${parsedLedger.keys.size} ledgered key(s).`);

  const allStats: RepoRunStats[] = [];
  const allNewEntries: LedgerEntry[] = [];

  for (const repo of config.repos) {
    const { stats, visibleEntries } = await processRepo(repo, config.watermark.seed_cutoff, parsedLedger, classify, since);
    allStats.push(stats);
    allNewEntries.push(...visibleEntries);
    console.log(
      `[shipped-ledger] ${repo}: watermark=${stats.watermark} read=${stats.read} kept=${stats.kept} skipped(dedup)=${stats.skippedDedup} ` +
        `skipped(internal)=${stats.skippedInternal} (malformed=${stats.classifierMalformed}) unclassified=${stats.unclassified}` +
        `${stats.limitHit ? " LIMIT-HIT" : ""}${stats.readError ? ` READ-ERROR: ${stats.readError}` : ""}`,
    );
  }

  const plan = planAppends(parsedLedger, allNewEntries);
  const lintErrors = lintPlan(plan);
  const table = renderDryRunTable(plan);
  const statsTable = renderStatsTable(allStats);
  const totalsLine = summarizeTotals(allStats);

  console.log("\n--- per-repo stats ---");
  console.log(statsTable);
  console.log(totalsLine);
  console.log("\n--- proposed additions ---");
  console.log(table);
  if (plan.dedupSkipped.length > 0) {
    console.log(`\n[shipped-ledger] dedup-skipped (already ledgered): ${plan.dedupSkipped.join(", ")}`);
  }

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    const summaryMd = ["# shipped-ledger-worker", "", totalsLine, "", "## Per-repo stats", statsTable, "", "## Proposed additions", table, ""].join("\n");
    appendFileSync(stepSummaryPath, summaryMd);
  }

  if (lintErrors.length > 0) {
    // Issue #162: "the run fails LOUD if any appended line fails lint" — fatal in BOTH
    // dry-run and apply; a plan that can't render a valid line is never surfaced as fine.
    console.error(`[shipped-ledger] LINT FAILED (${lintErrors.length} error(s)) — refusing to proceed:`);
    for (const e of lintErrors) console.error(`  - ${e}`);
    throw new Error(`shipped-ledger: ${lintErrors.length} planned line(s) failed lint.`);
  }

  if (dryRun) {
    console.log("\n(dry run — no branch, file, or PR was created, updated, or commented)");
    return;
  }

  if (plan.appendsBySection.size === 0) {
    console.log("[shipped-ledger] nothing new to append this run — skipping branch/PR entirely (no-op apply, never an empty PR).");
    return;
  }

  await applyToLedgerRepo(config, parsedLedger, plan, table);
  console.log("[shipped-ledger] apply done.");
}

main().catch((err) => {
  console.error(`shipped-ledger-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
