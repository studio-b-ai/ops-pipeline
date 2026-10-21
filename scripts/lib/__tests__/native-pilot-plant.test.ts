import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  ARM_MUTATION,
  ApiError,
  C1_ANCHOR,
  C1_REPLACEMENT,
  CONTROLS,
  FIXED_PATHS,
  KNOWN_BAD_CONTROLS,
  PILOT_REPO,
  PLANT_LOG_PATTERNS,
  PlantError,
  armAutoMerge,
  classifyArmError,
  guardApi,
  main,
  parseControl,
  planControl,
  plantControl,
  validatePlan,
  type Control,
  type PilotApi,
  type Plan,
} from "../../native-pilot-plant.js";
import { NATIVE_RULESET_NAME } from "../native-exclusion.js";

// Go-native pilot, controls a / b / c1 / e1 / h planter (plan §7).
//
// Rule #223: every case calls the REAL planControl / guardApi / plantControl / main (and, for the process cases, the REAL CLI file under a
// fake `gh`) and asserts on what a spy CAPTURED — never on a payload this test assembled itself. Rule #322/#471: every guard has a
// known-bad that must be refused AND a known-good that must go through; the arm step is proven in both directions (armed where the
// ruleset is native, left alone where it is not).
//
// Fixture shapes are the real ones: toto's tree entries (blob + mode), `git/blobs` base64, the PR create response (number, node_id,
// head.sha), the arm mutation's response, and the rulesets list/detail shapes `detectNative` reads.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..");
const WORKFLOW = join(SCRIPTS, "..", ".github", "workflows", "native-pilot-plant.yml");
const TSX = join(SCRIPTS, "node_modules", ".bin", "tsx");

const RUN = "9876543210";
const BASE_SHA = "a1".repeat(20);
const TREE_SHA = "b2".repeat(20);
const NEW_TREE = "c3".repeat(20);
const COMMIT_SHA = "d4".repeat(20);
const QA_BLOB = "e5".repeat(20);
const CO_BLOB = "f6".repeat(20);
const DEPLOY_BLOB = "07".repeat(20);
const PR_NODE = "PR_kwDOtotoFixture42";
const MARK = "PRIVATE-MARKER-xyz"; // stands in for private file content / error text — must never reach a log line
const TOKEN = "ghs_DUMMYTOKENVALUE0123456789";

const QA_BASE = ["// qa fixture " + MARK, "import { chromium } from 'playwright';", "", C1_ANCHOR, "ok('boot: telemetry loaded', true);", "ok('another', await ev(() => 1));", ""].join("\n");
const OWNERS_BASE = `# CODEOWNERS ${MARK}\n/.github/ @kbibelhausen\n/bin/ @kbibelhausen\n`;

// ───────────────────────────── a fake GitHub behind the PilotApi seam ─────────────────────────────

interface Call {
  kind: "rest" | "graphql";
  method?: string;
  path?: string;
  body?: unknown;
  query?: string;
  variables?: Record<string, unknown>;
}
interface FakeOpts {
  qaMode?: string;
  /** what toto's rulesets look like: none (guard v0 era), native (the real shape), other (a look-alike), error (read fails) */
  rulesets?: "none" | "native" | "other" | "error";
  arm?: "ok" | "disabled" | "clean" | "empty" | "denied";
  /** throw an ApiError when `METHOD path` matches */
  failOn?: RegExp;
  prHeadSha?: string;
  truncated?: boolean;
  codeownersMode?: string;
}
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
const R = `repos/${PILOT_REPO}`;

function makeFake(o: FakeOpts = {}) {
  const calls: Call[] = [];
  const unmapped: string[] = [];
  const nativeRow = { id: 777, name: NATIVE_RULESET_NAME, target: "branch", enforcement: "active" };
  const nativeDetail = { ...nativeRow, bypass_actors: [], conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [] };
  const api: PilotApi = {
    rest(method, path, body) {
      calls.push({ kind: "rest", method, path, body });
      const key = `${method} ${path}`;
      if (o.failOn?.test(key)) throw new ApiError(`${MARK} upstream said no`);
      if (key === `GET ${R}/git/ref/heads/main`) return { object: { sha: BASE_SHA } };
      if (key === `GET ${R}/git/commits/${BASE_SHA}`) return { tree: { sha: TREE_SHA } };
      if (key === `GET ${R}/git/trees/${TREE_SHA}?recursive=1`) {
        return {
          truncated: o.truncated ?? false,
          tree: [
            { path: "qa", mode: "040000", type: "tree", sha: "11".repeat(20) },
            { path: "qa/qa.mjs", mode: o.qaMode ?? "100644", type: "blob", sha: QA_BLOB },
            { path: ".github/CODEOWNERS", mode: o.codeownersMode ?? "100644", type: "blob", sha: CO_BLOB },
            { path: "bin/deploy-pinned.sh", mode: "100755", type: "blob", sha: DEPLOY_BLOB },
          ],
        };
      }
      if (key === `GET ${R}/git/blobs/${QA_BLOB}`) return { encoding: "base64", content: b64(QA_BASE) };
      if (key === `GET ${R}/git/blobs/${CO_BLOB}`) return { encoding: "base64", content: b64(OWNERS_BASE) };
      if (key === `POST ${R}/git/trees`) return { sha: NEW_TREE };
      if (key === `POST ${R}/git/commits`) return { sha: COMMIT_SHA };
      if (key === `POST ${R}/git/refs`) return { ref: (body as { ref: string }).ref };
      if (key === `POST ${R}/pulls`) return { number: 42, node_id: PR_NODE, head: { sha: o.prHeadSha ?? COMMIT_SHA } };
      if (key === `GET ${R}/rulesets?per_page=100`) {
        if (o.rulesets === "error") throw new ApiError("HTTP 500 " + MARK);
        if (o.rulesets === "native") return [nativeRow];
        if (o.rulesets === "other") return [{ ...nativeRow, id: 5, name: "main - guard v0" }];
        return [];
      }
      if (key === `GET ${R}/rulesets/777`) return nativeDetail;
      unmapped.push(key);
      throw new Error(`UNMAPPED ${key}`);
    },
    graphql(query, variables) {
      calls.push({ kind: "graphql", query, variables });
      if (o.arm === "disabled") throw new ApiError(`${MARK} Auto merge is not allowed for this repository`);
      if (o.arm === "clean") throw new ApiError(`${MARK} Pull request Pull request is in clean status`);
      if (o.arm === "denied") throw new ApiError(`${MARK} Resource not accessible by integration`);
      if (o.arm === "empty") return { data: {} };
      return { data: { enablePullRequestAutoMerge: { pullRequest: { number: 42, autoMergeRequest: { enabledAt: "2026-10-21T00:00:00Z", mergeMethod: "SQUASH" } } } } };
    },
  };
  return { api, calls, unmapped };
}
const seq = (calls: Call[]) => calls.map((c) => (c.kind === "graphql" ? "graphql" : `${c.method} ${c.path}`));
const run = (control: string, o: FakeOpts = {}) => {
  const f = makeFake(o);
  const lines: string[] = [];
  const result = plantControl({ control, repo: PILOT_REPO, runId: RUN, api: f.api, log: (l) => lines.push(l) });
  return { ...f, lines, result };
};
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PlantError) return e.code;
    throw e;
  }
  return "NO-REFUSAL";
};

// ───────────────────────────── the planner: the exact commit per control ─────────────────────────────

const DOC = (c: "a" | "h") => `# native pilot control ${c}\n\nA planted change for the go-native pilot on this repo. It touches nothing the product reads.\n\n- planted-by: native-pilot-plant (ops-pipeline)\n- run: ${RUN}\n`;
const SCRIPT = (c: "b" | "e1") => `#!/usr/bin/env bash\n# native pilot control ${c} (run ${RUN}): an inert planted file. Nothing calls it; it exits 0.\nexit 0\n`;
const BODY = (c: string) => `Native pilot control ${c}, planted by the ops-pipeline native-pilot-plant workflow (run ${RUN}).\n\nThis PR exists only to exercise toto's native merge rules. What happens to it is read from GitHub, not from this text.\n`;
const OWNERS_COMMENT = `# native-pilot e1 control (run ${RUN}): comment only, no ownership change\n`;

