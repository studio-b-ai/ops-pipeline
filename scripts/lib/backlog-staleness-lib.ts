/**
 * backlog-staleness-lib.ts — pure classify/render logic for the backlog-staleness worker
 * (ops-pipeline#136, CTO seat → CoS, LANES rule 17 rollout, Kevin word 2026-08-16 — "things
 * shouldn't be lost and should be ranked and prioritized to keep work moving forward"). Read
 * the issue's design comment FIRST — this file implements it, it does not restate it.
 *
 * Why this exists: rule 17(d) puts the stall check on every manager's tick already ("run `gh
 * issue list --repo <r> --label P1 --json number,updatedAt` by hand at each tick"). This leg
 * makes that check an INSTRUMENT instead of a hoped-for habit (#456/#464: a quiet backlog is
 * unverified silence until something actually measures it).
 *
 * Law (inherited from repo-hygiene-lib.ts / dead-cron-classify.ts, same CTO-seat arc):
 * **flags-only**. Nothing here (or in the caller, backlog-staleness-worker.ts) ever re-labels,
 * re-ranks, closes, or edits a MANAGED issue — it only produces findings and issue-body text a
 * human (the manager) reads and acts on. The only issues this leg ever mutates are its OWN
 * per-manager aggregate issues on studio-b-ai/ops-pipeline (Rule #165 auto-reconciled alerting
 * — see the worker).
 *
 * Pure (no I/O, no network, no `new Date()` / `Date.now()` — "now" is always passed in as an
 * ISO string) — mirrors repo-hygiene-lib.ts / dead-cron-classify.ts: `gh` calls and the
 * committed-YAML read live in backlog-staleness-worker.ts, this file only turns a repo's open
 * issues (plus its full label set) into findings, and a manager's findings into issue-body
 * text.
 *
 * ── Finding classes v1 (exactly five, per the issue, plus one informational note) ──
 *   1. p0p1-stale     — labeled P0 or P1, `updatedAt` more than `thresholds.p0p1_days` days
 *                        ago (STRICTLY greater-than — the issue's own text is "untouched > 2
 *                        days", so exactly-at-the-threshold does not flag).
 *   2. p2-stale        — labeled P2, `updatedAt` more than `thresholds.p2_days` days ago.
 *   3. unranked        — carries none of P0–P3, is not machinery-excluded (see below),
 *                         `createdAt` more than `thresholds.unranked_days` days ago (rule 17a:
 *                         "nothing unlabeled").
 *   4. headless        — the repo has ≥1 rankable P0–P3 issue and ZERO issues carrying `next`
 *                         — a REPO-LEVEL finding (`issue: null`), not about one specific issue.
 *   5. multi-next       — the repo has >1 issue carrying `next` ("a head is one item," per the
 *                          issue) — ONE finding PER next-labeled issue (all of them; it's
 *                          ambiguous from label data alone which one is "the real head"), each
 *                          naming its siblings.
 *   6. labels-missing   — INFORMATIONAL, reported at most ONCE per repo: the repo has open
 *                          issues at all, but NONE of P0/P1/P2/P3 exist as labels in the repo
 *                          AT ALL (not "unused this run" — genuinely absent from the label
 *                          set). Ranking is structurally impossible until a human creates them;
 *                          this is a hygiene note, not a ranking violation. `issue: null`.
 *
 * ── Machinery exclusion (backlog-managers.yaml's own rule, verbatim) ──
 * "excluded only if it has a machinery label AND no P0–P3 label." A monitor-opened issue
 * (`dead-cron`, `needs-human`, `backlog-staleness` itself, `credential-monitor`, or a plain
 * `bug`) is NOT lane backlog by default — it's exempt from every ranking check above. BUT the
 * moment a human triages one and adds a P-label, it re-enters the ranked pool exactly like any
 * other issue and is judged on the SAME staleness clock as everything else (the
 * credential-monitor+P1 worked example, live-verified against ops-pipeline#56/#57 the day this
 * shipped: both carry `credential-monitor` AND `P1` — they are ranked P1 issues, full stop,
 * never silently exempted because a monitor also happened to open them).
 *
 * `render()` always emits the SAME fixed rule-17 remedy line for every finding
 * (`RULE_17_REMEDY`) — this leg doesn't attempt to prescribe which of the three remedies fits
 * a given finding; that judgment call belongs to the manager reading the table, not to a
 * pattern-matched string here.
 */

