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
 *   3. Per workflow file found in step 2's tree listing (regardless of branch-protection
 *      state — this class doesn't care whether the workflow is required): fetch its most
 *      recent run's `name` (`gh run list --workflow <id> --limit 1`) and check whether it
 *      equals the file's own path — GitHub's tell for unparseable YAML
 *      (`classifyRunName`) → class `workflow_unparseable`.
 *   4. Open/update/close TWO independent auto-reconciled aggregate issues on ops-pipeline
 *      itself (github-issues.ts's pattern) — ONE PER CLASS, not one per repo (see the lib
 *      file header for why this leg picked the aggregate shape over dead-cron's per-repo
 *      shape). `planIssueAction` (imported from repo-hygiene-lib.js — already the exact
 *      generic reconcile decision every sibling worker in this repo reuses) drives both.
 *
 * ⚠️ EXPECTED CI DEGRADATION ON DAY ONE (2026-09-04 bug-squasher probe on this exact issue,
 * ops-pipeline#277 comment 2 — read it before assuming this is a bug): the fleet App
 * (`studiob-fleet-bot`) currently holds EXACTLY `issues:write` + `metadata:read`. This leg
 * needs THREE capabilities it does not have yet:
 *   - **Administration (read)** — required for `GET
 *     /repos/{o}/{r}/branches/{b}/protection/required_status_checks` (branch protection is
 *     an admin-scoped resource per GitHub's permissions-required-for-apps docs).
 *   - **Contents (read)** — required for `GET /repos/{o}/{r}/git/trees/{branch}` (workflow
 *     enumeration) and `GET /repos/{o}/{r}/contents/{path}` (workflow content) — the SAME
 *     gap already documented in dead-cron-worker.ts's header, granted together via the
 *     outstanding ops#104 visit.
 *   - **Actions (read)** — required for `GET
 *     /repos/{o}/{r}/actions/workflows/{id}/runs` (latest-run-name lookup) — also already
 *     documented in dead-cron-worker.ts's header, same ops#104 grant.
 * So on the FIRST live run, EVERY read in this worker is expected to 403, both aggregate
 * issues will carry loud `systemicFailures` notes (Rule #464 — never a silent 0 that reads
 * as "fleet healthy"), and zero real findings will surface until an org-owner grants
 * Administration:read + Contents:read + Actions:read to the fleet App's installation (org
 * Settings → GitHub Apps → studiob-fleet-bot, UI-only, no API path — mirrors Rule #78's
 * `workflows:` permission story). This is a documented, honest degraded-from-day-one ship
 * per the issue's own recommended sequencing option (c) — NOT a reason to withhold the
 * leg; the fleet App permission grant is a separate, Kevin-gated, cross-cutting follow-up
 * (Rule #6) that benefits this leg AND the dead-cron leg AND repo-hygiene's bot-churn leg
 * simultaneously, so gating this PR on it would just duplicate the same wait three times.
 *
 * Run LOCALLY under a personally-authed `gh` (an org owner's own session), all three reads
 * work today — same story as dead-cron-worker.ts's identical footnote.
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
  classifyRunName,
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
const TITLE_UNPARSEABLE = "[repo-hygiene] workflow YAML unparseable (run name == file path)";

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

// ───────────────────────────── latest run name (Actions:read) ─────────────────────────────

interface WorkflowListRow {
  id: number;
  path: string;
}

/** Workflow records (id + path) for the repo — needed because `gh run list -w` accepts an id/filename, not a full nested path, and id is the least ambiguous. Independent read from the Contents-API tree listing above (different API family entirely — Actions, not Contents), so it gets its own counter. */
function listWorkflowRecords(repoName: string, counter: FetchCounter): WorkflowListRow[] | null {
  counter.attempted += 1;
  try {
    const raw = gh(["api", `repos/${ORG}/${repoName}/actions/workflows?per_page=100`, "--paginate", "--jq", ".workflows[] | {id, path}"]);
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as WorkflowListRow);
  } catch (err) {
    recordFailure(counter, err);
    console.warn(`required-checks-drift: workflow-records list failed for ${repoName}: ${errMessage(err).trim()}`);
    return null;
  }
}

function fetchLatestRunName(repoName: string, workflowId: number, counter: FetchCounter): string | undefined {
  counter.attempted += 1;
  try {
    const raw = gh(["run", "list", "--repo", `${ORG}/${repoName}`, "--workflow", String(workflowId), "--all", "--limit", "1", "--json", "name"]);
    const rows = JSON.parse(raw) as { name: string }[];
    return rows[0]?.name;
  } catch (err) {
    recordFailure(counter, err);
    console.warn(`required-checks-drift: run-list read failed for ${repoName} workflow#${workflowId}: ${errMessage(err).trim()}`);
    return undefined;
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
  const actionsReads = newCounter(); // covers BOTH the workflow-records list and the per-workflow run-list read — same GitHub App permission (Actions:read)

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

    const protection = fetchRequiredContexts(repoName, branch, protectionReads);

    // ── required_check_dead: only meaningful when protection exists and requires ≥1 context ──
    if (protection.kind === "probe-failed") {
      probeFailedRepos.push(repoName);
    } else if (protection.kind === "contexts" && protection.contexts.length > 0) {
      const files = listWorkflowFiles(repoName, branch, contentReads);
      if (files === null) {
        inconclusiveRepos.push(repoName);
      } else if (files.length > MAX_WORKFLOW_FILES_PER_REPO) {
        console.warn(`required-checks-drift: ${repoName}@${branch} has ${files.length} workflow files (> ${MAX_WORKFLOW_FILES_PER_REPO} cap) — marked inconclusive rather than truncated (Rule #331).`);
        inconclusiveRepos.push(repoName);
      } else {
        const observations: WorkflowFileObservation[] = files.map((path) => {
          const content = readWorkflowContent(repoName, path, branch, contentReads);
          const jobNames = content === null ? null : extractJobCheckNames(content, basename(path).replace(/\.ya?ml$/, ""));
          return { path, jobNames };
        });
        const { findings, inconclusive } = diffRequiredChecks(repoName, protection.contexts, observations);
        deadFindings.push(...findings);
        if (inconclusive) inconclusiveRepos.push(repoName);
      }
    }
    // protection.kind === "no-protection", or contexts.length === 0: nothing to compare — no finding, no failure.

    // ── workflow_unparseable: independent of branch protection — every scannable repo's workflow files ──
    const records = listWorkflowRecords(repoName, actionsReads);
    if (records === null) continue; // already warned + counted above
    for (const wf of records) {
      if (!WORKFLOW_PATH_PATTERN.test(wf.path)) continue; // dynamic workflows (CodeQL default setup etc.) — mirrors dead-cron-worker.ts's identical guard
      scannedWorkflowCount += 1;
      const latestName = fetchLatestRunName(repoName, wf.id, actionsReads);
      if (latestName === undefined) {
        // Either zero runs ever, OR the read itself failed. Only the latter is a probe
        // failure worth naming — `recordFailure` already logged it and bumped the
        // counter; we can't distinguish the two shapes from this return value alone
        // (Rule #322: `fetchLatestRunName` deliberately collapses "no runs" and "read
        // failed" to the SAME safe `undefined`, since both must behave identically here —
        // never fire the finding). We surface the workflow in `probeFailedWorkflows` only
        // when `actionsReads` grew a NEW failure on this exact call.
        continue;
      }
      const finding = classifyRunName(repoName, wf.path, latestName);
      if (finding) unparseableFindings.push(finding);
    }
  }

  // `probeFailedWorkflows` reconstruction: the loop above can't tell "0 runs" from "read
  // failed" per-iteration without threading extra state through fetchLatestRunName's
  // return type (which Rule #322 wants collapsed to `undefined` either way, since both
  // must never fire a finding) — so a coarser, still-honest signal: when actionsReads
  // failed at all this run, name it in the body via systemicFailures (below); a fully
  // itemized per-workflow probe-failed list is not required by the spec's finding shape
  // and would need a second counter parallel to `undefined`'s two causes. Left empty by
  // design — the systemic-failure note carries the degradation signal instead.

  const requiredCheckSystemic = [toSystemicFailure("branch-protection reads (Administration:read)", protectionReads), toSystemicFailure("workflow-file reads (Contents:read)", contentReads)].filter(
    (x): x is SystemicFailure => x !== null,
  );
  const unparseableSystemic = [toSystemicFailure("workflow-run reads (Actions:read)", actionsReads), toSystemicFailure("workflow-file reads (Contents:read)", contentReads)].filter(
    (x): x is SystemicFailure => x !== null,
  );

  console.log(`protection reads: ${protectionReads.attempted} attempted, ${protectionReads.failed} failed${isSystemic(protectionReads) ? " (SYSTEMIC)" : ""}`);
  console.log(`content reads (trees + files): ${contentReads.attempted} attempted, ${contentReads.failed} failed${isSystemic(contentReads) ? " (SYSTEMIC)" : ""}`);
  console.log(`actions reads (workflow list + run list): ${actionsReads.attempted} attempted, ${actionsReads.failed} failed${isSystemic(actionsReads) ? " (SYSTEMIC)" : ""}`);
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
