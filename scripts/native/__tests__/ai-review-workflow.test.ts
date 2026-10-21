/**
 * go-native P1 — the sweep workflow and the reviewer's import closure.
 *
 *  1. A lint over the REAL .github/workflows/ai-review-sweep.yml, with a known-bad control for every rule (a mutation of the real parsed
 *     file that the lint MUST flag) — #322 / #471. The lint encodes the plan's structural promises: two jobs, the review job has no
 *     `environment` (its OIDC sub must stay the branch form) and never touches the reviewer credentials, the post job holds them in the
 *     main-only environment and never calls the model, tokens are scoped to the manifest repos, and — because ops-pipeline is PUBLIC —
 *     nothing expands an expression into a `run:` script and the sealed handoff only ever travels in `env:`.
 *  2. The import-closure guard (native-plan §4 / review B4): everything scripts/ai-review.ts imports must sit under a path the REAL
 *     registry (scripts/squasher-fleet.json, ops-pipeline row) already treats as sensitive. A reviewer whose imports can be edited
 *     without Kevin is a reviewer anyone can reconfigure.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..");
const ROOT = resolve(SCRIPTS, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "ai-review-sweep.yml");

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; "continue-on-error"?: boolean };
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};

const loadWorkflow = (): Workflow => parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
const text = (x: unknown): string => JSON.stringify(x);
const isMintStep = (s: Step): boolean => (s.uses ?? "").startsWith("actions/create-github-app-token@");
const PINNED = /^actions\/create-github-app-token@[0-9a-f]{40}( |$)/;

export function lintWorkflow(wf: Workflow): string[] {
  const v: string[] = [];
  const triggers = Object.keys(wf.on ?? {});
  for (const t of ["workflow_dispatch", "repository_dispatch", "schedule"]) if (!triggers.includes(t)) v.push(`missing trigger ${t}`);
  for (const t of triggers) if (!["workflow_dispatch", "repository_dispatch", "schedule"].includes(t)) v.push(`unexpected trigger ${t}`);
  if (JSON.stringify((wf.on.repository_dispatch as { types?: unknown } | undefined)?.types) !== '["ai-review"]') v.push("repository_dispatch must be exactly [ai-review]");
  if (JSON.stringify(wf.on.schedule) !== '[{"cron":"*/10 * * * *"}]') v.push("schedule must be exactly the */10 backstop cron");
  if (wf.concurrency?.group !== "ai-review-sweep" || wf.concurrency?.["cancel-in-progress"] !== false) v.push("concurrency must be group ai-review-sweep with cancel-in-progress false");
  if (JSON.stringify(wf.permissions) !== '{"contents":"read"}') v.push("workflow permissions must be exactly contents: read");
  if (Object.keys(wf.jobs).join(",") !== "review,post") v.push("jobs must be exactly review, post");

  const review = wf.jobs.review;
  const post = wf.jobs.post;
  if (review && post) {
    // ── review ──
    if (review.environment !== undefined) v.push("review job must have no environment (its OIDC sub must stay the branch form)");
    if (JSON.stringify(review.permissions) !== '{"contents":"read","id-token":"write"}') v.push("review job permissions must be exactly contents: read, id-token: write");
    if (/REVIEWER_APP/.test(text(review))) v.push("reviewer credentials must never appear in the review job");
    if (Object.keys(review.outputs ?? {}).join(",") !== "handoff") v.push("review outputs must be exactly handoff");
    const wif = review.steps.find((s) => s.uses === "./.github/actions/anthropic-federated-token");
    if (!wif) v.push("review job must reuse ./.github/actions/anthropic-federated-token");
    else {
      for (const k of ["rule_id", "organization_id", "service_account_id", "workspace_id"]) if (!/^\$\{\{ vars\.ANTHROPIC_/.test(String(wif.with?.[k] ?? ""))) v.push(`federated token input ${k} must come from vars.ANTHROPIC_*`);
      if (wif["continue-on-error"] !== true) v.push("the federated token step must be continue-on-error (the deterministic waiver must still run when federation is down)");
    }
    const sweep = review.steps.find((s) => /ai-review\.ts review/.test(s.run ?? ""));
    if (!sweep) v.push("review job must run ai-review.ts review");
    else if (!/steps\.mint\.outputs\.token/.test(String(sweep.env?.GH_TOKEN ?? "")) || !/secrets\.FLEET_APP_PRIVATE_KEY/.test(String(sweep.env?.AI_REVIEW_HANDOFF_KEY ?? ""))) {
      v.push("the sweep step must take GH_TOKEN from the mint step and the handoff key from the fleet key");
    }
    // ── post ──
    const needs = ([] as string[]).concat(post.needs ?? []);
    if (!needs.includes("review")) v.push("post must need review");
    const env = typeof post.environment === "string" ? post.environment : post.environment?.name;
    if (env !== "ai-review") v.push("post must run in environment ai-review");
    if (post.permissions && "id-token" in post.permissions) v.push("post must not hold id-token");
    if (post.steps.some((s) => (s.uses ?? "").includes("anthropic-federated-token")) || /ANTHROPIC_/.test(text(post))) v.push("post must never call the model");
    if (!post.steps.some((s) => /ai-review\.ts post/.test(s.run ?? ""))) v.push("post job must run ai-review.ts post");
    if (!post.steps.some((s) => /reviewer app not configured; nothing posted/.test(s.run ?? ""))) v.push("post must log the not-configured message");
    const postMint = post.steps.find(isMintStep);
    if (!postMint) v.push("post must mint the reviewer App token");
    else {
      if (!/REVIEWER_APP_ID/.test(String(postMint.with?.["app-id"] ?? "")) || !/secrets\.REVIEWER_APP_PRIVATE_KEY/.test(String(postMint.with?.["private-key"] ?? ""))) v.push("the post mint must use REVIEWER_APP_ID / REVIEWER_APP_PRIVATE_KEY");
      const perms = Object.entries(postMint.with ?? {}).filter(([k]) => k.startsWith("permission-"));
      if (JSON.stringify(Object.fromEntries(perms.filter(([, val]) => val === "write"))) !== '{"permission-checks":"write"}') v.push("the reviewer token may hold exactly one write permission: checks");
    }
  }
  // ── both ──
  for (const [name, job] of Object.entries(wf.jobs)) {
    if (!/github\.ref == 'refs\/heads\/main'/.test(job.if ?? "") || !/github\.repository == 'studio-b-ai\/ops-pipeline'/.test(job.if ?? "")) v.push(`${name}: must be guarded to ops-pipeline on main`);
    for (const s of job.steps) {
      const label = `${name}/${s.name ?? s.id ?? s.uses ?? "step"}`;
      if (isMintStep(s)) {
        if (!PINNED.test(s.uses ?? "")) v.push(`${label}: create-github-app-token must be pinned to a commit SHA`);
        if (!/steps\.repos\.outputs\.names/.test(String(s.with?.repositories ?? ""))) v.push(`${label}: the token must be scoped with repositories (an empty scope would cover the whole installation)`);
        if (name === "review") {
          for (const [k, val] of Object.entries(s.with ?? {})) if (k.startsWith("permission-") && val !== "read") v.push(`${label}: the review job's fleet token must be read-only (${k})`);
        }
      }
      if (s.run && s.run.includes("${{")) v.push(`${label}: an expression inside a run script (public logs; pass values through env)`);
      if (/needs\.[A-Za-z_-]+\.outputs/.test(text(s.with ?? {})) || /needs\.[A-Za-z_-]+\.outputs/.test(s.run ?? "") || /needs\.[A-Za-z_-]+\.outputs/.test(String(s.if ?? ""))) v.push(`${label}: a job output outside env`);
    }
  }
  return v;
}

describe("ai-review-sweep.yml — the real file", () => {
  it("lints clean", () => {
    expect(lintWorkflow(loadWorkflow())).toEqual([]);
  });
  it("the not-configured guard really gates every post step: mint and post run only when configured", () => {
    const post = loadWorkflow().jobs.post;
    const after = post.steps.slice(post.steps.findIndex((s) => s.id === "cfg") + 1);
    expect(after.length).toBeGreaterThan(3);
    for (const s of after) expect(s.if ?? "", s.name ?? s.uses).toContain("steps.cfg.outputs.configured == 'true'");
  });
  it("the sealed handoff is passed to the post step through env and nowhere else", () => {
    const post = loadWorkflow().jobs.post;
    const step = post.steps.find((s) => /ai-review\.ts post/.test(s.run ?? ""))!;
    expect(step.env?.AI_REVIEW_HANDOFF).toBe("${{ needs.review.outputs.handoff }}");
    expect(text(post.steps.filter((s) => s !== step))).not.toContain("needs.review.outputs");
  });
});

describe("known-bad controls: every rule fires on a mutation of the real workflow", () => {
  const mutations: Array<[string, (wf: Workflow) => void, string]> = [
    ["a pull_request trigger", (w) => void (w.on.pull_request = {}), "unexpected trigger pull_request"],
    ["a pull_request_target trigger", (w) => void (w.on.pull_request_target = {}), "unexpected trigger pull_request_target"],
    ["no repository_dispatch", (w) => void delete w.on.repository_dispatch, "missing trigger repository_dispatch"],
    ["a different cron", (w) => void (w.on.schedule = [{ cron: "* * * * *" }]), "schedule must be exactly"],
    ["cancel-in-progress true", (w) => void (w.concurrency!["cancel-in-progress"] = true), "concurrency must be group ai-review-sweep"],
    ["a third job", (w) => void (w.jobs.extra = { steps: [] }), "jobs must be exactly review, post"],
    ["an environment on the review job", (w) => void (w.jobs.review.environment = "ai-review"), "review job must have no environment"],
    ["write access on the review job", (w) => void (w.jobs.review.permissions!.contents = "write"), "review job permissions must be exactly"],
    ["the reviewer PEM referenced in the review job", (w) => void (w.jobs.review.steps[1].env = { K: "${{ secrets.REVIEWER_APP_PRIVATE_KEY }}" }), "reviewer credentials must never appear in the review job"],
    ["the review job not reusing the federated-token action", (w) => void (w.jobs.review.steps = w.jobs.review.steps.filter((s) => s.uses !== "./.github/actions/anthropic-federated-token")), "must reuse ./.github/actions/anthropic-federated-token"],
    ["the federated token step failing the whole job", (w) => void delete w.jobs.review.steps.find((s) => s.uses === "./.github/actions/anthropic-federated-token")!["continue-on-error"], "continue-on-error"],
    ["an extra review output", (w) => void (w.jobs.review.outputs!.verdicts = "x"), "review outputs must be exactly handoff"],
    ["post not needing review", (w) => void delete w.jobs.post.needs, "post must need review"],
    ["post without the environment", (w) => void delete w.jobs.post.environment, "post must run in environment ai-review"],
    ["id-token on post", (w) => void (w.jobs.post.permissions = { contents: "read", "id-token": "write" }), "post must not hold id-token"],
    ["the model called from post", (w) => void w.jobs.post.steps.push({ uses: "./.github/actions/anthropic-federated-token" }), "post must never call the model"],
    ["the not-configured message removed", (w) => void (w.jobs.post.steps.find((s) => s.id === "cfg")!.run = "echo hi"), "post must log the not-configured message"],
    ["an unscoped token (no repositories)", (w) => void delete w.jobs.review.steps.find(isMintStep)!.with!.repositories, "must be scoped with repositories"],
    ["a write permission on the review token", (w) => void (w.jobs.review.steps.find(isMintStep)!.with!["permission-contents"] = "write"), "must be read-only"],
    ["a second write permission on the reviewer token", (w) => void (w.jobs.post.steps.find(isMintStep)!.with!["permission-contents"] = "write"), "exactly one write permission"],
    ["an unpinned app-token action", (w) => void (w.jobs.post.steps.find(isMintStep)!.uses = "actions/create-github-app-token@v1"), "pinned to a commit SHA"],
    [
      "an expression in a run script",
      (w) => {
        const step = w.jobs.review.steps.find((s) => s.id === "repos")!;
        step.run = (step.run ?? "") + '\necho "${{ needs.review.outputs.handoff }}"';
      },
      "an expression inside a run script",
    ],
    ["a job output in `with:`", (w) => void (w.jobs.post.steps[1].with = { x: "${{ needs.review.outputs.handoff }}" }), "a job output outside env"],
    ["the main-branch guard removed", (w) => void (w.jobs.review.if = "github.repository == 'studio-b-ai/ops-pipeline'"), "must be guarded to ops-pipeline on main"],
  ];
  for (const [name, mutate, expected] of mutations) {
    it(name, () => {
      const wf = loadWorkflow();
      mutate(wf);
      const out = lintWorkflow(wf).join("\n");
      expect(out, name).toContain(expected);
    });
  }
});

// ───────────────────────────── import closure ─────────────────────────────

const IMPORT_RES = [
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiersOf(file: string): string[] {
  const src = readFileSync(file, "utf-8");
  const out: string[] = [];
  for (const re of IMPORT_RES) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

/** every file reachable through relative imports from `entry` (repo-relative, forward slashes), plus the bare specifiers seen on the way */
function closureOf(entry: string): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of specifiersOf(f)) {
      if (!spec.startsWith(".")) {
        bare.add(spec);
        continue;
      }
      const target = resolve(dirname(f), spec).replace(/\.js$/, ".ts");
      if (!existsSync(target)) throw new Error(`unresolved import ${spec} from ${relative(ROOT, f)}`);
      queue.push(target);
    }
  }
  return { files: [...seen].map((f) => relative(ROOT, f).split("\\").join("/")).sort(), bare: [...bare].sort() };
}

