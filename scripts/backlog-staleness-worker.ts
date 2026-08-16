#!/usr/bin/env tsx
/**
 * backlog-staleness-worker.ts — ops-pipeline#136 (CTO seat → CoS, LANES rule 17 rollout,
 * Kevin word 2026-08-16). Thin I/O glue around scripts/lib/backlog-staleness-lib.ts — read
 * THAT file's header first; no classification/render decision lives here.
 *
 * Per run (daily, .github/workflows/backlog-staleness.yml):
 *   1. Load scripts/backlog-managers.yaml (committed config — repo→manager map, thresholds,
 *      machinery_labels).
 *   2. Per configured repo (optionally narrowed via --repos, a comma-separated allowlist —
 *      the ship-gate's real-data dry-run scoping mechanism): `gh issue list --state open`
 *      (number/title/labels/updatedAt/createdAt) + `gh label list` (for the lib's
 *      labels-missing check) → classify().
 *   3. Group findings by manager (a manager can own several repos). Every manager with a
 *      config row is considered even at zero findings, so a manager that goes clean gets
 *      its issue closed, not silently forgotten.
 *   4. Per manager: exactly ONE aggregate issue on studio-b-ai/ops-pipeline, label
 *      `backlog-staleness`, title `[backlog-staleness] <manager> — N findings` (built by
 *      the lib's render(); parsed back out via lib/severity-issue-reconcile.ts's
 *      `parseSeverityTitle`, which the `[label] entity — status` shape already fits
 *      verbatim — Rule #283, no need for a second title convention). open (findings>0, none
 *      open) / retitle+comment with the fresh table (findings>0, one already open) / close
 *      with a counts comment (findings==0, one open) — Rule #165's auto-reconciled-issue
 *      pattern; `planIssueAction` is reused as-is from repo-hygiene-lib.ts (its
 *      open/update/close/none shape is exactly this leg's shape too — "update" means
 *      "retitle+comment" here, not "edit body in place").
 *
 * A manager is NEVER auto-closed off partial data: if ANY of a manager's configured repos
 * failed to read this run, that manager's close path is skipped (its issue, if open, stays
 * open and unmodified this run) — mirrors dead-cron-worker.ts's inconclusive-repo guard
 * (Rule #465: never close on evidence you didn't fully reconfirm). open/update still run on
 * whatever repos DID read successfully — partial alerting beats silently swallowing it.
 *
 * `--dry-run`: real reads throughout (every configured repo's issue list + label list,
 * Rule #376), zero issue mutations on ops-pipeline.
 * `--now <ISO>`: overrides the clock (the #464/#471 plant ladder) — omit for the real time.
 * `--repos <csv>`: scope to a comma-separated subset of backlog-managers.yaml's repo rows
 *   (targeted testing without a fleet App token locally — see the ship gate in ops#136).
 *
 * Flags-only for every OTHER repo's issues (never re-labels/re-ranks/closes a MANAGED
 * issue) — the only issues this worker ever mutates are its own per-manager aggregates on
 * studio-b-ai/ops-pipeline.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { classify, render, LABEL, type Finding, type IssueInput, type Thresholds } from "./lib/backlog-staleness-lib.js";
import { parseSeverityTitle } from "./lib/severity-issue-reconcile.js";
import { planIssueAction } from "./lib/repo-hygiene-lib.js";
import { ensureLabel, listIssuesByLabel, openIssue, closeIssue, commentIssue, retitleIssue, gh } from "./lib/github-issues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "backlog-managers.yaml");
const SELF_REPO = "studio-b-ai/ops-pipeline";
const LABEL_DESCRIPTION = "backlog-staleness LANES rule 17 fleet instrument (open = a manager has stale/unranked/headless backlog; auto-reconciled per manager)";
const LABEL_COLOR = "FBCA04";

/** Safety bound, not a paging mechanism (Rule #331) — a full final page is a loud warning, not a silent truncation. */
const ISSUE_LIST_LIMIT = 500;
const LABEL_LIST_LIMIT = 200;

interface RepoManagerEntry {
  repo: string;
  manager: string;
  note?: string;
}

interface Config {
  repos: RepoManagerEntry[];
  thresholds: Thresholds;
  machinery_labels: string[];
}

function loadConfig(): Config {
  const raw = parseYaml(readFileSync(CONFIG_FILE, "utf-8")) as Partial<Config> | null;
  if (!raw || !Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error(`${CONFIG_FILE} malformed: "repos" is missing or empty`);
  }
  if (
    !raw.thresholds ||
    typeof raw.thresholds.p0p1_days !== "number" ||
    typeof raw.thresholds.p2_days !== "number" ||
    typeof raw.thresholds.unranked_days !== "number"
  ) {
    throw new Error(`${CONFIG_FILE} malformed: "thresholds" must set p0p1_days/p2_days/unranked_days as numbers`);
  }
  if (!Array.isArray(raw.machinery_labels)) throw new Error(`${CONFIG_FILE} malformed: "machinery_labels" is not an array`);
  return { repos: raw.repos, thresholds: raw.thresholds, machinery_labels: raw.machinery_labels };
}

// ───────────────────────────── gh reads ─────────────────────────────

interface GhIssueRow {
  number: number;
  title: string;
  labels: { name: string }[];
  updatedAt: string;
  createdAt: string;
}

