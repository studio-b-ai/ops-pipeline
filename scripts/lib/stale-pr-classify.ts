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
 *   2. conflicting-unresolved — mergeStateStatus === "CONFLICTING" and open >= CONFLICT_HOURS
 *                                (Rule #433: a CONFLICTING PR gets zero CI runs at all —
 *                                this is exactly the silent-rot class that needs a human).
 *
 * A draft PR is excluded from both classes — a draft is deliberately not-yet-ready, not
 * abandoned (mirrors dead-cron's disabled_manually exclusion, Rule #157: a human chose
 * that state). Exactly one finding per PR, strongest class wins (conflicting-unresolved >
 * stale-no-motion) — a PR that is BOTH old-with-no-motion AND conflicting is reported once,
 * as the more actionable class.
 */

export const STALE_DAYS = 7;
export const CONFLICT_HOURS = 48;

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
  if (pr.mergeStateStatus === "CONFLICTING" && ageDays * 24 >= CONFLICT_HOURS) {
    return { repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, class: "conflicting-unresolved", ageDays, idleDays };
  }
  if (idleDays >= STALE_DAYS) {
    return { repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, class: "stale-no-motion", ageDays, idleDays };
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
    `Thresholds: no-motion >= ${STALE_DAYS}d (own \`updatedAt\`, not just age) · CONFLICTING unresolved >= ${CONFLICT_HOURS}h (Rule #433 — a conflicting PR gets zero CI runs and rots silently).`,
  );
  lines.push("");
  lines.push("| PR | class | age (d) | idle (d) |");
  lines.push("|---|---|---|---|");
  for (const f of findings) {
    lines.push(`| [#${f.number}](${f.url}) ${f.title} | ${f.class} | ${f.ageDays.toFixed(1)} | ${f.idleDays.toFixed(1)} |`);
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
