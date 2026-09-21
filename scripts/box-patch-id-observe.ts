// scripts/box-patch-id-observe.ts
//
// Entry point for .github/workflows/box-patch-id-observe.yml (workflow_dispatch,
// ops-pipeline#807 rollout step 4). Wired the same way scripts/box-patch-id-labeled.ts is wired:
// env/argv in, `gh` CLI out, all real math lives in scripts/lib/box-patch-id.ts,
// scripts/lib/label-authority.ts and scripts/lib/box-patch-id-observe.ts.
//
// Observe-only: this workflow never blocks a PR's checks (conclusion is always `neutral`, never
// `skipped` — see box-patch-id-labeled.ts's header for why `skipped` is unclean on this repo's
// release check). Every path below — a well-typed refusal, an unsupported mode, or an unexpected
// thrown error — still tries to print the required stdout line and record the
// box-patch-id-observe check run, then exits 0 either way.

import { execFileSync } from "node:child_process";
import { buildCheckRunApiArgs, observeBoxPatchId, type ShaWithCheckRuns } from "./lib/box-patch-id-observe.js";
import type { CheckRunLike } from "./lib/box-patch-id.js";

type CheckRunWithId = CheckRunLike & { id?: number };

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`box-patch-id-observe: missing required env var ${name}`);
  return v;
}

function fetchChangedPaths(repo: string, prNumber: number): string[] {
  const out = gh(["api", `repos/${repo}/pulls/${prNumber}/files`, "--paginate", "--jq", ".[].filename"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function fetchOrderedShas(repo: string, prNumber: number): string[] {
  const out = gh(["api", `repos/${repo}/pulls/${prNumber}/commits`, "--paginate", "--jq", ".[].sha"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function fetchCheckRunsForSha(repo: string, sha: string): CheckRunWithId[] {
  const out = gh(["api", `repos/${repo}/commits/${sha}/check-runs`, "--paginate", "--jq", ".check_runs[] | {id, name, output}"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as CheckRunWithId);
}

function findExistingObserveCheckRunId(checkRuns: readonly CheckRunWithId[]): number | undefined {
  for (const cr of checkRuns) {
    if (cr.name === "box-patch-id-observe" && cr.id != null) return cr.id;
  }
  return undefined;
}

function main(): void {
  const repo = env("BOX_REPO");
  const prNumber = Number(env("BOX_PR_NUMBER"));
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`box-patch-id-observe: BOX_PR_NUMBER must be a positive integer, got ${JSON.stringify(process.env.BOX_PR_NUMBER)}`);
  }
  const control = process.env.BOX_CONTROL || "n/a";
  const mode = process.env.BOX_MODE || "observe";
  const runId = process.env.GITHUB_RUN_ID || "local";
  const key = process.env.BOX_PATCH_ID_KEY || undefined;
  // head_sha_override is accepted (per the workflow's input contract) but unused by mode=observe —
  // it exists for mode=mint-dry, a sibling unit's job (control-5-nonexistent-ref.zsh's header).
  void process.env.BOX_HEAD_SHA_OVERRIDE;

  let line: string;
  let checkRunTitle: string;
  let checkRunText: string;
  let headSha: string | undefined;

  try {
    const prJson = JSON.parse(
      gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "headRefOid,baseRefName,headRepositoryOwner,headRepository"]),
    ) as {
      headRefOid: string;
      baseRefName: string;
      headRepositoryOwner?: { login?: string };
      headRepository?: { name?: string };
    };

    headSha = prJson.headRefOid;
    const baseRef = prJson.baseRefName;
    const headRepoOwner = prJson.headRepositoryOwner?.login;
    const headRepoName = prJson.headRepository?.name;
    const headRepo = headRepoOwner && headRepoName ? `${headRepoOwner}/${headRepoName}` : repo;

    const changedPaths = fetchChangedPaths(repo, prNumber);
    const orderedShas = fetchOrderedShas(repo, prNumber);
    const shasWithCheckRuns: ShaWithCheckRuns[] = orderedShas.map((sha) => ({
      sha,
      checkRuns: fetchCheckRunsForSha(repo, sha),
    }));

    const result = observeBoxPatchId({
      repo,
      prNumber,
      control,
      mode,
      runId,
      headSha,
      headRepo,
      baseRef,
      changedPaths,
      shasWithCheckRuns,
      key,
      repoDir: process.cwd(),
    });

    line = result.line;
    checkRunTitle = `box-patch-id-observe: ${result.verdict}`;
    checkRunText = JSON.stringify({
      verdict: result.verdict,
      recordedPatchId: result.recordedPatchId,
      currentPatchId: result.currentPatchId,
      recordedSha: result.recordedSha,
      movedShas: result.movedShas,
      unrefreshedShas: result.unrefreshedShas,
      control,
      mode,
      runId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    line = `[box-patch-id observe-only] control=${control} repo=${repo} pr=${prNumber} mode=${mode} recorded=none current=none verdict=box-patch-id-observe-error unrefreshed=[] moved=[] run=${runId}`;
    checkRunTitle = "box-patch-id-observe: error";
    checkRunText = JSON.stringify({ error: message, control, mode, runId });
  }

  // The stdout line is the load-bearing contract harvest-receipt.zsh greps — print it exactly
  // once, regardless of which branch above produced it.
  console.log(line);

  if (headSha) {
    try {
      const existingId = findExistingObserveCheckRunId(fetchCheckRunsForSha(repo, headSha));
      const action = buildCheckRunApiArgs({
        repo,
        headSha,
        conclusion: "neutral",
        title: checkRunTitle,
        text: checkRunText,
        existingId,
      });
      gh(action.args);
    } catch (err) {
      // Recording the observation must never fail the workflow — observe-only, per the ruling.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`box-patch-id-observe: failed to record the check run — ${message}`);
    }
  } else {
    console.error("box-patch-id-observe: no head sha resolved — skipping the box-patch-id-observe check-run write.");
  }
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`box-patch-id-observe: unexpected top-level error — ${message}`);
}
process.exit(0);
