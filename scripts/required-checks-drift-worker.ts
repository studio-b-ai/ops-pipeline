#!/usr/bin/env tsx
/**
 * required-checks-drift-worker.ts — ops-pipeline#277 (Mechanic seat, 2026-09-04). Thin I/O
 * glue around scripts/lib/required-checks-drift-classify.ts — read THAT file's header
 * first; no classification decision lives here.
 *
 * What it does, per run (weekly, as a third step in .github/workflows/repo-hygiene.yml,
 * riding the SAME minted fleet-App token as its siblings — repo-hygiene-worker.ts and
 * dead-cron-worker.ts):
 *   1. Enumerate live NON-ARCHIVED, NON-TEMPLATE org repos (`gh repo list`, mirrors
 *      dead-cron-worker.ts's `partitionRepos` policy — imported directly, not
 *      reimplemented, per Rule #283).
 *   2. Per repo: read branch-protection `required_status_checks` (contexts ∪
 *      checks[].context) for its default branch — a 404 means "no protection", skipped,
 *      never a finding. List `.github/workflows/*.yml`/`.yaml` on that branch via the
 *      Contents/Trees API, read each file's content, extract every check-name a job can
 *      render (`extractJobCheckNames`), diff against the required contexts
 *      (`diffRequiredChecks`) → class `required_check_dead`.
 *   3. Per workflow file found in step 2's tree listing: try to parse its content with
 *      `parseYaml` (via `classifyWorkflowContent`) — a parser exception IS a
 *      `workflow_unparseable` finding whose message is carried into the issue body.
 *      Content-API failures on a specific file are named per-workflow in
 *      `probeFailedWorkflows` (issue #307 — never silence). The workflow-file enumeration
 *      + content read is SHARED with step 2's `required_check_dead` analysis (one read
 *      per file, both classes consume it).
 *   4. Open/update/close TWO independent auto-reconciled aggregate issues on ops-pipeline
 *      itself (github-issues.ts's pattern) — ONE PER CLASS, not one per repo (see the lib
 *      file header for why this leg picked the aggregate shape over dead-cron's per-repo
 *      shape). `planIssueAction` (imported from repo-hygiene-lib.js — already the exact
 *      generic reconcile decision every sibling worker in this repo reuses) drives both.
 *
 * ⚠️ ops-pipeline#307 rewrite (2026-09-04): the previous `workflow_unparseable` mechanism
 * used the "latest run name equals the file path" tell (Actions:read via `gh run list`) —
 * false-fired on CLEAN `workflow_call` reusable workflows (5/5 first-firing hits were
 * false positives, Rule #425). The parse-error mechanism this file now uses depends on
 * Contents:read alone (the SAME read the `required_check_dead` leg already needs), so
 * Actions:read is no longer a dependency.
 *
 * ⚠️ EXPECTED CI DEGRADATION UNTIL ONE GRANT LANDS: the fleet App (`studiob-fleet-bot`)
 * still needs **Administration (read)** on its org installation for
 * `GET /repos/{o}/{r}/branches/{b}/protection/required_status_checks` — the last remaining
 * gap; Contents/Actions are already granted at write per the workflow's own live-verified
 * 9/04 header note. Until that grant lands, `required_check_dead` will systemically
 * degrade (loud in the issue body per Rule #464); `workflow_unparseable` runs green on
 * Contents:read alone. This is a documented, honest degraded-from-day-one ship per the
 * issue's own recommended sequencing option (c) — the fleet App permission grant is a
 * separate, Kevin-gated follow-up (Rule #6).
 *
 * Run LOCALLY under a personally-authed `gh` (an org owner's own session), all reads work
 * today — same story as dead-cron-worker.ts's identical footnote.
 *
 * Flags-only (the lib's Law): never edits branch protection, never fixes/disables/retires
 * a workflow.
 *
 * `--dry-run`: real reads throughout (Rule #376), zero issue mutations, prints planned
 * actions + would-be bodies.
 * `--repo <name>`: scope to one repo (targeted testing / a future plant ladder, mirrors
 * dead-cron-worker.ts's `--repo`).
 */

