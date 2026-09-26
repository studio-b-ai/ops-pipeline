/**
 * one-key-labels.ts — stint #679 sensor + actuator: every non-archived studio-b-ai
 * repo must carry the one-key labels (`box`, `hold`). Design + rationale in
 * scripts/lib/one-key-labels-lib.ts's header.
 *
 * MODES:
 *   (default)   dry run — real reads throughout (org enumeration + per-repo label
 *               reads need the org-wide fleet App token; Rule #376), zero mutations.
 *               Prints every missing label it WOULD create.
 *   --post      create the missing labels canonically (ensureLabel = `gh label
 *               create --force`, idempotent, rides the App's issues:write), then
 *               RE-READ every mutated repo and re-classify (Rule #210/#396: a write
 *               is verified by a fresh read, never by the write's exit code).
 *
 * KILL CONDITION (both modes): any active org repo still missing a required label
 * after the pass → exit 1. The weekly cron is the tick; a red tick is the alarm.
 *
 * Controls (stint #679 end_state): positive — a repo missing a label is named and
 * (with --post) carries it after the pass; negative — archived repos are skipped
 * AND REPORTED as skipped, so a silent skip can never masquerade as coverage.
 */

import { gh, ensureLabel } from "./lib/github-issues.js";
import {
  classifyRepo,
  killConditionBreached,
  FALLBACK_BOX,
  FALLBACK_HOLD,
  type LabelSpec,
  type RepoLabelState,
} from "./lib/one-key-labels-lib.js";

const ORG = "studio-b-ai";
const CANONICAL_SOURCE_REPO = "studio-b-ai/ops-pipeline";
const POST = process.argv.includes("--post");

function fetchCanonicalSpec(name: string, fallback: LabelSpec): LabelSpec {
  try {
    const out = gh(["api", `repos/${CANONICAL_SOURCE_REPO}/labels/${name}`]);
    const live = JSON.parse(out) as { name: string; color: string; description: string | null };
    if (live.name === name && typeof live.color === "string" && live.color.length > 0) {
      return { name, color: live.color, description: live.description ?? "" };
    }
    console.warn(`[one-key-labels] canonical read for '${name}' returned an unexpected shape — using the documented fallback spec`);
    return fallback;
  } catch (err) {
    console.warn(
      `[one-key-labels] canonical read for '${name}' failed (${err instanceof Error ? err.message : String(err)}) — using the documented fallback spec`,
    );
    return fallback;
  }
}

function listRepos(): { name: string; isArchived: boolean }[] {
  const out = gh(["repo", "list", ORG, "--limit", "200", "--json", "name,isArchived"]);
  return JSON.parse(out) as { name: string; isArchived: boolean }[];
}

function listLabelNames(repo: string): string[] {
  const out = gh(["api", `repos/${ORG}/${repo}/labels?per_page=100`, "--jq", ".[].name"]);
  return out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

function readState(repo: string, archived: boolean): RepoLabelState {
  if (archived) return { repo, archived, labels: [] }; // skipped leg never spends an API call
  return { repo, archived, labels: listLabelNames(repo) };
}

function main(): void {
  const specs = [fetchCanonicalSpec("box", FALLBACK_BOX), fetchCanonicalSpec("hold", FALLBACK_HOLD)];
  const required = specs.map((s) => s.name);
  console.log(`[one-key-labels] required labels: ${required.join(", ")} (specs read live from ${CANONICAL_SOURCE_REPO}); mode=${POST ? "POST" : "dry-run"}`);

  const repos = listRepos();
  console.log(`[one-key-labels] ${repos.length} org repos (${repos.filter((r) => r.isArchived).length} archived)`);

  const states = repos.map((r) => readState(r.name, r.isArchived));
  const verdicts = states.map((s) => classifyRepo(s, required));

  for (const v of verdicts) {
    if (v.kind === "skipped-archived") console.log(`[one-key-labels] SKIP ${v.repo} (archived)`);
    else if (v.kind === "missing") console.log(`[one-key-labels] MISSING ${v.repo}: ${v.missing.join(", ")}`);
  }

  const missing = verdicts.filter((v): v is Extract<typeof v, { kind: "missing" }> => v.kind === "missing");
  if (missing.length === 0) {
    console.log("[one-key-labels] every active org repo carries the one-key labels — nothing to do");
    return;
  }

  if (!POST) {
    console.log(`[one-key-labels] dry-run: would create ${missing.reduce((n, v) => n + v.missing.length, 0)} label(s) across ${missing.length} repo(s); re-run with --post to mutate`);
  } else {
    for (const v of missing) {
      for (const name of v.missing) {
        const spec = specs.find((s) => s.name === name)!;
        ensureLabel(`${ORG}/${v.repo}`, spec.name, spec.description, spec.color);
        console.log(`[one-key-labels] created ${name} on ${v.repo}`);
      }
    }
    // Re-read every mutated repo and re-classify — the write's exit code is not the proof.
    const reVerdicts = repos.map((r) => classifyRepo(readState(r.name, r.isArchived), required));
    const stillMissing = killConditionBreached(reVerdicts);
    if (stillMissing.length > 0) {
      console.error(`[one-key-labels] KILL CONDITION: still missing after --post: ${stillMissing.join(", ")}`);
      process.exit(1);
    }
    console.log("[one-key-labels] post-pass re-read: every active org repo now carries the one-key labels");
    return;
  }

  const breached = killConditionBreached(verdicts);
  if (breached.length > 0) {
    console.error(`[one-key-labels] KILL CONDITION (dry-run): active repos missing one-key labels: ${breached.join(", ")}`);
    process.exit(1);
  }
}

main();
