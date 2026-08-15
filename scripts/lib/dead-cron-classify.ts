/**
 * dead-cron-classify.ts — pure classification logic for the dead-cron detector leg
 * (ops-pipeline#112, CTO seat 2026-08-15 — read the issue FIRST; this file implements it).
 *
 * The class this leg exists to catch (evidence: client-asthetik#217, found 8/15 by manual
 * probe only): six scheduled workflows failed daily for 100+ days with zero effective
 * alerting — five broken since birth (scripts that never existed, secrets never minted),
 * one a working detector crashing at a never-before-fired reporting leg. A second known
 * specimen: hubspot-configs' own drift workflow silently stopped running 2026-03-13 (the
 * auto-disable/never-fires class). Nothing in the fleet watched for any of it.
 *
 * Law (inherited from repo-hygiene-lib.ts, same arc): **flags-only**. Classification
 * sweeps NOMINATE, instruments DECIDE, humans WORD. Nothing here (or in the caller,
 * dead-cron-worker.ts) ever fixes, disables, retires, or re-runs a workflow — it only
 * produces findings and issue-body text a human reads and acts on. Tonight's own triage
 * proved why: 5 of the 6 "dead" workflows were true corpses, but the 6th was a WORKING
 * detector one missing label away from healthy — retirement is a judgment call.
 *
 * Pure (no I/O, no network, no `new Date()` — "now" is always passed in) so it is fully
 * unit-testable — mirrors repo-hygiene-lib.ts / railway-volume-classify.ts: `gh` calls
 * live in dead-cron-worker.ts, this file only turns observations into findings.
 *
 * Finding classes v1 (exactly three, from the issue's spec):
 *   1. zero-success-history — no success in the run window with ≥10 failing runs:
 *      broken-since-birth (Rule #464's class — a guard that has never once worked).
 *   2. failure-streak      — K consecutive failing scheduled runs, K derived from the
 *      cron period (≈7 daily / 3 weekly — dead-for-a-week at its own cadence).
 *   3. scheduled-but-silent — cron present but not firing: GitHub's 60-day inactivity
 *      auto-disable (state=disabled_inactivity), a never-fired cron (the #280 class —
 *      invalid identifiers etc. make GitHub silently never run it), or an active
 *      workflow whose last scheduled run is older than 2× its period.
 *
 * Exactly ONE finding per workflow, strongest class wins (silent > zero-success >
 * streak): a disabled_inactivity workflow also carries an old failure streak, and a
 * 25/25-failing workflow always has a ≥K streak — reporting both would be noise
 * dressed as thoroughness.
 *
 * Precision posture (Rule #425 — this detector's output drives ISSUES humans act on):
 * conservative everywhere. `disabled_manually` never flags (a human chose that — Rule
 * #157). Streaks BREAK on any non-failing conclusion (a cancelled/skipped run is not
 * evidence of death). Never-fired only flags past a minimum age (a cron added yesterday
 * legitimately has no runs). Unknown periods fall back to observed run spacing, then to
 * a conservative default — never to the aggressive end.
 *
 * Cadence honesty (Rule #448): the worker runs WEEKLY (repo-hygiene.yml, Fri 09:00Z) —
 * detection latency is up to 7 days plus the condition's own threshold. This leg makes
 * no per-run freshness claims; `renderDeadCronIssueBody`'s footer says exactly that.
 *
 * Transient-read guard (2026-08-15, ui-test-suite#44 — the detector's FIRST false
 * positive, ~13h after its first live fire): the 04:07Z run's one-shot read of a
 * workflow's scheduled-run window came back with the 6/22 run as its NEWEST entry — the
 * seven weekly successes 6/29→8/10 were absent or mis-ordered in that single response
 * (the identical query 13h later returned all 18, newest-first; a 30-workflow fleet
 * ordering check found 30/30 newest-first). The classifier trusted `runs[0]` as newest
 * and flagged "silent 53d". Two defenses now:
 *   • this file NEVER trusts input order — `classifyWorkflow` sorts newest-first itself
 *     (`sortRunsNewestFirst`), so a mis-ordered page can't fake silence or a streak;
 *   • the worker reads the window TWICE with different query shapes (the plain window +
 *     a `created>=now-90d` filter) and classifies on the UNION (`mergeRunWindows`) — a
 *     run missing from one response is caught if the other has it (#322/#465: an
 *     absence claim needs a second instrument). Residual: a backend that drops the same
 *     runs from BOTH shapes still fools it — the weekly re-evaluation + auto-close is
 *     the self-heal (that is exactly what closed #44).
 */