function listOpenIssues(repo: string): IssueInput[] {
  const raw = gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(ISSUE_LIST_LIMIT), "--json", "number,title,labels,updatedAt,createdAt"]);
  const rows = JSON.parse(raw) as GhIssueRow[];
  if (rows.length === ISSUE_LIST_LIMIT) {
    console.warn(`backlog-staleness: ${repo} returned exactly the ${ISSUE_LIST_LIMIT}-issue cap — this run may be scanning a truncated list (Rule #331).`);
  }
  return rows.map((r) => ({ number: r.number, title: r.title, labels: r.labels.map((l) => l.name), updatedAt: r.updatedAt, createdAt: r.createdAt }));
}

interface GhLabelRow {
  name: string;
}

function listRepoLabels(repo: string): string[] {
  const raw = gh(["label", "list", "--repo", repo, "--limit", String(LABEL_LIST_LIMIT), "--json", "name"]);
  return (JSON.parse(raw) as GhLabelRow[]).map((r) => r.name);
}

// ───────────────────────────── main ─────────────────────────────

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
  console.log(`=== backlog-staleness-worker${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""} now=${now}${reposFilter ? ` --repos ${reposFilter.join(",")}` : ""} ===`);

  const config = loadConfig();
  const entries = reposFilter ? config.repos.filter((e) => reposFilter.includes(e.repo)) : config.repos;
  if (reposFilter && entries.length === 0) {
    throw new Error(`--repos ${reposFilter.join(",")}: none of these match a "repo:" row in ${CONFIG_FILE}`);
  }

  const findingsByManager = new Map<string, Finding[]>();
  const managerReadFailed = new Set<string>();
  let totalFindings = 0;

  for (const entry of entries) {
    let issues: IssueInput[];
    let repoLabels: string[];
    try {
      issues = listOpenIssues(entry.repo);
      repoLabels = listRepoLabels(entry.repo);
    } catch (err) {
      managerReadFailed.add(entry.manager);
      console.warn(
        `backlog-staleness: read failed for ${entry.repo} (manager ${entry.manager}) — skipping this repo this run, manager close-ineligible: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const repoFindings = classify({
      repo: entry.repo,
      manager: entry.manager,
      now,
      issues,
      thresholds: config.thresholds,
      machineryLabels: config.machinery_labels,
      repoLabels,
    });
    totalFindings += repoFindings.length;
    const list = findingsByManager.get(entry.manager) ?? [];
    list.push(...repoFindings);
    findingsByManager.set(entry.manager, list);
    console.log(`${entry.repo} (${entry.manager}): ${issues.length} open issue(s) -> ${repoFindings.length} finding(s)`);
  }

  // Every manager with a config row is considered, even at zero findings — otherwise a
  // manager that goes fully clean would never reach the close path below.
  for (const entry of entries) {
    if (!findingsByManager.has(entry.manager)) findingsByManager.set(entry.manager, []);
  }

  // Real read regardless of --dry-run (Rule #376) — a dry-run preview should reflect real
  // open-issue state, not a guess.
  const openIssues = listIssuesByLabel(SELF_REPO, LABEL, "open");
  const openByManager = new Map<string, number>();
  for (const iss of openIssues) {
    const parsed = parseSeverityTitle(LABEL, iss.title);
    if (parsed) openByManager.set(parsed.entity, iss.number);
  }

  let opened = 0;
  let updated = 0;
  let closed = 0;
  const managers = [...findingsByManager.keys()].sort();

  for (const manager of managers) {
    const findings = findingsByManager.get(manager)!;
    const { title, body } = render({ manager, now, thresholds: config.thresholds, findings });
    const existingNum = openByManager.get(manager);
    const action = planIssueAction(findings.length, existingNum !== undefined);

    if (action === "close" && managerReadFailed.has(manager)) {
      console.warn(
        `backlog-staleness: ${manager} would CLOSE #${existingNum} but at least one of its repos failed to read this run — SKIPPING close (never close on incomplete data, Rule #465). Issue stays open, unmodified.`,
      );
      continue;
    }

    if (dryRun) {
      console.log(`\n--- [dry-run] manager=${manager}: ${findings.length} finding(s) — would ${action.toUpperCase()} ---`);
      if (action === "open" || action === "update") console.log(`${title}\n\n${body}`);
      if (action === "close") console.log(`(close #${existingNum} with a counts comment)`);
      continue;
    }

    if (action === "open") {
      ensureLabel(SELF_REPO, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
      openIssue(SELF_REPO, LABEL, title, body);
      opened += 1;
      console.log(`OPENED backlog-staleness issue for ${manager} (${findings.length} finding(s)).`);
    } else if (action === "update") {
      ensureLabel(SELF_REPO, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
      retitleIssue(SELF_REPO, existingNum!, title);
      commentIssue(SELF_REPO, existingNum!, body);
      updated += 1;
      console.log(`UPDATED (retitle+comment) backlog-staleness issue #${existingNum} for ${manager} (${findings.length} finding(s)).`);
    } else if (action === "close") {
      closeIssue(
        SELF_REPO,
        existingNum!,
        `0 backlog-staleness findings for ${manager} this run — every repo under this manager is within threshold. Auto-closed by the backlog-staleness worker.`,
      );
      closed += 1;
      console.log(`CLOSED backlog-staleness issue #${existingNum} for ${manager} (clean).`);
    }
  }

  console.log(`[backlog-staleness] managers=${managers.length} findings=${totalFindings} opened=${opened} updated=${updated} closed=${closed} dry_run=${dryRun}`);
}

main().catch((err) => {
  console.error(`backlog-staleness-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
