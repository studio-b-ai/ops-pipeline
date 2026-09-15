/**
 * stale-pr-classify.ts — pure classification logic for the stale-PR sweep leg
 * (studio-b#112 sub-leg c: "stale sweep — Scout Fri 15Z: any PR >7d with no motion ->
 * yellow stale-pr:<repo>#N; CONFLICTING >48h -> the owning seat rebases or closes in its
 * next lap"; org sweep evidence: library/product/2026-09-12-merge-train-defect-org-sweep.md
 * §"Also found" — 7 CONFLICTING PRs + several 65-139h-stale PRs found by manual probe only,
 * nothing in the fleet watched for it).
 *
 * Law (inherited from repo-hygiene-lib.ts / dead-cron-classify.ts, same arc): flags-only.
 * This leg NOMINATES (a finding), never rebases/closes/merges a PR itself — the owning
 * seat acts on the finding in its next lap. Pure (no I/O, no `new Date()` — "now" is
 * always passed in) so it is fully unit-testable; `gh` calls live in stale-pr-sweep.ts.
 *
 * Finding classes (exactly two, from the stint text):
 *   1. stale-no-motion     — PR open >= STALE_DAYS with its OWN updatedAt also that old
 *                             (no motion, not merely old — a PR someone just pushed to
 *                             today is not stale even if opened three weeks ago).
 *   2. conflicting-unresolved — mergeable === "CONFLICTING" and open >= CONFLICT_HOURS
 *                                (Rule #433: a conflicting PR gets zero CI runs at all —
 *                                this is exactly the silent-rot class that needs a human).
 *
 * ⚠ THE CONFLICT SIGNAL IS `mergeable`, NOT `mergeStateStatus` (#322/#465 — found by live
 * probe, 2026-09-13, while proving this leg's first zero honest rather than blind):
 * `gh pr list --json mergeStateStatus` NEVER emits "CONFLICTING" — a conflicting PR reports
 * mergeStateStatus="DIRTY" there, and only `mergeable` carries "CONFLICTING". Observed
 * across the whole fleet's open-PR population (34 PRs / 13 repos): list-mode
 * mergeStateStatus values were exactly {CLEAN, DIRTY, UNSTABLE, BLOCKED} — "CONFLICTING"
 * appeared zero times anywhere. Confirmed against the single-PR instrument on three named
 * rows: brain#160 / #252 / #230 each read `mergeStateStatus=DIRTY mergeable=CONFLICTING`.
 * Classifying on mergeStateStatus therefore made this class STRUCTURALLY BLIND — it would
 * have shipped fail-closed-silent forever, reporting a healthy fleet-wide zero while the
 * org sweep's 7 hand-found CONFLICTING PRs sat in plain sight. mergeStateStatus is kept on
 * the input purely as reported CONTEXT; it is never the conflict predicate.
 *
 * A draft PR is excluded from both classes — a draft is deliberately not-yet-ready, not
 * abandoned (mirrors dead-cron's disabled_manually exclusion, Rule #157: a human chose
 * that state). Exactly one finding per PR, strongest class wins (conflicting-unresolved >
 * stale-no-motion) — a PR that is BOTH old-with-no-motion AND conflicting is reported once,
 * as the more actionable class.
 */

export const STALE_DAYS = 7;

/**
 * How many of a repo's non-draft open PRs may report `mergeable="UNKNOWN"` before the
 * whole read is rejected as unresolved. Zero: GitHub resolves mergeability for the WHOLE
 * page at once, so a legitimate warm read has no UNKNOWN rows at all (observed across
 * 13 repos / 34 PRs, 2026-09-13) — one UNKNOWN means the page was served cold.
 */
export const MAX_UNKNOWN_MERGEABLE = 0;
export const CONFLICT_HOURS = 48;

/** `mergeable` — the ONLY field that reports a conflict in list mode (see header). */
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** `mergeStateStatus` — reported context only, never the conflict predicate (see header). */
export type MergeStateStatus = "CLEAN" | "CONFLICTING" | "DIRTY" | "UNSTABLE" | "BLOCKED" | "BEHIND" | "DRAFT" | "UNKNOWN";

export interface PrInput {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 — last activity (commits/comments/reviews) per GitHub's own field. */
  updatedAt: string;
  /** The conflict predicate. `mergeStateStatus` does NOT carry this signal (see header). */
  mergeable: Mergeable;
  /** Context only — surfaced in the issue body so a reader can audit the verdict. */
  mergeStateStatus: MergeStateStatus;
  isDraft: boolean;
}

export const STALE_PR_CLASSES = ["conflicting-unresolved", "stale-no-motion"] as const;
export type StalePrClass = (typeof STALE_PR_CLASSES)[number];

