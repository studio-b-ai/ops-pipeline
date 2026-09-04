/**
 * required-checks-drift-classify.ts — pure classification logic for the required-checks-
 * drift leg of the weekly repo-hygiene detector (ops-pipeline#277, Mechanic seat
 * 2026-09-04 — read the issue FIRST, this file implements it, it does not restate it).
 *
 * Born from `library/incidents/2026-09-03-note-intelligence-ci-stale-required-check-and-
 * unparseable-ci-yml.md` §(b)/(c): note-intelligence's `main` branch protection required a
 * status context (`TypeScript Build`) whose job was renamed on 2026-03-09 — every PR
 * needed an admin bypass for six months (Rule #29's exact failure mode: a broken gate
 * looks like a strict one, so nobody noticed). A second, independent defect in the SAME
 * repo compounded it: `ci.yml` itself was unparseable YAML, so the job that would have
 * produced ANY context never ran at all — GitHub's own tell is a workflow run whose
 * `name` defaults to the file path instead of a real name.
 *
 * Law (inherited from repo-hygiene-lib.ts / dead-cron-classify.ts, same detector family):
 * **flags-only**. Nothing here (or in the caller, required-checks-drift-worker.ts) ever
 * edits branch protection, disables/retires a workflow, or fixes YAML — it only produces
 * findings and issue-body text a human (or a follow-up PR) reads and acts on.
 *
 * Pure (no network, no `new Date()` — "now" is always passed in where used at all; this
 * leg needs no clock). YAML parsing from an in-memory string is pure computation, not I/O
 * — unlike dead-cron-worker.ts (which keeps `parseYaml` in the worker), this file owns
 * `extractJobCheckNames` directly so the spec's own test cases ("a workflow declaring job
 * `name: X` → no finding") can run as single-function unit tests with zero `gh` mocking —
 * this repo's entire existing test suite (grepped before writing this file) never mocks
 * `gh`/network at all; every test here follows that same convention.
 *
 * Two INDEPENDENT finding classes, each riding its OWN auto-reconciled aggregate issue on
 * ops-pipeline itself (github-issues.ts's pattern — an open issue IS the alert/dedup
 * state, Rules #292/#358 by construction) — "one per class", not one per repo (repo-
 * hygiene-worker.ts's aggregate-issue shape, not dead-cron-worker.ts's per-repo shape:
 * this leg's two classes are unrelated defects on unrelated repos most weeks, and a
 * fleet-wide "here's everywhere this fires" issue is more useful than N per-repo issues a
 * human has to tab through):
 *
 *   1. required_check_dead   — a repo's branch protection requires a status-check CONTEXT
 *      that no job in `.github/workflows/*.yml` on its default branch can produce. No
 *      baseline tracks WHEN a context died (unlike repo-hygiene-lib.ts's classes, which
 *      diff against a committed baseline) — every finding is "since unknown", reporting
 *      only current live state. `null`-safe: a repo with NO branch protection (404 on the
 *      protection endpoint) is skipped entirely — no protection is not a finding.
 *
 *   2. workflow_unparseable  — a workflow file under `.github/workflows/` fails to parse as
 *      YAML — THIS leg's own parse of the file's fetched content, nothing derived.
 *      ⚠️ SUPERSEDED design (ops-pipeline#307, 2026-09-04 first firing): originally driven
 *      by GitHub's OWN tell — a workflow whose most recent run is named EXACTLY its file
 *      path instead of a real workflow/job name (the note-intelligence `ci.yml` incident:
 *      "GitHub records a zero-job failed run named `.github/workflows/ci.yml` on every
 *      push"). That tell FALSIFIED on its first live firing: 5/5 hits were clean
 *      `workflow_call` reusables and other legitimate path-named-run cases whose YAML
 *      parsed fine with `yaml.safe_load` and carried a real top-level `name:` — "a
 *      detector that fires on clean input is lying about dirty input too" (Rule #425). Fix:
 *      derive the finding from THIS file's own parse result instead — the content fetch
 *      class 1 already performs (`readWorkflowContent`, Contents:read) feeds this class
 *      too now, so the worker no longer calls `gh run list` at all, dropping the
 *      Actions:read dependency entirely and cutting API volume. A workflow with content the
 *      Contents API cannot fetch is `probe_failed` (repo/path named) — a fetch failure says
 *      nothing about the YAML's validity and must never silently read as either verdict
 *      (Rule #322).
 */