import { basename } from "node:path";
import {
  extractJobCheckNames,
  diffRequiredChecks,
  classifyWorkflowContent,
  classifyProtectionProbeError,
  alertWorthyCount,
  renderRequiredCheckDeadIssueBody,
  renderWorkflowUnparseableIssueBody,
  summarizeRequiredCheckDead,
  summarizeWorkflowUnparseable,
  type RequiredCheckDeadFinding,
  type WorkflowUnparseableFinding,
  type WorkflowFileObservation,
  type SystemicFailure,
} from "./lib/required-checks-drift-classify.js";
import { partitionRepos, type LiveRepoRow } from "./lib/dead-cron-classify.js";
import { planIssueAction } from "./lib/repo-hygiene-lib.js";
import { ensureLabel, listIssuesByLabel, openIssue, closeIssue, gh } from "./lib/github-issues.js";

const ORG = "studio-b-ai";
const SELF_REPO = "studio-b-ai/ops-pipeline";
const LABEL = "required-checks-drift";
// ≤100 chars — GitHub 422s past it (ops-pipeline#136's live lesson, dead-cron-worker.ts's
// own comment on the same trap); verified at 91 chars before shipping.
const LABEL_DESCRIPTION = "required-checks-drift: dead branch-protection contexts / unparseable workflow YAML (weekly)";
const LABEL_COLOR = "B60205";
const TITLE_DEAD = "[repo-hygiene] required-status-check contexts with no live job";
const TITLE_UNPARSEABLE = "[repo-hygiene] workflow YAML unparseable";

/** Safety bound, not a paging mechanism (Rule #331) — mirrors both sibling workers. */
const LIVE_ENUMERATION_LIMIT = 300;

/**
 * Per-repo cap on workflow files considered for `required_check_dead` (bounds worst-case
 * API calls per the issue's own instruction — "Bound API calls (page sizes, per-repo
 * cap)"). A repo past the cap is marked INCONCLUSIVE rather than silently truncated (Rule
 * #331: truncating the tail risks a false `required_check_dead` for a context actually
 * produced by a file past the cut line) — no fleet repo is anywhere close to this today.
 */
const MAX_WORKFLOW_FILES_PER_REPO = 60;

// ───────────────────────────── fetch counters (Rule #464 degradation tracking) ─────────────────────────────

interface FetchCounter {
  attempted: number;
  failed: number;
  firstError: string | null;
}

function newCounter(): FetchCounter {
  return { attempted: 0, failed: 0, firstError: null };
}

function recordFailure(counter: FetchCounter, err: unknown): string {
  counter.failed += 1;
  const msg = errMessage(err);
  if (counter.firstError === null) counter.firstError = msg;
  return msg;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? `${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}\n${err.message}` : String(err);
}

/** Systemic = every attempt failed (and ≥1 was attempted) — mirrors dead-cron-classify.ts's `isSystemic`, duplicated here as a one-liner rather than imported: it's trivial arithmetic, and importing it would pull a whole sibling-leg module for one boolean check. */
function isSystemic(c: FetchCounter): boolean {
  return c.attempted > 0 && c.failed === c.attempted;
}

function toSystemicFailure(capability: string, c: FetchCounter): SystemicFailure | null {
  if (!isSystemic(c)) return null;
  return { capability, attempted: c.attempted, firstError: c.firstError ?? "unknown error" };
}

// ───────────────────────────── live enumeration ─────────────────────────────

interface GhRepoListRow {
  name: string;
  isArchived: boolean;
  isTemplate: boolean;
  defaultBranchRef: { name: string } | null;
}

function listLiveRepos(): { rows: GhRepoListRow[] } {
  const raw = gh(["repo", "list", ORG, "--limit", String(LIVE_ENUMERATION_LIMIT), "--json", "name,isArchived,isTemplate,defaultBranchRef"]);
  const rows = JSON.parse(raw) as GhRepoListRow[];
  if (rows.length === LIVE_ENUMERATION_LIMIT) {
    throw new Error(`live enumeration returned exactly the ${LIVE_ENUMERATION_LIMIT}-repo cap — raise LIVE_ENUMERATION_LIMIT and re-run (mirrors repo-hygiene-worker.ts's / dead-cron-worker.ts's identical guard, Rule #331).`);
  }
  return { rows };
}

