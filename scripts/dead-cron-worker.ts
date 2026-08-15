#!/usr/bin/env tsx
/**
 * dead-cron-worker.ts — ops-pipeline#112 (CTO seat, 2026-08-15). Thin I/O glue around
 * scripts/lib/dead-cron-classify.ts — read THAT file's header first; no classification
 * decision lives here.
 *
 * What it does, per run (weekly, as a second step in .github/workflows/repo-hygiene.yml):
 *   1. Enumerate live NON-ARCHIVED org repos (fleet App token — same mint as the
 *      repo-hygiene step; archived repos' workflows can't run and never flag).
 *   2. Per repo: list Actions workflows; per real workflow file, read its YAML for
 *      `on.schedule` crons (Contents read); for schedule-bearing workflows, fetch the
 *      last RUN_WINDOW scheduled-trigger runs (`event=schedule`) and classify.
 *   3. Per repo with findings: open/update ONE auto-reconciled `[dead-cron]` issue ON THE
 *      OWNING REPO (Rule #165 amended — the open-issue set is the dedup state). Repos
 *      whose issue is open but came back clean this run: auto-close with a comment.
 *   4. If a read capability is SYSTEMICALLY dead (every attempt failed — the fleet App
 *      permission gap, not per-repo flakiness), file/refresh a self-issue on ops-pipeline
 *      saying exactly what is blind and how to fix it (Rule #464 — never a silent 0 that
 *      reads as "fleet healthy"), and SKIP the close sweep entirely: a blind run must not
 *      close alerts it could not have re-confirmed (Rules #456/#465).
 *
 * ⚠️ Expected CI degradation on day one (live-verified 2026-08-15, same probe as the
 * bot-churn leg: `gh api /orgs/studio-b-ai/installations` → the fleet App holds exactly
 * `issues:write` + `metadata:read`): GitHub's permissions-required-for-apps docs put
 * `GET /repos/{o}/{r}/actions/workflows` + `.../runs` under **Actions (read)** and
 * workflow-file reads under **Contents (read)** — the App has neither, so in CI this leg
 * runs straight into the systemic-degradation path and files the self-issue naming the
 * ops#104 grant (one org-UI visit adds both). Run LOCALLY under a personally-authed `gh`
 * (how the #471 plant proof was produced), everything works today. Either way the output
 * is honest — if the docs claim is wrong and metadata suffices, the leg simply works and
 * no degradation note ever appears.
 *
 * Flags-only (the lib's Law): never disables, re-runs, edits, or retires a workflow.
 *
 * `--dry-run`: real reads throughout (Rule #376), zero issue mutations, prints planned
 * actions + would-be bodies.
 * `--repo <name>`: scope to one repo (targeted testing / the plant ladder). The close
 * sweep only ever touches scanned repos, so scoping can never close another repo's issue.
 */

import { parse as parseYaml } from "yaml";
import {
  RUN_WINDOW,
  classifyWorkflow,
  isSystemic,
  renderDeadCronIssueBody,
  renderDegradationBody,
  summarizeDeadCron,
  type DeadCronFinding,
  type DegradationReport,
  type ScheduledRun,
  type WorkflowMeta,
} from "./lib/dead-cron-classify.js";
import { planIssueAction } from "./lib/repo-hygiene-lib.js";
import { ensureLabel, listIssuesByLabel, openIssue, closeIssue, gh } from "./lib/github-issues.js";

const ORG = "studio-b-ai";
const SELF_REPO = "studio-b-ai/ops-pipeline";
const LABEL = "dead-cron";
// ≤100 chars — GitHub hard-caps label descriptions (HTTP 422 past it); caught by the
// FIRST live label create, invisible to tests/dry-run/codex (dry-run gates mutations by
// design, so the mutation leg's own validity was unproven until the live firing — #464).
const LABEL_DESCRIPTION = "dead-cron detector: open = a scheduled workflow here is failing or silent (auto-reconciled weekly)";
const LABEL_COLOR = "D93F0B";
const TITLE = "[dead-cron] scheduled workflows failing or silent";
const SELF_TITLE = "[dead-cron] detector leg structurally degraded — fleet App permission gap";