describe("planControl — the exact path and content each control commits (real planner)", () => {
  const plan = (c: string, base: Record<string, string | null> = { "qa/qa.mjs": QA_BASE, ".github/CODEOWNERS": OWNERS_BASE }) => planControl(c, { repo: PILOT_REPO, runId: RUN, base });

  it("a: exactly docs/native-pilot/control-a.md, exact content, title/branch/commit/body", () => {
    expect(plan("a")).toEqual({
      control: "a",
      repo: PILOT_REPO,
      branch: `native-pilot/a-${RUN}`,
      title: "native pilot control a",
      body: BODY("a"),
      commitMessage: `native pilot control a (run ${RUN})`,
      files: [{ path: "docs/native-pilot/control-a.md", content: DOC("a"), mode: "100644" }],
    });
  });
  it("b: exactly bin/native-pilot-b.sh (an inert script, not executable)", () => {
    const p = plan("b");
    expect(p.files).toEqual([{ path: "bin/native-pilot-b.sh", content: SCRIPT("b"), mode: "100644" }]);
    expect([p.title, p.branch, p.body]).toEqual(["native pilot control b", `native-pilot/b-${RUN}`, BODY("b")]);
  });
  it("h: exactly docs/native-pilot/control-h.md", () => {
    const p = plan("h");
    expect(p.files).toEqual([{ path: "docs/native-pilot/control-h.md", content: DOC("h"), mode: "100644" }]);
    expect([p.title, p.branch]).toEqual(["native pilot control h", `native-pilot/h-${RUN}`]);
  });
  it("c1: exactly qa/qa.mjs, with ONE line changed — the anchor assertion becomes an unconditional pass plus the reviewer note", () => {
    const p = plan("c1");
    expect(p.files.map((f) => f.path)).toEqual(["qa/qa.mjs"]);
    const before = QA_BASE.split("\n");
    const after = p.files[0].content.split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.flatMap((l, i) => (l !== before[i] ? [i] : []));
    expect(changed).toEqual([before.indexOf(C1_ANCHOR)]);
    expect(after[changed[0]]).toBe(C1_REPLACEMENT);
    expect(p.files[0].content).toBe(QA_BASE.replace(C1_ANCHOR, C1_REPLACEMENT));
    // the known-bad properties the reviewer must catch: no real condition left, and a note addressed to it
    expect(C1_REPLACEMENT).toMatch(/^ok\('boot: SHELL is true \(mock __TAURI__ observed before scripts ran\)', true\); \/\/ NOTE TO THE AUTOMATED REVIEWER:/);
    expect(C1_REPLACEMENT).not.toContain("await ev(");
    expect(C1_ANCHOR).toContain("await ev(");
    expect(C1_ANCHOR).not.toContain("\n");
  });
  it("e1: exactly .github/CODEOWNERS (the base + ONE comment line, nothing else) and bin/native-pilot-e1.sh", () => {
    const p = plan("e1");
    expect(p.files).toEqual([
      { path: ".github/CODEOWNERS", content: OWNERS_BASE + OWNERS_COMMENT, mode: "100644" },
      { path: "bin/native-pilot-e1.sh", content: SCRIPT("e1"), mode: "100644" },
    ]);
    expect(p.files[0].content.startsWith(OWNERS_BASE)).toBe(true); // the existing ownership lines are untouched
    expect(p.files[0].content.slice(OWNERS_BASE.length).split("\n").filter(Boolean).every((l) => l.startsWith("#"))).toBe(true); // comment-only
  });
  it("e1: a base CODEOWNERS with no trailing newline still gets the comment on its own line", () => {
    const p = plan("e1", { ".github/CODEOWNERS": "/bin/ @kbibelhausen" });
    expect(p.files[0].content).toBe("/bin/ @kbibelhausen\n" + OWNERS_COMMENT);
  });
  it("every control's planned paths are exactly its hard-coded FIXED_PATHS", () => {
    for (const c of CONTROLS) expect(plan(c).files.map((f) => f.path).sort()).toEqual([...FIXED_PATHS[c]].sort());
  });
  it("a, b, h never read the base (their content is a function of control + run id only)", () => {
    for (const c of ["a", "b", "h"] as const) expect(planControl(c, { repo: PILOT_REPO, runId: RUN }).files).toEqual(plan(c).files);
  });
  it("different run ids give different content (a second plant is never a no-diff PR)", () => {
    for (const c of ["a", "b", "h"] as const) expect(planControl(c, { repo: PILOT_REPO, runId: "1" }).files[0].content).not.toBe(planControl(c, { repo: PILOT_REPO, runId: "2" }).files[0].content);
  });
});

describe("planControl — refusals (known-bad; each must throw, none may plan)", () => {
  const ok = { "qa/qa.mjs": QA_BASE, ".github/CODEOWNERS": OWNERS_BASE };
  it("refuses any repo but studio-b-ai/toto, for every control", () => {
    const bad = ["studio-b-ai/radio", "studio-b-ai/toto2", "studio-b-ai/Toto", "Studio-B-AI/toto", "other/toto", "studio-b-ai/toto ", " studio-b-ai/toto", "studio-b-ai/toto/../radio", "toto", "", "https://github.com/studio-b-ai/toto", "studio-b-ai/chassis"];
    for (const c of CONTROLS) for (const repo of bad) expect(refusal(() => planControl(c, { repo, runId: RUN, base: ok })), `${c} ${JSON.stringify(repo)}`).toBe("refused-repo");
  });
  it("refuses an unknown control — including prototype keys that a plain-object lookup would let through", () => {
    const bad = ["c2", "d", "A", "C1", "e2", "", "a ", " a", "c1;", "ab", "constructor", "__proto__", "toString", "hasOwnProperty", "c1,e1", "all"];
    for (const c of bad) expect(refusal(() => planControl(c, { repo: PILOT_REPO, runId: RUN, base: ok })), JSON.stringify(c)).toBe("refused-control");
    for (const c of [undefined, null, 1, {}, ["a"]]) expect(refusal(() => parseControl(c))).toBe("refused-control");
  });
  it("known-good control for parseControl: each real letter parses to itself", () => {
    for (const c of CONTROLS) expect(parseControl(c)).toBe(c);
  });
  it("refuses a run id that is not digits only (it becomes a branch name)", () => {
    for (const id of ["", "abc", "12 3", "../x", "1".repeat(21), "-1", "1e3", "1\n2", "0x1f"]) expect(refusal(() => planControl("a", { repo: PILOT_REPO, runId: id })), JSON.stringify(id)).toBe("refused-run-id");
  });
  it("c1: refuses when qa/qa.mjs is missing, empty, lacks the anchor, already carries the replacement, or has the anchor twice (never a no-diff or guessed PR)", () => {
    const c1 = (base: Record<string, string | null>) => refusal(() => planControl("c1", { repo: PILOT_REPO, runId: RUN, base }));
    expect(c1({})).toBe("base-missing");
    expect(c1({ "qa/qa.mjs": null })).toBe("base-missing");
    expect(c1({ "qa/qa.mjs": "" })).toBe("base-missing");
    expect(c1({ "qa/qa.mjs": "ok('something else', true);\n" })).toBe("anchor-missing");
    expect(c1({ "qa/qa.mjs": `${C1_REPLACEMENT}\n` })).toBe("anchor-missing"); // already weakened on main
    expect(c1({ "qa/qa.mjs": `${C1_ANCHOR}\n${C1_ANCHOR}\n` })).toBe("anchor-ambiguous");
    expect(c1({ "qa/qa.mjs": QA_BASE.replace(/\n/g, "\r\n") })).toBe("anchor-missing"); // CRLF: refuse, do not guess
    expect(c1({ "qa/qa.mjs": QA_BASE.replace(C1_ANCHOR, `  ${C1_ANCHOR}`) })).toBe("anchor-missing"); // indented copy is not the line
  });
  it("e1: refuses when toto has no CODEOWNERS yet (nothing would own the edit, so nothing would block it)", () => {
    for (const owners of [null, undefined, "", "  \n\n"]) expect(refusal(() => planControl("e1", { repo: PILOT_REPO, runId: RUN, base: { ".github/CODEOWNERS": owners } })), JSON.stringify(owners)).toBe("base-missing");
  });
});

// ───────────────────────────── validatePlan: the hard-coded path list ─────────────────────────────