// ───────────────────────────── constants ─────────────────────────────

/** GitHub label name this leg's own aggregate issues carry, AND the `[backlog-staleness]` title tag — one source of truth so the worker's `ensureLabel`/`listIssuesByLabel` calls and this file's title-building can never drift apart. */
export const LABEL = "backlog-staleness";

/** The rule-17 remedy line every finding table row carries, verbatim (the issue's own wording). */
export const RULE_17_REMEDY = "re-rank / escalate to CoS with a rec / label it";

/** The four priority labels rule 17 ranks by. Order matters nowhere in this file (membership-only checks), but P0→P3 is the canonical read order. */
export const P_LABELS = ["P0", "P1", "P2", "P3"] as const;

export const FINDING_CLASSES = ["p0p1-stale", "p2-stale", "unranked", "headless", "multi-next", "labels-missing"] as const;

export type FindingClass = (typeof FINDING_CLASSES)[number];

// ───────────────────────────── input shapes ─────────────────────────────

export interface IssueInput {
  number: number;
  title: string;
  /** Label NAMES only (the worker flattens `gh issue list --json labels`' `{name,...}` objects). */
  labels: string[];
  /** ISO 8601. */
  updatedAt: string;
  /** ISO 8601. */
  createdAt: string;
}

export interface Thresholds {
  p0p1_days: number;
  p2_days: number;
  unranked_days: number;
}

export interface ClassifyInput {
  repo: string;
  manager: string;
  /** ISO 8601 — the worker's clock (real or `--now`-overridden), passed in so this stays pure. */
  now: string;
  /** This repo's OPEN issues only (the worker fetches with `--state open`). */
  issues: IssueInput[];
  thresholds: Thresholds;
  /** `backlog-managers.yaml`'s `machinery_labels:` list, verbatim. */
  machineryLabels: string[];
  /**
   * ALL labels defined in the repo (`gh label list`), not merely labels currently applied to
   * open issues — this is what distinguishes "no P0–P3 issues open right now" (healthy;
   * `unranked`/`p0p1-stale`/etc. already cover real ranking gaps) from "P0–P3 don't even exist
   * as labels here" (`labels-missing`; a structural gap no per-issue check can see).
   */
  repoLabels: string[];
}

export interface Finding {
  class: FindingClass;
  repo: string;
  manager: string;
  /** The specific issue this finding is about, or `null` for a repo-level finding (`headless`, `labels-missing`) that isn't about one issue. */
  issue: number | null;
  /** Issue title, when `issue` is set (for worker logging; `render()`'s table shows only the linked number per the issue's own column spec). */
  title: string | null;
  labels: string[];
  /** Whole days idle (floored) — for `p0p1-stale`/`p2-stale`/`multi-next` this is time since `updatedAt`; for `unranked` it's time since `createdAt` (see each class's detail text for which). `null` for the two repo-level classes. */
  daysIdle: number | null;
  detail: string;
  remedy: string;
}

// ───────────────────────────── helpers ─────────────────────────────

function hasAnyLabel(labels: string[], targets: readonly string[]): boolean {
  return targets.some((t) => labels.includes(t));
}

function hasPLabel(labels: string[]): boolean {
  return hasAnyLabel(labels, P_LABELS);
}

/** backlog-managers.yaml's own rule, verbatim: "excluded only if it has a machinery label AND no P0–P3 label." */
function isMachineryExcluded(labels: string[], machineryLabels: string[]): boolean {
  return hasAnyLabel(labels, machineryLabels) && !hasPLabel(labels);
}

/** Float days from `fromIso` to `toIso` (`toIso` normally `now`) — never itself reads the clock; both timestamps are caller-supplied. */
function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  return (to - from) / (24 * 60 * 60 * 1000);
}

function byIssueNumber(a: IssueInput, b: IssueInput): number {
  return a.number - b.number;
}

// ───────────────────────────── classify ─────────────────────────────

/**
 * Classifies one repo's open issues into findings. Deterministic for identical inputs: each
 * per-class pass iterates issues sorted by number, and classes are pushed in `FINDING_CLASSES`
 * order, so re-running on unchanged data reproduces byte-identical output (no Map/Set
 * iteration-order leakage) — an already-open manager issue's body should not churn on a no-op
 * re-run (mirrors repo-hygiene-lib.ts's `diffFleet` determinism contract).
 */