/** Safety bound, not a paging mechanism (Rule #331) — mirrors repo-hygiene-worker.ts. */
const LIVE_ENUMERATION_LIMIT = 300;

// ───────────────────────────── enumeration ─────────────────────────────

interface GhRepoListRow {
  name: string;
  isArchived: boolean;
}

function listLiveRepoNames(): string[] {
  const raw = gh(["repo", "list", ORG, "--limit", String(LIVE_ENUMERATION_LIMIT), "--json", "name,isArchived"]);
  const rows = JSON.parse(raw) as GhRepoListRow[];
  if (rows.length === LIVE_ENUMERATION_LIMIT) {
    // Same contract as the sibling worker: a full final page means the enumeration may be
    // truncated — refuse to run on a partial fleet picture (the close sweep would treat
    // unscanned repos' open issues as out of scope, fine, but findings coverage would
    // silently claim fleet-wide reach it doesn't have — Rule #401).
    throw new Error(`live enumeration returned exactly the ${LIVE_ENUMERATION_LIMIT}-repo cap — raise LIVE_ENUMERATION_LIMIT and re-run.`);
  }
  return rows.filter((r) => !r.isArchived).map((r) => r.name);
}

// ───────────────────────────── per-repo reads ─────────────────────────────

interface FetchCounter {
  attempted: number;
  failed: number;
  firstError: string | null;
}

function recordFailure(counter: FetchCounter, err: unknown): string {
  counter.failed += 1;
  const msg = err instanceof Error ? err.message : String(err);
  if (counter.firstError === null) counter.firstError = msg;
  return msg;
}

interface WorkflowRow extends WorkflowMeta {
  id: number;
}

function listWorkflows(repoName: string): WorkflowRow[] {
  // `--paginate` + `--jq` emits one JSON object per line across pages (the
  // listIssueComments pattern in lib/github-issues.ts).
  const raw = gh([
    "api",
    `repos/${ORG}/${repoName}/actions/workflows?per_page=100`,
    "--paginate",
    "--jq",
    '.workflows[] | {id, name, path, state, createdAt: .created_at}',
  ]);
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as WorkflowRow);
}

/**
 * Cron expressions from a workflow file's `on.schedule[].cron`. Returns null when the
 * CONTENT READ failed (permission/API failure — counts toward the systemic detector);
 * returns [] when the file was read fine but has no schedule (the definitive "not a
 * scheduled workflow" answer — no runs fetch needed). A YAML parse failure on fetched
 * content is treated as [] with a warning: the read capability itself is healthy, we just
 * couldn't extract crons (run history can still drive classification via observed spacing
 * — but only if the workflow shows scheduled runs, which `probeRuns` below discovers).
 */