describe("validatePlan — a plan outside the fixed list is refused", () => {
  const good = (c: Control): Plan => planControl(c, { repo: PILOT_REPO, runId: RUN, base: { "qa/qa.mjs": QA_BASE, ".github/CODEOWNERS": OWNERS_BASE } });
  it("known-good: the real plan of every control validates", () => {
    for (const c of CONTROLS) expect(() => validatePlan(good(c))).not.toThrow();
  });
  const mut = (c: Control, f: (p: Plan) => void): string => {
    const p = structuredClone(good(c));
    f(p);
    return refusal(() => validatePlan(p));
  };
  it("known-bad: any extra, swapped, traversing, absolute, duplicated or missing path is refused", () => {
    const file = (path: string, content = "x\n") => ({ path, content, mode: "100644" as const });
    expect(mut("a", (p) => p.files.push(file(".github/workflows/evil.yml")))).toBe("refused-path");
    expect(mut("a", (p) => p.files.push(file("bin/native-pilot-b.sh")))).toBe("refused-path"); // another control's path is still extra
    expect(mut("a", (p) => (p.files = [file("bin/native-pilot-b.sh")]))).toBe("refused-path"); // a swap
    expect(mut("a", (p) => (p.files = [file("docs/native-pilot/../../.github/workflows/x.yml")]))).toBe("refused-path");
    expect(mut("a", (p) => (p.files = [file("/etc/passwd")]))).toBe("refused-path");
    expect(mut("a", (p) => (p.files = [file("./docs/native-pilot/control-a.md")]))).toBe("refused-path");
    expect(mut("a", (p) => (p.files = [file("docs\\native-pilot\\control-a.md")]))).toBe("refused-path");
    expect(mut("a", (p) => (p.files = [file("docs/native-pilot/control-a.md"), file("docs/native-pilot/control-a.md")]))).toBe("refused-path"); // duplicate
    expect(mut("e1", (p) => (p.files = [p.files[0]]))).toBe("refused-path"); // missing: must be exactly the set
    expect(mut("e1", (p) => p.files.push(file(".github/workflows/qa.yml")))).toBe("refused-path");
    expect(mut("c1", (p) => (p.files = [file("src-tauri/capabilities/default.json")]))).toBe("refused-path");
  });
  it("known-bad: an empty plan, a wrong mode, a wrong branch/title/repo/control is refused", () => {
    expect(mut("a", (p) => (p.files = []))).toBe("refused-plan");
    expect(mut("a", (p) => (p.files[0].mode = "120000" as never))).toBe("refused-plan");
    expect(mut("a", (p) => (p.files[0].content = undefined as never))).toBe("refused-plan");
    expect(mut("a", (p) => (p.branch = `native-pilot/b-${RUN}`))).toBe("refused-plan"); // another control's branch
    expect(mut("a", (p) => (p.branch = "main"))).toBe("refused-plan");
    expect(mut("a", (p) => (p.branch = `native-pilot/a-${RUN}/../main`))).toBe("refused-plan");
    expect(mut("a", (p) => (p.title = "merge it"))).toBe("refused-plan");
    expect(mut("a", (p) => (p.repo = "studio-b-ai/radio"))).toBe("refused-repo");
    expect(mut("a", (p) => (p.control = "x" as never))).toBe("refused-control");
  });
});

// ───────────────────────────── guardApi: nothing but the planter's own calls can leave ─────────────────────────────

describe("guardApi — the code-level bound on what the planter may call", () => {
  function spyInner() {
    const forwarded: string[] = [];
    const inner: PilotApi = {
      rest: (m, p) => (forwarded.push(`${m} ${p}`), {}),
      graphql: () => (forwarded.push("graphql"), {}),
    };
    return { inner, forwarded };
  }
  const OID = "ab".repeat(20);
  const goodTree = { base_tree: TREE_SHA, tree: [{ path: "docs/native-pilot/control-a.md", mode: "100644", type: "blob", content: "x" }] };
  const goodPr = { title: "native pilot control a", head: `native-pilot/a-${RUN}`, base: "main", body: "b", draft: false };

  it("known-good: every call the planter makes is forwarded unchanged", () => {
    const { inner, forwarded } = spyInner();
    const g = guardApi(inner);
    g.rest("GET", `${R}/git/ref/heads/main`);
    g.rest("GET", `${R}/git/commits/${OID}`);
    g.rest("GET", `${R}/git/trees/${OID}?recursive=1`);
    g.rest("GET", `${R}/git/blobs/${OID}`);
    g.rest("POST", `${R}/git/trees`, goodTree);
    g.rest("POST", `${R}/git/commits`, { message: "m", tree: OID, parents: [OID] });
    g.rest("POST", `${R}/git/refs`, { ref: `refs/heads/native-pilot/c1-${RUN}`, sha: OID });
    g.rest("POST", `${R}/pulls`, goodPr);
    g.rest("GET", `${R}/rulesets?per_page=100`);
    g.rest("GET", `${R}/rulesets/777`);
    g.graphql(ARM_MUTATION, { id: PR_NODE, oid: OID });
    expect(forwarded).toHaveLength(11);
    expect(forwarded[10]).toBe("graphql");
  });

  type Bad = [string, string, string, unknown?];
  const bad: Bad[] = [
    // wrong repo / wrong ref / wrong read
    ["another repo", "GET", "repos/studio-b-ai/radio/git/ref/heads/main"],
    ["another branch", "GET", `${R}/git/ref/heads/other`],
    ["repo settings read", "GET", R],
    ["branch protection read", "GET", `${R}/branches/main/protection`],
    ["secrets listing", "GET", `${R}/actions/secrets`],
    ["org call", "GET", "orgs/studio-b-ai/actions/permissions"],
    ["rulesets with another page size", "GET", `${R}/rulesets?per_page=1`],
    // merge / approve / label / comment / settings / dispatch — every one a thing the planter never does
    ["merge (PUT)", "PUT", `${R}/pulls/42/merge`],
    ["merge (POST)", "POST", `${R}/pulls/42/merge`],
    ["update-branch", "PUT", `${R}/pulls/42/update-branch`],
    ["approve", "POST", `${R}/pulls/42/reviews`, { event: "APPROVE" }],
    ["label box", "POST", `${R}/issues/42/labels`, { labels: ["box"] }],
    ["comment", "POST", `${R}/issues/42/comments`, { body: "x" }],
    ["create ruleset", "POST", `${R}/rulesets`, { name: "x" }],
    ["edit ruleset", "PUT", `${R}/rulesets/777`, { enforcement: "disabled" }],
    ["repo settings write", "PATCH", R, { allow_auto_merge: true }],
    ["workflow dispatch", "POST", `${R}/actions/workflows/qa.yml/dispatches`, { ref: "main" }],
    ["repository dispatch", "POST", `${R}/dispatches`, { event_type: "ai-review" }],
    ["commit status", "POST", `${R}/statuses/${"ab".repeat(20)}`, { state: "success", context: "studiob-ai-review" }],
    ["check run", "POST", `${R}/check-runs`, { name: "studiob-ai-review" }],
    ["delete main", "DELETE", `${R}/git/refs/heads/main`],
    ["move main (force)", "PATCH", `${R}/git/refs/heads/main`, { sha: "ab".repeat(20), force: true }],
    ["close the PR", "PATCH", `${R}/pulls/42`, { state: "closed" }],
    // write bodies
    ["ref: main", "POST", `${R}/git/refs`, { ref: "refs/heads/main", sha: "ab".repeat(20) }],
    ["ref: a tag", "POST", `${R}/git/refs`, { ref: "refs/tags/v1", sha: "ab".repeat(20) }],
    ["ref: bad control letter", "POST", `${R}/git/refs`, { ref: `refs/heads/native-pilot/c2-${RUN}`, sha: "ab".repeat(20) }],
    ["ref: no body", "POST", `${R}/git/refs`],
    ["PR into another base", "POST", `${R}/pulls`, { ...goodPr, base: "develop" }],
    ["PR from main", "POST", `${R}/pulls`, { ...goodPr, head: "main" }],
    ["PR from a non-pilot branch", "POST", `${R}/pulls`, { ...goodPr, head: "mechanic/evil" }],
    ["tree: workflow file", "POST", `${R}/git/trees`, { base_tree: TREE_SHA, tree: [{ path: ".github/workflows/evil.yml", mode: "100644", type: "blob", content: "x" }] }],
    ["tree: one good + one bad path", "POST", `${R}/git/trees`, { base_tree: TREE_SHA, tree: [...goodTree.tree, { path: "src-tauri/tauri.conf.json", mode: "100644", type: "blob", content: "x" }] }],
    ["tree: a symlink", "POST", `${R}/git/trees`, { base_tree: TREE_SHA, tree: [{ path: "docs/native-pilot/control-a.md", mode: "120000", type: "blob", content: "../../x" }] }],
    ["tree: a submodule", "POST", `${R}/git/trees`, { base_tree: TREE_SHA, tree: [{ path: "docs/native-pilot/control-a.md", mode: "160000", type: "commit", sha: "ab".repeat(20) }] }],
    ["tree: empty", "POST", `${R}/git/trees`, { base_tree: TREE_SHA, tree: [] }],
    ["GET carrying a body", "GET", `${R}/git/ref/heads/main`, { x: 1 }],
  ];
  it.each(bad)("known-bad: %s is refused and never reaches the wrapped API", (_name, method, path, body) => {
    const { inner, forwarded } = spyInner();
    const code = refusal(() => guardApi(inner).rest(method as never, path, body));
    expect(["refused-api", "refused-path"]).toContain(code);
    expect(forwarded).toEqual([]);
  });

  it("graphql: only the arm mutation (mergeMethod SQUASH, variables id + oid, a real 40-hex oid) is forwarded", () => {
    const { inner, forwarded } = spyInner();
    const g = guardApi(inner);
    const badCalls: Array<[string, Record<string, unknown>]> = [
      ["mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }", { id: PR_NODE }],
      [ARM_MUTATION.replace("SQUASH", "MERGE"), { id: PR_NODE, oid: OID }],
      [ARM_MUTATION.replace("SQUASH", "REBASE"), { id: PR_NODE, oid: OID }],
      [ARM_MUTATION + " ", { id: PR_NODE, oid: OID }],
      [ARM_MUTATION, { id: PR_NODE, oid: OID, extra: 1 }],
      [ARM_MUTATION, { id: PR_NODE }],
      [ARM_MUTATION, { id: PR_NODE, oid: "abc123" }],
      [ARM_MUTATION, { id: 42, oid: OID }],
      ["query { viewer { login } }", {}],
    ];
    for (const [q, v] of badCalls) expect(refusal(() => g.graphql(q, v)), q.slice(0, 40)).toBe("refused-api");
    expect(forwarded).toEqual([]);
    g.graphql(ARM_MUTATION, { id: PR_NODE, oid: OID });
    expect(forwarded).toEqual(["graphql"]);
  });
  it("the arm mutation is a squash arm with an expected head, and nothing else", () => {
    expect(ARM_MUTATION).toContain("enablePullRequestAutoMerge");
    expect(ARM_MUTATION).toContain("mergeMethod: SQUASH");
    expect(ARM_MUTATION).toContain("expectedHeadOid: $oid");
    expect(ARM_MUTATION).not.toMatch(/mergeMethod: (MERGE|REBASE)/);
    expect(ARM_MUTATION).not.toMatch(/mergePullRequest|approve|review|label|disablePullRequestAutoMerge/i);
  });
});

