#!/usr/bin/env tsx
/**
 * stale-pr-sweep.ts — studio-b#112 sub-leg c ("stale sweep — Scout Fri 15Z: any PR >7d
 * with no motion -> yellow stale-pr:<repo>#N; CONFLICTING >48h -> the owning seat rebases
 * or closes in its next lap"). Thin I/O glue around scripts/lib/stale-pr-classify.ts —
 * read THAT file's header first; no classification decision lives here.
 *
 * Per run (weekly, Fri 15:00Z, .github/workflows/stale-pr-sweep.yml):
 *   1. Reuse scripts/backlog-managers.yaml's repo list (Rule #283 — grep for an existing
 *      fleet-repo enumeration before building a new one; this leg needs the SAME "which
 *      repos does a seat open PRs in" answer backlog-staleness-worker.ts already has, and
 *      the file is committed config this worker never writes).
 *   2. Per repo: `gh pr list --state open` (number/title/url/createdAt/updatedAt/
 *      mergeStateStatus/isDraft) -> classifyPrs().
 *   3. Per repo with findings: open/update ONE auto-reconciled `[stale-pr]` issue ON THE
 *      OWNING REPO (Rule #165 — the open-issue set is the dedup state; mirrors
 *      dead-cron-worker.ts's per-repo pattern exactly, Rule #283). Repos whose issue is
 *      open but came back clean this run: auto-close with a comment.
 *   4. A repo whose `gh pr list` read fails is skipped this run (its issue, if open,
 *      stays open unmodified — Rule #465: never close on data you didn't fully reconfirm).
 *
 * Flags-only (the classify lib's Law): never rebases, closes, or merges a PR itself — the
 * owning seat (named by backlog-managers.yaml's manager column) acts on the finding in its
 * next lap, exactly like the stint text's "the owning seat rebases or closes in its next
 * lap".
 *
 * `--dry-run`: real reads throughout (Rule #376), zero issue mutations, prints planned
 * actions + would-be bodies.
 * `--now <ISO>`: overrides the clock (the #464/#471 plant ladder) — omit for the real time.
 * `--repos <csv>`: scope to a comma-separated subset of backlog-managers.yaml's repo rows.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { classifyPrs, planStalePrAction, renderStalePrIssueBody, summarizeStalePr, type MergeStateStatus, type PrInput } from "./lib/stale-pr-classify.js";
import { ensureLabel, listIssuesByLabel, openIssue, closeIssue, commentIssue, gh } from "./lib/github-issues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "backlog-managers.yaml");
const LABEL = "stale-pr";
const LABEL_DESCRIPTION = "studio-b#112 stale sweep: open = this repo has a PR stale >=7d no-motion or CONFLICTING >=48h (auto-reconciled)"; // <=100 chars, guarded by ensureLabel
const LABEL_COLOR = "FBCA04"; // yellow — matches the stint's "yellow stale-pr:<repo>#N" vocabulary

/** Safety bound, not a paging mechanism (Rule #331). */
const PR_LIST_LIMIT = 500;

interface RepoManagerEntry {
  repo: string;
}

interface Config {
  repos: RepoManagerEntry[];
}

function loadConfig(): Config {
  const raw = parseYaml(readFileSync(CONFIG_FILE, "utf-8")) as { repos?: RepoManagerEntry[] } | null;
  if (!raw || !Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error(`${CONFIG_FILE} malformed: "repos" is missing or empty`);
  }
  return { repos: raw.repos };
}

interface GhPrRow {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  mergeStateStatus: string;
  isDraft: boolean;
}

function listOpenPrs(repo: string): PrInput[] {
  const raw = gh([
    "pr", "list", "--repo", repo, "--state", "open", "--limit", String(PR_LIST_LIMIT),
    "--json", "number,title,url,createdAt,updatedAt,mergeStateStatus,isDraft",
  ]);
  const rows = JSON.parse(raw) as GhPrRow[];
  if (rows.length === PR_LIST_LIMIT) {
    throw new Error(`${repo} returned exactly the ${PR_LIST_LIMIT}-PR cap — this run may be scanning a truncated list (Rule #331); refusing to classify against a possibly-incomplete picture.`);
  }
  return rows.map((r) => ({
    repo,
    number: r.number,
    title: r.title,
    url: r.url,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    mergeStateStatus: r.mergeStateStatus as MergeStateStatus,
    isDraft: r.isDraft,
  }));
}