// ───────────────────────────── constants ─────────────────────────────

/** Scheduled-run window fetched per workflow (newest-first). The spec's N=25. */
export const RUN_WINDOW = 25;

/**
 * zero-success-history requires at least this many FAILING completed runs alongside zero
 * successes — below it, a young workflow's early failures are the failure-streak class's
 * business (which matures at its own K), not a "broken since birth" verdict.
 */
export const MIN_FAILING_FOR_ZERO_SUCCESS = 10;

/**
 * A never-fired cron (zero scheduled runs EVER) only flags when the workflow is at least
 * this old (or 2× its period, whichever is larger) — a workflow created yesterday with a
 * weekly cron legitimately has no runs yet.
 */
export const NEVER_FIRED_MIN_AGE_DAYS = 14;

/** Silence fallback when no period can be derived (no parseable cron, <2 observed runs). */
export const UNKNOWN_PERIOD_SILENCE_DAYS = 14;

/** Run conclusions that count as FAILING for streak/zero-success purposes. Everything else (cancelled, skipped, neutral, action_required, stale, null) is NEUTRAL — it neither fails nor succeeds, and it BREAKS a streak (see file header's precision posture). */
export const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

// ───────────────────────────── input shapes ─────────────────────────────

export interface WorkflowMeta {
  /** Display name from the workflows API. */
  name: string;
  /** e.g. ".github/workflows/foo.yml" — dynamic workflows (CodeQL default setup etc.) have non-.github paths and are excluded by the caller. */
  path: string;
  /** "active" | "disabled_manually" | "disabled_inactivity" (GitHub's own state vocabulary). */
  state: string;
  /** ISO 8601 — when the workflow was created, from the workflows API. */
  createdAt: string;
}

export interface ScheduledRun {
  /** GitHub run id — the dedupe key when two window reads are merged (`mergeRunWindows`). Optional so hand-built fixtures stay terse. */
  id?: number;
  /** "completed" | "in_progress" | "queued" | ... */
  status: string;
  /** null while not completed; else "success" | "failure" | "cancelled" | "timed_out" | "startup_failure" | "skipped" | "neutral" | ... */
  conclusion: string | null;
  /** ISO 8601. */
  createdAt: string;
}

export interface WorkflowObservation {
  repo: string;
  workflow: WorkflowMeta;
  /**
   * Cron expressions parsed from the workflow FILE (`on.schedule[].cron`). Empty when the
   * file could not be read/parsed — the workflow may still be schedule-bearing if it has
   * scheduled RUN history (`runs`), which is why classification treats "has a cron" as
   * `crons.length > 0 || runs.length > 0`.
   */
  crons: string[];
  /**
   * Scheduled-trigger runs ONLY (`event=schedule`), newest-first, up to RUN_WINDOW.
   * workflow_dispatch/push runs are deliberately excluded: a cron can be dead while
   * manual dispatches work fine — the cron is what this leg watches.
   */
  runs: ScheduledRun[];
}

// ───────────────────────────── cron → period ─────────────────────────────

/**
 * Coarse period classification of a single 5-field cron expression — this leg needs the
 * PERIOD (how often should this fire), never the exact next-fire time, so a full cron
 * engine would be complexity without evidence value. Mapping:
 *
 *   dom=* dow=*            → 1d  (daily or more frequent — sub-daily collapses to daily
 *                                 for thresholds; a 7-failure streak of an hourly cron is
 *                                 still exactly the evidence the streak class wants)
 *   dow restricted, single → 7d  (weekly)
 *   dow restricted, multi  → 3d  (several days a week — max healthy gap ≈ a long weekend)
 *   dom restricted         → 31d (monthly)
 *   both restricted        → 3d  (standard cron ORs dom/dow → fires MORE often than
 *                                 either alone; the more-frequent read is the safe one
 *                                 for K, and silence still uses 2× this)
 *   unparseable            → null
 */
