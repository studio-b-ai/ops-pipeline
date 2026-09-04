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
 * Finding classes v2 (census ③, 2026-08-30 — the Fleet Maintenance Census fold; seed:
 * brain `library/decisions/2026-08-29-maintenance-tax-build-vs-buy-posture-seed.md`):
 * the baseline IS the census. Each active (non-archived) repo's baseline line carries
 * optional census fields — `class293` (Rule #293 state) + `verdict` (maintenance
 * posture) + `verdictAt` + `note` — and three new classes enforce them:
 *   6. census-verdict-missing — live, unarchived, and its baseline line has missing/
 *      invalid/TBD census fields. TBD is a VALID value that still flags: the standing
 *      pressure that keeps unworded repos visible until a human words them (Rule #465 —
 *      an invalid enum value must flag too, or a typo silently exempts a repo from
 *      classes 7/8).
 *   7. unexecuted-retirement — verdict=retire but the repo is still live unarchived:
 *      the standing kill-list tracker. Retire verdicts are Kevin-worded (Rules #97/#366);
 *      this class only ever tracks execution of an already-worded retirement.
 *   8. freeze-violation — verdict=freeze but live pushedAt > verdictAt: a frozen repo
 *      moved. Pure ISO-8601 string compare (both UTC "Z" strings) — no clock read.
 *      All three carry `baselineEdit: null` — resolution is human judgment or live
 *      action, never a mechanical baseline accept (see NULL_EDIT_NOTES). Archived repos
 *      are census-exempt by construction (Dead per Rule #293's vocabulary); a repo added
 *      via a class-1 ADD line arrives census-bare and class 6 demands its verdict on the
 *      next run — new repos cannot silently skip the census.
 *
 * Finding class v3 (issue #245, 2026-08-30 — the half-retirement fold): archiving a repo
 * before dispositioning its open PRs is Rule #366 executed halfway — the repo goes
 * read-only, its open PRs can no longer be merged AND can no longer be closed (closing
 * requires unarchive → close → re-archive; archive state is Kevin-gated), so they become
 * permanent phantoms in every fleet-wide open-PR sweep. One new class enforces:
 *   9. archived-with-open-prs — live archived repo carrying >0 open PRs. Rule #366 full
 *      form. `baselineEdit: null` — resolution is a live repo-settings action (unarchive
 *      → close/merge → re-archive) or the deliberate acceptance of the phantom; there is
 *      no mechanical baseline accept, exactly like classes 6-8. This class reads the LIVE
 *      `openPrCount` from `LiveRepo`; the worker probes it EXCLUSIVELY for archived
 *      repos, since an open PR on a live repo is ordinary backlog, not a phantom. Absent
 *      openPrCount (never probed) never fires the class — same presence contract as
 *      `botChurn` in class 5.
 *
 * Rule #465 (a summary line always prints every class with its count including 0) is
 * `summarizeFindings` below — the SAME function feeds both the worker's console output
 * and the issue body's closing line, so the two can never drift apart.
 *
 * Rule #381 (tightening/versioning a guard is forward-only; a stale guard-version stamp
 * forces one full re-evaluation): `BASELINE_RULES_VERSION` is this worker's compiled-in
 * rule vocabulary version; `renderDriftIssueBody` compares it against the baseline FILE's
 * own `rulesVersion` and prepends a loud mismatch note when they differ. This worker has
 * no incremental/skip path (`diffFleet` always re-evaluates every repo, every run — there
 * is no watermark to short-circuit), so the practical effect of a mismatch today is the
 * note itself: a human reading the issue should not assume the finding classes below mean
 * what they meant when the baseline was last reviewed. The seam did its job at v2: the
 * census fold bumped this to 2 together with a full baseline re-seed in the same PR, so a
 * v1 baseline meeting a v2 worker (or vice versa) announces itself instead of silently
 * half-applying the census classes.
 */

export const BASELINE_RULES_VERSION = 2;

/** ≥7d since push ⇒ outside the freshness window the worker bothers fetching commits for. Informational only — see class 5's header note. */
export const BOT_CHURN_LOOKBACK_DAYS = 7;

/** ≥90% of the last (up to 20) commits bot-authored ⇒ "freshness is machine churn". */
export const BOT_CHURN_MIN_BOT_RATIO_NUM = 9; // integer-safe ratio: botCommits / totalCommits >= 9/10
export const BOT_CHURN_MIN_BOT_RATIO_DEN = 10;

// ───────────────────────────── census vocabulary (v2) ─────────────────────────────

/** Rule #293's four terminal states + TBD (valid-but-flagging — see class 6's header note). */
export const CLASS293_VALUES = ["Product", "Internal Tooling", "IP", "Dead", "TBD"] as const;
export type Class293 = (typeof CLASS293_VALUES)[number];

/**
 * Maintenance-posture verdicts (census ③'s vocabulary, from the Dispatcher assignment):
 *   mechanic-covered — standing loops protect it (squasher/automerge, restart-train,
 *                      monitors, drift gates, CI guards); maintenance lands on machinery first.
 *   manual-tax       — live (deployed service or active dev) but maintenance lands on humans.
 *   freeze           — keep, zero investment; any push is anomalous (class 8 enforces).
 *   retire           — Kevin-worded kill list; class 7 tracks execution until archived.
 *   TBD              — genuinely unworded; class 6 keeps the pressure on.
 */
export const VERDICT_VALUES = ["mechanic-covered", "manual-tax", "freeze", "retire", "TBD"] as const;
export type Verdict = (typeof VERDICT_VALUES)[number];

// ───────────────────────────── baseline + live shapes ─────────────────────────────

export interface BaselineEntry {
  name: string;
  archived: boolean;
  /** As reported by `gh repo list --json visibility` at seed time: "PUBLIC" | "PRIVATE" | "INTERNAL". */
  visibility: string;
  /** ISO 8601 — the live `pushedAt` recorded when this entry was seeded/last accepted into the baseline. Informational context only; never itself diffed (there is no "freshness drifted" finding class). */
  pushedAtAtSeed: string;
  // ── census fields (v2, human-authored — the worker never writes them; Rule #379/#381).
  // Optional so archived rows carry none (census-exempt) and a fresh class-1 ADD line is
  // legal census-bare (class 6 then demands the verdict). Typed `string`, not the enums:
  // these arrive from a hand-edited JSON file, and an out-of-vocabulary value must FLOW
  // THROUGH to validation and flag (Rule #465), not fail some upstream cast.
  /** Rule #293 state — validated against CLASS293_VALUES by class 6. */
  class293?: string;
  /** Maintenance posture — validated against VERDICT_VALUES by class 6; drives classes 7/8. */
  verdict?: string;
  /** ISO 8601 UTC — when the verdict was authored. REQUIRED for verdict=freeze (class 8's comparand). */
  verdictAt?: string;
  /** Free-text coverage/rationale one-liner (what protects it, or why frozen/retiring). */
  note?: string;
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
  /**
   * Open PR count as observed live (any state=open PRs, human or bot). Set by the caller
   * ONLY for repos it chose to probe (the worker fetches this exclusively for repos where
   * `isArchived === true` — an ordinary live repo carrying open PRs is normal backlog, not
   * a phantom; the whole reason this field exists is class 9 below, and an archived repo
   * is the only shape that class ever fires on). Presence-driven — same contract as
   * `botChurn`: absent (`undefined`) means "not probed this run" and never fires class 9,
   * `0` means "probed and clean" and also never fires class 9 (a real read of zero is not
   * a defect). Rule #322: an absent sample is not a positive result.
   */
  openPrCount?: number;
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
  "census-verdict-missing",
  "unexecuted-retirement",
  "freeze-violation",
  "archived-with-open-prs",
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

/** Single-line JSON matching `repo-baseline.json`'s per-entry format — see repo-hygiene-worker.ts's seeding for the identical shape/key order. Stable key order; `JSON.stringify` drops `undefined` values, so census-bare rows (archived repos, fresh class-1 ADD lines) render without the census keys at all. */
function formatBaselineEntry(e: BaselineEntry): string {
  return JSON.stringify({
    name: e.name,
    archived: e.archived,
    visibility: e.visibility,
    pushedAtAtSeed: e.pushedAtAtSeed,
    class293: e.class293,
    verdict: e.verdict,
    verdictAt: e.verdictAt,
    note: e.note,
  });
}

/**
 * What `repo`'s baseline entry would be if its CURRENT live state were fully accepted —
 * every field, not just whichever one triggered a given finding. `pushedAtAtSeed`
 * refreshes to the live `pushedAt` (harmless: this field is never itself diffed, and
 * refreshing it reflects "current as of this accepted edit"). Census fields are
 * human-authored state, not live state — an accept line must CARRY them from the existing
 * baseline entry, not strip them: a class-3/4 accept that silently deleted a repo's
 * census would re-fire class 6 next run and lose the human's words (the census sibling of
 * the full-state law in the flip comment below). `entry` is absent only at class-1 ADD
 * sites, where the row is deliberately census-bare.
 */
function liveEntrySnapshot(repo: LiveRepo, entry?: BaselineEntry): BaselineEntry {
  return {
    name: repo.name,
    archived: repo.isArchived,
    visibility: repo.visibility,
    pushedAtAtSeed: repo.pushedAt,
    class293: entry?.class293,
    verdict: entry?.verdict,
    verdictAt: entry?.verdictAt,
    note: entry?.note,
  };
}

/**
 * Diffs a live org enumeration against the committed baseline, producing findings for
 * the eight classes (five v1 + three census v2), grouped in `FINDING_CLASSES` order and sorted by repo name
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
      baselineEdit: `ADD to "repos": ${formatBaselineEntry(liveEntrySnapshot(repo))}`,
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
  //
  // codex review (2026-08-14, ops#101 PR pass 1, P2): each flip's resolve line MUST be
  // built from the repo's FULL current live state, not `{...entry, <onlyThisField>:
  // newValue}` — a repo that changes BOTH archived and visibility in the same run used to
  // get two DIFFERENT resolve lines, each correct on its own changed field but carrying
  // the OTHER field's STALE baseline value. Applying either one alone (the natural
  // reading of "resolve THIS finding") would silently revert the other field, and the
  // monitor would keep reporting drift forever. `liveEntrySnapshot` makes both flip
  // findings on the same repo emit the IDENTICAL, fully-correct line — safe to apply
  // either one, or both, with the same end state either way.
  for (const entry of [...baseline.repos].sort(byName)) {
    const repo = liveByName.get(entry.name);
    if (!repo) continue;
    const archivedDiffers = entry.archived !== repo.isArchived;
    const visibilityDiffers = entry.visibility.toUpperCase() !== repo.visibility.toUpperCase();
    if (!archivedDiffers && !visibilityDiffers) continue;
    const fullLiveLine = `UPDATE its "repos" line to: ${formatBaselineEntry(liveEntrySnapshot(repo, entry))}`;
    if (archivedDiffers) {
      findings.push({
        class: "archived-flip",
        repo: entry.name,
        detail: `\`${entry.name}\` archived state differs: baseline=${entry.archived}, live=${repo.isArchived}.`,
        baselineEdit: fullLiveLine,
      });
    }
    if (visibilityDiffers) {
      findings.push({
        class: "visibility-flip",
        repo: entry.name,
        detail: `\`${entry.name}\` visibility differs: baseline=${entry.visibility}, live=${repo.visibility}.`,
        baselineEdit: fullLiveLine,
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

  // 9. archived-with-open-prs — live archived AND caller attached a positive openPrCount.
  // Reads the LIVE `isArchived`, not the baseline's flag (a stale baseline archived flag
  // already fires class 3, and a repo unarchived live carries legitimate open-PR backlog
  // regardless of what the baseline claims). Presence-driven per `LiveRepo.openPrCount`:
  // an absent sample means "not probed this run" and never fires here — Rule #322, an
  // empty population is not a positive result. Independent of baseline membership (a
  // newly-born archived repo with open PRs fires this alongside class 1).
  for (const repo of [...live].sort(byName)) {
    if (!repo.isArchived || repo.openPrCount === undefined || repo.openPrCount === 0) continue;
    const noun = repo.openPrCount === 1 ? "PR" : "PRs";
    findings.push({
      class: "archived-with-open-prs",
      repo: repo.name,
      detail: `\`${repo.name}\` is archived but has ${repo.openPrCount} open ${noun} — a permanent phantom in fleet-wide open-PR sweeps: archived repos are read-only, so open PRs can neither merge nor close (closing requires unarchive → close → re-archive, a Kevin-gated repo-settings action). Rule #366 full-leg teardown: close/merge PRs FIRST, then archive.`,
      baselineEdit: null,
    });
  }

  // 6-8. census classes (v2) — active repos present in BOTH baseline and live. The
  // exemption reads LIVE `isArchived`, not the baseline's flag (a stale baseline archived
  // flag already fires class 3, and a repo archived live needs no verdict regardless of
  // what the baseline claims). Gone repos fire class 2, not census pressure. All three
  // classes carry `baselineEdit: null` — resolution is human judgment or live action
  // (see NULL_EDIT_NOTES), never a mechanical accept.
  for (const entry of [...baseline.repos].sort(byName)) {
    const repo = liveByName.get(entry.name);
    if (!repo || repo.isArchived) continue;

    // 6. census-verdict-missing — ONE aggregated finding per repo naming every census gap
    // (missing, out-of-vocabulary, TBD, or structurally unusable), so a repo with three
    // defects is one line to act on, not three interleaved findings.
    const gaps: string[] = [];
    if (entry.class293 === undefined) gaps.push("class293 missing");
    else if (!(CLASS293_VALUES as readonly string[]).includes(entry.class293)) gaps.push(`class293 invalid ("${entry.class293}")`);
    else if (entry.class293 === "TBD") gaps.push("class293 TBD");
    if (entry.verdict === undefined) gaps.push("verdict missing");
    else if (!(VERDICT_VALUES as readonly string[]).includes(entry.verdict)) gaps.push(`verdict invalid ("${entry.verdict}")`);
    else if (entry.verdict === "TBD") gaps.push("verdict TBD");
    if (entry.verdict === "freeze" && entry.verdictAt === undefined) gaps.push("verdict=freeze without verdictAt (class 8 has no comparand)");
    if (entry.verdictAt !== undefined && !/^\d{4}-\d{2}-\d{2}T/.test(entry.verdictAt)) gaps.push(`verdictAt malformed ("${entry.verdictAt}")`);
    if (gaps.length > 0) {
      findings.push({
        class: "census-verdict-missing",
        repo: entry.name,
        detail: `\`${entry.name}\` is live and unarchived but its census is incomplete: ${gaps.join("; ")}.`,
        baselineEdit: null,
      });
    }

    // 7. unexecuted-retirement — worded retire, still live unarchived. Fires alongside
    // class 6 when the same row ALSO has census gaps (independent defects, both real).
    if (entry.verdict === "retire") {
      findings.push({
        class: "unexecuted-retirement",
        repo: entry.name,
        detail: `\`${entry.name}\` carries verdict=retire${entry.verdictAt ? ` (worded ${entry.verdictAt})` : ""} but is still live and unarchived — the retirement has not been executed (Rule #366 full-leg teardown).`,
        baselineEdit: null,
      });
    }

    // 8. freeze-violation — a frozen repo moved. Only fires with a well-formed verdictAt
    // (missing/malformed already fires class 6 — one root cause, one class). Lexicographic
    // compare is correct for same-shape ISO-8601 UTC "Z" strings; no clock read.
    if (
      entry.verdict === "freeze" &&
      entry.verdictAt !== undefined &&
      /^\d{4}-\d{2}-\d{2}T/.test(entry.verdictAt) &&
      repo.pushedAt > entry.verdictAt
    ) {
      findings.push({
        class: "freeze-violation",
        repo: entry.name,
        detail: `\`${entry.name}\` is verdict=freeze (as of ${entry.verdictAt}) but was pushed ${repo.pushedAt} — a frozen repo moved.`,
        baselineEdit: null,
      });
    }
  }

  return findings;
}

// ───────────────────────────── summary line (Rule #465) ─────────────────────────────

/**
 * Always lists every class with its count, including 0 — Rule #465. The
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
  "census-verdict-missing": "Census verdict missing/invalid",
  "unexecuted-retirement": "Unexecuted retirement (kill-list tracker)",
  "freeze-violation": "Freeze violation",
  "archived-with-open-prs": "Archived with open PRs (Rule #366 half-retirement)",
};

/**
 * Per-class resolution guidance for findings whose `baselineEdit` is null — Rule #412:
 * the body must say what resolution looks like, and for these classes it is human
 * judgment or live action, never a mechanical baseline accept.
 */
const NULL_EDIT_NOTES: Partial<Record<FindingClass, string>> = {
  "bot-churn-freshness": "Informational — no baseline edit; this class has no baseline representation.",
  "census-verdict-missing":
    "Resolve by human judgment: add/fix the census fields (class293/verdict/verdictAt) on this repo's baseline line — values are decisions, not mechanical accepts (retire verdicts are Kevin-worded).",
  "unexecuted-retirement":
    "Resolve by EXECUTING the retirement (Rule #366 full-leg teardown, Kevin-worded #97) and archiving the repo — or re-verdict the baseline line if the retirement is rescinded. No mechanical baseline accept exists.",
  "freeze-violation":
    "Resolve by investigating the push (who/why), then either re-verdict the repo (it is not frozen in practice) or refresh verdictAt after confirming the push was sanctioned.",
  "archived-with-open-prs":
    "Resolve by dispositioning the open PR(s): unarchive → close/merge each PR (with a pointer to what superseded the work if applicable) → re-archive (Rule #366 full-leg teardown; Kevin-gated repo-settings action, ~30s). Or accept the phantom deliberately if the underlying work is stale and this is the last one — the finding will still fire until dispositioned. No mechanical baseline accept exists.",
};

/**
 * Renders the aggregate issue body — regenerated fresh every run (Rule #412: a stale body
 * would misstate current drift), grouped by class in `FINDING_CLASSES` order, each finding
 * carrying the exact baseline-edit line that would resolve it (or an explicit
 * per-class resolution note for the classes that have none). Handles the zero-findings case
 * too (all sections render "_none_") even though the worker's own all-clean path uses
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
        lines.push(f.baselineEdit ? `  Resolve: \`${f.baselineEdit}\`` : `  ${NULL_EDIT_NOTES[f.class] ?? "Informational — no baseline edit."}`);
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
 * What counts as "alert-worthy" for the SINGLE aggregate issue's open/close decision —
 * real findings, OR the bot-churn-freshness leg being systemically broken (see
 * `DriftMeta.botChurnSystemicFailure`'s doc comment).
 *
 * codex review (2026-08-14, ops#101 PR pass 2, P2): without this, a run with ZERO real
 * drift findings but every bot-churn commit fetch failing (the fleet App's documented
 * current Contents:read gap) computed `planIssueAction(0, ...)` → `"none"` and exited
 * green — forever, in production today. The degradation note `renderDriftIssueBody`
 * writes into the body (`botChurnSystemicFailure`) was correctly RENDERED but never
 * REACHED, because no issue ever opened to carry it: the only trace was a workflow-log
 * line nobody is expected to watch (Rule #8 — "anything that needs my attention must push
 * to me directly"). Folding the systemic-failure flag into this count means the aggregate
 * issue opens (or stays open, carrying the note) until Contents:read is granted and the
 * leg starts succeeding again — the SAME issue-based channel as every other finding,
 * never a silent log-only degradation.
 */
export function alertWorthyCount(findings: Finding[], botChurnSystemicFailure: boolean): number {
  return findings.length + (botChurnSystemicFailure ? 1 : 0);
}

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
 *
 * `alertCount` is normally `findings.length`, but the caller should pass
 * `alertWorthyCount(findings, systemicFailure)` instead so a fully-broken bot-churn leg
 * keeps the issue open even at zero real findings (see that function's doc comment).
 */
export function planIssueAction(alertCount: number, issueOpen: boolean): IssueAction {
  if (alertCount > 0) return issueOpen ? "update" : "open";
  return issueOpen ? "close" : "none";
}
