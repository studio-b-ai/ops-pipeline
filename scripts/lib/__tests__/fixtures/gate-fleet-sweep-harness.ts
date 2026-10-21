/**
 * Runs the REAL `list` step of .github/workflows/squasher-fleet-sweep.yml (go-native PR-A2 tests, #223).
 *
 * `listStepScript()` extracts the step's `run:` text straight out of the workflow file; `runSweep()` runs it in bash exactly as Actions does
 * (`bash --noprofile --norc -e -o pipefail`) with the REAL native-exclusion, fleet-sweep-changed and fleet-sweep-order CLIs under tsx,
 * against a fake `gh` (gate-gh-stub.ts) that answers GitHub. The only edit to the script is `/tmp/` → a per-run directory, which holds the
 * sweep's state file — so pass the SAME `dir` to consecutive runs to model consecutive hourly ticks sharing the Actions cache
 * (`runSweep` returns its `dir`; a run without one gets a fresh dir, i.e. a cold cache).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { makeGhStub, type GhStubRule } from "./gate-gh-stub.js";

export const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ROOT = join(SCRIPTS, "..");
export const WORKFLOW = join(ROOT, ".github", "workflows", "squasher-fleet-sweep.yml");

export function listStepScript(): string {
  const wf = parse(readFileSync(WORKFLOW, "utf-8")) as { jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }> };
  const step = wf.jobs["determine-prs"].steps.find((s) => s.id === "list");
  if (!step?.run) throw new Error("the `list` step of determine-prs was not found — the workflow was restructured; update this test deliberately");
  return step.run;
}

export type SweepEntry = { repo: string; pr_number: string };

export function runSweep(
  env: Record<string, string>,
  rules: GhStubRule[],
  opts: { dir?: string; transformScript?: (script: string) => string } = {},
) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "fleet-sweep-"));
  const stub = makeGhStub(dir, rules);
  const scriptPath = join(dir, "list-step.sh");
  const script = listStepScript();
  writeFileSync(scriptPath, (opts.transformScript ? opts.transformScript(script) : script).replaceAll("/tmp/", `${dir}/`));
  const ghOutput = join(dir, "github-output");
  writeFileSync(ghOutput, "");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
    cwd: ROOT,
    env: {
      PATH: stub.path,
      HOME: process.env.HOME ?? "",
      GH_STUB_LOG: stub.logPath,
      GH_TOKEN: "stub-not-a-secret",
      PATCH_ID_WINS: "config",
      MAX_FANOUT: "100",
      PER_REPO_CAP: "5",
      RUN_OFFSET: "1",
      GITHUB_OUTPUT: ghOutput,
      ONLY_REPO: "",
      ONLY_PR: "",
      ...env,
    },
    encoding: "utf-8",
  });
  const calls = readFileSync(stub.logPath, "utf-8").split("\n").filter(Boolean);
  const out = readFileSync(ghOutput, "utf-8");
  const entriesLine = out.split("\n").find((l) => l.startsWith("entries="));
  return {
    dir,
    status: r.status,
    log: `${r.stdout}\n${r.stderr}`,
    calls,
    entries: entriesLine ? (JSON.parse(entriesLine.slice("entries=".length)) as SweepEntry[]) : null,
  };
}
export const prListCalls = (calls: string[]) => calls.filter((c) => c.startsWith("pr list "));
export const writeCalls = (calls: string[]) => calls.filter((c) => /update-branch|pr edit|issues\/\d+\/labels|--add-label|-X (POST|PUT|PATCH|DELETE)/.test(c));