export function cronPeriodDays(cron: string): number | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [, , dom, , dow] = fields;
  const domAny = dom === "*";
  const dowAny = dow === "*";
  if (domAny && dowAny) return 1;
  if (!domAny && !dowAny) return 3;
  if (!dowAny) {
    // dow restricted, dom=* — single value = weekly; lists/ranges/steps = several days a week.
    return /^[A-Za-z0-9]+$/.test(dow) ? 7 : 3;
  }
  return 31; // dom restricted, dow=*
}

/** Shortest period across a workflow's cron entries (the most frequent trigger governs expectations). null when none parse. */
export function resolveCronPeriodDays(crons: string[]): number | null {
  const periods = crons.map(cronPeriodDays).filter((p): p is number => p !== null);
  return periods.length > 0 ? Math.min(...periods) : null;
}

/**
 * Fallback period from OBSERVED scheduled-run spacing (median gap between consecutive
 * runs, newest-first input) — failing runs still fire ON SCHEDULE, so their spacing
 * reflects the cron even when the file itself couldn't be read. Needs ≥3 runs (≥2 gaps)
 * to say anything; result clamped to [1, 45] days so one weird gap (an outage, a
 * re-enable) can't produce a nonsense period.
 */
export function observedPeriodDays(runs: ScheduledRun[]): number | null {
  if (runs.length < 3) return null;
  const times = runs.map((r) => new Date(r.createdAt).getTime()).filter((t) => Number.isFinite(t));
  if (times.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 0; i + 1 < times.length; i++) gaps.push(Math.abs(times[i] - times[i + 1]) / (24 * 60 * 60 * 1000));
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.min(45, Math.max(1, median));
}

/** Period ladder: parsed cron → observed spacing → null (callers then use conservative defaults). */
export function resolvePeriodDays(obs: WorkflowObservation): number | null {
  return resolveCronPeriodDays(obs.crons) ?? observedPeriodDays(obs.runs);
}

/**
 * Streak threshold K from the period — the issue's own calibration (K≈7 daily, 3 weekly),
 * extended monotonically: more frequent crons need longer streaks before "dead" is a fair
 * read, rarer crons are dead after fewer misses (2 straight monthly failures = 2+ months
 * broken). Unknown period → the daily K (7), the conservative end (hardest to trip).
 */
export function streakThresholdK(periodDays: number | null): number {
  if (periodDays === null) return 7;
  if (periodDays <= 1) return 7;
  if (periodDays <= 3) return 5;
  if (periodDays <= 7) return 3;
  return 2;
}

// ───────────────────────────── run-history reads ─────────────────────────────

function runTime(run: ScheduledRun): number {
  const t = new Date(run.createdAt).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY; // unparseable dates sort LAST (oldest)
}

/**
 * Newest-first copy of `runs` (stable; unparseable dates last). Every reader in this file
 * assumes newest-first — this is what makes that assumption TRUE regardless of what the
 * API handed back (the ui-test-suite#44 transient-read class, see file header).
 */
export function sortRunsNewestFirst(runs: ScheduledRun[]): ScheduledRun[] {
  return [...runs].sort((a, b) => runTime(b) - runTime(a));
}

function runKey(run: ScheduledRun): string {
  return run.id !== undefined ? `id:${run.id}` : `t:${run.createdAt}|${run.status}|${run.conclusion ?? ""}`;
}

export interface MergedRunWindow {
  /** Union of both reads, newest-first, capped to `window`. */
  runs: ScheduledRun[];
  /** Runs present in `secondary` but absent from `primary` (any age). */
  added: number;
  /** Subset of `added` STRICTLY newer than primary's newest run (or all of `added` when primary was empty) — the transient-read signature: the plain window read missed recent activity. */
  addedNewer: number;
}

/**
 * Union of two reads of the same workflow's scheduled-run window (dedupe by run id, else
 * by createdAt+status+conclusion), newest-first, capped to `window`. The worker's
 * transient-read guard: classification runs on the union, so a run dropped or mis-placed
 * in ONE response is still seen if the OTHER response has it. `addedNewer > 0` is the
 * observable that the primary read was stale — the worker logs it loudly.
 */
