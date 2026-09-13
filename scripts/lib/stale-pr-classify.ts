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
