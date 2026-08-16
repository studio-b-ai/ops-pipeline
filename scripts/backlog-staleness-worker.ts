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
 * Separately: a manager is also NEVER mutated (open/update/close, all three) when --repos
 * DELIBERATELY scopes the run to only some of that manager's configured repos — a clean
 * single-repo scoped run must never close (or undercount-update) an aggregate while other,
 * unscanned repos for that manager still carry real findings (codex pass-2 finding on
 * ops#136). Unlike a read failure, a scoped run isn't a run-level error — the exit code is
 * unaffected; only that manager's mutation is skipped.
 *
 * `--dry-run`: real reads throughout (every configured repo's issue list + label list,
 * Rule #376), zero issue mutations on ops-pipeline.
 * `--now <ISO>`: overrides the clock (the #464/#471 plant ladder) — omit for the real time.
 * `--repos <csv>`: scope to a comma-separated subset of backlog-managers.yaml's repo rows
 *   (targeted testing without a fleet App token locally — see the ship gate in ops#136). Any
 *   name not present in the config throws (codex pass-1 P3). A manager only partially covered
 *   by this scope has its mutations skipped this run (see above).
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
const LABEL_DESCRIPTION = "LANES rule 17 instrument: open = manager has stale/unranked/headless backlog (auto-reconciled)"; // ≤100 chars (GitHub cap, guarded in ensureLabel)
const LABEL_COLOR = "FBCA04";

/** Safety bound, not a paging mechanism (Rule #331) — a full final page is a loud warning, not a silent truncation. */
const ISSUE_LIST_LIMIT = 500;
const LABEL_LIST_LIMIT = 200;

interface RepoManagerEntry {
  repo: string;
  manager: string;
  note?: string;
  /** Multi-lane repo: one `next` per lane is legitimate → `multi-next` not evaluated (CoS 2026-08-16). */
  shared?: boolean;
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

// Codex pass-1 P2: a cap hit is treated exactly like a read FAILURE (throw, not warn-and-
// proceed) — Rule #331's "loud warning" alone still let the caller classify() against a
// silently-truncated list. Throwing routes both functions through the SAME catch block in
// main()'s per-repo loop as any other gh failure: skip this repo this run, mark the manager
// read-incomplete (close-ineligible, Rule #465), and fold into the run's non-zero exit
// (below) — a truncated picture is exactly as untrustworthy as a missing one.
function listOpenIssues(repo: string): IssueInput[] {
  const raw = gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(ISSUE_LIST_LIMIT), "--json", "number,title,labels,updatedAt,createdAt"]);
  const rows = JSON.parse(raw) as GhIssueRow[];
  if (rows.length === ISSUE_LIST_LIMIT) {
    throw new Error(`${repo} returned exactly the ${ISSUE_LIST_LIMIT}-issue cap — this run may be scanning a truncated list (Rule #331); refusing to classify against a possibly-incomplete picture.`);
  }
  return rows.map((r) => ({ number: r.number, title: r.title, labels: r.labels.map((l) => l.name), updatedAt: r.updatedAt, createdAt: r.createdAt }));
}

interface GhLabelRow {
  name: string;
}

function listRepoLabels(repo: string): string[] {
  const raw = gh(["label", "list", "--repo", repo, "--limit", String(LABEL_LIST_LIMIT), "--json", "name"]);
  const rows = JSON.parse(raw) as GhLabelRow[];
  if (rows.length === LABEL_LIST_LIMIT) {
    throw new Error(`${repo} returned exactly the ${LABEL_LIST_LIMIT}-label cap — this run may be scanning a truncated label list (Rule #331); refusing to classify labels-missing against a possibly-incomplete picture.`);
  }
  return rows.map((r) => r.name);
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
  // Codex pass-1 P3: reject ANY --repos entry absent from config, not just an all-miss list —
  // a typo'd repo mixed with valid ones used to silently scope itself out with no signal.
  const configRepoNames = new Set(config.repos.map((e) => e.repo));
  if (reposFilter) {
    if (reposFilter.length === 0) {
      throw new Error("--repos parsed to zero repo names (check for stray commas/whitespace)");
    }
    const unknown = reposFilter.filter((r) => !configRepoNames.has(r));
    if (unknown.length > 0) {
      throw new Error(`--repos names repo(s) not present in ${CONFIG_FILE}: ${unknown.join(", ")}. Known repos: ${[...configRepoNames].sort().join(", ")}`);
    }
  }
  const entries = reposFilter ? config.repos.filter((e) => reposFilter.includes(e.repo)) : config.repos;

  // Codex pass-2 P2: a manager whose --repos scope covers only SOME of its configured repos
  // must never mutate that manager's aggregate — a clean single-repo scoped run could close
  // (or undercount-update) an issue while OTHER, unscanned repos for that manager still carry
  // real findings, presenting a partial picture as the manager's complete current state.
  // Managers entirely OUTSIDE the scope never reach `managers` below (nothing to guard); this
  // only fires for a non-empty-but-partial intersection. Unlike managerReadFailed (a genuine
  // failure), a deliberate --repos narrowing is intentional — it gates mutations, not the run's
  // exit code.
  const managerScopeIncomplete = new Set<string>();
  if (reposFilter) {
    for (const manager of new Set(config.repos.map((e) => e.manager))) {
      const fullCount = config.repos.filter((e) => e.manager === manager).length;
      const scopedCount = entries.filter((e) => e.manager === manager).length;
      if (scopedCount > 0 && scopedCount < fullCount) managerScopeIncomplete.add(manager);
    }
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
      sharedRepo: entry.shared === true,
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

    // Codex pass-2 P2 — checked BEFORE the dry-run branch so a dry-run preview under a partial
    // --repos scope accurately shows "SKIPPED", not a would-be action a real run would refuse.
    if (action !== "none" && managerScopeIncomplete.has(manager)) {
      console.warn(
        `backlog-staleness: ${manager} would ${action.toUpperCase()} but --repos scoped this run to only some of its configured repos — SKIPPING ${action} (a partial scope must never present itself as this manager's complete state). Re-run without --repos (or with this manager's full repo set) to mutate its aggregate.`,
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

  // Codex pass-1 P1: a per-repo read failure used to be a console.warn only — if the affected
  // manager had no pre-existing open issue, the run still exited 0 with no durable signal
  // anywhere (Rule #412/#465: a leg that can go blind must SAY so, loudly, not just log it).
  // Every open/update/close possible from the repos that DID read already ran above — this
  // throw only flips the process exit code so the GH Actions job itself goes red, which is
  // the one signal that survives beyond a log line nobody's reading (Rule #8/#60).
  if (managerReadFailed.size > 0) {
    throw new Error(
      `repo read failed for manager(s) ${[...managerReadFailed].sort().join(", ")} this run — see the warnings above for which repo(s) and why. The next scheduled run retries; this run's findings for those managers are incomplete.`,
    );
  }
}

main().catch((err) => {
  console.error(`backlog-staleness-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