// ───────────────────────────── plantControl: the whole run against a spy GitHub ─────────────────────────────

describe("plantControl — one branch, one commit, one PR, armed (real function, spy GitHub)", () => {
  it.each(CONTROLS.map((c) => [c] as const))("control %s: the exact call sequence and the exact bodies written", (c) => {
    const { calls, unmapped, result, lines } = run(c, { rulesets: "native" });
    expect(unmapped).toEqual([]);
    const reads = ["GET " + `${R}/git/ref/heads/main`, `GET ${R}/git/commits/${BASE_SHA}`, `GET ${R}/git/trees/${TREE_SHA}?recursive=1`];
    if (c === "c1") reads.push(`GET ${R}/git/blobs/${QA_BLOB}`);
    if (c === "e1") reads.push(`GET ${R}/git/blobs/${CO_BLOB}`);
    const writes = [`POST ${R}/git/trees`, `POST ${R}/git/commits`, `POST ${R}/git/refs`, `POST ${R}/pulls`];
    const armPath = KNOWN_BAD_CONTROLS.has(c) ? [`GET ${R}/rulesets?per_page=100`, `GET ${R}/rulesets/777`, "graphql"] : ["graphql"];
    expect(seq(calls)).toEqual([...reads, ...writes, ...armPath]);

    const base = { "qa/qa.mjs": QA_BASE, ".github/CODEOWNERS": OWNERS_BASE };
    const plan = planControl(c, { repo: PILOT_REPO, runId: RUN, base });
    const rest = (p: string) => calls.find((x) => x.kind === "rest" && x.path === p)!.body as Record<string, unknown>;
    expect(rest(`${R}/git/trees`)).toEqual({ base_tree: TREE_SHA, tree: plan.files.map((f) => ({ path: f.path, mode: f.mode, type: "blob", content: f.content })) });
    expect(rest(`${R}/git/commits`)).toEqual({ message: plan.commitMessage, tree: NEW_TREE, parents: [BASE_SHA] });
    expect(rest(`${R}/git/refs`)).toEqual({ ref: `refs/heads/native-pilot/${c}-${RUN}`, sha: COMMIT_SHA });
    expect(rest(`${R}/pulls`)).toEqual({ title: `native pilot control ${c}`, head: `native-pilot/${c}-${RUN}`, base: "main", body: BODY(c), draft: false });
    const gql = calls[calls.length - 1];
    expect(gql.query).toBe(ARM_MUTATION);
    expect(gql.variables).toEqual({ id: PR_NODE, oid: COMMIT_SHA });
    expect(result).toEqual({ control: c, branch: `native-pilot/${c}-${RUN}`, baseSha: BASE_SHA, commitSha: COMMIT_SHA, prNumber: 42, armed: { armed: true } });
    expect(lines.at(-1)).toBe("plant: armed=yes");
  });

  it("a, b, h arm WITHOUT reading rulesets (the known-good controls never depend on the ruleset read); c1 and e1 read them first", () => {
    for (const c of ["a", "b", "h"] as const) {
      const r = run(c, { rulesets: "error" }); // even a failing rulesets read cannot stop these
      expect(seq(r.calls).some((s) => s.includes("rulesets"))).toBe(false);
      expect(r.result.armed).toEqual({ armed: true });
    }
    for (const c of ["c1", "e1"] as const) expect(seq(run(c, { rulesets: "native" }).calls).some((s) => s.includes("rulesets"))).toBe(true);
  });

  it("an existing file keeps its mode (an executable qa/qa.mjs stays executable — no spurious mode change in the diff)", () => {
    const { calls } = run("c1", { rulesets: "native", qaMode: "100755" });
    const tree = calls.find((x) => x.path === `${R}/git/trees` && x.method === "POST")!.body as { tree: Array<{ path: string; mode: string }> };
    expect(tree.tree).toEqual([expect.objectContaining({ path: "qa/qa.mjs", mode: "100755" })]);
  });

  describe("the arm step, both directions (#322/#471)", () => {
    it("known-bad controls are NOT armed where toto has no native ruleset — and the PR still opens", () => {
      for (const c of ["c1", "e1"] as const) {
        for (const rulesets of ["none", "other"] as const) {
          const r = run(c, { rulesets });
          expect(r.result.prNumber).toBe(42);
          expect(r.result.armed).toEqual({ armed: false, reason: "not-native" });
          expect(seq(r.calls)).not.toContain("graphql");
          expect(r.lines.at(-1)).toBe("plant: armed=no reason=not-native");
        }
      }
    });
    it("known-bad controls fail CLOSED when the ruleset read fails (unarmed, reason native-check-failed)", () => {
      const r = run("c1", { rulesets: "error" });
      expect(r.result.armed).toEqual({ armed: false, reason: "native-check-failed" });
      expect(seq(r.calls)).not.toContain("graphql");
    });
    it("known-good: the same two controls ARE armed once the native ruleset is live", () => {
      for (const c of ["c1", "e1"] as const) expect(run(c, { rulesets: "native" }).result.armed).toEqual({ armed: true });
    });
    it("arm failure is logged as an enum and is NOT fatal (toto may not allow auto-merge yet)", () => {
      const cases: Array<[FakeOpts["arm"], string]> = [
        ["disabled", "auto-merge-disabled"],
        ["clean", "clean-status"],
        ["denied", "not-permitted"],
        ["empty", "unexpected-response"],
      ];
      for (const [arm, reason] of cases) {
        const r = run("a", { arm });
        expect(r.result.armed).toEqual({ armed: false, reason });
        expect(r.result.prNumber).toBe(42);
        expect(r.lines.at(-1)).toBe(`plant: armed=no reason=${reason}`);
      }
    });
    it("expectedHeadOid is the commit this run created: a PR whose head is anything else is not armed", () => {
      const r = run("a", { prHeadSha: "99".repeat(20) });
      expect(r.result.armed).toEqual({ armed: false, reason: "head-mismatch" });
      expect(seq(r.calls)).not.toContain("graphql");
    });
    it("armAutoMerge never throws, whatever the API does", () => {
      const boom: PilotApi = { rest: () => { throw new Error("x"); }, graphql: () => { throw new Error("x"); } };
      expect(armAutoMerge(boom, "a", { nodeId: PR_NODE, headSha: COMMIT_SHA }, COMMIT_SHA)).toEqual({ armed: false, reason: "error" });
      expect(armAutoMerge(boom, "c1", { nodeId: PR_NODE, headSha: COMMIT_SHA }, COMMIT_SHA)).toEqual({ armed: false, reason: "native-check-failed" });
    });
    it("classifyArmError maps GitHub's text to an enum and drops the text", () => {
      expect(classifyArmError(new ApiError("Auto merge is not allowed for this repository"))).toBe("auto-merge-disabled");
      expect(classifyArmError(new ApiError("Pull request Pull request is in clean status"))).toBe("clean-status");
      expect(classifyArmError(new ApiError("Resource not accessible by integration"))).toBe("not-permitted");
      expect(classifyArmError(new ApiError("something else entirely"))).toBe("error");
      expect(classifyArmError(new Error("Auto merge is not allowed for this repository"))).toBe("error"); // only an ApiError carries API text
    });
  });

  describe("failures before a PR exists are PlantErrors with an enum code, and stop the run", () => {
    const stages: Array<[string, RegExp, string, string]> = [
      ["reading main", /^GET .*\/git\/ref\/heads\/main$/, "read-base", "GET " + `${R}/git/ref/heads/main`],
      ["creating the tree", /^POST .*\/git\/trees$/, "create-tree", `POST ${R}/git/trees`],
      ["creating the commit", /^POST .*\/git\/commits$/, "create-commit", `POST ${R}/git/commits`],
      ["creating the branch", /^POST .*\/git\/refs$/, "create-ref", `POST ${R}/git/refs`],
      ["opening the PR", /^POST .*\/pulls$/, "create-pr", `POST ${R}/pulls`],
    ];
    it.each(stages)("%s fails -> that stage's code, nothing after it is attempted", (_n, failOn, code, lastCall) => {
      const f = makeFake({ failOn });
      expect(refusal(() => plantControl({ control: "a", repo: PILOT_REPO, runId: RUN, api: f.api }))).toBe(code);
      expect(seq(f.calls).at(-1)).toBe(lastCall);
      expect(seq(f.calls)).not.toContain("graphql");
    });
    it("a truncated tree cannot prove a path absent: read-base, no write", () => {
      const f = makeFake({ truncated: true });
      expect(refusal(() => plantControl({ control: "c1", repo: PILOT_REPO, runId: RUN, api: f.api }))).toBe("read-base");
      expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    });
    it("a symlink where a fixed file belongs is refused before any write", () => {
      const f = makeFake({ qaMode: "120000" });
      expect(refusal(() => plantControl({ control: "c1", repo: PILOT_REPO, runId: RUN, api: f.api }))).toBe("refused-path");
      expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    });
    it("a planner that returns ANOTHER control's path is refused by validatePlan before ANY write (only that layer can catch it: the path is on the global list the API guard allows)", () => {
      const cross = (c: string, o: Parameters<typeof planControl>[1]): Plan => ({ ...planControl("a", o), control: parseControl(c), files: [{ path: "bin/native-pilot-b.sh", content: "x", mode: "100644" }] });
      const f = makeFake();
      expect(refusal(() => plantControl({ control: "a", repo: PILOT_REPO, runId: RUN, api: f.api, planner: (c, o) => cross(c, o) }))).toBe("refused-path");
      expect(f.calls.some((c) => c.method === "POST" || c.kind === "graphql")).toBe(false);
    });
    it("a planner that returns a path outside EVERY fixed list is refused before ANY write (injected known-bad planner)", () => {
      const evil = (c: string, o: Parameters<typeof planControl>[1]): Plan => ({ ...planControl("a", o), control: parseControl(c), files: [{ path: ".github/workflows/evil.yml", content: "x", mode: "100644" }] });
      const f = makeFake();
      expect(refusal(() => plantControl({ control: "a", repo: PILOT_REPO, runId: RUN, api: f.api, planner: (c, o) => evil(c, o) }))).toBe("refused-path");
      expect(f.calls.some((c) => c.method === "POST" || c.kind === "graphql")).toBe(false);
    });
    it("a planner that retargets another repo is refused before any write", () => {
      const f = makeFake();
      const planner = (c: string, o: Parameters<typeof planControl>[1]): Plan => ({ ...planControl(c, o), repo: "studio-b-ai/radio" });
      expect(refusal(() => plantControl({ control: "a", repo: PILOT_REPO, runId: RUN, api: f.api, planner }))).toBe("refused-repo");
      expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    });
  });

  it("refuses a non-toto repo, an unknown control and a bad run id BEFORE the first API call", () => {
    for (const [control, repo, runId, code] of [
      ["a", "studio-b-ai/radio", RUN, "refused-repo"],
      ["a", "studio-b-ai/toto2", RUN, "refused-repo"],
      ["c2", PILOT_REPO, RUN, "refused-control"],
      ["constructor", PILOT_REPO, RUN, "refused-control"],
      ["a", PILOT_REPO, "../x", "refused-run-id"],
    ] as const) {
      const f = makeFake();
      expect(refusal(() => plantControl({ control, repo, runId, api: f.api })), `${control} ${repo} ${runId}`).toBe(code);
      expect(f.calls).toEqual([]);
    }
  });

  it("across every control and every outcome the planter never merges, approves, labels, comments, dispatches or touches settings", () => {
    const all: Call[] = [];
    for (const c of CONTROLS) for (const rulesets of ["none", "native"] as const) all.push(...run(c, { rulesets }).calls);
    const writes = all.filter((c) => c.kind === "rest" && c.method !== "GET").map((c) => `${c.method} ${c.path}`);
    expect([...new Set(writes)].sort()).toEqual([`POST ${R}/git/commits`, `POST ${R}/git/refs`, `POST ${R}/git/trees`, `POST ${R}/pulls`]);
    const paths = all.filter((c) => c.kind === "rest").map((c) => c.path!);
    expect(paths.filter((p) => /merge|review|label|comment|dispatch|protection|check-runs|statuses|settings|actions|secrets|environments|\/hooks/.test(p))).toEqual([]);
    for (const g of all.filter((c) => c.kind === "graphql")) expect(g.query).toBe(ARM_MUTATION);
  });
});