export interface StalePrFinding {
  repo: string;
  number: number;
  title: string;
  url: string;
  class: StalePrClass;
  ageDays: number;
  idleDays: number;
  /** Observed at classify time — rendered into the issue body as the verdict's evidence. */
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
}

function daysBetween(fromIso: string, nowIso: string): number {
  return (new Date(nowIso).getTime() - new Date(fromIso).getTime()) / (24 * 60 * 60 * 1000);
}

/** One PR -> at most one finding. Pure. */
export function classifyPr(pr: PrInput, nowIso: string): StalePrFinding | null {
  if (pr.isDraft) return null; // Rule #157 — a human chose draft; not abandoned.
  const ageDays = daysBetween(pr.createdAt, nowIso);
  const idleDays = daysBetween(pr.updatedAt, nowIso);

  // Strongest class first (Rule #433's silent-CI-death class is the more actionable read).
  const observed = { mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus };
  if (pr.mergeable === "CONFLICTING" && ageDays * 24 >= CONFLICT_HOURS) {
    return { repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, class: "conflicting-unresolved", ageDays, idleDays, ...observed };
  }
  if (idleDays >= STALE_DAYS) {
    return { repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, class: "stale-no-motion", ageDays, idleDays, ...observed };
  }
  return null;
}

export function classifyPrs(prs: PrInput[], nowIso: string): StalePrFinding[] {
  return prs.map((pr) => classifyPr(pr, nowIso)).filter((f): f is StalePrFinding => f !== null);
}

/**
 * GitHub computes `mergeable` LAZILY (#382 — a read taken before the value resolves is a
 * FAILED INSTRUMENT, not a result). A cold `gh pr list` returns `mergeable="UNKNOWN"` for
 * every row; a warm one returns the truth. Found live 2026-09-13 while proving this leg's
 * first firing: the 12:42Z dry-run reported `brain: 18 open PR(s) -> 0 findings` while the
 * very same query moments later reported **7 CONFLICTING** (#160 at 308h, #221, #225,
 * #230, #242, #252, #270). `classifyPr` treats UNKNOWN as not-conflicting, so a cold page
 * degrades SILENTLY to a healthy-looking fleet-wide zero.
 *
 * That zero is not merely a missed finding: `planStalePrAction(0, true)` returns "close",
 * so a cold read would have AUTO-CLOSED a repo's live `[stale-pr]` issue — the exact thing
 * this worker's step-4 contract promises never to do ("never close on data you didn't
 * fully reconfirm", Rule #465).
 *
 * So an unresolved page is a READ FAILURE, routed into the existing per-repo skip path
 * (issue left untouched, next run retries) rather than classified. Drafts are excluded
 * from the count because they are excluded from classification.
 */
export function isMergeabilityUnresolved(prs: PrInput[]): boolean {
  const considered = prs.filter((p) => !p.isDraft);
  const unknown = considered.filter((p) => p.mergeable === "UNKNOWN").length;
  return unknown > MAX_UNKNOWN_MERGEABLE;
}

/** Fleet-wide summary line for logs / the [stale-pr] issue's opening line. */
export function summarizeStalePr(findings: StalePrFinding[]): string {
  const byClass = new Map<StalePrClass, number>();
  for (const f of findings) byClass.set(f.class, (byClass.get(f.class) ?? 0) + 1);
  const parts = STALE_PR_CLASSES.filter((c) => byClass.has(c)).map((c) => `${byClass.get(c)} ${c}`);
  return findings.length === 0 ? "0 findings" : `${findings.length} finding(s): ${parts.join(", ")}`;
}

/** Markdown body for the per-repo `[stale-pr]` aggregate issue (mirrors dead-cron's per-repo pattern). */
export function renderStalePrIssueBody(repo: string, findings: StalePrFinding[], generatedAtIso: string): string {
  const lines: string[] = [];
  lines.push(`**Stale-PR sweep** for \`${repo}\` — generated ${generatedAtIso}.`);
  lines.push("");
  lines.push(
    `Thresholds: no-motion >= ${STALE_DAYS}d (own \`updatedAt\`, not just age) · conflicting unresolved >= ${CONFLICT_HOURS}h (Rule #433 — a conflicting PR gets zero CI runs and rots silently).`,
  );
  lines.push("");
  lines.push("| PR | class | age (d) | idle (d) | mergeable | mergeStateStatus |");
  lines.push("|---|---|---|---|---|---|");
  for (const f of findings) {
    lines.push(
      `| [#${f.number}](${f.url}) ${f.title} | ${f.class} | ${f.ageDays.toFixed(1)} | ${f.idleDays.toFixed(1)} | ${f.mergeable} | ${f.mergeStateStatus} |`,
    );
  }
  lines.push("");
  lines.push(
    "Flags-only (studio-b#112 sub-leg c) — this leg nominates; the owning seat rebases or closes in its next lap. Cadence: weekly, Fri 15:00Z.",
  );
  return lines.join("\n");
}