import { parse as parseYaml } from "yaml";

// ───────────────────────────── job → check-name extraction ─────────────────────────────

/**
 * Every check-name FORM one job in a workflow file can render as a required-check
 * `context` string: its own `name:` (or, absent that, its job KEY — the issue's exact
 * spec: "job KEYS, since a job without `name:` reports its key"), PLUS the composite
 * `"<workflow display name> / <job name>"` form GitHub renders for jobs whose check name
 * would otherwise collide or that call a reusable workflow (the issue's exact spec: "a
 * context of the form `<job name>` or `<workflow name> / <job name>` both count as
 * matched"). Computed for EVERY job unconditionally (not gated on `uses:`) — Rule #425:
 * this detector's output drives issues humans act on, so recall (fewer false
 * `required_check_dead` positives) is the safe direction; a required context matching
 * either form is a real live job, never dead weight.
 *
 * `workflow display name` = the file's top-level `name:` when present and non-blank, else
 * the caller-supplied file basename (GitHub's own fallback when a workflow has no `name:`
 * — it displays the file's basename in the Actions UI).
 */
export function extractJobCheckNames(yamlText: string, workflowFileBaseName: string): string[] | null {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return null; // structurally unparseable — caller must NOT trust this repo's comparison this run
  }
  if (doc === null || typeof doc !== "object") return null;
  const record = doc as Record<string, unknown>;
  const displayName = typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : workflowFileBaseName;
  const jobsNode = record.jobs;
  if (jobsNode === undefined || jobsNode === null || typeof jobsNode !== "object") return []; // parsed fine, just no jobs (or a non-workflow YAML file under the path — never a finding source)

  const names = new Set<string>();
  for (const [jobKey, jobDefRaw] of Object.entries(jobsNode as Record<string, unknown>)) {
    const jobDef = jobDefRaw && typeof jobDefRaw === "object" ? (jobDefRaw as Record<string, unknown>) : {};
    const jobName = typeof jobDef.name === "string" && jobDef.name.trim().length > 0 ? jobDef.name.trim() : jobKey;
    names.add(jobName);
    names.add(`${displayName} / ${jobName}`);
  }
  return [...names];
}

// ───────────────────────────── protection-probe error classification ─────────────────────────────

/**
 * Classifies a FAILED `GET .../branches/{b}/protection/required_status_checks` call's
 * error text — the pure, testable half of the worker's `fetchRequiredContexts` (mirrors
 * github-issues.ts's `isTransientGhFailure`/`isOrgMember` pattern: string-match the `gh`
 * stderr, kept as a standalone function so the discrimination is unit-testable with zero
 * `gh`/network mocking, matching this repo's entire existing test suite). The issue's own
 * spec: "a 404 = no protection → skip, not a finding" (definitive — the repo simply has no
 * required checks at all) vs any OTHER failure (403, 5xx, transport) → `probe_failed`
 * (Rule #322 — an inconclusive read is not a "no protection" result, and must never be
 * silently treated as one; it also must never itself become a finding).
 */
export function classifyProtectionProbeError(errorText: string): "no-protection" | "probe-failed" {
  return errorText.includes("HTTP 404") ? "no-protection" : "probe-failed";
}

// ───────────────────────────── class 1: required_check_dead ─────────────────────────────

export interface RequiredCheckDeadFinding {
  class: "required_check_dead";
  repo: string;
  context: string;
  /** Human-readable one-liner — always "since unknown" (no baseline tracks when a context died; see file header). */
  detail: string;
}

/** One workflow file's content-read + parse outcome, as the worker observed it. `jobNames: null` means the content read failed OR the YAML failed to parse — see `extractJobCheckNames`'s doc comment. */
export interface WorkflowFileObservation {
  path: string;
  jobNames: string[] | null;
}