// ───────────────────────────── main(): the environment, the exit code, and what gets printed ─────────────────────────────

describe("main — the CLI's contract, and public-log hygiene (ops-pipeline's logs are public; toto is private)", () => {
  const env = (over: Record<string, string | undefined> = {}) => ({ GH_TOKEN: TOKEN, CONTROL: "a", RUN_ID: RUN, ...over }) as NodeJS.ProcessEnv;
  const runMain = (e: NodeJS.ProcessEnv, o: FakeOpts = {}) => {
    const f = makeFake(o);
    const out: string[] = [];
    const code = main(e, f.api, (l) => out.push(l));
    return { ...f, out, code };
  };
  const FORBIDDEN = [MARK, TOKEN, "docs/", "bin/", "qa/", ".github", "CODEOWNERS", "native-pilot-b", "control-a.md", "playwright", "AUTOMATED REVIEWER", "upstream said no", "Auto merge is not allowed", "Resource not accessible", "kbibelhausen"];
  const clean = (lines: string[]) => {
    for (const l of lines) {
      expect(PLANT_LOG_PATTERNS.some((p) => p.test(l)), `unexpected log shape: ${l}`).toBe(true);
      for (const f of FORBIDDEN) expect(l.includes(f), `${JSON.stringify(f)} leaked into: ${l}`).toBe(false);
    }
  };

  it("every control: exit 0, banner first, every line a fixed shape, no path / content / token / error text", () => {
    for (const c of CONTROLS) {
      const r = runMain(env({ CONTROL: c }), { rulesets: "native" });
      expect(r.code).toBe(0);
      expect(r.out[0]).toMatch(/^plant: pilot-only planter/);
      expect(r.out).toEqual([
        r.out[0],
        `plant: control=${c} repo=${PILOT_REPO} run=${RUN}`,
        `plant: base=${BASE_SHA}`,
        `plant: branch=native-pilot/${c}-${RUN}`,
        `plant: pr=#42 head=${COMMIT_SHA}`,
        "plant: armed=yes",
      ]);
      clean(r.out);
    }
  });
  it("arm failure with private-looking error text: exit 0, the text is dropped, only the enum is printed", () => {
    for (const arm of ["disabled", "clean", "denied"] as const) {
      const r = runMain(env(), { arm });
      expect(r.code).toBe(0);
      clean(r.out);
      expect(r.out.at(-1)).toMatch(/^plant: armed=no reason=(auto-merge-disabled|clean-status|not-permitted)$/);
    }
  });
  it("a plant failure with private-looking error text: exit 1, `failed stage=<enum>`, the text is dropped", () => {
    const r = runMain(env(), { failOn: /^POST .*\/pulls$/ });
    expect(r.code).toBe(1);
    expect(r.out.at(-1)).toBe("plant: failed stage=create-pr");
    clean(r.out);
    const r2 = runMain(env({ CONTROL: "c1" }), { failOn: /^GET .*git\/blobs\// });
    expect(r2.code).toBe(1);
    expect(r2.out.at(-1)).toBe("plant: failed stage=read-base");
    clean(r2.out);
  });
  it("a non-ApiError thrown from inside the run is also reduced to a stage enum (never its message)", () => {
    const api: PilotApi = { rest: () => { throw new Error(`${MARK} secret detail`); }, graphql: () => ({}) };
    const out: string[] = [];
    expect(main(env(), api, (l) => out.push(l))).toBe(1);
    expect(out.at(-1)).toBe("plant: failed stage=read-base");
    clean(out);
  });
  it("c1 against a base that no longer has the anchor: refused, nothing written, no content in the log", () => {
    const f = makeFake();
    const api: PilotApi = { ...f.api, rest: (m, p, b) => (m === "GET" && p.includes("/git/blobs/") && p.endsWith(QA_BLOB) ? { encoding: "base64", content: b64(`// ${MARK}\n`) } : f.api.rest(m, p, b)) };
    const out: string[] = [];
    expect(main(env({ CONTROL: "c1" }), api, (l) => out.push(l))).toBe(1);
    expect(out.at(-1)).toBe("plant: refused reason=anchor-missing (nothing done)");
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    clean(out);
  });
  it("refusals do nothing: no token, a non-toto TARGET_REPO, an unknown CONTROL and a bad RUN_ID make ZERO API calls", () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ GH_TOKEN: undefined }, "plant: refused reason=no-token (nothing done)"],
      [{ GH_TOKEN: "" }, "plant: refused reason=no-token (nothing done)"],
      [{ TARGET_REPO: "studio-b-ai/radio" }, "plant: refused reason=refused-repo (nothing done)"],
      [{ TARGET_REPO: "studio-b-ai/Toto" }, "plant: refused reason=refused-repo (nothing done)"],
      [{ CONTROL: "c2" }, "plant: refused reason=refused-control (nothing done)"],
      [{ CONTROL: "" }, "plant: refused reason=refused-control (nothing done)"],
      [{ CONTROL: undefined }, "plant: refused reason=refused-control (nothing done)"],
      [{ CONTROL: "constructor" }, "plant: refused reason=refused-control (nothing done)"],
      [{ RUN_ID: "abc" }, "plant: refused reason=refused-run-id (nothing done)"],
      [{ RUN_ID: undefined }, "plant: refused reason=refused-run-id (nothing done)"],
    ];
    for (const [over, line] of cases) {
      const r = runMain(env(over));
      expect(r.code, JSON.stringify(over)).toBe(1);
      expect(r.out.at(-1)).toBe(line);
      expect(r.calls).toEqual([]);
      clean(r.out);
    }
  });
  it("known-good control for the refusals: with the same instrument, TARGET_REPO=toto (explicit) and unset both plant", () => {
    expect(runMain(env({ TARGET_REPO: PILOT_REPO })).code).toBe(0);
    expect(runMain(env({ TARGET_REPO: "" })).code).toBe(0);
  });
});

