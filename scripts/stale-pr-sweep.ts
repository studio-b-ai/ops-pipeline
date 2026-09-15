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
 *      mergeable/mergeStateStatus/isDraft) -> classifyPrs(). `mergeable` is the conflict
 *      predicate — list-mode `mergeStateStatus` never says CONFLICTING (lib header).
 *   3. Per repo with findings: open/update ONE auto-reconciled `[stale-pr]` issue ON THE
 *      OWNING REPO (Rule #165 — the open-issue set is the dedup state; mirrors
 *      dead-cron-worker.ts's per-repo pattern exactly, Rule #283). Repos whose issue is
 *      open but came back clean this run: auto-close with a comment.
 *   4. A repo whose `gh pr list` read fails is skipped this run (its issue, if open,
 *      stays open unmodified — Rule #465: never close on data you didn't fully reconfirm).
 *      A page whose `mergeable` came back UNKNOWN counts as such a failure: GitHub computes
 *      mergeability lazily, so a cold read reports UNKNOWN everywhere and would classify as
 *      a healthy zero (and then AUTO-CLOSE the repo's live issue). `listOpenPrsResolved`
 *      re-reads to warm the page and gives up into the skip path — see
 *      `isMergeabilityUnresolved` in the classify lib for the measured evidence.
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
import { classifyPrs, isMergeabilityUnresolved, planStalePrAction, renderStalePrIssueBody, resolveSweepPopulation, summarizeStalePr, type BacklogManagerRow, type DoorRegistryRow, type Mergeable, type MergeStateStatus, type PrInput, type SweepRepo } from "./lib/stale-pr-classify.js";
import { ensureLabel, listIssuesByLabel, openIssue, closeIssue, commentIssue, gh } from "./lib/github-issues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "backlog-managers.yaml");
// The RELEASE door's own registry (ops#405 flipped `train: true` onto 5 more repos).
// Read-only here — this worker never writes either config. See resolveSweepPopulation's
// header for why the population is a read-time UNION instead of a widened yaml.
const DOOR_REGISTRY_FILE = join(HERE, "squasher-fleet.json");
const LABEL = "stale-pr";
// <=100 chars — GitHub silently rejects longer; guarded by github-issues.test.ts's
// repo-wide literal scrape, which caught this at 111 chars on first write.
const LABEL_DESCRIPTION = "studio-b#112: open = a PR here is stale >=7d or CONFLICTING >=48h (auto-reconciled)";
const LABEL_COLOR = "FBCA04"; // yellow — matches the stint's "yellow stale-pr:<repo>#N" vocabulary

/** Safety bound, not a paging mechanism (Rule #331). */
const PR_LIST_LIMIT = 500;

/**
 * The swept population: backlog-managers.yaml's rows UNION the release door's
 * train-enabled repos. Both files are read read-only and neither is mutated — see
 * resolveSweepPopulation's header in the classify lib for the measured gap this closes
 * (claude-config-plane#272 and radio#1010 were CONFLICTING in door repos no sweep covered).
 * A malformed/missing door registry is FATAL, not a silent narrowing: degrading back to
 * the 13-repo population is exactly the blind spot this leg exists to remove (Rule #465).
 */
function loadPopulation(): SweepRepo[] {
  const rawYaml = parseYaml(readFileSync(CONFIG_FILE, "utf-8")) as { repos?: BacklogManagerRow[] } | null;
  if (!rawYaml || !Array.isArray(rawYaml.repos) || rawYaml.repos.length === 0) {
    throw new Error(`${CONFIG_FILE} malformed: "repos" is missing or empty`);
  }

  const rawJson = JSON.parse(readFileSync(DOOR_REGISTRY_FILE, "utf-8")) as { repos?: DoorRegistryRow[] } | null;
  if (!rawJson || !Array.isArray(rawJson.repos) || rawJson.repos.length === 0) {
    throw new Error(`${DOOR_REGISTRY_FILE} malformed: "repos" is missing or empty — refusing to sweep a silently-narrowed population (Rule #465).`);
  }

  return resolveSweepPopulation(rawYaml.repos, rawJson.repos);
}

interface GhPrRow {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus: string;
  isDraft: boolean;
}

/**
 * How many times to re-read a repo whose page came back with unresolved mergeability, and
 * how long to wait between tries. GitHub starts computing `mergeable` when it is ASKED for
 * (the cold read is itself the trigger), so the retry is what warms the page — measured
 * 2026-09-13: brain's cold read was all-UNKNOWN and a re-read seconds later reported the
 * real 7 CONFLICTING rows. Bounded, then surfaced as a read failure (Rule #382: a poll that
 * never waited proves nothing; Rule #465: never act on data you didn't fully reconfirm).
 */
const MERGEABILITY_RETRIES = 4;
const MERGEABILITY_RETRY_MS = 4000;

function sleepSync(ms: number): void {
  // Deliberately synchronous: this worker is a straight-line script and every other `gh`
  // call in it is execFileSync — an async detour here would be the only await in the file.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a repo's open PRs with mergeability actually RESOLVED. Retries a cold page
 * (see `isMergeabilityUnresolved`) and throws — into the caller's per-repo skip path — if
 * it never resolves, rather than classifying against UNKNOWN and reporting a blind zero.
 */
function listOpenPrsResolved(repo: string): PrInput[] {
  let prs = listOpenPrs(repo);
  for (let attempt = 1; attempt <= MERGEABILITY_RETRIES && isMergeabilityUnresolved(prs); attempt += 1) {
    const started = Date.now();
    sleepSync(MERGEABILITY_RETRY_MS);
    const waited = Date.now() - started;
    console.warn(
      `stale-pr-sweep: ${repo} returned unresolved mergeability (GitHub computes it lazily) — re-read ${attempt}/${MERGEABILITY_RETRIES} after ${waited}ms.`,
    );
    prs = listOpenPrs(repo);
  }
  if (isMergeabilityUnresolved(prs)) {
    const unknown = prs.filter((p) => !p.isDraft && p.mergeable === "UNKNOWN").map((p) => `#${p.number}`);
    throw new Error(
      `${repo}: mergeability still UNRESOLVED after ${MERGEABILITY_RETRIES} re-reads (UNKNOWN on ${unknown.join(", ")}). Refusing to classify — an UNKNOWN page reads as a healthy zero and would auto-close this repo's live [stale-pr] issue (Rules #382/#465).`,
    );
  }
  return prs;
}

function listOpenPrs(repo: string): PrInput[] {
  const raw = gh([
    "pr", "list", "--repo", repo, "--state", "open", "--limit", String(PR_LIST_LIMIT),
    // `mergeable` is the conflict predicate; `mergeStateStatus` is context only. See
    // lib/stale-pr-classify.ts's header — list-mode mergeStateStatus NEVER emits
    // "CONFLICTING" (it reports DIRTY), so asking only for it made the class blind.
    "--json", "number,title,url,createdAt,updatedAt,mergeable,mergeStateStatus,isDraft",
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
    mergeable: r.mergeable as Mergeable,
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

  const population = loadPopulation();
  const configRepoNames = new Set(population.map((e) => e.repo));
  if (reposFilter) {
    if (reposFilter.length === 0) throw new Error("--repos parsed to zero repo names (check for stray commas/whitespace)");
    const unknown = reposFilter.filter((r) => !configRepoNames.has(r));
    if (unknown.length > 0) {
      throw new Error(`--repos names repo(s) not in the swept population (${CONFIG_FILE} ∪ train-enabled ${DOOR_REGISTRY_FILE}): ${unknown.join(", ")}. Known repos: ${[...configRepoNames].sort().join(", ")}`);
    }
  }
  const entries = reposFilter ? population.filter((e) => reposFilter.includes(e.repo)) : population;

  // The population IS part of the receipt (#465): print where each swept repo came from,
  // so a zero can be read against what the sweep could actually see.
  const doorOnly = population.filter((e) => e.source === "release-door").map((e) => e.repo);
  console.log(
    `[stale-pr-sweep] population=${population.length} (backlog-managers ${population.filter((e) => e.source !== "release-door").length} + release-door-only ${doorOnly.length}${doorOnly.length > 0 ? `: ${doorOnly.join(", ")}` : ""})`,
  );

  const readFailed = new Set<string>();
  let opened = 0;
  let updated = 0;
  let closed = 0;
  let totalFindings = 0;

  for (const entry of entries) {
    let prs: PrInput[];
    try {
      prs = listOpenPrsResolved(entry.repo);
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