function readCrons(repoName: string, path: string, counter: FetchCounter): string[] | null {
  counter.attempted += 1;
  let text: string;
  try {
    const b64 = gh(["api", `repos/${ORG}/${repoName}/contents/${path}`, "--jq", ".content"]);
    text = Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf-8");
  } catch (err) {
    const msg = err instanceof Error ? `${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}\n${err.message}` : String(err);
    if (msg.includes("HTTP 404")) {
      // Definitive, not inconclusive: the FILE is gone but GitHub keeps the workflow
      // record after deletion (live-verified 2026-08-15: 3 such residues in the fleet). A
      // deleted file has no schedule and its cron cannot fire — treat as not-scheduled,
      // and do NOT count toward the permission-gap (systemic) counter: a 404 would both
      // pollute that signal and (codex P2's cousin) permanently block the repo's
      // close-sweep eligibility for a residue that never clears.
      counter.attempted -= 1;
      console.warn(`dead-cron: ${repoName}/${path} — workflow record exists but the file 404s (deleted file, lingering record); treating as not scheduled.`);
      return [];
    }
    recordFailure(counter, err);
    console.warn(`dead-cron: content read failed for ${repoName}/${path}: ${msg.trim()}`);
    return null;
  }
  try {
    const doc = parseYaml(text) as Record<string, unknown> | null;
    // YAML 1.1 parsers coerce a bare `on` key to boolean true (stringified "true" as a JS
    // object key); the `yaml` package's 1.2 default keeps "on". Tolerate both.
    const onNode = (doc?.["on"] ?? doc?.["true"]) as Record<string, unknown> | undefined;
    const schedule = onNode?.["schedule"];
    if (!Array.isArray(schedule)) return [];
    return schedule
      .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>)["cron"] : undefined))
      .filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  } catch (err) {
    console.warn(`dead-cron: YAML parse failed for ${repoName}/${path} (read OK — not counted as a capability failure): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

interface RunRow {
  status: string;
  conclusion: string | null;
  createdAt: string;
}

/** Last RUN_WINDOW scheduled-trigger runs, newest-first (the API's default sort). Throws on failure — caller decides per-workflow skip vs systemic. */
function fetchScheduledRuns(repoName: string, workflowId: number): ScheduledRun[] {
  const raw = gh([
    "api",
    `repos/${ORG}/${repoName}/actions/workflows/${workflowId}/runs?event=schedule&per_page=${RUN_WINDOW}`,
    "--jq",
    "[.workflow_runs[] | {status, conclusion, createdAt: .created_at}]",
  ]);
  return (JSON.parse(raw) as RunRow[]).map((r) => ({ status: r.status, conclusion: r.conclusion, createdAt: r.createdAt }));
}

// ───────────────────────────── close-sweep candidates ─────────────────────────────

/**
 * Repo names (bare, no org prefix) with an OPEN dead-cron-labeled issue, via one org-wide
 * search (paginated — codex review P3, 2026-08-15: the default single page caps at 30
 * items, so a fleet with more open dead-cron issues than that would leave recovered repos
 * past the first page stale indefinitely; `--paginate` + line-per-item jq mirrors
 * lib/github-issues.ts's listIssueComments pattern). Search-index lag tolerance: a
 * just-opened issue missing from search only delays its close-sweep consideration to next
 * week's run — the OPEN/UPDATE path never relies on search (it lists the target repo's
 * issues authoritatively). Search failure → null: the caller skips the close sweep loudly
 * rather than treating "search broke" as "nothing is open anywhere" (Rule #322 — a broken
 * instrument's zero is not a result).
 */
function searchOpenDeadCronRepos(): string[] | null {
  try {
    const raw = gh([
      "api",
      "-X",
      "GET",
      "search/issues",
      "-f",
      `q=org:${ORG} label:${LABEL} state:open is:issue`,
      "-F",
      "per_page=100",
      "--paginate",
      "--jq",
      ".items[].repository_url",
    ]);
    const names = raw
      .split("\n")
      .map((l) => l.trim().replace(/^"|"$/g, ""))
      .filter((l) => l.length > 0)
      .map((u) => u.split("/").pop() ?? "")
      .filter((n) => n.length > 0);
    return [...new Set(names)];
  } catch (err) {
    console.warn(`dead-cron: org-wide open-issue search failed — SKIPPING the close sweep this run (open issues stay open, re-evaluated next week): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const repoFlagIdx = process.argv.indexOf("--repo");
  const repoFilter = repoFlagIdx !== -1 ? process.argv[repoFlagIdx + 1] : undefined;
  if (repoFlagIdx !== -1 && !repoFilter) throw new Error("--repo requires a repo name");
  const now = new Date();
  const nowIso = now.toISOString();

  console.log(`=== dead-cron-worker${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""}${repoFilter ? ` --repo ${repoFilter}` : ""} ===`);

  const allRepos = listLiveRepoNames();
  const scannedRepos = repoFilter ? allRepos.filter((r) => r === repoFilter) : allRepos;
  if (repoFilter && scannedRepos.length === 0) throw new Error(`--repo ${repoFilter}: not a live non-archived repo in ${ORG}`);
  console.log(`Scanning ${scannedRepos.length} non-archived repo(s) of ${allRepos.length} live.`);

  const workflowsList: FetchCounter = { attempted: 0, failed: 0, firstError: null };
  const contentReads: FetchCounter = { attempted: 0, failed: 0, firstError: null };
  const findingsByRepo = new Map<string, DeadCronFinding[]>();
  // codex review P2 (2026-08-15): a repo with ANY per-repo read failure this run was not
  // fully re-confirmed — it must never be close-sweep-eligible on this run's evidence
  // (Rule #465 at repo granularity: the systemic guard covers all-fail, this covers the
  // partial/transient case). Open/update paths are unaffected — positive findings from
  // the reads that DID succeed are still real.
  const inconclusiveRepos = new Set<string>();
  let scheduleBearing = 0;

  for (const repoName of scannedRepos) {
    workflowsList.attempted += 1;
    let workflows: WorkflowRow[];
    try {
      workflows = listWorkflows(repoName);
    } catch (err) {
      const msg = recordFailure(workflowsList, err);
      inconclusiveRepos.add(repoName);
      console.warn(`dead-cron: workflows list failed for ${repoName}, skipping repo this run (close-ineligible): ${msg}`);
      continue;
    }

    for (const wf of workflows) {
      // Dynamic workflows (CodeQL default setup etc.) have non-repo paths — not cron-bearing files.
      if (!wf.path.startsWith(".github/workflows/")) continue;

      const crons = readCrons(repoName, wf.path, contentReads);
      if (crons === null) inconclusiveRepos.add(repoName); // read FAILED (404s return [] and don't land here)
      // Definitive no-schedule answer — skip without a runs fetch.
      if (crons !== null && crons.length === 0) continue;

      let runs: ScheduledRun[];
      try {
        runs = fetchScheduledRuns(repoName, wf.id);
      } catch (err) {
        inconclusiveRepos.add(repoName);
        console.warn(`dead-cron: scheduled-runs fetch failed for ${repoName}/${wf.path}, skipping workflow this run (no finding without evidence; repo close-ineligible): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // Content unreadable AND no scheduled runs → cannot even tell a schedule exists; classify() would return null anyway.
      if ((crons === null || crons.length === 0) && runs.length === 0) continue;

      scheduleBearing += 1;
      const finding = classifyWorkflow(
        { repo: repoName, workflow: { name: wf.name, path: wf.path, state: wf.state, createdAt: wf.createdAt }, crons: crons ?? [], runs },
        nowIso,
      );
      if (finding) {
        const list = findingsByRepo.get(repoName) ?? [];
        list.push(finding);
        findingsByRepo.set(repoName, list);
      }
    }
  }

  const degradation: DegradationReport = { workflowsList, contentReads };
  const anySystemic = isSystemic(workflowsList) || isSystemic(contentReads);
  const allFindings = [...findingsByRepo.values()].flat();

  console.log(`Schedule-bearing workflows classified: ${scheduleBearing} · repos with findings: ${findingsByRepo.size}`);
  console.log(`workflows-list reads: ${workflowsList.attempted} attempted, ${workflowsList.failed} failed${isSystemic(workflowsList) ? " (SYSTEMIC)" : ""}`);
  console.log(`content reads: ${contentReads.attempted} attempted, ${contentReads.failed} failed${isSystemic(contentReads) ? " (SYSTEMIC)" : ""}`);
  console.log(summarizeDeadCron(allFindings));

  // ── per-repo open/update ──
  for (const [repoName, findings] of [...findingsByRepo.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const fullRepo = `${ORG}/${repoName}`;
    const body = renderDeadCronIssueBody(findings, { repo: repoName, generatedAt: nowIso });
    if (dryRun) {
      console.log(`\n--- [dry-run] ${fullRepo}: ${findings.length} finding(s) — would open/update "${TITLE}" ---`);
      console.log(body);
      continue;
    }
    const existing = listIssuesByLabel(fullRepo, LABEL, "open").find((i) => i.title === TITLE);
    const action = planIssueAction(findings.length, Boolean(existing));
    ensureLabel(fullRepo, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
    if (action === "open") {
      openIssue(fullRepo, LABEL, TITLE, body);
      console.log(`${fullRepo}: OPENED dead-cron issue (${findings.length} finding(s)).`);
    } else {
      gh(["issue", "edit", String(existing!.number), "--repo", fullRepo, "--body", body]);
      console.log(`${fullRepo}: UPDATED dead-cron issue #${existing!.number} (${findings.length} finding(s)).`);
    }
  }

  // ── close sweep — only on a NON-degraded run (a blind run must not close what it could not re-confirm) ──
  if (anySystemic) {
    console.warn("dead-cron: systemic degradation this run — close sweep SKIPPED (open issues stay open; see the self-issue).");
  } else {
    const openRepos = searchOpenDeadCronRepos();
    if (openRepos !== null) {
      const scanned = new Set(scannedRepos);
      const excludedInconclusive = openRepos.filter((r) => inconclusiveRepos.has(r));
      if (excludedInconclusive.length > 0) {
        console.warn(`dead-cron: ${excludedInconclusive.length} repo(s) with open issues excluded from the close sweep — reads incomplete this run (codex P2): ${excludedInconclusive.join(", ")}`);
      }
      const closeCandidates = openRepos.filter((r) => scanned.has(r) && !findingsByRepo.has(r) && !inconclusiveRepos.has(r));
      for (const repoName of closeCandidates) {
        const fullRepo = `${ORG}/${repoName}`;
        const existing = listIssuesByLabel(fullRepo, LABEL, "open").find((i) => i.title === TITLE);
        if (!existing) continue; // search lag or a different dead-cron-labeled issue — nothing of ours to close
        if (dryRun) {
          console.log(`[dry-run] ${fullRepo}: clean this run — would CLOSE dead-cron issue #${existing.number}.`);
          continue;
        }
        closeIssue(
          fullRepo,
          existing.number,
          `0 dead-cron findings for this repo this run — every previously-flagged workflow now shows recent scheduled activity/successes, or was retired or deliberately disabled. Auto-closed by the dead-cron detector.\n\n${summarizeDeadCron([])}.`,
        );
        console.log(`${fullRepo}: CLOSED dead-cron issue #${existing.number} (clean).`);
      }
    }
  }

  // ── self-issue reconcile (degradation channel — full-fleet runs only: a --repo-scoped
  // run's counters describe one repo, not the leg's fleet-wide capability) ──
  if (!repoFilter) {
    const selfBody = renderDegradationBody(degradation, nowIso);
    const selfExisting = listIssuesByLabel(SELF_REPO, LABEL, "open").find((i) => i.title === SELF_TITLE);
    const selfAction = planIssueAction(anySystemic ? 1 : 0, Boolean(selfExisting));
    if (dryRun) {
      console.log(`\n[dry-run] degradation self-issue planned action: ${selfAction.toUpperCase()}`);
      if (anySystemic) console.log(selfBody);
    } else if (selfAction === "open") {
      ensureLabel(SELF_REPO, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
      openIssue(SELF_REPO, LABEL, SELF_TITLE, selfBody);
      console.log(`${SELF_REPO}: OPENED degradation self-issue.`);
    } else if (selfAction === "update") {
      gh(["issue", "edit", String(selfExisting!.number), "--repo", SELF_REPO, "--body", selfBody]);
      console.log(`${SELF_REPO}: UPDATED degradation self-issue #${selfExisting!.number}.`);
    } else if (selfAction === "close") {
      closeIssue(
        SELF_REPO,
        selfExisting!.number,
        "Both read capabilities succeeded this run (workflows enumeration + workflow-file reads) — the permission gap is resolved and the dead-cron leg is fully sighted. Auto-closed.",
      );
      console.log(`${SELF_REPO}: CLOSED degradation self-issue #${selfExisting!.number}.`);
    }
  }

  console.log(`dead-cron-worker done${dryRun ? " (dry run)" : ""}.`);
}

main().catch((err) => {
  console.error(`dead-cron-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