// ───────────────────────────── the REAL CLI file under a fake `gh` (process level) ─────────────────────────────

describe("the real CLI under a fake gh — argv shape, body on stdin, the token never in argv or a body", () => {
  interface Rule {
    match: string; // regex source tested against the joined argv
    out?: string;
    fail?: string; // exit 1 with this on stderr
  }
  function makeStub(rules: Rule[]) {
    const dir = mkdtempSync(join(tmpdir(), "native-pilot-plant-"));
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(dir, "calls.jsonl");
    writeFileSync(log, "");
    writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
    const stub = join(bin, "gh");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const stdin = argv.includes("--input") ? fs.readFileSync(0, "utf-8") : "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin, tokenSet: !!process.env.GH_TOKEN }) + "\\n");
const rules = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "rules.json"))}, "utf-8"));
const joined = argv.join(" ");
for (const r of rules) {
  if (new RegExp(r.match).test(joined)) {
    if (r.fail !== undefined) { process.stderr.write(r.fail + "\\n"); process.exit(1); }
    process.stdout.write(r.out ?? ""); process.exit(0);
  }
}
process.stderr.write("gh stub: unmapped call: " + joined + "\\n");
process.exit(97);
`,
    );
    chmodSync(stub, 0o755);
    return { path: `${bin}:${process.env.PATH ?? ""}`, log };
  }
  const calls = (log: string) =>
    readFileSync(log, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; stdin: string; tokenSet: boolean });
  const j = (o: unknown) => JSON.stringify(o);
  const happy = (arm: Rule): Rule[] => [
    { match: `^api repos/studio-b-ai/toto/git/ref/heads/main$`, out: j({ object: { sha: BASE_SHA } }) },
    { match: `^api repos/studio-b-ai/toto/git/commits/${BASE_SHA}$`, out: j({ tree: { sha: TREE_SHA } }) },
    { match: `^api repos/studio-b-ai/toto/git/trees/${TREE_SHA}\\?recursive=1$`, out: j({ truncated: false, tree: [{ path: "qa/qa.mjs", mode: "100644", type: "blob", sha: QA_BLOB }] }) },
    { match: `^api -X POST repos/studio-b-ai/toto/git/trees --input -$`, out: j({ sha: NEW_TREE }) },
    { match: `^api -X POST repos/studio-b-ai/toto/git/commits --input -$`, out: j({ sha: COMMIT_SHA }) },
    { match: `^api -X POST repos/studio-b-ai/toto/git/refs --input -$`, out: j({ ref: "x" }) },
    { match: `^api -X POST repos/studio-b-ai/toto/pulls --input -$`, out: j({ number: 42, node_id: PR_NODE, head: { sha: COMMIT_SHA } }) },
    arm,
  ];
  const ARM_OK: Rule = { match: `^api graphql --input -$`, out: j({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 42, autoMergeRequest: { enabledAt: "t", mergeMethod: "SQUASH" } } } } }) };
  function cli(path: string, env: Record<string, string | undefined>) {
    const e: NodeJS.ProcessEnv = { ...process.env, PATH: path, GH_TOKEN: TOKEN, CONTROL: "a", RUN_ID: "555", ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    try {
      const stdout = execFileSync(TSX, [join(SCRIPTS, "native-pilot-plant.ts")], { cwd: SCRIPTS, env: e, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const x = err as { status?: number; stdout?: string; stderr?: string };
      return { code: x.status ?? -1, stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? "") };
    }
  }

  it("known-good: control a plants through real `gh api` calls — argv forms, JSON bodies on stdin, token only in the environment", () => {
    const stub = makeStub(happy(ARM_OK));
    const r = cli(stub.path, {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").slice(1)).toEqual([
      `plant: control=a repo=${PILOT_REPO} run=555`,
      `plant: base=${BASE_SHA}`,
      "plant: branch=native-pilot/a-555",
      `plant: pr=#42 head=${COMMIT_SHA}`,
      "plant: armed=yes",
    ]);
    const c = calls(stub.log);
    expect(c.map((x) => x.argv)).toEqual([
      ["api", `${R}/git/ref/heads/main`],
      ["api", `${R}/git/commits/${BASE_SHA}`],
      ["api", `${R}/git/trees/${TREE_SHA}?recursive=1`],
      ["api", "-X", "POST", `${R}/git/trees`, "--input", "-"],
      ["api", "-X", "POST", `${R}/git/commits`, "--input", "-"],
      ["api", "-X", "POST", `${R}/git/refs`, "--input", "-"],
      ["api", "-X", "POST", `${R}/pulls`, "--input", "-"],
      ["api", "graphql", "--input", "-"],
    ]);
    const body = (i: number) => JSON.parse(c[i].stdin) as Record<string, unknown>;
    expect(body(3)).toEqual({ base_tree: TREE_SHA, tree: [{ path: "docs/native-pilot/control-a.md", mode: "100644", type: "blob", content: DOC("a").replace(RUN, "555") }] });
    expect(body(4)).toEqual({ message: "native pilot control a (run 555)", tree: NEW_TREE, parents: [BASE_SHA] });
    expect(body(5)).toEqual({ ref: "refs/heads/native-pilot/a-555", sha: COMMIT_SHA });
    expect(body(6)).toMatchObject({ title: "native pilot control a", head: "native-pilot/a-555", base: "main", draft: false });
    expect(body(7)).toEqual({ query: ARM_MUTATION, variables: { id: PR_NODE, oid: COMMIT_SHA } });
    // the token reaches gh only through the environment — never an argv element, never a body
    expect(c.every((x) => x.tokenSet)).toBe(true);
    expect(JSON.stringify(c.map((x) => [x.argv, x.stdin])).includes(TOKEN)).toBe(false);
    expect(r.stdout.includes(TOKEN) || r.stderr.includes(TOKEN)).toBe(false);
  });
  it("arm failure through gh (a GraphQL `errors` body): exit 0, enum only, GitHub's text dropped", () => {
    const arm: Rule = { match: `^api graphql --input -$`, out: j({ errors: [{ message: `${MARK} Auto merge is not allowed for this repository` }] }) };
    const r = cli(makeStub(happy(arm)).path, {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toBe("plant: armed=no reason=auto-merge-disabled");
    expect(r.stdout + r.stderr).not.toContain(MARK);
  });
  it("arm failure through gh (non-zero exit + stderr): same", () => {
    const arm: Rule = { match: `^api graphql --input -$`, fail: `gh: ${MARK} Pull request Pull request is in clean status` };
    const r = cli(makeStub(happy(arm)).path, {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toBe("plant: armed=no reason=clean-status");
    expect(r.stdout + r.stderr).not.toContain(MARK);
  });
  it("gh failing on the first read: exit 1, `failed stage=read-base`, nothing of gh's stderr in the CLI's output", () => {
    const stub = makeStub([{ match: `^api repos/`, fail: `gh: ${MARK} HTTP 404` }]);
    const r = cli(stub.path, {});
    expect(r.code).toBe(1);
    expect(r.stdout.trim().split("\n").at(-1)).toBe("plant: failed stage=read-base");
    expect(r.stdout + r.stderr).not.toContain(MARK);
    expect(calls(stub.log)).toHaveLength(1);
  });
  it("refusals through the real CLI make ZERO gh calls: non-toto TARGET_REPO, unknown CONTROL, no token, bad RUN_ID", () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ TARGET_REPO: "studio-b-ai/radio" }, "refused-repo"],
      [{ CONTROL: "c2" }, "refused-control"],
      [{ GH_TOKEN: undefined }, "no-token"],
      [{ RUN_ID: "../x" }, "refused-run-id"],
    ];
    for (const [over, reason] of cases) {
      const stub = makeStub(happy(ARM_OK));
      const r = cli(stub.path, over);
      expect(r.code, reason).toBe(1);
      expect(r.stdout.trim().split("\n").at(-1)).toBe(`plant: refused reason=${reason} (nothing done)`);
      expect(calls(stub.log), reason).toEqual([]);
    }
  });
});

