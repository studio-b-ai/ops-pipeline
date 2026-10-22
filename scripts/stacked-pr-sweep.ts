#!/usr/bin/env tsx
/**
 * stacked-pr-sweep.ts — mechanic stint #1018 ("A stacked PR can be merged into its
 * parent's branch after the parent lands, so the fix looks merged but never reaches
 * main"). Thin I/O glue around scripts/lib/stacked-pr-classify.ts — read THAT file's
 * header first; no classification decision lives here.
 *
 * Per run (weekly, Fri 15:00Z, .github/workflows/stacked-pr-sweep.yml):
 *   1. Read the swept population from backlog-managers.yaml ∪ squasher-fleet.json
 *      (same union as stale-pr-sweep — Rule #283: reuse existing fleet enumeration).
 *   2. Per repo:
 *      a. Get default branch via `gh repo view --json defaultBranchRef`.
 *      b. List OPEN, non-draft PRs with baseRefName + headRefName.
 *      c. List MERGED+CLOSED PRs by their headRefName to build the parent-PR index.
 *      d. classifyPrs() returns findings where baseRefName !== defaultBranch AND
 *         a merged parent PR matches that base.
 *   3. Per repo with findings: open/update ONE auto-reconciled `[stacked-pr]` issue
 *      ON THE OWNING REPO (Rule #165 — the open-issue set is the dedup state).
 *   4. A repo whose reads fail is skipped this run (its issue stays open unmodified
 *      — Rule #465).
 *
 * Flags-only (the classify lib's Law): never rebases, re-targets, or merges a PR
 * itself — the owning seat re-targets the PR to the default branch in its next lap.
 *
 * `--dry-run`: real reads throughout, zero issue mutations, prints planned actions.
 * `--now <ISO>`: overrides the clock (the #464/#471 plant ladder).
 * `--repos <csv>`: scope to a comma-separated subset.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  classifyPrs,
  planStackedPrAction,
  renderStackedPrIssueBody,
  summarizeStackedPr,
  type ParentPr,
  type StackedPrFinding,
  type StackedPrInput,
} from "./lib/stacked-pr-classify.js";
import {
  resolveSweepPopulation,
  type BacklogManagerRow,
  type DoorRegistryRow,
  type SweepRepo,
} from "./lib/stale-pr-classify.js";
import {
  ensureLabel,
  listIssuesByLabel,
  openIssue,
  closeIssue,
  commentIssue,
  gh,
} from "./lib/github-issues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "backlog-managers.yaml");
const DOOR_REGISTRY_FILE = join(HERE, "squasher-fleet.json");
const LABEL = "stacked-pr";
const LABEL_DESCRIPTION = "stint#1018: open = PR targets non-default branch whose parent PR already merged (auto-reconciled)";
const LABEL_COLOR = "D73A4A"; // red — stacked PRs targeting dead bases are a merge defect
const PR_LIST_LIMIT = 500;

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
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
}

interface GhParentPrRow {
  number: number;
  headRefName: string;
  state: string;
}

function getDefaultBranch(repo: string): string {
  const raw = gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  return raw.trim();
}

function listOpenPrs(repo: string): GhPrRow[] {
  const raw = gh([
    "pr", "list", "--repo", repo, "--state", "open",
    "--limit", String(PR_LIST_LIMIT),
    "--json", "number,title,url,baseRefName,headRefName,isDraft",
  ]);
  const rows = JSON.parse(raw) as GhPrRow[];
  if (rows.length === PR_LIST_LIMIT) {
    throw new Error(`${repo} returned exactly the ${PR_LIST_LIMIT}-PR cap — refusing to classify against a possibly-incomplete picture.`);
  }
  return rows;
}

function listMergedClosedPrs(repo: string): ParentPr[] {
  const raw = gh([
    "pr", "list", "--repo", repo,
    "--state", "merged,closed",
    "--limit", String(PR_LIST_LIMIT),
    "--json", "number,headRefName,state",
  ]);
  const rows = JSON.parse(raw) as GhParentPrRow[];
  return rows.map((r) => ({
    headRefName: r.headRefName,
    state: r.state as "MERGED" | "CLOSED",
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
  console.log(`=== stacked-pr-sweep${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""} now=${now}${reposFilter ? ` --repos ${reposFilter.join(",")}` : ""} ===`);

  const population = loadPopulation();
  const configRepoNames = new Set(population.map((e) => e.repo));
  if (reposFilter) {
    if (reposFilter.length === 0) throw new Error("--repos parsed to zero repo names");
    const unknown = reposFilter.filter((r) => !configRepoNames.has(r));
    if (unknown.length > 0) {
      throw new Error(`--repos names repo(s) not in the swept population: ${unknown.join(", ")}. Known repos: ${[...configRepoNames].sort().join(", ")}`);
    }
  }
  const entries = reposFilter ? population.filter((e) => reposFilter.includes(e.repo)) : population;

  const doorOnly = population.filter((e) => e.source === "release-door").map((e) => e.repo);
  console.log(
    `[stacked-pr-sweep] population=${population.length} (backlog-managers ${population.filter((e) => e.source !== "release-door").length} + release-door-only ${doorOnly.length}${doorOnly.length > 0 ? `: ${doorOnly.join(", ")}` : ""})`,
  );

  const readFailed = new Set<string>();
  let opened = 0;
  let updated = 0;
  let closed = 0;
  let totalFindings = 0;

  for (const entry of entries) {
    let defaultBranch: string;
    let openPrs: GhPrRow[];
    let parentPrs: ParentPr[];
    try {
      defaultBranch = getDefaultBranch(entry.repo);
      openPrs = listOpenPrs(entry.repo);
      parentPrs = listMergedClosedPrs(entry.repo);
    } catch (err) {
      readFailed.add(entry.repo);
      console.warn(`stacked-pr-sweep: read failed for ${entry.repo} — skipping this run: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const inputs: StackedPrInput[] = openPrs.map((p) => ({
      repo: entry.repo,
      number: p.number,
      title: p.title,
      url: p.url,
      baseRefName: p.baseRefName,
      headRefName: p.headRefName,
      defaultBranch,
      isDraft: p.isDraft,
    }));

    const findings = classifyPrs(inputs, parentPrs);

    // Enrich findings with parent PR numbers (the pure classifier only carries state).
    const enrichedFindings: StackedPrFinding[] = findings.map((f) => {
      const parentRow = openPrs.find((p) => p.headRefName === f.baseRefName)
        ?? (parentPrs.find((p) => p.headRefName === f.baseRefName) as unknown as GhParentPrRow | undefined);
      return {
        ...f,
        parentPrNumber: parentRow && "number" in parentRow ? (parentRow as GhParentPrRow).number : -1,
      };
    });

    totalFindings += enrichedFindings.length;
    console.log(
      `${entry.repo}: ${openPrs.length} open PR(s), default=${defaultBranch} -> ${summarizeStackedPr(enrichedFindings)}`,
    );

    const openIssues = listIssuesByLabel(entry.repo, LABEL, "open");
    const existing = openIssues[0];
    const action = planStackedPrAction(enrichedFindings.length, existing !== undefined);
    const title = "[stacked-pr] fleet-internal stacked-PR sweep";
    const body = renderStackedPrIssueBody(entry.repo, enrichedFindings, now);

    if (dryRun) {
      console.log(`--- [dry-run] ${entry.repo}: would ${action.toUpperCase()} ---`);
      if (action === "open" || action === "update") console.log(body);
      continue;
    }

    if (action === "open") {
      ensureLabel(entry.repo, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
      openIssue(entry.repo, LABEL, title, body);
      opened += 1;
      console.log(`OPENED [stacked-pr] issue on ${entry.repo} (${enrichedFindings.length} finding(s)).`);
    } else if (action === "update") {
      commentIssue(entry.repo, existing!.number, body);
      updated += 1;
      console.log(`UPDATED (commented) [stacked-pr] issue #${existing!.number} on ${entry.repo} (${enrichedFindings.length} finding(s)).`);
    } else if (action === "close") {
      closeIssue(entry.repo, existing!.number, "0 stacked-pr findings this run — every open PR either targets the default branch or has no merged parent. Auto-closed by the stacked-pr sweep (stint #1018).");
      closed += 1;
      console.log(`CLOSED [stacked-pr] issue #${existing!.number} on ${entry.repo} (clean).`);
    }
  }

  console.log(`[stacked-pr-sweep] repos=${entries.length} findings=${totalFindings} opened=${opened} updated=${updated} closed=${closed} dry_run=${dryRun}`);

  if (readFailed.size > 0) {
    throw new Error(`repo read failed for: ${[...readFailed].sort().join(", ")} this run — see warnings above. The next scheduled run retries.`);
  }
}

main().catch((err) => {
  console.error(`stacked-pr-sweep FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});