export function mergeRunWindows(primary: ScheduledRun[], secondary: ScheduledRun[], window: number = RUN_WINDOW): MergedRunWindow {
  const seen = new Set(primary.map(runKey));
  const primaryNewest = primary.length > 0 ? Math.max(...primary.map(runTime)) : Number.NEGATIVE_INFINITY;
  let added = 0;
  let addedNewer = 0;
  const union = [...primary];
  for (const run of secondary) {
    const key = runKey(run);
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(run);
    added += 1;
    if (runTime(run) > primaryNewest) addedNewer += 1;
  }
  return { runs: sortRunsNewestFirst(union).slice(0, window), added, addedNewer };
}

function completedRuns(runs: ScheduledRun[]): ScheduledRun[] {
  return runs.filter((r) => r.status === "completed");
}

export function isFailingConclusion(conclusion: string | null): boolean {
  return conclusion !== null && FAILING_CONCLUSIONS.has(conclusion);
}

/** Consecutive FAILING completed runs from the newest backward; ANY non-failing completed run (success, cancelled, skipped, …) breaks it — see the file header's precision posture. */
export function failureStreak(runs: ScheduledRun[]): number {
  let streak = 0;
  for (const run of completedRuns(runs)) {
    if (isFailingConclusion(run.conclusion)) streak += 1;
    else break;
  }
  return streak;
}

function daysBetween(earlierIso: string, laterIso: string): number | null {
  const a = new Date(earlierIso).getTime();
  const b = new Date(laterIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / (24 * 60 * 60 * 1000);
}

// ───────────────────────────── classification ─────────────────────────────

export const DEAD_CRON_CLASSES = ["scheduled-but-silent", "zero-success-history", "failure-streak"] as const;

export type DeadCronClass = (typeof DEAD_CRON_CLASSES)[number];

export interface DeadCronFinding {
  repo: string;
  workflowName: string;
  workflowPath: string;
  class: DeadCronClass;
  /** Human-readable one-liner with the exact evidence (counts, dates, thresholds used). */
  detail: string;
}

/**
 * Classifies one workflow observation into AT MOST one finding (strongest class wins —
 * see file header). Returns null for healthy, for disabled_manually (a human's choice),
 * and for anything the evidence doesn't clearly support (Rule #425: conservative).
 *
 * Callers pass only workflows that are schedule-bearing (cron in file OR scheduled-run
 * history) — this function additionally guards on that itself so a stray non-scheduled
 * workflow can never produce a finding.
 */
export function classifyWorkflow(input: WorkflowObservation, nowIso: string): DeadCronFinding | null {
  // Never trust input order (file header, transient-read guard): everything below reads
  // `obs.runs[0]` as newest — make that true here, whatever the API returned.
  const obs: WorkflowObservation = { ...input, runs: sortRunsNewestFirst(input.runs) };
  const { workflow } = obs;
  const hasScheduleEvidence = obs.crons.length > 0 || obs.runs.length > 0;
  if (!hasScheduleEvidence) return null;
  if (workflow.state === "disabled_manually") return null;

  const periodDays = resolvePeriodDays(obs);
  const base = { repo: obs.repo, workflowName: workflow.name, workflowPath: workflow.path };

  // ── class 3 first (strongest): scheduled-but-silent ──
  if (workflow.state === "disabled_inactivity") {
    const newest = obs.runs[0];
    const lastRunNote = newest ? `last scheduled run ${newest.createdAt}` : "no scheduled runs in the fetched window";
    return {
      ...base,
      class: "scheduled-but-silent",
      detail: `GitHub auto-disabled this workflow for 60 days of repository inactivity (state=disabled_inactivity) — its cron no longer fires at all; ${lastRunNote}. Re-enable it if it should run, or retire it if not.`,
    };
  }

  if (workflow.state === "active") {
    if (obs.runs.length === 0) {
      // Never fired. Only meaningful when we KNOW a cron exists (file was readable) and
      // the workflow is old enough that "it just hasn't come around yet" is ruled out.
      const minAgeDays = Math.max(NEVER_FIRED_MIN_AGE_DAYS, periodDays !== null ? 2 * periodDays : 0);
      const ageDays = daysBetween(workflow.createdAt, nowIso);
      if (obs.crons.length > 0 && ageDays !== null && ageDays >= minAgeDays) {
        return {
          ...base,
          class: "scheduled-but-silent",
          detail: `has \`on: schedule\` (${obs.crons.map((c) => `\`${c}\``).join(", ")}) but ZERO scheduled runs ever, and the workflow is ~${Math.floor(ageDays)}d old (≥${minAgeDays}d threshold) — the cron has never fired (the Rule-#280 class: GitHub silently never runs workflows with invalid identifiers, or the schedule was added and never took).`,
        };
      }
    } else {
      const newest = obs.runs[0];
      const silenceDays = daysBetween(newest.createdAt, nowIso);
      const silenceThresholdDays = periodDays !== null ? 2 * periodDays : UNKNOWN_PERIOD_SILENCE_DAYS;
      if (silenceDays !== null && silenceDays >= silenceThresholdDays) {
        return {
          ...base,
          class: "scheduled-but-silent",
          detail: `last scheduled run was ${newest.createdAt} (~${Math.floor(silenceDays)}d ago) against an expected period of ~${periodDays ?? "unknown"}d (threshold ${silenceThresholdDays}d) — the cron has stopped firing (manual dispatches, if any, don't count here).`,
        };
      }
    }
  }

  // ── classes 1/2 need completed-run history ──
  const completed = completedRuns(obs.runs);
  const successes = completed.filter((r) => r.conclusion === "success").length;
  const failures = completed.filter((r) => isFailingConclusion(r.conclusion)).length;

  if (successes === 0 && failures >= MIN_FAILING_FOR_ZERO_SUCCESS) {
    return {
      ...base,
      class: "zero-success-history",
      detail: `0 successes across its last ${completed.length} completed scheduled runs (${failures} failing) — broken-since-birth territory (the Rule-#464 class: this workflow may never once have worked; check whether its scripts/secrets ever existed before assuming a regression).`,
    };
  }

  const streak = failureStreak(obs.runs);
  const k = streakThresholdK(periodDays);
  if (streak >= k) {
    return {
      ...base,
      class: "failure-streak",
      detail: `${streak} consecutive failing scheduled runs (threshold K=${k} for a ~${periodDays ?? "unknown"}d period) — dead for at least ${streak} cycles at its own cadence.`,
    };
  }

  return null;
}