function sensitivePatterns(): RegExp[] {
  const reg = JSON.parse(readFileSync(join(SCRIPTS, "squasher-fleet.json"), "utf-8")) as { repos: Array<{ repo: string; sensitive_path_patterns: string }> };
  const row = reg.repos.find((r) => r.repo === "studio-b-ai/ops-pipeline");
  if (!row) throw new Error("no ops-pipeline row in the registry");
  // the workflow splits this field on commas and compiles each piece as a JS RegExp; so do we
  return row.sensitive_path_patterns.split(",").map((p) => p.trim()).filter(Boolean).map((p) => new RegExp(p));
}
const unprotected = (files: string[], pats: RegExp[]): string[] => files.filter((f) => !pats.some((re) => re.test(f)));

describe("import closure — the reviewer imports only from registry-protected paths", () => {
  const pats = sensitivePatterns();
  const closure = closureOf(join(SCRIPTS, "ai-review.ts"));

  it("the closure is exactly the reviewer's own modules plus anthropic-credentials (an added import is a deliberate edit of this list)", () => {
    expect(closure.files).toEqual([
      "scripts/ai-review.ts",
      "scripts/lib/ai-review-evaluate.ts",
      "scripts/lib/ai-review-github.ts",
      "scripts/lib/ai-review-handoff.ts",
      "scripts/lib/ai-review-log.ts",
      "scripts/lib/ai-review-manifest.ts",
      "scripts/lib/ai-review-rubric.ts",
      "scripts/lib/ai-review-verdict.ts",
      "scripts/lib/anthropic-credentials.ts",
    ]);
  });
  it("every file in the closure, the manifest, the workflow and the tests is under a REAL sensitive pattern", () => {
    expect(unprotected(closure.files, pats)).toEqual([]);
    expect(unprotected(["scripts/native/manifest.json", ".github/workflows/ai-review-sweep.yml", "scripts/native/__tests__/ai-review-evaluate.test.ts", "scripts/native/__tests__/helpers.ts"], pats)).toEqual([]);
  });
  it("it reaches no package beyond the Anthropic SDK and node built-ins", () => {
    for (const b of closure.bare) expect(b === "@anthropic-ai/sdk" || b.startsWith("node:"), b).toBe(true);
  });
  it("CONTROL (#322): the instrument is not vacuous — it flags an unprotected import and still admits ordinary scripts", () => {
    expect(unprotected([...closure.files, "scripts/lib/issue-class-routing.ts"], pats)).toEqual(["scripts/lib/issue-class-routing.ts"]);
    expect(unprotected(["scripts/drift-check.ts"], pats)).toEqual(["scripts/drift-check.ts"]); // registry still admits ordinary scripts
    expect(unprotected(["scripts/lib/hold-rail.ts", "scripts/package-lock.json"], pats)).toEqual([]);
  });
  it("CONTROL: closureOf follows real imports (a synthetic edge is found), so an empty closure cannot pass silently", () => {
    expect(closure.files.length).toBeGreaterThan(5);
    expect(closureOf(join(SCRIPTS, "lib", "native-exclusion.ts")).files).toEqual(["scripts/lib/native-exclusion.ts"]);
    expect(closureOf(join(SCRIPTS, "restart-train.ts")).files.length).toBeGreaterThan(1);
  });
});