export function classify(input: ClassifyInput): Finding[] {
  const { repo, manager, now, issues, thresholds, machineryLabels, repoLabels } = input;
  const findings: Finding[] = [];

  // "excluded from ranking checks" (backlog-managers.yaml) — applies uniformly to every check
  // below, not just `unranked`: a machinery-only issue (no P-label) never counts toward
  // p0p1-stale/p2-stale (it couldn't anyway — those require a P-label, which by definition
  // un-excludes it), never counts as "ranked" for `headless`, and never counts toward
  // `multi-next` even if it happens to carry `next` (a monitor issue is never a rule-17 head).
  const rankable = [...issues].filter((i) => !isMachineryExcluded(i.labels, machineryLabels)).sort(byIssueNumber);

  // 1. p0p1-stale — P0 or P1, updatedAt strictly older than p0p1_days.
  for (const issue of rankable) {
    if (!issue.labels.includes("P0") && !issue.labels.includes("P1")) continue;
    const idle = daysBetween(issue.updatedAt, now);
    if (idle <= thresholds.p0p1_days) continue;
    findings.push({
      class: "p0p1-stale",
      repo,
      manager,
      issue: issue.number,
      title: issue.title,
      labels: issue.labels,
      daysIdle: Math.floor(idle),
      detail: `P0/P1 issue untouched for ${Math.floor(idle)}d since its last update (> ${thresholds.p0p1_days}d threshold).`,
      remedy: RULE_17_REMEDY,
    });
  }

  // 2. p2-stale — P2, updatedAt strictly older than p2_days.
  for (const issue of rankable) {
    if (!issue.labels.includes("P2")) continue;
    const idle = daysBetween(issue.updatedAt, now);
    if (idle <= thresholds.p2_days) continue;
    findings.push({
      class: "p2-stale",
      repo,
      manager,
      issue: issue.number,
      title: issue.title,
      labels: issue.labels,
      daysIdle: Math.floor(idle),
      detail: `P2 issue untouched for ${Math.floor(idle)}d since its last update (> ${thresholds.p2_days}d threshold).`,
      remedy: RULE_17_REMEDY,
    });
  }

  // 3. unranked — no P0–P3 label (and not machinery-excluded, already filtered into `rankable`), createdAt strictly older than unranked_days.
  for (const issue of rankable) {
    if (hasPLabel(issue.labels)) continue;
    const idle = daysBetween(issue.createdAt, now);
    if (idle <= thresholds.unranked_days) continue;
    findings.push({
      class: "unranked",
      repo,
      manager,
      issue: issue.number,
      title: issue.title,
      labels: issue.labels,
      daysIdle: Math.floor(idle),
      detail: `No P0–P3 label, open for ${Math.floor(idle)}d since creation (> ${thresholds.unranked_days}d threshold) — rule 17a violation: nothing stays unlabeled.`,
      remedy: RULE_17_REMEDY,
    });
  }

  // 4. headless — ≥1 rankable P0–P3 issue, zero `next` among rankable issues. Repo-level.
  const rankedCount = rankable.filter((i) => hasPLabel(i.labels)).length;
  const nextIssues = rankable.filter((i) => i.labels.includes("next"));
  if (rankedCount > 0 && nextIssues.length === 0) {
    findings.push({
      class: "headless",
      repo,
      manager,
      issue: null,
      title: null,
      labels: [],
      daysIdle: null,
      detail: `${rankedCount} ranked (P0–P3) open issue(s) but none carries \`next\` — no head is set.`,
      remedy: RULE_17_REMEDY,
    });
  }

  // 5. multi-next — >1 `next`-labeled issue: one finding PER such issue, each naming its siblings.
  if (nextIssues.length > 1) {
    const numbers = nextIssues.map((i) => i.number);
    for (const issue of nextIssues) {
      const idle = daysBetween(issue.updatedAt, now);
      const siblings = numbers.filter((n) => n !== issue.number).map((n) => `#${n}`);
      findings.push({
        class: "multi-next",
        repo,
        manager,
        issue: issue.number,
        title: issue.title,
        labels: issue.labels,
        daysIdle: Math.floor(idle),
        detail: `${nextIssues.length} issues carry \`next\` in this repo (${numbers.map((n) => `#${n}`).join(", ")}) — a head is one item. This issue's sibling next(s): ${siblings.join(", ")}.`,
        remedy: RULE_17_REMEDY,
      });
    }
  }

  // 6. labels-missing — informational, at most once per repo. Uses the RAW issue set (not
  // `rankable`) — a repo whose only open issues are machinery-excluded is still worth flagging
  // if P0–P3 don't exist there at all; the note is about label EXISTENCE, independent of any
  // one issue's labels.
  if (issues.length > 0 && !hasAnyLabel(repoLabels, P_LABELS)) {
    findings.push({
      class: "labels-missing",
      repo,
      manager,
      issue: null,
      title: null,
      labels: [],
      daysIdle: null,
      detail: `Repo has ${issues.length} open issue(s) but none of P0–P3 exist as labels in this repo at all — ranking is structurally impossible until they're created.`,
      remedy: RULE_17_REMEDY,
    });
  }

  return findings;
}