// ───────────────────────────── summary (Rule #465) ─────────────────────────────

/** Every class with its count, including 0 — same string feeds the worker console AND issue bodies, so they can never disagree (the repo-hygiene-lib pattern). */
// ───────────────────────────── repo scope policy ─────────────────────────────

export interface LiveRepoRow {
  name: string;
  isArchived: boolean;
  isTemplate: boolean;
}

export interface RepoPartition {
  /** Non-archived, not policy-skipped — the repos this leg classifies (INCLUDES template-flagged live repos, see `templateFlaggedLive`). */
  scannable: string[];
  /** Non-archived repos matching the FULL template policy (`is_template` AND a `*template*` name) — skipped from classification, close-eligible. */
  templates: string[];
  /** Non-archived repos carrying `is_template=true` WITHOUT a template name — live repos using GitHub's flag for "Use this template" convenience (2026-08-15: client-asthetik, acuops-pipeline). Classified normally; surfaced so the flag's oddity stays visible. */
  templateFlaggedLive: string[];
  /** Archived — out of scope entirely (their workflows cannot run and never flag). */
  archived: string[];
}

/**
 * Template-repo policy (2026-08-15, ops-template#1 + studiob-test-template#1 — two of the
 * first fleet firing's findings were GitHub TEMPLATE repos): a template's workflow files
 * are BLUEPRINTS copied into spawned repos, not services that run on the template itself.
 * A cron on the template is therefore never a service-health signal — it fires (or is
 * auto-disabled for the template's natural dormancy, `disabled_inactivity`, which it will
 * re-trip forever) against nothing. Templates are excluded from classification; SPAWNED
 * repos are classified normally. A template repo carrying an open dead-cron issue is
 * close-eligible with `renderTemplatePolicyCloseComment` (else the exclusion would orphan
 * the issue behind the "only scanned repos get closed" rule).
 */
