import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { NATIVE_RULESET_NAME } from "../native-exclusion.js";
import { makeGhStub, type GhStubRule } from "./fixtures/gate-gh-stub.js";

// Go-native Phase A, PR-A2 item 2 — automerge-sweep.yml leg (ops-pipeline's own self-sweep). Same method as
// fleet-sweep-native-exclusion.test.ts (#223): the REAL `list` step script out of the workflow, run in bash as Actions runs it,
// with the REAL native-exclusion CLI under tsx and a fake `gh`.

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = join(SCRIPTS, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "automerge-sweep.yml");
const REPO = "studio-b-ai/ops-pipeline";

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string> };
const steps = (): Step[] => (parse(readFileSync(WORKFLOW, "utf-8")) as { jobs: Record<string, { steps: Step[] }> }).jobs["determine-prs"].steps;
const listStep = (): Step => {
  const s = steps().find((x) => x.id === "list");
  if (!s?.run) throw new Error("the `list` step of determine-prs was not found — update this test deliberately");
  return s;
};

const nativeRow = { id: 99, name: NATIVE_RULESET_NAME, target: "branch", enforcement: "active", source_type: "Repository" };
const nativeDetail = { ...nativeRow, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } };
const RULESETS = `^api repos/${REPO}/rulesets\\?per_page=100$`;
// Token separation is part of the contract: the ruleset reads are mapped ONLY under the minted fleet token (github.token carries no
// administration scope), the PR listing ONLY under github.token. A step wired to the wrong credential finds its call unmapped.
const FLEET = "stub-fleet-token";
const GITHUB = "stub-github-token";
const NATIVE: GhStubRule[] = [
  { match: new RegExp(RULESETS), out: JSON.stringify([nativeRow]), token: FLEET },
  { match: new RegExp(`^api repos/${REPO}/rulesets/99$`), out: JSON.stringify(nativeDetail), token: FLEET },
];
const PLAIN: GhStubRule = { match: new RegExp(RULESETS), out: "[]", token: FLEET };
const OPEN_BOX_PRS: GhStubRule = { match: /^pr list --repo studio-b-ai\/ops-pipeline --state open --label box /, out: "[7]", token: GITHUB };

function run(env: Record<string, string>, rules: GhStubRule[]) {
  const dir = mkdtempSync(join(tmpdir(), "automerge-sweep-"));
  const stub = makeGhStub(dir, rules);
  const scriptPath = join(dir, "list-step.sh");
  writeFileSync(scriptPath, listStep().run!);
  const ghOutput = join(dir, "github-output");
  writeFileSync(ghOutput, "");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
    cwd: ROOT,
    env: {
      PATH: stub.path,
      HOME: process.env.HOME ?? "",
      GH_STUB_LOG: stub.logPath,
      GH_TOKEN: GITHUB,
      NATIVE_GH_TOKEN: FLEET,
      REPO,
      ONLY_PR: "",
      MAX_FANOUT: "20",
      GITHUB_OUTPUT: ghOutput,
      ...env,
    },
    encoding: "utf-8",
  });
  const out = readFileSync(ghOutput, "utf-8");
  return {
    status: r.status,
    log: `${r.stdout}\n${r.stderr}`,
    calls: readFileSync(stub.logPath, "utf-8").split("\n").filter(Boolean),
    prs: out.split("\n").find((l) => l.startsWith("prs=")) ?? null,
  };
}
const listCalls = (calls: string[]) => calls.filter((c) => c.startsWith("pr list "));

describe("automerge-sweep.yml `list` step — native exclusion, run for real", () => {
  it("a NATIVE ops-pipeline enumerates nothing and logs `excluded: native <repo>` — even for a pr_number dispatch (the check precedes the dispatch short-circuit)", () => {
    for (const onlyPr of ["", "5"]) {
      const r = run({ ONLY_PR: onlyPr }, [...NATIVE, OPEN_BOX_PRS]);
      expect(r.status).toBe(0);
      expect(r.log.split("\n")).toContain(`excluded: native ${REPO}`);
      expect(r.prs).toBe("prs=[]");
      expect(listCalls(r.calls)).toEqual([]);
    }
  });

  it("POSITIVE CONTROL (same instrument): a non-native repo still enumerates its box PRs, and a pr_number dispatch still passes through", () => {
    const sweep = run({}, [PLAIN, OPEN_BOX_PRS]);
    expect(sweep.status).toBe(0);
    expect(sweep.log).not.toContain("excluded:");
    expect(sweep.prs).toBe("prs=[7]");
    expect(listCalls(sweep.calls)).toHaveLength(1);
    const dispatch = run({ ONLY_PR: "5" }, [PLAIN, OPEN_BOX_PRS]);
    expect(dispatch.status).toBe(0);
    expect(dispatch.prs).toBe("prs=[5]");
  });

  it("FAIL CLOSED: an unreadable ruleset list enumerates nothing and says so", () => {
    const r = run({}, [{ match: new RegExp(RULESETS), fail: true, token: FLEET }, OPEN_BOX_PRS]);
    expect(r.status).toBe(0);
    expect(r.log.split("\n")).toContain(`excluded: native-check-failed ${REPO} (fail-closed: ruleset read failed)`);
    expect(r.prs).toBe("prs=[]");
    expect(listCalls(r.calls)).toEqual([]);
  });

  it("the scan ITSELF breaking aborts the job non-zero and enumerates nothing", () => {
    const r = run({ NODE_OPTIONS: "--require=/nonexistent/boom.cjs" }, [PLAIN, OPEN_BOX_PRS]);
    expect(r.status).not.toBe(0);
    expect(r.log).toContain("native-exclusion scan failed — refusing to sweep");
    expect(r.prs).toBeNull();
    expect(listCalls(r.calls)).toEqual([]);
  });
});

describe("automerge-sweep.yml — the plumbing the script test cannot see", () => {
  it("the ruleset read uses the minted FLEET token (github.token has no administration scope), and the mint is guarded against an empty token", () => {
    const ss = steps();
    const mint = ss.find((s) => s.id === "mint");
    expect(mint?.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(mint?.with).toMatchObject({ "app-id": "${{ secrets.FLEET_APP_ID }}", "private-key": "${{ secrets.FLEET_APP_PRIVATE_KEY }}" });
    expect(listStep().env?.NATIVE_GH_TOKEN).toBe("${{ steps.mint.outputs.token }}");
    expect(listStep().env?.GH_TOKEN).toBe("${{ github.token }}"); // the listing itself is unchanged
    expect(ss.some((s) => s.if === "steps.mint.outputs.token == ''" && /exit 1/.test(s.run ?? ""))).toBe(true);
    // order: checkout + deps + mint all precede the list step that runs the CLI
    const idx = (pred: (s: Step) => boolean) => ss.findIndex(pred);
    const listIdx = idx((s) => s.id === "list");
    expect(idx((s) => (s.uses ?? "").startsWith("actions/checkout@"))).toBeLessThan(listIdx);
    expect(idx((s) => s.name === "Install deps")).toBeLessThan(listIdx);
    expect(idx((s) => s.id === "mint")).toBeLessThan(listIdx);
  });
});
