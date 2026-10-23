#!/usr/bin/env tsx
/**
 * post-merge-reachability-check.ts — post-merge safety net (fleet stint #1018).
 *
 * After a PR merges, verifies the merge commit IS reachable from the default branch.
 * If the merge landed on a dead parent branch (the 2026-10-22 incident: bolt-wms#3945
 * merged into fix/3823-wms-onhand-shippable-sites after the parent #3934 had already
 * been squashed onto main), the commit is NOT reachable from main and nobody knows the
 * fix never shipped.
 *
 * Runs via `git merge-base --is-ancestor <merge_sha> origin/<default_branch>`.
 * Exit 0 from that command means the merge commit IS reachable — clean.
 * Exit 1 means it is NOT reachable — the dead-branch-merge class.
 *
 * On a non-reachable merge:
 *   1. Prints a ::error:: annotation with the PR number and sha
 *   2. Opens a GitHub issue in the caller repo with the alert
 *   3. Exits 0 (the alarm IS the action; a red job after merge is noise — the merge
 *      already happened and can't be undone by failing CI)
 *
 * The issue-as-dedup pattern (v2 alerting standard, 2026): reconcile ONE standing
 * issue; close it with a comment when the commit is retroactively cherry-picked.
 */

import { execFileSync } from "node:child_process";

interface Inputs {
  repo: string;
  prNumber: string;
  mergeSha: string;
  defaultBranch: string;
  title: string;
}

function parseInputs(): Inputs {
  const repo = (process.env.INPUT_REPO ?? "").trim();
  const prNumber = (process.env.INPUT_PR_NUMBER ?? "").trim();
  const mergeSha = (process.env.INPUT_MERGE_SHA ?? "").trim();
  const defaultBranch = (process.env.INPUT_DEFAULT_BRANCH ?? "").trim();
  const title = (process.env.INPUT_TITLE ?? "").trim();

  if (!repo || !prNumber || !mergeSha || !defaultBranch) {
    console.log(
      "::warning::post-merge-reachability-check: missing required input — FAIL-OPEN, check skipped"
    );
    process.exit(0);
  }

  return { repo, prNumber, mergeSha, defaultBranch, title };
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8", timeout: 30000 }).trim();
}

async function main(): Promise<void> {
  const inputs = parseInputs();

  console.log(
    JSON.stringify({
      repo: inputs.repo,
      pr: inputs.prNumber,
      sha: inputs.mergeSha,
      defaultBranch: inputs.defaultBranch,
    })
  );

  // git merge-base --is-ancestor returns 0 if <commit> is an ancestor of <ref>,
  // 1 if not, 128+ on error.
  let reachable = false;
  try {
    git(["merge-base", "--is-ancestor", inputs.mergeSha, `origin/${inputs.defaultBranch}`]);
    reachable = true;
  } catch (err: any) {
    if (err.status === 1) {
      reachable = false;
    } else {
      console.log(
        `::warning::post-merge-reachability-check: git merge-base error (${String(err)}) — FAIL-OPEN`
      );
      return;
    }
  }

  if (reachable) {
    console.log(
      `post-merge-reachability-check CLEAN — ${inputs.mergeSha} is reachable from ${inputs.defaultBranch}`
    );
    return;
  }

  // NOT reachable — the dead-branch-merge class.
  const alertTitle = `[post-merge] PR #${inputs.prNumber} merge commit not reachable from ${inputs.defaultBranch}`;
  const alertBody = [
    `PR #${inputs.prNumber} was merged, but its merge commit \`${inputs.mergeSha}\` is **not reachable** from \`${inputs.defaultBranch}\`.`,
    "",
    "This is the dead-branch-merge class (fleet stint #1018): the PR's base was a feature branch",
    "whose parent had already been merged to the default branch. The merge landed on the dead",
    "parent branch — the fix never shipped.",
    "",
    "### Recovery",
    "1. Cherry-pick the merge commit onto the default branch:",
    "   ```sh",
    `   git fetch origin ${inputs.mergeSha}`,
    `   git cherry-pick ${inputs.mergeSha}`,
    "   git push origin HEAD:refs/heads/<recovery-branch>",
    "   ```",
    "2. Open a new PR from the recovery branch to the default branch.",
    `3. Close this issue when the fix is live on \`${inputs.defaultBranch}\`.`,
    "",
    `| field | value |`,
    `|---|---|`,
    `| repo | ${inputs.repo} |`,
    `| PR | #${inputs.prNumber} |`,
    `| merge commit | \`${inputs.mergeSha}\` |`,
    `| default branch | \`${inputs.defaultBranch}\` |`,
  ].join("\n");

  console.log(
    `::error::post-merge-reachability-check DEAD-BRANCH-MERGE — PR #${inputs.prNumber} (${inputs.mergeSha}) is NOT reachable from ${inputs.defaultBranch}`
  );

  // Search for an existing issue with the same title to dedup.
  const issueLabel = "post-merge-reachability";
  try {
    const existingJson = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        inputs.repo,
        "--label",
        issueLabel,
        "--search",
        `PR #${inputs.prNumber}`,
        "--state",
        "open",
        "--json",
        "number,title",
        "--limit",
        "5",
      ],
      { encoding: "utf-8", timeout: 15000 }
    ).trim();

    const existing: { number: number; title: string }[] = existingJson
      ? JSON.parse(existingJson)
      : [];
    const existingMatch = existing.find((i) => i.title.includes(`#${inputs.prNumber}`));

    if (existingMatch) {
      console.log(
        `post-merge-reachability-check: open issue #${existingMatch.number} already exists for PR #${inputs.prNumber} — not creating a duplicate`
      );
    } else {
      // Ensure the label exists (idempotent).
      execFileSync("gh", ["label", "create", issueLabel, "--repo", inputs.repo, "--force"], {
        stdio: "ignore",
        timeout: 10000,
      });

      const issueUrl = execFileSync(
        "gh",
        [
          "issue",
          "create",
          "--repo",
          inputs.repo,
          "--title",
          alertTitle,
          "--body",
          alertBody,
          "--label",
          issueLabel,
        ],
        { encoding: "utf-8", timeout: 15000 }
      ).trim();

      console.log(`post-merge-reachability-check: opened alert issue ${issueUrl}`);
    }
  } catch (err) {
    console.log(
      `::warning::post-merge-reachability-check: could not create/dedup issue (${String(err)}) — alert body follows`
    );
    console.log(`---\n${alertTitle}\n${alertBody}\n---`);
  }

  // Exit 0: the alarm IS the action. A red job after a merge that already
  // happened is noise (the merge can't be undone by failing CI).
}

main().catch((err) => {
  console.log(
    `::warning::post-merge-reachability-check: internal error (${String(err)}) — FAIL-OPEN`
  );
});