export const TEMPLATE_POLICY = "template repos are blueprints, not services — skipped by policy; spawned repos are classified normally";

/**
 * The policy needs BOTH signals. GitHub's `is_template` flag alone is NOT a safe proxy for
 * "blueprint, not a service": the first dry-run of this policy (2026-08-15) listed
 * client-asthetik and acuops-pipeline as templates — live, actively-pushed repos that carry
 * the flag for "Use this template" convenience — and would have policy-closed
 * client-asthetik#219, a REAL finding. Rule #425 caught it in the dry-run (#465: a policy
 * keyed on a metadata flag inherits the flag's semantics, not the intent). Studio B's own
 * naming convention (`*-template`: ops-template, studiob-test-template) is the
 * discriminator that actually holds; the flag confirms it.
 */
export const TEMPLATE_NAME_PATTERN = /template/i;

export function isPolicyTemplate(row: LiveRepoRow): boolean {
  return row.isTemplate && TEMPLATE_NAME_PATTERN.test(row.name);
}

export function partitionRepos(rows: LiveRepoRow[]): RepoPartition {
  const scannable: string[] = [];
  const templates: string[] = [];
  const templateFlaggedLive: string[] = [];
  const archived: string[] = [];
  for (const r of rows) {
    if (r.isArchived) archived.push(r.name);
    else if (isPolicyTemplate(r)) templates.push(r.name);
    else {
      scannable.push(r.name);
      if (r.isTemplate) templateFlaggedLive.push(r.name);
    }
  }
  return { scannable, templates, templateFlaggedLive, archived };
}

export function renderTemplatePolicyCloseComment(): string {
  return [
    "This repository is a GitHub **template** (`is_template=true`): its workflow files are blueprints copied into spawned repos, not services that run here — a cron firing (or being auto-disabled for the template's natural dormancy) on the template itself is never a service-health signal.",
    `The dead-cron detector now skips template repos by policy (${TEMPLATE_POLICY}); spawned repos are still classified normally, so a broken cron in a spawn is caught there.`,
    "Auto-closed by the dead-cron detector.",
  ].join("\n\n");
}

export function summarizeDeadCron(findings: DeadCronFinding[]): string {
  const counts = new Map<DeadCronClass, number>(DEAD_CRON_CLASSES.map((c) => [c, 0]));
  for (const f of findings) counts.set(f.class, (counts.get(f.class) ?? 0) + 1);
  const parts = DEAD_CRON_CLASSES.map((c) => `${c}=${counts.get(c) ?? 0}`);
  return `dead-cron summary — ${parts.join(", ")} · total=${findings.length}`;
}

// ───────────────────────────── per-repo issue body ─────────────────────────────

const CLASS_LABELS: Record<DeadCronClass, string> = {
  "scheduled-but-silent": "Scheduled but silent",
  "zero-success-history": "Zero-success history",
  "failure-streak": "Failure streak",
};

export interface DeadCronIssueMeta {
  repo: string;
  /** ISO 8601 — the worker's `new Date()`, passed in so this stays pure. */
  generatedAt: string;
}

/**
 * Body for the ONE auto-reconciled `[dead-cron]` issue on an owning repo (Rule #165
 * amended: machinery alerts are auto-reconciled GitHub issues; the open-issue set is the
 * dedup state). Regenerated fresh every run (Rule #412), grouped by class, with a footer
 * that states the flags-only contract and the honest detection cadence (Rule #448).
 */
