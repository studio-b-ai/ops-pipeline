/**
 * stacked-pr-guard.ts — stint #1018 (KIT bay studio-b, 2026-10-23).
 *
 * Pure decision logic: refuse to merge a PR whose base branch has already been
 * merged into main via its own PR. The stacked scenario:
 *   PR #1: feature/x → main (merges first)
 *   PR #2: some-fix → feature/x (stacked on feature/x)
 * After PR #1 lands, PR #2 can still be merged into feature/x — the code lives
 * in feature/x but never reaches main. The fix looks merged but is orphaned.
 *
 * This guard refuses that merge. The caller resolves the live fact ("has
 * baseRefName already been merged to main?") via a gh CLI or API call; this
 * file only decides — zero I/O, matching dead-lane-guard.ts's contract.
 *
 * Target rule: a PR whose base branch != "main" AND that base branch is
 * already reflected on main (its own PR was merged) is BLOCKED. The PR's head
 * must be rebased onto main (or a fresh branch off main) and a new PR opened.
 */

export interface StackedPrCheck {
  /** The PR's base-branch name (e.g. `feature/x`). */
  baseRefName: string;
  /** Caller-resolved: does a merged PR with head=base branch -> base=main exist? */
  baseBranchMergedToMain: boolean;
  /** Caller-resolved: is there an OPEN PR with head=base branch -> base=main?
   *  If yes, the base branch has NOT yet landed — stacking is valid. */
  baseBranchHasOpenPrToMain: boolean;
}

export interface StackedPrResult {
  safe: boolean;
  reason?: string;
}

/**
 * Check whether a PR whose target branch is NOT main is safe to merge.
 * The guard is the caller's first line of defense before any merge attempt.
 *
 * Known-bad (control for the stint): baseRefName = "feature/x",
 *   baseBranchMergedToMain = true, baseBranchHasOpenPrToMain = false
 *   → safe=false, "base branch already merged to main"
 *
 * Known-good (positive control): baseRefName = "main"
 *   → safe=true (no stacking to check)
 *
 * Known-good (stacked but not yet landed): baseRefName = "feature/y",
 *   baseBranchMergedToMain = false, baseBranchHasOpenPrToMain = true
 *   → safe=true (parent still en route)
 */
export function checkStackedPr(input: StackedPrCheck): StackedPrResult {
  if (input.baseRefName === "main") {
    return { safe: true };
  }

  if (input.baseBranchMergedToMain) {
    return {
      safe: false,
      reason: `base branch \`${input.baseRefName}\` has already been merged to main via its own PR — merging this stacked PR would land the diff in \`${input.baseRefName}\` but it would never reach main. Rebase onto main and open a fresh PR.`,
    };
  }

  if (!input.baseBranchHasOpenPrToMain) {
    return {
      safe: false,
      reason: `base branch \`${input.baseRefName}\` has no open PR targeting main and has not been merged to main — the base branch's status cannot be determined. Refusing to merge into a base whose relationship to main is unknown.`,
    };
  }

  return { safe: true };
}