function parseArgs(argv: string[]): { dryRun: boolean; now: string; reposFilter: string[] | undefined } {
  const dryRun = argv.includes("--dry-run");
  const nowIdx = argv.indexOf("--now");
  if (nowIdx !== -1 && !argv[nowIdx + 1]) throw new Error("--now requires an ISO timestamp");
  const now = nowIdx !== -1 ? argv[nowIdx + 1] : new Date().toISOString();
  const reposIdx = argv.indexOf("--repos");
  if (reposIdx !== -1 && !argv[reposIdx + 1]) throw new Error("--repos requires a comma-separated repo list");
  const reposFilter = reposIdx !== -1 ? argv[reposIdx + 1].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  return { dryRun, now, reposFilter };
}

async function main(): Promise<void> {
  const { dryRun, now, reposFilter } = parseArgs(process.argv.slice(2));
  console.log(`=== stale-pr-sweep${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""} now=${now}${reposFilter ? ` --repos ${reposFilter.join(",")}` : ""} ===`);

  const config = loadConfig();
  const configRepoNames = new Set(config.repos.map((e) => e.repo));
  if (reposFilter) {
    if (reposFilter.length === 0) throw new Error("--repos parsed to zero repo names (check for stray commas/whitespace)");
    const unknown = reposFilter.filter((r) => !configRepoNames.has(r));
    if (unknown.length > 0) {
      throw new Error(`--repos names repo(s) not present in ${CONFIG_FILE}: ${unknown.join(", ")}. Known repos: ${[...configRepoNames].sort().join(", ")}`);
    }
  }
  const entries = reposFilter ? config.repos.filter((e) => reposFilter.includes(e.repo)) : config.repos;

  const readFailed = new Set<string>();
  let opened = 0;
  let updated = 0;
  let closed = 0;
  let totalFindings = 0;

  for (const entry of entries) {
    let prs: PrInput[];
    try {
      prs = listOpenPrs(entry.repo);
    } catch (err) {
      readFailed.add(entry.repo);
      console.warn(`stale-pr-sweep: read failed for ${entry.repo} — skipping this repo this run: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const findings = classifyPrs(prs, now);
    totalFindings += findings.length;
    console.log(`${entry.repo}: ${prs.length} open PR(s) -> ${summarizeStalePr(findings)}`);

    const openIssues = listIssuesByLabel(entry.repo, LABEL, "open");
    const existing = openIssues[0]; // exactly one aggregate per repo, mirrors dead-cron-worker.ts
    const action = planStalePrAction(findings.length, existing !== undefined);
    const title = "[stale-pr] fleet-internal stale sweep";
    const body = renderStalePrIssueBody(entry.repo, findings, now);

    if (dryRun) {
      console.log(`--- [dry-run] ${entry.repo}: would ${action.toUpperCase()} ---`);
      if (action === "open" || action === "update") console.log(body);
      continue;
    }

    if (action === "open") {
      ensureLabel(entry.repo, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
      openIssue(entry.repo, LABEL, title, body);
      opened += 1;
      console.log(`OPENED [stale-pr] issue on ${entry.repo} (${findings.length} finding(s)).`);
    } else if (action === "update") {
      commentIssue(entry.repo, existing!.number, body); // keep prior sweeps as history, mirrors backlog-staleness's comment leg
      updated += 1;
      console.log(`UPDATED (commented) [stale-pr] issue #${existing!.number} on ${entry.repo} (${findings.length} finding(s)).`);
    } else if (action === "close") {
      closeIssue(entry.repo, existing!.number, "0 stale-pr findings this run — every open PR is either fresh, moving, or clean. Auto-closed by the stale-pr sweep (studio-b#112).");
      closed += 1;
      console.log(`CLOSED [stale-pr] issue #${existing!.number} on ${entry.repo} (clean).`);
    }
  }

  console.log(`[stale-pr-sweep] repos=${entries.length} findings=${totalFindings} opened=${opened} updated=${updated} closed=${closed} dry_run=${dryRun}`);

  if (readFailed.size > 0) {
    throw new Error(`repo read failed for: ${[...readFailed].sort().join(", ")} this run — see warnings above. The next scheduled run retries.`);
  }
}

main().catch((err) => {
  console.error(`stale-pr-sweep FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