export type StalePrAction = "open" | "update" | "close" | "none";

/** Mirrors repo-hygiene-lib.ts's planIssueAction exactly (Rule #283 — reuse the shape). */
export function planStalePrAction(findingCount: number, issueOpen: boolean): StalePrAction {
  if (findingCount > 0) return issueOpen ? "update" : "open";
  return issueOpen ? "close" : "none";
}

/**
 * ── The swept POPULATION (studio-b#112 leg 1 ↔ leg 4 coherence) ──────────────────────
 *
 * A watcher's predicate is only half its receipt — the other half is the POPULATION it
 * could see (Rule #465). This leg originally swept `backlog-managers.yaml` alone (13
 * repos, the "which repos does a seat open PRs in" answer, reused per Rule #283). But
 * stint #112's FIRST leg widened the RELEASE door (`train: true` in squasher-fleet.json)
 * onto claude-config-plane, brain, radio, lightsout and client-asthetik — and three of
 * those five (claude-config-plane, radio, lightsout) are absent from backlog-managers.yaml.
 *
 * So the door could auto-merge in a repo the rot-watch could not see. Measured live
 * 2026-09-13T12:54Z, exactly the PRs that fell through the gap:
 *   - studio-b-ai/claude-config-plane#272 — mergeable=CONFLICTING mergeStateStatus=DIRTY
 *   - studio-b-ai/radio#1010            — mergeable=CONFLICTING mergeStateStatus=DIRTY
 * Neither repo was in ANY sweep population, so neither PR was watched by anything.
 *
 * The fix is a UNION derived at read time, never a mutation of either file:
 *   - `backlog-managers.yaml` is shared committed config consumed by three OTHER workers
 *     (backlog-compliance-worker, backlog-staleness-worker, train-liveness-worker) —
 *     widening it would silently change THEIR behavior too (Rule #1 scope discipline).
 *   - `squasher-fleet.json` is the door's own registry, owned by the door.
 * Reading both and unioning leaves each file's owner intact while closing the gap: any
 * repo the release door can act in is a repo this watch covers. Pure + order-stable so
 * the population itself is unit-testable.
 *
 * Seat attribution: backlog-managers.yaml names a `manager` per repo; a door-registry
 * repo with no manager row is attributed to the door's owning seat (Mechanic holds
 * ops-pipeline). The finding still lands on the OWNING repo either way (Rule #165).
 */
export const DOOR_ONLY_FALLBACK_MANAGER = "Mechanic";

export interface SweepRepo {
  repo: string;
  manager: string;
  /** Which registry put this repo in the population — rendered as the finding's provenance. */
  source: "backlog-managers" | "release-door" | "both";
}

export interface BacklogManagerRow {
  repo: string;
  manager?: string;
}

export interface DoorRegistryRow {
  repo: string;
  /** squasher-fleet.json's `train` field — true = the RELEASE (`queued`) leg is live here. */
  train?: boolean;
}

/**
 * Union the backlog-manager rows with the release-door registry's TRAIN-ENABLED repos.
 *
 * Only `train: true` door rows join: a registry row with the release leg off cannot
 * auto-merge, so it is not the coherence gap this closes (and pulling all 18 registry
 * rows in would widen the watch on a claim nobody made). Pure; output order is stable —
 * backlog-manager rows first in their config order, then door-only repos in registry
 * order — so the swept order (and thus the issue bodies) are deterministic.
 */
export function resolveSweepPopulation(
  backlogRows: BacklogManagerRow[],
  doorRows: DoorRegistryRow[],
): SweepRepo[] {
  const doorTrain = new Set(doorRows.filter((d) => d.train === true).map((d) => d.repo));
  const seen = new Set<string>();
  const out: SweepRepo[] = [];

  for (const row of backlogRows) {
    if (seen.has(row.repo)) continue; // a duplicated config row must not double-sweep
    seen.add(row.repo);
    out.push({
      repo: row.repo,
      manager: row.manager ?? DOOR_ONLY_FALLBACK_MANAGER,
      source: doorTrain.has(row.repo) ? "both" : "backlog-managers",
    });
  }

  for (const repo of doorTrain) {
    if (seen.has(repo)) continue;
    seen.add(repo);
    out.push({ repo, manager: DOOR_ONLY_FALLBACK_MANAGER, source: "release-door" });
  }

  return out;
}