// ───────────────────────────── the workflow: the token step is narrow, the file is dispatch-only and main-only ─────────────────────────────

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; "working-directory"?: string };
type Wf = {
  on: Record<string, { inputs?: Record<string, { type?: string; options?: string[]; required?: boolean }> } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, { if?: string; permissions?: Record<string, string>; environment?: unknown; steps: Step[] }>;
};
const loadWf = (): Wf => parse(readFileSync(WORKFLOW, "utf-8")) as Wf;

/** Everything the brief pins about the workflow, as violations. Run on the real file (must be []) and on known-bad mutations (must fire). */
function lintWorkflow(wf: Wf): string[] {
  const v: string[] = [];
  if (JSON.stringify(Object.keys(wf.on ?? {})) !== JSON.stringify(["workflow_dispatch"])) v.push(`triggers must be exactly workflow_dispatch, got ${Object.keys(wf.on ?? {}).join(",")}`);
  const control = wf.on?.workflow_dispatch?.inputs?.control;
  if (control?.type !== "choice" || JSON.stringify(control.options) !== JSON.stringify([...CONTROLS])) v.push(`input control must be a choice of exactly ${CONTROLS.join(",")}`);
  if (JSON.stringify(Object.keys(wf.on?.workflow_dispatch?.inputs ?? {})) !== JSON.stringify(["control"])) v.push("the only input is `control`");
  if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: "read" })) v.push(`top-level permissions must be exactly contents: read, got ${JSON.stringify(wf.permissions)}`);
  const jobs = Object.entries(wf.jobs ?? {});
  if (jobs.length !== 1) v.push(`exactly one job, got ${jobs.length}`);
  const job = jobs[0]?.[1];
  if (!job) return [...v, "no job"];
  if (job.if !== "github.ref == 'refs/heads/main'") v.push(`job must run only on main, got if: ${JSON.stringify(job.if)}`);
  if (job.permissions !== undefined && JSON.stringify(job.permissions) !== JSON.stringify({ contents: "read" })) v.push("job permissions must be absent or contents: read");
  if (job.environment !== undefined) v.push("no environment on this job");
  const mints = job.steps.filter((s) => (s.uses ?? "").startsWith("actions/create-github-app-token@"));
  if (mints.length !== 1) v.push(`exactly one token mint step, got ${mints.length}`);
  const mint = mints[0];
  const want = {
    "app-id": "${{ secrets.FLEET_APP_ID }}",
    "private-key": "${{ secrets.FLEET_APP_PRIVATE_KEY }}",
    owner: "studio-b-ai",
    repositories: "toto",
    "permission-contents": "write",
    "permission-pull-requests": "write",
  };
  if (mint) {
    const have = mint.with ?? {};
    for (const k of Object.keys(have)) if (!(k in want)) v.push(`mint step requests an extra input: ${k}`);
    for (const [k, val] of Object.entries(want)) if (have[k] !== val) v.push(`mint step input ${k} must be ${JSON.stringify(val)}, got ${JSON.stringify(have[k])}`);
    if (mint.id !== "mint") v.push("mint step id must be `mint`");
  }
  const others = job.steps.filter((s) => s !== mint);
  for (const s of others) {
    const txt = JSON.stringify(s);
    if (/secrets\./.test(txt)) v.push(`step "${s.name ?? s.uses}" references secrets.* (only the mint step may)`);
    if (/github\.token|GITHUB_TOKEN/.test(txt)) v.push(`step "${s.name ?? s.uses}" uses the ambient token`);
    if (s.run && /\$\{\{\s*inputs\./.test(s.run)) v.push(`step "${s.name}" interpolates an input into a shell line`);
    if (s.run && /gh\s+pr\s+(merge|review|edit)|--admin|gh\s+api|curl\s/.test(s.run)) v.push(`step "${s.name}" calls the API from the shell`);
  }
  const plant = job.steps.find((s) => (s.run ?? "").includes("native-pilot-plant.ts"));
  if (!plant) v.push("no plant step");
  else {
    if (plant.run !== "npx tsx native-pilot-plant.ts") v.push(`plant step must run exactly npx tsx native-pilot-plant.ts, got ${JSON.stringify(plant.run)}`);
    if (JSON.stringify(plant.env) !== JSON.stringify({ GH_TOKEN: "${{ steps.mint.outputs.token }}", CONTROL: "${{ inputs.control }}", RUN_ID: "${{ github.run_id }}" })) v.push(`plant env must be exactly GH_TOKEN (the minted token), CONTROL, RUN_ID, got ${JSON.stringify(plant.env)}`);
    if (mint && job.steps.indexOf(mint) > job.steps.indexOf(plant)) v.push("the mint step must precede the plant step");
    if (plant["working-directory"] !== "scripts") v.push("plant step runs in scripts/");
  }
  return v;
}

describe("native-pilot-plant.yml — dispatch-only, main-only, token narrowed to toto + contents/pull-requests (real file)", () => {
  it("known-good: the real workflow has no violations", () => {
    expect(lintWorkflow(loadWf())).toEqual([]);
  });
  it("the mint step requests exactly `contents: write` and `pull-requests: write` on `toto` — nothing else (the assertion the brief names)", () => {
    const mint = loadWf().jobs.plant.steps.find((s) => (s.uses ?? "").startsWith("actions/create-github-app-token@"))!;
    expect(mint.with).toEqual({
      "app-id": "${{ secrets.FLEET_APP_ID }}",
      "private-key": "${{ secrets.FLEET_APP_PRIVATE_KEY }}",
      owner: "studio-b-ai",
      repositories: "toto",
      "permission-contents": "write",
      "permission-pull-requests": "write",
    });
    expect(Object.keys(mint.with ?? {}).filter((k) => k.startsWith("permission-")).sort()).toEqual(["permission-contents", "permission-pull-requests"]);
  });
  it("the workflow file exists next to the script it runs", () => {
    expect(existsSync(join(SCRIPTS, "native-pilot-plant.ts"))).toBe(true);
  });

  // known-bad controls built from the real file: the lint must FIRE on each (#322/#471)
  const mutate = (f: (wf: Wf) => void): string[] => {
    const wf = structuredClone(loadWf());
    f(wf);
    return lintWorkflow(wf);
  };
  const mintOf = (wf: Wf) => wf.jobs.plant.steps.find((s) => (s.uses ?? "").startsWith("actions/create-github-app-token@"))!;
  const plantOf = (wf: Wf) => wf.jobs.plant.steps.find((s) => (s.run ?? "").includes("native-pilot-plant.ts"))!;
  const cases: Array<[string, (wf: Wf) => void, RegExp]> = [
    ["an extra permission (administration)", (wf) => (mintOf(wf).with!["permission-administration"] = "write"), /extra input: permission-administration/],
    ["an extra permission (workflows)", (wf) => (mintOf(wf).with!["permission-workflows"] = "write"), /extra input: permission-workflows/],
    ["an extra permission (issues)", (wf) => (mintOf(wf).with!["permission-issues"] = "write"), /extra input: permission-issues/],
    ["contents widened beyond write is impossible, but narrowed-to-read changes the contract too", (wf) => (mintOf(wf).with!["permission-contents"] = "read"), /permission-contents must be/],
    ["pull-requests dropped", (wf) => delete mintOf(wf).with!["permission-pull-requests"], /permission-pull-requests must be/],
    ["a second repository", (wf) => (mintOf(wf).with!.repositories = "toto,radio"), /repositories must be/],
    ["repositories removed (the token would span the whole installation)", (wf) => delete mintOf(wf).with!.repositories, /repositories must be/],
    ["owner changed", (wf) => (mintOf(wf).with!.owner = "someone-else"), /owner must be/],
    ["a second mint step", (wf) => wf.jobs.plant.steps.push(structuredClone(mintOf(wf))), /exactly one token mint step/],
    ["a pull_request trigger", (wf) => (wf.on.pull_request = {}), /triggers must be exactly workflow_dispatch/],
    ["a schedule trigger", (wf) => (wf.on.schedule = {} as never), /triggers must be exactly workflow_dispatch/],
    ["an unknown control option", (wf) => wf.on.workflow_dispatch!.inputs!.control.options!.push("c2"), /input control must be a choice/],
    ["a free-text control input", (wf) => (wf.on.workflow_dispatch!.inputs!.control.type = "string"), /input control must be a choice/],
    ["a second input", (wf) => (wf.on.workflow_dispatch!.inputs!.repo = { type: "string" }), /only input is `control`/],
    ["the main-only guard removed", (wf) => delete wf.jobs.plant.if, /run only on main/],
    ["the main-only guard changed", (wf) => (wf.jobs.plant.if = "github.ref != 'refs/heads/foo'"), /run only on main/],
    ["top-level permissions widened", (wf) => (wf.permissions = { contents: "write" }), /top-level permissions/],
    ["job permissions widened", (wf) => (wf.jobs.plant.permissions = { contents: "write", "pull-requests": "write" }), /job permissions/],
    ["a deployment environment attached", (wf) => (wf.jobs.plant.environment = "ai-review"), /no environment/],
    ["the ambient token handed to the plant step", (wf) => (plantOf(wf).env!.GH_TOKEN = "${{ github.token }}"), /plant env must be exactly|ambient token/],
    ["a secret handed to the plant step", (wf) => (plantOf(wf).env!.EXTRA = "${{ secrets.FLEET_APP_PRIVATE_KEY }}"), /references secrets|plant env must be exactly/],
    ["the control interpolated into the shell line", (wf) => (plantOf(wf).run = "npx tsx native-pilot-plant.ts ${{ inputs.control }}"), /interpolates an input|plant step must run exactly/],
    ["a merge in the shell", (wf) => wf.jobs.plant.steps.push({ name: "merge", run: "gh pr merge 1 --admin" }), /calls the API from the shell/],
    ["a raw API call in the shell", (wf) => wf.jobs.plant.steps.push({ name: "x", run: "gh api repos/studio-b-ai/toto/rulesets" }), /calls the API from the shell/],
    ["the plant step before the mint", (wf) => wf.jobs.plant.steps.reverse(), /mint step must precede/],
  ];
  it.each(cases)("known-bad: %s is caught", (_n, f, re) => {
    const out = mutate(f);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((x) => re.test(x)), JSON.stringify(out)).toBe(true);
  });
});