export interface RequiredCheckDiffResult {
  findings: RequiredCheckDeadFinding[];
  /**
   * true when ANY workflow file in this repo could not be read/parsed this run — the
   * repo's comparison is UNTRUSTWORTHY (a context genuinely produced by the unreadable
   * file would falsely read as dead) and the caller must skip it, not report partial
   * findings (Rule #425: conservative; a detector whose output drives issues must not
   * trade a real repo-read failure for a false positive).
   */
  inconclusive: boolean;
}

/**
 * Diffs one repo's LIVE required-check contexts (from branch protection) against every
 * check name its workflow files can currently produce. Pure — `workflowFiles` is already
 * fetched+parsed by the caller (or carries `jobNames: null` for a file that failed).
 * `requiredContexts` empty (protection exists but requires nothing) → always `{findings:
 * [], inconclusive: false}`, no workflow reads needed by the caller in that case (the
 * caller may skip fetching workflow files entirely when contexts is empty — an I/O-cost
 * decision, not a diff-logic one, so it lives in the worker, exactly like
 * repo-hygiene-lib.ts's `LiveRepo.botChurn` presence contract).
 */
export function diffRequiredChecks(repo: string, requiredContexts: string[], workflowFiles: WorkflowFileObservation[]): RequiredCheckDiffResult {
  if (requiredContexts.length === 0) return { findings: [], inconclusive: false };
  if (workflowFiles.some((w) => w.jobNames === null)) return { findings: [], inconclusive: true };

  const liveNames = new Set<string>();
  for (const w of workflowFiles) for (const n of w.jobNames ?? []) liveNames.add(n);

  const findings: RequiredCheckDeadFinding[] = [];
  for (const context of [...requiredContexts].sort()) {
    if (liveNames.has(context)) continue;
    findings.push({
      class: "required_check_dead",
      repo,
      context,
      detail: `\`${repo}\` requires status context \`${context}\` on its default branch, but no job in \`.github/workflows/*.yml\` there renders that check name (since unknown — no baseline tracks when this context died, only current live state). Every PR needs an admin bypass while this stands (Rule #29's exact failure mode — the note-intelligence \`TypeScript Build\` incident: dead since a 2026-03-09 job rename, unnoticed for six months). Resolve by editing branch protection to require the CURRENT job name/key instead (repo Settings → Branches → \`required_status_checks\`), or by restoring a job that produces this exact context.`,
    });
  }
  return { findings, inconclusive: false };
}

// ───────────────────────────── class 2: workflow_unparseable ─────────────────────────────

export interface WorkflowUnparseableFinding {
  class: "workflow_unparseable";
  repo: string;
  workflowPath: string;
  detail: string;
}

/**
 * Truncates `message` to at most `maxCodePoints` Unicode CODE POINTS, appending an
 * ellipsis when it truncates — code-point-safe (ops-pipeline#309 review, P3): `.slice()`
 * on a JS string counts UTF-16 code UNITS, so a surrogate pair (e.g. an emoji) straddling
 * the boundary would be split in half, leaving a lone unpaired surrogate in the output —
 * invalid UTF-16 that renders as a replacement glyph or corrupts downstream JSON/Markdown.
 * `Array.from` iterates a string via its string ITERATOR, which yields whole code points
 * (surrogate pairs stay paired), so slicing the resulting array can never cut one in half.
 * Extracted as its own function (rather than inlined in `classifyWorkflowYamlParse`) so it
 * has a deterministic, directly-testable boundary case independent of any particular YAML
 * parser error's own message shape.
 */
export function truncateToCodePoints(message: string, maxCodePoints: number): string {
  const codePoints = Array.from(message);
  return codePoints.length > maxCodePoints ? `${codePoints.slice(0, maxCodePoints).join("")}…` : message;
}

/**
 * `workflow_unparseable` (ops-pipeline#307 fix) = THIS leg's own YAML parse of the
 * workflow file's fetched content THREW — nothing else. Deliberately does NOT reuse
 * `extractJobCheckNames`'s `null`-on-throw result: that function swallows the exception
 * for class 1's purposes (a "no jobs found" signal), where THIS class needs the actual
 * parser message — the diagnostic a human needs to fix the file — so it re-parses
 * independently and carries `err.message`, truncated to 160 code points via
 * `truncateToCodePoints` (long YAML error messages can embed large chunks of surrounding
 * source). A document that parses to a non-object (e.g. a bare scalar) is NOT this class's
 * concern — that's still a successful parse; only a thrown exception counts.
 */
