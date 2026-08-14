/**
 * repo-hygiene-lib.ts — pure diff/render logic for the recurring repo-hygiene worker
 * (ops-pipeline#101, design locked 2026-08-14 — read the issue's design comment FIRST,
 * this file implements it, it does not restate it).
 *
 * Law (from the arc that birthed this — Batch 7, ops#61): **flags-only**. The classifier
 * mis-classed shuttle; Batch 7's instrument overrode the 8/12 sweep's naming-derived
 * classifications in BOTH directions (acusync "confirmed-live" → instrument-dead;
 * acuops-website "pushed today" → hourly bot loop). Classification sweeps NOMINATE,
 * instruments DECIDE, humans WORD. Nothing in this file (or its caller,
 * repo-hygiene-worker.ts) ever mutates a repo, archives anything, or edits the baseline —
 * it only produces findings and issue-body text a human reads and acts on.
 *
 * Pure (no I/O, no network, no `new Date()`) so it is fully unit-testable — mirrors
 * railway-volume-classify.ts / gateway-token-classify.ts's shape: network + `gh` calls
 * live in repo-hygiene-worker.ts, this file only turns two snapshots (a committed
 * baseline + a live enumeration) into findings and renders them.
 *
 * Finding classes v1 (exactly five, from the issue):
 *   1. new-unmapped-repo    — born since baseline, absent from it
 *   2. baseline-repo-gone   — in baseline, absent live (deleted/transferred)
 *   3. archived-flip        — archived state differs from baseline
 *   4. visibility-flip      — public/private differs from baseline
 *   5. bot-churn-freshness  — pushed <7d but ≥90% of last 20 commits bot-authored
 *      (INFORMATIONAL — "freshness is machine churn", the acuops-website case from the
 *      arc that birthed this worker). Unlike classes 1-4, this class is not a comparison
 *      against the committed baseline at all (the baseline schema carries no commit-
 *      authorship data), so its `Finding.baselineEdit` is always `null` — Rule #412: an
 *      alert must not imply a baseline edit exists when none would do anything.
 *
 * Rule #465 (a summary line always prints every class with its count including 0) is
 * `summarizeFindings` below — the SAME function feeds both the worker's console output
 * and the issue body's closing line, so the two can never drift apart.
 *
 * Rule #381 (tightening/versioning a guard is forward-only; a stale guard-version stamp
 * forces one full re-evaluation): `BASELINE_RULES_VERSION` is this worker's compiled-in
 * rule vocabulary version; `renderDriftIssueBody` compares it against the baseline FILE's
 * own `rulesVersion` and prepends a loud mismatch note when they differ. This worker has
 * no incremental/skip path in v1 (`diffFleet` always re-evaluates every repo, every run —
 * there is no watermark to short-circuit), so the practical effect of a mismatch today is
 * the note itself: a human reading the issue should not assume the finding classes below
 * mean what they meant when the baseline was last reviewed. The seam exists so a future
 * versioned rule change (a v2 finding class, a changed threshold) has somewhere to hook
 * "was this baseline ever re-reviewed under the new rules" without inventing new plumbing.
 */

export const BASELINE_RULES_VERSION = 1;

/** ≥7d since push ⇒ outside the freshness window the worker bothers fetching commits for. Informational only — see class 5's header note. */
export const BOT_CHURN_LOOKBACK_DAYS = 7;

/** ≥90% of the last (up to 20) commits bot-authored ⇒ "freshness is machine churn". */
export const BOT_CHURN_MIN_BOT_RATIO_NUM = 9; // integer-safe ratio: botCommits / totalCommits >= 9/10
export const BOT_CHURN_MIN_BOT_RATIO_DEN = 10;

// ───────────────────────────── baseline + live shapes ─────────────────────────────