// ───────────────────────────── render ─────────────────────────────

export interface RenderInput {
  manager: string;
  /** ISO 8601 — echoed into the footer verbatim (Rule #412: the body states exactly what run produced it). */
  now: string;
  thresholds: Thresholds;
  /** This manager's findings, across every repo it owns — normally the concatenation of `classify()` calls for each of the manager's rows in backlog-managers.yaml. */
  findings: Finding[];
}

function classOrderIndex(cls: FindingClass): number {
  return FINDING_CLASSES.indexOf(cls);
}

function byRenderOrder(a: Finding, b: Finding): number {
  const classDiff = classOrderIndex(a.class) - classOrderIndex(b.class);
  if (classDiff !== 0) return classDiff;
  return (a.issue ?? 0) - (b.issue ?? 0);
}

/** GitHub issue URL for a finding's linked issue — `repo` is `"org/name"`. */
function issueUrl(repo: string, issueNumber: number): string {
  return `https://github.com/${repo}/issues/${issueNumber}`;
}

/**
 * Renders `{ title, body }` for ONE manager's aggregate issue. Title is always
 * `[backlog-staleness] <manager> — N findings` (N = `findings.length`, including at N=0 — the
 * worker never actually POSTS the N=0 title, since a clean manager gets `close`d or left
 * `none`, not opened/retitled; `render()` still computes it unconditionally so a dry-run
 * preview and this function's own tests can see it). Body groups findings by repo
 * (alphabetical), each repo section a markdown table sorted in `FINDING_CLASSES` order (issue
 * number as the tiebreak) — deterministic run-to-run for unchanged input, so an already-open
 * issue's body/comment doesn't needlessly churn wording on a no-op re-run.
 */
export function render(input: RenderInput): { title: string; body: string } {
  const { manager, now, thresholds, findings } = input;
  const title = `[${LABEL}] ${manager} — ${findings.length} findings`;

  const lines: string[] = [];
  lines.push(`Backlog-staleness findings for **${manager}** — LANES rule 17 fleet instrument (ops-pipeline#136).`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("_No findings this run — every repo under this manager is within threshold._");
  } else {
    const repos = [...new Set(findings.map((f) => f.repo))].sort();
    for (const repo of repos) {
      const repoFindings = findings.filter((f) => f.repo === repo).sort(byRenderOrder);
      lines.push(`### ${repo}`);
      lines.push("");
      lines.push("| Issue | Labels | Days idle | Class | Remedy |");
      lines.push("|---|---|---|---|---|");
      for (const f of repoFindings) {
        const issueCell = f.issue !== null ? `[#${f.issue}](${issueUrl(repo, f.issue)})` : "—";
        const labelsCell = f.labels.length > 0 ? f.labels.join(", ") : "—";
        const daysCell = f.daysIdle !== null ? String(f.daysIdle) : "—";
        lines.push(`| ${issueCell} | ${labelsCell} | ${daysCell} | ${f.class} | ${f.remedy} |`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(
    `Run ${now} · thresholds: P0/P1 > ${thresholds.p0p1_days}d, P2 > ${thresholds.p2_days}d, unranked > ${thresholds.unranked_days}d.`,
  );
  lines.push("");
  lines.push(
    "This is a flags-only instrument (LANES rule 17(d)) — it never re-labels, re-ranks, or closes a finding's issue. Clear it by re-ranking, escalating to the CoS with a recommendation, or applying the right label; this aggregate auto-closes (with a comment) once this manager shows zero findings.",
  );

  return { title, body: lines.join("\n") };
}
