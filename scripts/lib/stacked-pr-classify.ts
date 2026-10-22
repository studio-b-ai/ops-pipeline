/**
 * stacked-pr-classify.ts — pure classification logic for the stacked-PR defunct-base
 * sweep leg (crew mechanic stint #1018, "A stacked PR can be merged into its parent's
 * branch after the parent lands, so the fix looks merged but never reaches main").
 *
 * Law (inherited from stale-pr-sweep / repo-hygiene-lib.ts, same arc): flags-only.
 * This leg NOMINATES (a finding), never rebases/re-targets/merges a PR itself — the
 * owning seat acts on the finding in its next lap. Pure (no I/O, no `new Date()` —
 * "now" is always passed in) so it is fully unit-testable; `gh` calls live in
 * stacked-pr-sweep.ts.
 *
 * Finding class (exactly one):
 * 1. stacked-base-defunct — an OPEN, non-draft PR whose `baseRefName` is not the
 *    repo's default branch AND whose base branch name matches the `headRefName` of
 *    a merged PR in the same repo. This is the "parent landed, child left behind"
 *    signal: the stacked child PR's base is a branch whose associated PR already
 *    merged (into main or another target), so merging THIS PR into its now-stale
 *    base would never reach the default branch. The fix: retarget the PR to the
 *    default branch after the parent lands.
 *
 * Signal design:
 *   - baseRefName !== defaultBranch: the PR targets something other than main.
 *   - Parent PR merged: a PR exists whose headRefName === this PR's baseRefName and
 *     that PR's state is MERGED. This is the positive proof the base is defunct —
 *     the parent's branch won't be merged again.
 *
 * A draft PR is excluded — a draft is deliberately not-yet-ready, not abandoned
 * (mirrors stale-pr-classify's draft exclusion, Rule #157).
 */

export interface ParentPr {
  headRefName: string;
  state: "MERGED" | "CLOSED" | "OPEN";
}

export interface StackedPrInput {
  repo: string;
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  defaultBranch: string;
  isDraft: boolean;
}

export const STACKED_PR_CLASSES = ["stacked-base-defunct"] as const;
export type StackedPrClass = (typeof STACKED_PR_CLASSES)[number];

export interface StackedPrFinding {
  repo: string;
  number: number;
  title: string;
  url: string;
  class: StackedPrClass;
  baseRefName: string;
  headRefName: string;
  defaultBranch: string;
  parentPrNumber: number;
  parentPrState: string;
}

/**
 * One PR -> at most one finding. Pure.
 * A finding means: this PR targets a non-default branch, and the branch it targets
 * was the head of a merged PR — the parent landed, but this child was never re-targeted
 * to the default branch. Merging this PR into the stale base branch would land the
 * changes "merged" but unreachable from main.
 */
export function classifyPr(pr: StackedPrInput, parentPrs: ParentPr[]): StackedPrFinding | null {
  if (pr.isDraft) return null; // Rule #157 — a human chose draft; not abandoned.
  if (pr.baseRefName === pr.defaultBranch) return null; // Targets main — not stacked on a non-default base.

  const mergedParent = parentPrs.find(
    (p) => p.headRefName === pr.baseRefName && p.state === "MERGED",
  );
  if (!mergedParent) return null; // No merged parent PR found for this base branch name.

  // The remaining parent PRs are passed as context so the I/O glue can render them,
  // but classification only needs: base≠default + parent merged. The merged parent
  // IS the finding's root cause.
  return {
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    class: "stacked-base-defunct",
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    defaultBranch: pr.defaultBranch,
    parentPrNumber: -1, // filled by the caller who has the numbered parent PR list
    parentPrState: mergedParent.state,
  };
}

/**
 * Classify all PRs against a parent-PR index keyed by head ref name.
 * The index is built by the I/O glue: `gh pr list --state merged,closed --json headRefName,state,number`
 * for the repo, then classified here purely.
 */
export function classifyPrs(
  prs: StackedPrInput[],
  parentPrs: ParentPr[],
): StackedPrFinding[] {
  return prs
    .map((pr) => classifyPr(pr, parentPrs))
    .filter((f): f is StackedPrFinding => f !== null);
}

/** Fleet-wide summary line for logs / the [stacked-pr] issue's opening line. */
export function summarizeStackedPr(findings: StackedPrFinding[]): string {
  return findings.length === 0
    ? "0 findings"
    : `${findings.length} finding(s): ${findings.length} stacked-base-defunct`;
}

/** Markdown body for the per-repo `[stacked-pr]` aggregate issue. */
export function renderStackedPrIssueBody(
  repo: string,
  findings: StackedPrFinding[],
  generatedAtIso: string,
): string {
  const lines: string[] = [];
  lines.push(
    `**Stacked-PR sweep** for \`${repo}\` — generated ${generatedAtIso}.`,
  );
  lines.push("");
  lines.push(
    "Defect (mechanic stint #1018): an OPEN PR whose `baseRefName` is not the default branch AND " +
      "that base branch was the head of a MERGED PR — the parent landed, the child was never " +
      "re-targeted to the default branch. Merging this PR into the stale base branch lands the " +
      "changes \"merged\" but unreachable from main.",
  );
  lines.push("");
  lines.push("| PR | base (defunct) | head | parent PR | parent state |");
  lines.push("|---|---|---|---|---|");
  for (const f of findings) {
    const parentRef = f.parentPrNumber > 0
      ? `[#${f.parentPrNumber}](https://github.com/${f.repo}/pull/${f.parentPrNumber})`
      : "unknown";
    lines.push(
      `| [#${f.number}](${f.url}) ${f.title} | \`${f.baseRefName}\` | \`${f.headRefName}\` | ${parentRef} | ${f.parentPrState} |`,
    );
  }
  lines.push("");
  lines.push(
    "Flags-only (mechanic stint #1018) — this leg nominates; the owning seat re-targets the PR " +
      "to the default branch so it can reach main.",
  );
  lines.push("");
  lines.push(
    `Default branch for this repo: \`${findings[0]?.defaultBranch ?? "unknown"}\`.`,
  );
  return lines.join("\n");
}

export type StackedPrAction = "open" | "update" | "close" | "none";

/** Mirrors stale-pr-classify.ts's planStalePrAction exactly (Rule #283 — reuse the shape). */
export function planStackedPrAction(
  findingCount: number,
  issueOpen: boolean,
): StackedPrAction {
  if (findingCount > 0) return issueOpen ? "update" : "open";
  return issueOpen ? "close" : "none";
}