export interface BaselineEntry {
  name: string;
  archived: boolean;
  /** As reported by `gh repo list --json visibility` at seed time: "PUBLIC" | "PRIVATE" | "INTERNAL". */
  visibility: string;
  /** ISO 8601 — the live `pushedAt` recorded when this entry was seeded/last accepted into the baseline. Informational context only; never itself diffed (there is no "freshness drifted" finding class). */
  pushedAtAtSeed: string;
}

export interface BaselineFile {
  rulesVersion: number;
  seededAt: string;
  repos: BaselineEntry[];
}

/** One (up to 20) recent-commit author, as read from `GET /repos/{owner}/{repo}/commits`'s `.author`. Both fields are `null` when GitHub can't associate the commit with a GitHub account (no matching verified email) — such a commit counts toward `totalCommits` but never toward `botCommits`. */
export interface CommitAuthorInfo {
  login: string | null;
  /** GitHub's own account-type discriminant: "Bot" | "User" | null. */
  type: string | null;
}

export interface BotChurnSample {
  /** Commits actually inspected (≤20 — fewer only when the repo itself has fewer commits). */
  totalCommits: number;
  botCommits: number;
}

export interface LiveRepo {
  name: string;
  isArchived: boolean;
  /** As reported by `gh repo list --json visibility`. */
  visibility: string;
  /** ISO 8601, as reported by `gh repo list --json pushedAt`. */
  pushedAt: string;
  /**
   * Set by the caller ONLY for repos it chose to fetch commits for (the worker's own
   * `BOT_CHURN_LOOKBACK_DAYS` freshness gate — an I/O-cost decision, not diff logic, so it
   * lives in the worker, not here). `diffFleet` trusts presence: a repo with no attached
   * sample is simply never considered for the bot-churn-freshness class, by construction
   * — there is no redundant date check inside `diffFleet` itself. Tests exercise the
   * threshold directly by attaching a synthetic sample, with no freshness-window or
   * network dependency at all.
   */
  botChurn?: BotChurnSample;
}

// ───────────────────────────── bot-churn classification ─────────────────────────────

/** "author login ending `[bot]` or type Bot counts" — the issue's exact rule, verbatim. */
export function isBotAuthoredCommit(c: CommitAuthorInfo): boolean {
  if (c.type === "Bot") return true;
  if (c.login !== null && c.login.endsWith("[bot]")) return true;
  return false;
}

export function computeBotChurnSample(commits: CommitAuthorInfo[]): BotChurnSample {
  return { totalCommits: commits.length, botCommits: commits.filter(isBotAuthoredCommit).length };
}

/**
 * ≥90%, integer-safe (no floating-point boundary risk at the exact threshold: `botCommits
 * * 10 >= totalCommits * 9` is exactly equivalent to `botCommits / totalCommits >= 0.9`
 * for the small integers this ever sees, with no rounding error possible). An empty
 * sample (`totalCommits === 0`) is NEVER bot-churn — Rule #322: an empty population is
 * not itself a positive result; a repo the worker couldn't read any commits for gets no
 * finding, not a false one.
 */
export function isBotChurn(sample: BotChurnSample): boolean {
  if (sample.totalCommits === 0) return false;
  return sample.botCommits * BOT_CHURN_MIN_BOT_RATIO_DEN >= sample.totalCommits * BOT_CHURN_MIN_BOT_RATIO_NUM;
}

// ───────────────────────────── findings ─────────────────────────────

export const FINDING_CLASSES = [
  "new-unmapped-repo",
  "baseline-repo-gone",
  "archived-flip",
  "visibility-flip",
  "bot-churn-freshness",
] as const;

export type FindingClass = (typeof FINDING_CLASSES)[number];

