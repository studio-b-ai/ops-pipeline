#!/usr/bin/env tsx
/**
 * base-must-be-main.ts — pre-merge gate: a non-draft PR whose base is not the default
 * branch fails (CLAUDE.md Rule #460 kin; fleet stint #1018).
 *
 * The 2026-10-22 incident: bolt-wms#3945 was stacked on bolt-wms#3934. Kevin merged #3934
 * (squashed onto main as ba266df6), then #3945 — whose base was still #3934's branch
 * fix/3823-wms-onhand-shippable-sites. The merge commit landed on the dead parent branch,
 * not main. The fix from #3945 never shipped.
 *
 * This guard blocks the merge of any non-draft PR whose base is not the default branch.
 * Draft PRs are allowed — stacked-PR workflows use drafts for the child while the parent
 * is under review. A base-name allowlist (comma-separated) permits cross-repo or
 * special-purpose base branches (e.g. gh-pages, a release branch).
 *
 * Verdicts:
 *   PASS (exit 0) — base IS the default branch · PR is a draft · base is allowlisted
 *   FAIL (exit 1) — base is NOT the default branch AND PR is NOT a draft AND base is
 *                    NOT allowlisted
 *
 * Per Rule #322/#471, the test suite plants both verdicts:
 *   - main-as-base + non-draft → PASS (known-good)
 *   - non-main-base + draft → PASS (known-good, stacked draft)
 *   - non-main-base + non-draft → FAIL (known-bad)
 */

const PR_BASE_REF = (process.env.PR_BASE_REF ?? "").trim();
const PR_DRAFT = (process.env.PR_DRAFT ?? "false").trim();
const DEFAULT_BRANCH = (process.env.DEFAULT_BRANCH ?? "").trim();
const ALLOW_LIST = (process.env.ALLOW_LIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function main(): void {
  if (!PR_BASE_REF || !DEFAULT_BRANCH) {
    console.log(
      "::warning::base-must-be-main: PR_BASE_REF or DEFAULT_BRANCH missing — FAIL-OPEN, gate skipped"
    );
    return;
  }

  const isDraft = PR_DRAFT === "true";
  const isDefault = PR_BASE_REF === DEFAULT_BRANCH;
  const isAllowlisted = ALLOW_LIST.includes(PR_BASE_REF);

  const pass = isDefault || isDraft || isAllowlisted;

  const reason = isDefault
    ? `base "${PR_BASE_REF}" is the default branch`
    : isDraft
      ? `base "${PR_BASE_REF}" is not default but PR is a draft (stacked-PR workflow)`
      : isAllowlisted
        ? `base "${PR_BASE_REF}" is allowlisted`
        : `base "${PR_BASE_REF}" is not the default branch "${DEFAULT_BRANCH}", and the PR is not a draft`;

  console.log(
    JSON.stringify({
      verdict: pass ? "PASS" : "FAIL",
      reason,
      draft: isDraft,
      base: PR_BASE_REF,
      defaultBranch: DEFAULT_BRANCH,
      allowlisted: isAllowlisted,
    })
  );

  if (!pass) {
    console.log(
      `::error::base-must-be-main FAIL — ${reason}. ` +
        "Merge the parent PR to main first (GitHub auto-retargets the base within ~2 min), " +
        "or mark the child PR as draft until the parent lands."
    );
    process.exit(1);
  }

  console.log(`base-must-be-main PASS — ${reason}`);
}

main();