export function classifyWorkflowYamlParse(repo: string, workflowPath: string, yamlText: string): WorkflowUnparseableFinding | null {
  try {
    parseYaml(yamlText);
    return null;
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = truncateToCodePoints(rawMessage, 160);
    return {
      class: "workflow_unparseable",
      repo,
      workflowPath,
      detail: `\`${repo}\`'s workflow \`${workflowPath}\` fails to parse as YAML: ${message} — every job this file was meant to run has been silently dead weight since it broke (a local \`python3 -c 'import yaml,sys;yaml.safe_load(open(sys.argv[1]))'\` or \`actionlint\` pass reproduces this).`,
    };
  }
}

// ───────────────────────────── summaries (Rule #465 — every class, every count, incl. 0) ─────────────────────────────

export function summarizeRequiredCheckDead(findings: RequiredCheckDeadFinding[]): string {
  return `required-checks-drift summary — required_check_dead=${findings.length}`;
}

export function summarizeWorkflowUnparseable(findings: WorkflowUnparseableFinding[]): string {
  return `required-checks-drift summary — workflow_unparseable=${findings.length}`;
}

/** findings.length, plus 1 when the read capability this class depends on is systemically dead this run — mirrors repo-hygiene-lib.ts's `alertWorthyCount` (Rule #464: a structurally-blind run must not silently plan "close"/"none" and look like a clean fleet). Kept local (not imported) because it takes THIS file's own finding-array element types, not repo-hygiene-lib.ts's `Finding` shape. */
export function alertWorthyCount(findingsLength: number, systemicDegradation: boolean): number {
  return findingsLength + (systemicDegradation ? 1 : 0);
}

// ───────────────────────────── issue bodies ─────────────────────────────

/** One structurally-dead read capability this run (Rule #464) — every attempt failed, not a handful of flaky repos. */
export interface SystemicFailure {
  capability: string;
  attempted: number;
  firstError: string;
}

export interface RequiredCheckDeadMeta {
  org: string;
  scannedRepoCount: number;
  generatedAt: string;
  /** Repos where the protection read 403'd (or any other non-404 failure) — Rule #322: a probe failure is not a "no protection" result; distinct from `inconclusiveRepos` below. */
  probeFailedRepos: string[];
  /** Repos where ≥1 workflow file couldn't be read/parsed/enumerated this run — comparison skipped for them (see `diffRequiredChecks`'s doc comment). */
  inconclusiveRepos: string[];
  /**
   * Every read capability that failed for EVERY repo attempted this run (as opposed to a
   * handful of individually flaky/permission-denied repos) — the fleet App permission-gap
   * pattern from repo-hygiene-worker.ts / dead-cron-worker.ts, applied to this leg's
   * dependencies (Administration:read for protection, Contents:read for workflow-file
   * enumeration+content — see the worker's file header for the live-verified gap). An
   * ARRAY, not a single optional field: on this leg's first live run BOTH capabilities are
   * expected to be simultaneously missing (2026-09-04 bug-squasher probe: the fleet App
   * currently holds only `issues:write` + `metadata:read`) — collapsing that into "pick
   * one to report" would silently drop the other's note.
   */
  systemicFailures: SystemicFailure[];
}