export interface Finding {
  class: FindingClass;
  repo: string;
  /** Human-readable one-liner describing what was observed. */
  detail: string;
  /**
   * The exact `repos[]` JSON line (single-line, matching `repo-baseline.json`'s own
   * one-entry-per-line formatting) that would resolve this finding by accepting current
   * live state as the new baseline truth — an ADD line for new-unmapped-repo, a REMOVE
   * instruction carrying the exact line to delete for baseline-repo-gone, or an UPDATED
   * line for archived-flip/visibility-flip. `null` only for bot-churn-freshness, which
   * has no baseline representation at all (informational; see file header).
   */
  baselineEdit: string | null;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

/** Single-line JSON matching `repo-baseline.json`'s per-entry format — see repo-hygiene-worker.ts's seeding for the identical shape/key order. */
function formatBaselineEntry(e: BaselineEntry): string {
  return JSON.stringify({ name: e.name, archived: e.archived, visibility: e.visibility, pushedAtAtSeed: e.pushedAtAtSeed });
}

/**
 * Diffs a live org enumeration against the committed baseline, producing findings for
 * exactly the five v1 classes, grouped in `FINDING_CLASSES` order and sorted by repo name
 * within each class — deterministic output for identical inputs (no Map/Set iteration-
 * order dependence leaks through), so `renderDriftIssueBody`'s output is stable run-to-run
 * when nothing actually changed (an already-open issue's body should not churn on a no-op
 * re-run).
 *
 * Pure: never mutates `baseline` or `live`; never reads the clock or the network. The
 * bot-churn-freshness class is entirely driven by whether a `LiveRepo` carries a
 * `botChurn` sample (see that field's doc comment) — this function does not itself apply
 * any freshness/date window.
 */
export function diffFleet(baseline: BaselineFile, live: LiveRepo[]): Finding[] {
  const baselineByName = new Map(baseline.repos.map((r) => [r.name, r]));
  const liveByName = new Map(live.map((r) => [r.name, r]));
  const findings: Finding[] = [];

  // 1. new-unmapped-repo — live, not in baseline.
  for (const repo of [...live].sort(byName)) {
    if (baselineByName.has(repo.name)) continue;
    findings.push({
      class: "new-unmapped-repo",
      repo: repo.name,
      detail: `\`${repo.name}\` is live but absent from the baseline (archived=${repo.isArchived}, visibility=${repo.visibility}, pushedAt=${repo.pushedAt}).`,
      baselineEdit: `ADD to "repos": ${formatBaselineEntry({ name: repo.name, archived: repo.isArchived, visibility: repo.visibility, pushedAtAtSeed: repo.pushedAt })}`,
    });
  }

  // 2. baseline-repo-gone — in baseline, not live.
  for (const entry of [...baseline.repos].sort(byName)) {
    if (liveByName.has(entry.name)) continue;
    findings.push({
      class: "baseline-repo-gone",
      repo: entry.name,
      detail: `\`${entry.name}\` is in the baseline but absent live (deleted or transferred).`,
      baselineEdit: `REMOVE this line from "repos": ${formatBaselineEntry(entry)}`,
    });
  }

  // 3 + 4: archived-flip / visibility-flip — present in both, one field differs. Visibility
  // compares case-insensitively (defensive only — `gh` itself always reports uppercase; a
  // hand-edited baseline typo like "public" must not read as live drift).
  for (const entry of [...baseline.repos].sort(byName)) {
    const repo = liveByName.get(entry.name);
    if (!repo) continue;
    if (entry.archived !== repo.isArchived) {
      findings.push({
        class: "archived-flip",
        repo: entry.name,
        detail: `\`${entry.name}\` archived state differs: baseline=${entry.archived}, live=${repo.isArchived}.`,
        baselineEdit: `UPDATE its "repos" line to: ${formatBaselineEntry({ ...entry, archived: repo.isArchived })}`,
      });
    }
    if (entry.visibility.toUpperCase() !== repo.visibility.toUpperCase()) {
      findings.push({
        class: "visibility-flip",
        repo: entry.name,
        detail: `\`${entry.name}\` visibility differs: baseline=${entry.visibility}, live=${repo.visibility}.`,
        baselineEdit: `UPDATE its "repos" line to: ${formatBaselineEntry({ ...entry, visibility: repo.visibility })}`,
      });
    }
  }

  // 5. bot-churn-freshness — informational; driven entirely by an attached sample (see LiveRepo.botChurn).
  for (const repo of [...live].sort(byName)) {
    if (!repo.botChurn || !isBotChurn(repo.botChurn)) continue;
    const { totalCommits, botCommits } = repo.botChurn;
    const pct = Math.round((botCommits / totalCommits) * 100);
    findings.push({
      class: "bot-churn-freshness",
      repo: repo.name,
      detail: `\`${repo.name}\` pushed ${repo.pushedAt} (within the ${BOT_CHURN_LOOKBACK_DAYS}d freshness window); ${botCommits}/${totalCommits} of its last commits are bot-authored (${pct}%). Freshness here is machine churn, not necessarily human activity.`,
      baselineEdit: null,
    });
  }

  return findings;
}

// ───────────────────────────── summary line (Rule #465) ─────────────────────────────

/**
 * Always lists every one of the five classes with its count, including 0 — Rule #465. The
 * SAME function renders the worker's console summary line AND the issue body's closing
 * line, so the two outputs can never disagree about what this run found.
 */
export function summarizeFindings(findings: Finding[]): string {
  const counts = new Map<FindingClass, number>(FINDING_CLASSES.map((c) => [c, 0]));
  for (const f of findings) counts.set(f.class, (counts.get(f.class) ?? 0) + 1);
  const parts = FINDING_CLASSES.map((c) => `${c}=${counts.get(c) ?? 0}`);
  return `repo-hygiene summary — ${parts.join(", ")} · total=${findings.length}`;
}

// ───────────────────────────── issue body ─────────────────────────────

export interface DriftMeta {
  org: string;
  liveRepoCount: number;
  baselineRepoCount: number;
  /** The baseline FILE's own `rulesVersion` (not this worker's compiled-in `BASELINE_RULES_VERSION`, which this function imports/compares directly). */
  baselineRulesVersion: number;
  baselineSeededAt: string;
  /** ISO 8601 — when THIS run generated the body (the worker's `new Date()`, passed in so this function stays pure). */
  generatedAt: string;
  /**
   * Set by the caller when the bot-churn-freshness leg's commit-history fetch FAILED FOR
   * EVERY repo it attempted this run (as opposed to a handful of individually flaky repos)
   * — live-verified 2026-08-14: the fleet App (`studiob-fleet-bot`) is installed with only
   * `issues:write` + `metadata:read`; GitHub's own docs list `GET
   * /repos/{owner}/{repo}/commits` as requiring the **Contents** permission (read), which
   * this installation does not have, so every commit fetch 403s today. Rule #464 ("a
   * guard's first live firing is part of its ship, not its follow-up"): a finding class
   * that can structurally never fire must say so where a human will see it, not sit
   * silently at 0 looking identical to "no drift this week". `undefined`/omitted when
   * nothing was attempted or at least one fetch succeeded (the ordinary, expected state
   * once Contents:read is granted).
   */
  botChurnSystemicFailure?: { attempted: number; firstError: string };
}

const FINDING_CLASS_LABELS: Record<FindingClass, string> = {
  "new-unmapped-repo": "New unmapped repo",
  "baseline-repo-gone": "Baseline repo gone",
  "archived-flip": "Archived-state flip",
  "visibility-flip": "Visibility flip",
  "bot-churn-freshness": "Bot-churn freshness (informational)",
};

/**
 * Renders the aggregate issue body — regenerated fresh every run (Rule #412: a stale body
 * would misstate current drift), grouped by class in `FINDING_CLASSES` order, each finding
 * carrying the exact baseline-edit line that would resolve it (or an explicit
 * "informational" note for the one class that has none). Handles the zero-findings case
 * too (all five sections render "_none_") even though the worker's own all-clean path uses
 * a dedicated close comment instead of this body — kept correct so a dry-run preview or a
 * future caller can render "what the body would say right now" unconditionally.
 */
export function renderDriftIssueBody(findings: Finding[], meta: DriftMeta): string {
  const lines: string[] = [];
  lines.push(`Fleet drift vs the committed baseline — \`${meta.org}\`.`);
  lines.push("");
  lines.push(
    `Baseline seeded ${meta.baselineSeededAt} (rulesVersion ${meta.baselineRulesVersion}) · this run ${meta.generatedAt} · ${meta.liveRepoCount} live repos vs ${meta.baselineRepoCount} baseline entries.`,
  );

  if (meta.baselineRulesVersion !== BASELINE_RULES_VERSION) {
    lines.push("");
    lines.push(
      `⚠️ **Baseline rulesVersion mismatch (Rule #381)**: the baseline file carries rulesVersion ${meta.baselineRulesVersion}, this worker runs BASELINE_RULES_VERSION ${BASELINE_RULES_VERSION}. Treat this run as a FULL re-evaluation — every finding below is a complete re-check against current live state, not an incremental diff since the baseline's rule vocabulary was last current.`,
    );
  }

  if (meta.botChurnSystemicFailure) {
    lines.push("");
    lines.push(
      `⚠️ **bot-churn-freshness is structurally degraded this run (Rule #464)**: commit-history fetch failed for all ${meta.botChurnSystemicFailure.attempted} repo(s) it attempted — this reads as a permission gap, not per-repo flakiness. \`GET /repos/{owner}/{repo}/commits\` requires the App's **Contents** permission (read); the fleet App's org installation currently grants only \`issues:write\` + \`metadata:read\`. This class will read 0 findings until Contents:read is granted to \`studiob-fleet-bot\`'s installation (org Settings → GitHub Apps → studiob-fleet-bot → org-owner UI, no API path). First error observed: ${meta.botChurnSystemicFailure.firstError}`,
    );
  }

  lines.push("");

  for (const cls of FINDING_CLASSES) {
    const inClass = findings.filter((f) => f.class === cls);
    lines.push(`### ${FINDING_CLASS_LABELS[cls]} (${inClass.length})`);
    lines.push("");
    if (inClass.length === 0) {
      lines.push("_none_");
    } else {
      for (const f of inClass) {
        lines.push(`- ${f.detail}`);
        lines.push(f.baselineEdit ? `  Resolve: \`${f.baselineEdit}\`` : `  Informational — no baseline edit; this class has no baseline representation.`);
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(summarizeFindings(findings) + ".");
  lines.push("");
  lines.push(
    "Baseline updates are human (Rules #379/#381): this worker never edits `scripts/repo-baseline.json` itself — it only flags. Apply the `Resolve:` line(s) above to accept current live state as the new baseline truth, or take corrective action live and let this re-evaluate clean next run. This issue auto-closes (with a comment) once every finding above clears.",
  );

  return lines.join("\n");
}

// ───────────────────────────── issue reconcile (single stable-title issue) ─────────────────────────────

export type IssueAction = "open" | "update" | "close" | "none";

/**
 * Unlike the fleet's per-entity multi-issue monitors (credential-expiry-monitor.ts,
 * railway-volume-monitor.ts — one issue per entity, title carries severity, reconciled via
 * `gateway-token-reconcile.ts`'s `reconcileCondition` / `severity-issue-reconcile.ts`'s
 * `reconcileSeverity`), this worker keeps exactly ONE issue at one stable title
 * (`[repo-hygiene] fleet drift vs baseline`) whose BODY is what's regenerated each run —
 * there is no severity/title state to retitle. That needs a fourth state beyond plain
 * active/clear: an already-open issue with findings still present must have its body
 * refreshed ("update"), not silently left stale (Rule #412) and not duplicated (Rules
 * #292/#358).
 */
export function planIssueAction(findingsCount: number, issueOpen: boolean): IssueAction {
  if (findingsCount > 0) return issueOpen ? "update" : "open";
  return issueOpen ? "close" : "none";
}