// ───────────────────────────── branch protection (Administration:read) ─────────────────────────────

type ProtectionResult = { kind: "no-protection" } | { kind: "probe-failed" } | { kind: "contexts"; contexts: string[] };

interface ProtectionApiShape {
  contexts?: string[];
  checks?: { context: string }[];
}

function fetchRequiredContexts(repoName: string, branch: string, counter: FetchCounter): ProtectionResult {
  counter.attempted += 1;
  try {
    const raw = gh(["api", `repos/${ORG}/${repoName}/branches/${branch}/protection/required_status_checks`]);
    const parsed = JSON.parse(raw) as ProtectionApiShape;
    const set = new Set<string>([...(parsed.contexts ?? []), ...((parsed.checks ?? []).map((c) => c.context))]);
    return { kind: "contexts", contexts: [...set] };
  } catch (err) {
    const msg = errMessage(err);
    if (classifyProtectionProbeError(msg) === "no-protection") {
      // Definitive: no branch protection at all (or protection exists with no required
      // status checks configured) — never counts toward the permission-gap signal, same
      // contract as dead-cron-worker.ts's readCrons 404 handling.
      counter.attempted -= 1;
      return { kind: "no-protection" };
    }
    recordFailure(counter, err);
    console.warn(`required-checks-drift: protection read failed for ${repoName}@${branch} (probe_failed, no finding either way): ${msg.trim()}`);
    return { kind: "probe-failed" };
  }
}

// ───────────────────────────── workflow file enumeration + content (Contents:read) ─────────────────────────────

const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/.+\.ya?ml$/;

function listWorkflowFiles(repoName: string, branch: string, counter: FetchCounter): string[] | null {
  counter.attempted += 1;
  try {
    const raw = gh(["api", `repos/${ORG}/${repoName}/git/trees/${branch}?recursive=1`]);
    const parsed = JSON.parse(raw) as { tree?: { path: string; type: string }[]; truncated?: boolean };
    const paths = (parsed.tree ?? []).filter((t) => t.type === "blob" && WORKFLOW_PATH_PATTERN.test(t.path)).map((t) => t.path);
    if (parsed.truncated) {
      // GitHub's OWN truncation of the tree response (>100k entries or >7MB) — vanishingly
      // unlikely for `.github/workflows/`, but Rule #331 applies: never silently trust a
      // truncated enumeration as complete.
      console.warn(`required-checks-drift: git/trees response for ${repoName}@${branch} was TRUNCATED by GitHub — treating workflow enumeration as failed for this repo this run.`);
      return null;
    }
    return paths;
  } catch (err) {
    recordFailure(counter, err);
    console.warn(`required-checks-drift: workflow-tree read failed for ${repoName}@${branch}: ${errMessage(err).trim()}`);
    return null;
  }
}