export function renderRequiredCheckDeadIssueBody(findings: RequiredCheckDeadFinding[], meta: RequiredCheckDeadMeta): string {
  const lines: string[] = [];
  lines.push(`Branch-protection required-check contexts vs live job names — \`${meta.org}\`.`);
  lines.push("");
  lines.push(`This run ${meta.generatedAt} · ${meta.scannedRepoCount} repo(s) scanned.`);

  for (const sf of meta.systemicFailures) {
    lines.push("");
    lines.push(
      `⚠️ **This class is structurally degraded this run (Rule #464)**: ${sf.capability} failed for ALL ${sf.attempted} repo(s)/read(s) attempted — this reads as a fleet-App permission gap, not per-repo flakiness. Findings below may be incomplete or absent until the grant lands (org Settings → GitHub Apps → studiob-fleet-bot → org-owner UI, no API path — the same class of grant already documented for the dead-cron leg's Actions/Contents gap). First error observed: ${sf.firstError}`,
    );
  }

  if (meta.probeFailedRepos.length > 0) {
    lines.push("");
    lines.push(`\`probe_failed\` (protection read errored — 403 or other, NOT a 404-no-protection result, so no finding either way): ${meta.probeFailedRepos.sort().join(", ")}.`);
  }
  if (meta.inconclusiveRepos.length > 0) {
    lines.push("");
    lines.push(`Skipped this run (≥1 workflow file unreadable/unparseable — comparison would risk a false positive, Rule #425): ${meta.inconclusiveRepos.sort().join(", ")}.`);
  }

  lines.push("");
  lines.push(`### Required-check contexts with no live job (${findings.length})`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("_none_");
  } else {
    for (const f of [...findings].sort((a, b) => a.repo.localeCompare(b.repo) || a.context.localeCompare(b.context))) {
      lines.push(`- ${f.detail}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push(summarizeRequiredCheckDead(findings) + ".");
  lines.push("");
  lines.push(
    "**Flags-only** (the repo-hygiene family's Law): this leg never edits branch protection — a human resolves each finding by updating the repo's `required_status_checks` to the current job name, or restoring the job that used to produce the dead context. Auto-closes when every finding above clears.",
  );
  return lines.join("\n");
}

export interface WorkflowUnparseableMeta {
  org: string;
  scannedWorkflowCount: number;
  generatedAt: string;
  /** Repos/repo-paths where the workflow file's content could not be fetched via the Contents API (not evidence either way — a fetch failure says nothing about the YAML's validity — see systemicFailures). */
  probeFailedWorkflows: string[];
  /** See `RequiredCheckDeadMeta.systemicFailures`'s doc comment — same array-not-optional rationale. Post-#307: this class depends on Contents:read ONLY (the prior Actions:read `gh run list` dependency was dropped entirely). */
  systemicFailures: SystemicFailure[];
}

export function renderWorkflowUnparseableIssueBody(findings: WorkflowUnparseableFinding[], meta: WorkflowUnparseableMeta): string {
  const lines: string[] = [];
  lines.push(`Workflows whose content fails to parse as YAML — \`${meta.org}\` (this leg's own parse of the fetched file; see ops-pipeline#307 for the superseded run-name-tell design).`);
  lines.push("");
  lines.push(`This run ${meta.generatedAt} · ${meta.scannedWorkflowCount} workflow file(s) checked.`);

  for (const sf of meta.systemicFailures) {
    lines.push("");
    lines.push(
      `⚠️ **This class is structurally degraded this run (Rule #464)**: ${sf.capability} failed for ALL ${sf.attempted} read(s) attempted — reads as a fleet-App permission gap, not per-workflow flakiness (the same gap class already documented for the dead-cron leg). Findings below may be incomplete or absent until the grant lands. First error observed: ${sf.firstError}`,
    );
  }
  if (meta.probeFailedWorkflows.length > 0) {
    lines.push("");
    lines.push(`Content fetch failed via the Contents API (excluded from this run's evidence, not a clean result): ${meta.probeFailedWorkflows.sort().join(", ")}.`);
  }

  lines.push("");
  lines.push(`### Unparseable workflow YAML (${findings.length})`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("_none_");
  } else {
    for (const f of [...findings].sort((a, b) => a.repo.localeCompare(b.repo) || a.workflowPath.localeCompare(b.workflowPath))) {
      lines.push(`- ${f.detail}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push(summarizeWorkflowUnparseable(findings) + ".");
  lines.push("");
  lines.push(
    "**Flags-only**: this leg never edits a workflow file — a human fixes the YAML (local `yaml.safe_load`/`actionlint` reproduces the parse error) and the next scheduled run confirms recovery. Auto-closes when every workflow above parses cleanly again.",
  );
  return lines.join("\n");
}