export function renderDeadCronIssueBody(findings: DeadCronFinding[], meta: DeadCronIssueMeta): string {
  const lines: string[] = [];
  lines.push(`Scheduled workflows in \`${meta.repo}\` are failing or not firing — flagged by the weekly dead-cron detector (ops-pipeline's repo-hygiene worker).`);
  lines.push("");
  lines.push(`Run ${meta.generatedAt} · scheduled-trigger runs only (manual dispatches don't reset these clocks).`);
  lines.push("");
  for (const cls of DEAD_CRON_CLASSES) {
    const inClass = findings.filter((f) => f.class === cls);
    if (inClass.length === 0) continue; // per-repo body: only classes actually present (the #465 all-classes line is the footer summary)
    lines.push(`### ${CLASS_LABELS[cls]} (${inClass.length})`);
    lines.push("");
    for (const f of inClass) {
      lines.push(`- **${f.workflowName}** (\`${f.workflowPath}\`): ${f.detail}`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push(summarizeDeadCron(findings) + ".");
  lines.push("");
  lines.push(
    "**What to do:** fix the workflow (tonight's precedent: client-asthetik's drift detector was one missing label away from healthy for 80 days), retire it (client-asthetik#217: five crons broken since birth — three referenced scripts that never existed), or disable it deliberately (`disabled_manually` is never flagged). This detector **flags, never acts** — no workflow is disabled, re-run, or edited by it.",
  );
  lines.push("");
  lines.push(
    "_Detection cadence is WEEKLY (Fri 09:00Z) — a cron can be dead up to ~7 days plus its class threshold before this fires; this issue makes no fresher claim. It auto-closes when every flagged workflow here recovers or is retired/disabled._",
  );
  return lines.join("\n");
}

// ───────────────────────────── systemic-degradation body ─────────────────────────────

export interface DegradationReport {
  /** Repos whose workflows-list read was attempted / failed (Actions:read gap ⇒ all fail). */
  workflowsList: { attempted: number; failed: number; firstError: string | null };
  /** Workflow-file content reads attempted / failed (Contents:read gap ⇒ all fail). */
  contentReads: { attempted: number; failed: number; firstError: string | null };
}

/** Systemic = every attempt failed (and ≥1 was attempted) — a permission gap, not per-item flakiness. The repo-hygiene bot-churn pattern, applied to this leg's two read capabilities. */
export function isSystemic(o: { attempted: number; failed: number }): boolean {
  return o.attempted > 0 && o.failed === o.attempted;
}

/**
 * Body for the self-issue the worker files on ops-pipeline when one/both of its read
 * capabilities is systemically dead (Rule #464: a leg that can structurally never fire
 * must say so where a human sees it — never a silent 0 that reads as "fleet healthy").
 * Auto-reconciled like everything else: closes when the reads start succeeding.
 */
export function renderDegradationBody(report: DegradationReport, generatedAt: string): string {
  const lines: string[] = [];
  lines.push("The dead-cron detector leg ran but is **structurally degraded** — it could not perform its reads, so per-repo findings this run are incomplete or empty and MUST NOT be read as \"fleet healthy\" (Rule #464).");
  lines.push("");
  lines.push(`Run ${generatedAt}.`);
  lines.push("");
  if (isSystemic(report.workflowsList)) {
    lines.push(
      `- **Workflows enumeration dead**: \`GET /repos/{owner}/{repo}/actions/workflows\` failed for ALL ${report.workflowsList.attempted} repos attempted — GitHub requires the App's **Actions** permission (read); the fleet App (\`studiob-fleet-bot\`) does not have it. First error: ${report.workflowsList.firstError ?? "unknown"}`,
    );
  }
  if (isSystemic(report.contentReads)) {
    lines.push(
      `- **Workflow-file reads dead**: \`GET /repos/{owner}/{repo}/contents/...\` failed for ALL ${report.contentReads.attempted} files attempted — requires **Contents** (read), which the fleet App lacks (the same gap already documented for the bot-churn leg). Without it, cron expressions can't be read: never-fired detection is blind and periods fall back to observed run spacing only.`,
    );
  }
  lines.push("");
  lines.push(
    "**Remediation (org-owner UI only, no API path — the ops#104 visit):** org Settings → GitHub Apps → studiob-fleet-bot → add **Actions: read** and **Contents: read**, then approve on the installation. One 2-minute visit lights up this leg AND the bot-churn leg AND the ops#111 mirror option.",
  );
  lines.push("");
  lines.push("_Auto-closes when the reads start succeeding (the next weekly run after the grant)._");
  return lines.join("\n");
}