function readWorkflowContent(repoName: string, path: string, branch: string, counter: FetchCounter): string | null {
  counter.attempted += 1;
  try {
    const b64 = gh(["api", `repos/${ORG}/${repoName}/contents/${path}?ref=${branch}`, "--jq", ".content"]);
    return Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf-8");
  } catch (err) {
    recordFailure(counter, err);
    console.warn(`required-checks-drift: content read failed for ${repoName}/${path}: ${errMessage(err).trim()}`);
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

  console.log(`=== required-checks-drift-worker${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""}${repoFilter ? ` --repo ${repoFilter}` : ""} ===`);

  const { rows } = listLiveRepos();
  const live: LiveRepoRow[] = rows.map((r) => ({ name: r.name, isArchived: r.isArchived, isTemplate: r.isTemplate }));
  const branchByName = new Map(rows.map((r) => [r.name, r.defaultBranchRef?.name ?? null]));
  const partition = partitionRepos(live);
  const scannedRepos = repoFilter ? partition.scannable.filter((r) => r === repoFilter) : partition.scannable;
  if (repoFilter && scannedRepos.length === 0) throw new Error(`--repo ${repoFilter}: not a live non-archived non-template repo in ${ORG}`);
  console.log(`Scanning ${scannedRepos.length} non-archived non-template repo(s) of ${live.length} live (${partition.archived.length} archived, ${partition.templates.length} template out of scope).`);

  const protectionReads = newCounter();
  const contentReads = newCounter(); // covers BOTH git/trees enumeration and per-file content reads — same GitHub App permission (Contents:read)

  const deadFindings: RequiredCheckDeadFinding[] = [];
  const unparseableFindings: WorkflowUnparseableFinding[] = [];
  const probeFailedRepos: string[] = [];
  const inconclusiveRepos: string[] = [];
  const probeFailedWorkflows: string[] = [];
  let scannedWorkflowCount = 0;

  for (const repoName of scannedRepos) {
    const branch = branchByName.get(repoName) ?? null;
    if (!branch) {
      console.warn(`required-checks-drift: ${repoName} has no default branch (empty repo?) — skipped.`);
      continue;
    }

    // ── protection read (Administration:read) — only used by required_check_dead ──
    const protection = fetchRequiredContexts(repoName, branch, protectionReads);
    if (protection.kind === "probe-failed") {
      probeFailedRepos.push(repoName);
    }

    // ── workflow file enumeration + per-file content reads (Contents:read) ──
    // Always run for BOTH classes: workflow_unparseable checks every file; required_check_dead
    // consumes the same reads. Enumeration failure = inconclusive for required_check_dead AND
    // no unparseable evidence for this repo — flagged separately below via `probeFailedRepos`
    // fabric (repo-level) and `probeFailedWorkflows` (file-level) so a human sees WHICH read
    // failed.
    const files = listWorkflowFiles(repoName, branch, contentReads);
    if (files === null) {
      // Tree-listing failed — both classes are blind for this repo this run.
      inconclusiveRepos.push(repoName);
      continue;
    }
    if (files.length > MAX_WORKFLOW_FILES_PER_REPO) {
      console.warn(`required-checks-drift: ${repoName}@${branch} has ${files.length} workflow files (> ${MAX_WORKFLOW_FILES_PER_REPO} cap) — marked inconclusive rather than truncated (Rule #331).`);
      inconclusiveRepos.push(repoName);
      continue;
    }

    const observations: WorkflowFileObservation[] = [];
    for (const path of files) {
      scannedWorkflowCount += 1;
      const content = readWorkflowContent(repoName, path, branch, contentReads);
      if (content === null) {
        // Content-API fetch failed for THIS specific file — named per-workflow in
        // probeFailedWorkflows (issue #307: never silence a Contents-API miss). Cannot
        // decide unparseable-vs-clean for this file, and cannot contribute jobNames.
        probeFailedWorkflows.push(`${repoName}/${path}`);
        observations.push({ path, jobNames: null });
        continue;
      }
      // parse-error-based workflow_unparseable — one parse per file, shared with
      // required_check_dead's jobNames extraction on the clean-parse path.
      const unparseable = classifyWorkflowContent(repoName, path, content);
      if (unparseable) {
        unparseableFindings.push(unparseable);
        // A parser exception means jobNames can't be derived — the file is inconclusive
        // for required_check_dead (mirrors extractJobCheckNames's own null contract).
        observations.push({ path, jobNames: null });
      } else {
        observations.push({ path, jobNames: extractJobCheckNames(content, basename(path).replace(/\.ya?ml$/, "")) });
      }
    }

    // required_check_dead only fires when protection exists AND requires ≥1 context.
    if (protection.kind === "contexts" && protection.contexts.length > 0) {
      const { findings, inconclusive } = diffRequiredChecks(repoName, protection.contexts, observations);
      deadFindings.push(...findings);
      if (inconclusive && !inconclusiveRepos.includes(repoName)) inconclusiveRepos.push(repoName);
    }
    // protection.kind === "no-protection" or contexts.length === 0: no finding, no failure.
  }

  const requiredCheckSystemic = [toSystemicFailure("branch-protection reads (Administration:read)", protectionReads), toSystemicFailure("workflow-file reads (Contents:read)", contentReads)].filter(
    (x): x is SystemicFailure => x !== null,
  );
  const unparseableSystemic = [toSystemicFailure("workflow-file reads (Contents:read)", contentReads)].filter((x): x is SystemicFailure => x !== null);

  console.log(`protection reads: ${protectionReads.attempted} attempted, ${protectionReads.failed} failed${isSystemic(protectionReads) ? " (SYSTEMIC)" : ""}`);
  console.log(`content reads (trees + files): ${contentReads.attempted} attempted, ${contentReads.failed} failed${isSystemic(contentReads) ? " (SYSTEMIC)" : ""}`);
  console.log(summarizeRequiredCheckDead(deadFindings));
  console.log(summarizeWorkflowUnparseable(unparseableFindings));

  const deadBody = renderRequiredCheckDeadIssueBody(deadFindings, {
    org: ORG,
    scannedRepoCount: scannedRepos.length,
    generatedAt: now.toISOString(),
    probeFailedRepos,
    inconclusiveRepos,
    systemicFailures: requiredCheckSystemic,
  });
  const unparseableBody = renderWorkflowUnparseableIssueBody(unparseableFindings, {
    org: ORG,
    scannedWorkflowCount,
    generatedAt: now.toISOString(),
    probeFailedWorkflows,
    systemicFailures: unparseableSystemic,
  });

  if (dryRun) {
    console.log("\n--- [dry-run] would-be required_check_dead issue body ---");
    console.log(deadBody);
    console.log("\n--- [dry-run] would-be workflow_unparseable issue body ---");
    console.log(unparseableBody);
    console.log("\n(dry run — no issue was opened, updated, or closed)");
    return;
  }

  const deadAlertCount = alertWorthyCount(deadFindings.length, requiredCheckSystemic.length > 0);
  const unparseableAlertCount = alertWorthyCount(unparseableFindings.length, unparseableSystemic.length > 0);

  reconcileAggregateIssue(TITLE_DEAD, deadAlertCount, deadBody, `Fleet is clean — 0 required_check_dead findings this run, and all read capabilities succeeded. Auto-closed.\n\n${summarizeRequiredCheckDead([])}.`);
  reconcileAggregateIssue(TITLE_UNPARSEABLE, unparseableAlertCount, unparseableBody, `Fleet is clean — 0 workflow_unparseable findings this run, and all read capabilities succeeded. Auto-closed.\n\n${summarizeWorkflowUnparseable([])}.`);

  console.log("required-checks-drift-worker done.");
}

function reconcileAggregateIssue(title: string, alertCount: number, body: string, closeComment: string): void {
  const openIssues = listIssuesByLabel(SELF_REPO, LABEL, "open");
  const existing = openIssues.find((i) => i.title === title);
  const action = planIssueAction(alertCount, Boolean(existing));
  if (action === "open") {
    ensureLabel(SELF_REPO, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
    openIssue(SELF_REPO, LABEL, title, body);
    console.log(`${SELF_REPO}: OPENED "${title}".`);
  } else if (action === "update") {
    ensureLabel(SELF_REPO, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
    gh(["issue", "edit", String(existing!.number), "--repo", SELF_REPO, "--body", body]);
    console.log(`${SELF_REPO}: UPDATED "${title}" (#${existing!.number}).`);
  } else if (action === "close") {
    closeIssue(SELF_REPO, existing!.number, closeComment);
    console.log(`${SELF_REPO}: CLOSED "${title}" (#${existing!.number}).`);
  } else {
    console.log(`${SELF_REPO}: "${title}" — no open issue, nothing to do.`);
  }
}

main().catch((err) => {
  console.error(`required-checks-drift-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