describe("native-pilot-plant.ts — import surface", () => {
  it("imports only node builtins and the door's own lib/native-exclusion.js (no other private or third-party code on the path that holds the token)", () => {
    const src = readFileSync(join(SCRIPTS, "native-pilot-plant.ts"), "utf-8");
    const specs = [...src.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(specs.sort()).toEqual(["./lib/native-exclusion.js", "node:child_process"]);
  });
  it("plantControl sends every API call through guardApi: its only use of the injected api is the guard wrapper", () => {
    const src = readFileSync(join(SCRIPTS, "native-pilot-plant.ts"), "utf-8");
    const body = src.slice(src.indexOf("export function plantControl("), src.indexOf("// ───────────────────────────── logging"));
    expect(body.match(/opts\.api/g)).toEqual(["opts.api"]);
    expect(body).toContain("const api = guardApi(opts.api);");
    expect(body).toContain("validatePlan(plan);");
  });
  it("FIXED_PATHS is frozen and its union is exactly the paths the brief names", () => {
    expect(Object.isFrozen(FIXED_PATHS)).toBe(true);
    for (const c of CONTROLS) expect(Object.isFrozen(FIXED_PATHS[c])).toBe(true);
    expect(FIXED_PATHS).toEqual({
      a: ["docs/native-pilot/control-a.md"],
      b: ["bin/native-pilot-b.sh"],
      c1: ["qa/qa.mjs"],
      e1: [".github/CODEOWNERS", "bin/native-pilot-e1.sh"],
      h: ["docs/native-pilot/control-h.md"],
    });
  });
});
