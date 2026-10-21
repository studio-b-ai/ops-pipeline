import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { mintBoxPatchId } from "../box-patch-id.js";

// Go-native Phase A, PR-A2 item 4 — box-patch-id-labeled.yml must not run PR-head code with the fleet token.
//
// The hole (native-plan §5/§6, lead-found L1): on `pull_request: [labeled]` the job minted a full-scope fleet App installation token,
// checked out the PR HEAD, then ran that head's `npm ci` (install scripts) and `scripts/box-patch-id-labeled.ts` with GH_TOKEN set. Any
// identity with `issues:write` can apply `box`, so any branch author could run code as the fleet App. The fix: the labeled path checks
// out the BASE sha and fetches the head as an object only.
//
// Two kinds of evidence (#223, #322/#471):
//   1. a workflow lint over the REAL file, with known-bad controls built from the pre-change shape — the lint must FIRE on those;
//   2. a REAL-git check that "checkout BASE + git fetch <head sha>" (a) leaves the head's code out of the working tree and (b) mints the
//      SAME patch-id the old head checkout did, via the real `mintBoxPatchId` and its real git runner.

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, "..", "..", "..", ".github", "workflows", "box-patch-id-labeled.yml");

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, { steps: Step[] }> };

const loadWorkflow = (): Workflow => parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
const BASE_REF = "${{ github.event.pull_request.base.sha }}";

/** A step is dispatch-only when its `if` requires workflow_dispatch and offers no other way in. Everything else can run on pull_request:labeled. */
const dispatchOnly = (s: Step): boolean => !!s.if && /github\.event_name == 'workflow_dispatch'/.test(s.if) && !/\|\||pull_request|label/.test(s.if);

/** Steps that execute repository code (a local action, or a shell step that runs a package manager / interpreter / repo script). */
const runsRepoCode = (s: Step): boolean =>
  (s.uses ?? "").startsWith("./") || (!!s.run && /\b(npm|npx|node|tsx|yarn|pnpm|bash|sh|python3?)\b|(^|\s)\.\/|\bscripts\//.test(s.run));

/** Everything that would let the PR head's code reach a step that runs with the fleet token on the pull_request:labeled path. */
function headExecutionViolations(wf: Workflow): string[] {
  const out: string[] = [];
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
  const onPr = steps.filter((s) => !dispatchOnly(s));
  let baseCheckedOut = false;
  for (const s of onPr) {
    const label = s.name ?? s.id ?? s.uses ?? "(unnamed step)";
    if ((s.uses ?? "").startsWith("actions/checkout@")) {
      if (s.with?.ref === BASE_REF && !s.with?.repository) baseCheckedOut = true;
      else out.push(`checkout step "${label}" on the pull_request path does not check out exactly ${BASE_REF} (ref=${JSON.stringify(s.with?.ref)}, repository=${JSON.stringify(s.with?.repository)})`);
    }
    if (s.with && /pull_request\.head|\.head\./.test(JSON.stringify(s.with))) out.push(`step "${label}" feeds a head-derived value into with: ${JSON.stringify(s.with)}`);
    if (s.run && /\bgit\s+(checkout|switch|reset|merge|cherry-pick|pull|restore|read-tree|am|apply|stash|worktree)\b|\bgh\s+pr\s+checkout\b/.test(s.run)) {
      out.push(`step "${label}" moves the working tree (${s.run.trim().split("\n")[0]})`);
    }
    if (runsRepoCode(s) && !baseCheckedOut) out.push(`step "${label}" runs repository code before the BASE checkout on the pull_request path`);
  }
  if (!baseCheckedOut) out.push("no BASE-sha checkout exists on the pull_request path");
  return out;
}

describe("box-patch-id-labeled.yml — the real file", () => {
  it("known-good: no step on the pull_request:labeled path checks out the head ref, moves the tree to it, or runs code before the BASE checkout", () => {
    expect(headExecutionViolations(loadWorkflow())).toEqual([]);
  });

  it("the labeled path is ordered: BASE checkout → head fetched as data → deps → mint+record (which is the only step holding the fleet token for code)", () => {
    const steps = loadWorkflow().jobs.mint.steps;
    const idx = (pred: (s: Step) => boolean) => steps.findIndex(pred);
    const base = idx((s) => s.with?.ref === BASE_REF);
    const fetchHead = idx((s) => /git fetch --no-tags origin "\$HEAD_SHA"/.test(s.run ?? ""));
    const deps = idx((s) => s.name === "Install deps");
    const mint = idx((s) => /box-patch-id-labeled\.ts/.test(s.run ?? ""));
    expect(base).toBeGreaterThan(-1);
    expect(fetchHead).toBeGreaterThan(base);
    expect(deps).toBeGreaterThan(fetchHead);
    expect(mint).toBeGreaterThan(deps);
    // the head SHA reaches the fetch step (and the script) as ENV data from the event payload, never through `with:`
    expect(steps[fetchHead].env?.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(steps[base].if).toBe("github.event_name == 'pull_request' && github.event.label.name == 'box'");
    expect(steps[fetchHead].if).toBe(steps[base].if);
  });

  it("the dispatch path is unchanged: its checkout is still dispatch-only and still uses the resolved same-repo head sha (documented residual)", () => {
    const steps = loadWorkflow().jobs.mint.steps;
    const d = steps.find((s) => s.name === "Checkout full history (workflow_dispatch path)");
    expect(d?.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(d?.with?.ref).toBe("${{ steps.resolve.outputs.same-repo-head-sha || github.sha }}");
    expect(d?.with?.["fetch-depth"]).toBe(0);
  });
});

describe("headExecutionViolations — KNOWN-BAD controls (the lint must fire on the vulnerable shapes)", () => {
  const withSteps = (mutate: (steps: Step[]) => Step[]): Workflow => {
    const wf = loadWorkflow();
    wf.jobs.mint.steps = mutate(wf.jobs.mint.steps);
    return wf;
  };
  /** the pre-change step, verbatim from origin/main 951bc03 */
  const OLD_CHECKOUT: Step = {
    name: "Checkout full history",
    if: "github.event.label.name == 'box' || github.event_name == 'workflow_dispatch'",
    uses: "actions/checkout@v5",
    with: { ref: "${{ github.event.pull_request.head.sha || steps.resolve.outputs.same-repo-head-sha || github.sha }}", "fetch-depth": "0" },
  };
  const isNewCheckout = (s: Step) => (s.uses ?? "").startsWith("actions/checkout@");

  it("the ORIGINAL vulnerable workflow shape (single head checkout feeding npm ci + the script) is flagged", () => {
    const wf = withSteps((steps) => {
      const out: Step[] = [];
      let placed = false;
      for (const s of steps) {
        if (isNewCheckout(s) || /git fetch --no-tags origin/.test(s.run ?? "")) {
          if (!placed) out.push(OLD_CHECKOUT);
          placed = true;
          continue;
        }
        out.push(s);
      }
      return out;
    });
    const v = headExecutionViolations(wf);
    expect(v.length).toBeGreaterThan(0);
    expect(v.join("\n")).toMatch(/does not check out exactly/);
    expect(v.join("\n")).toMatch(/feeds a head-derived value into with:/);
  });

  it("a checkout with NO ref (the default is the PR merge ref, which contains the head) is flagged", () => {
    const v = headExecutionViolations(withSteps((steps) => steps.map((s) => (s.with?.ref === BASE_REF ? { ...s, with: { "fetch-depth": "0" } } : s))));
    expect(v.join("\n")).toMatch(/does not check out exactly/);
  });

  it("a head fetched into the working tree by a later `git checkout` is flagged even though the checkout step itself is BASE", () => {
    const v = headExecutionViolations(
      withSteps((steps) => steps.flatMap((s) => (s.name === "Install deps" ? [{ name: "Switch to head", if: "github.event_name == 'pull_request'", run: 'git checkout "$HEAD_SHA"' }, s] : [s]))),
    );
    expect(v.join("\n")).toMatch(/moves the working tree/);
  });

  it("deps/script steps with the BASE checkout removed (they would run on the default merge ref) are flagged", () => {
    const v = headExecutionViolations(withSteps((steps) => steps.filter((s) => !isNewCheckout(s) || dispatchOnly(s))));
    expect(v.join("\n")).toMatch(/runs repository code before the BASE checkout|no BASE-sha checkout exists/);
  });

  it("a local action invoked before the BASE checkout is flagged", () => {
    const v = headExecutionViolations(
      withSteps((steps) => [{ name: "local action", if: "github.event_name == 'pull_request'", uses: "./.github/actions/anything" }, ...steps]),
    );
    expect(v.join("\n")).toMatch(/runs repository code before the BASE checkout/);
  });
});

// ───────────────────────────── real git ─────────────────────────────

describe("real git — BASE checkout + `git fetch <head sha>` keeps the head's code out of the tree and mints the SAME patch-id", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (dir: string, path: string, body: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  };

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "bpid-real-git-"));
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = join(root, "seed");
    execFileSync("git", ["clone", "-q", origin, seed], { stdio: "pipe" });
    git(seed, "checkout", "-q", "-b", "main");
    write(seed, "scripts/box-patch-id-labeled.ts", "// trusted base script\n");
    write(seed, "scripts/package-lock.json", '{"name":"trusted-base"}\n');
    write(seed, "src/app.ts", "export const a = 1;\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "A: base");
    git(seed, "push", "-q", "origin", "main");
    // the PR branch: changes real code AND plants hostile files where the workflow would execute them
    git(seed, "checkout", "-q", "-b", "pr");
    write(seed, "src/app.ts", "export const a = 2;\n");
    write(seed, "scripts/box-patch-id-labeled.ts", "// PWNED-BY-PR-HEAD: would run with the fleet token\n");
    write(seed, "scripts/package-lock.json", '{"name":"PWNED-BY-PR-HEAD"}\n');
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "B: pr head");
    git(seed, "push", "-q", "origin", "pr");
    const headSha = git(seed, "rev-parse", "HEAD");
    // main moves on after the PR was opened: the event's base.sha is the CURRENT main tip, merge-base is still A
    git(seed, "checkout", "-q", "main");
    write(seed, "docs/readme.md", "later change on main\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "D: main moved");
    git(seed, "push", "-q", "origin", "main");
    const baseSha = git(seed, "rev-parse", "HEAD");
    return { root, origin, headSha, baseSha };
  }

  function mint(repoDir: string, headSha: string) {
    return mintBoxPatchId({
      repo: "studio-b-ai/ops-pipeline",
      prNumber: 700,
      headRepo: "studio-b-ai/ops-pipeline",
      headSha,
      baseRef: "main",
      labelEventDbId: 4242,
      changedPaths: ["src/app.ts", "scripts/box-patch-id-labeled.ts", "scripts/package-lock.json"],
      repoDir,
    });
  }

  /** every file in the working tree (never .git) that contains `needle` */
  function filesContaining(dir: string, needle: string, rel = ""): string[] {
    const hits: string[] = [];
    for (const name of readdirSync(join(dir, rel))) {
      if (name === ".git") continue;
      const p = join(rel, name);
      if (statSync(join(dir, p)).isDirectory()) hits.push(...filesContaining(dir, needle, p));
      else if (readFileSync(join(dir, p), "utf-8").includes(needle)) hits.push(p);
    }
    return hits;
  }

  it("NEW layout: working tree = BASE sha with no head file anywhere, head present as an object, and the minted patch-id EQUALS the old head-checkout layout's", () => {
    const { root, origin, headSha, baseSha } = fixture();

    // what `actions/checkout@v5 { ref: base.sha, fetch-depth: 0 }` + `git fetch --no-tags origin "$HEAD_SHA"` leaves on the runner
    const next = join(root, "new-layout");
    execFileSync("git", ["clone", "-q", "--no-tags", origin, next], { stdio: "pipe" });
    git(next, "checkout", "-q", "--detach", baseSha);
    git(next, "fetch", "--no-tags", "-q", "origin", headSha);

    expect(git(next, "rev-parse", "HEAD")).toBe(baseSha);
    expect(git(next, "status", "--porcelain")).toBe("");
    expect(git(next, "cat-file", "-t", headSha)).toBe("commit"); // the head is available as DATA…
    expect(readFileSync(join(next, "scripts/box-patch-id-labeled.ts"), "utf-8")).toBe("// trusted base script\n"); // …and is NOT what would run
    expect(filesContaining(next, "PWNED-BY-PR-HEAD")).toEqual([]);
    const fromBase = mint(next, headSha);
    expect(fromBase.ok).toBe(true);

    // CONTROL — the OLD layout (head checked out): the hostile files ARE in the tree that `npm ci` + the script would run from
    const old = join(root, "old-layout");
    execFileSync("git", ["clone", "-q", "--no-tags", origin, old], { stdio: "pipe" });
    git(old, "checkout", "-q", "--detach", headSha);
    expect(filesContaining(old, "PWNED-BY-PR-HEAD").sort()).toEqual(["scripts/box-patch-id-labeled.ts", "scripts/package-lock.json"]);
    const fromHead = mint(old, headSha);
    expect(fromHead.ok).toBe(true);

    // the restructure changes WHERE code runs, not WHAT is recorded
    if (fromBase.ok && fromHead.ok) {
      expect(fromBase.record.patchId).toBe(fromHead.record.patchId);
      expect(fromBase.record.baseSha).toBe(fromHead.record.baseSha);
      expect(fromBase.record.pathHashes).toEqual(fromHead.record.pathHashes);
      expect(fromBase.record.baseSha).not.toBe(baseSha); // merge-base is A (the PR's fork point), not the moved main tip D — the fixture exercises it
    }
  }, 60000);

  it("known-bad control for the instrument: a head sha that was never fetched cannot mint (so the `git fetch` step is load-bearing, not decorative)", () => {
    const { root, origin, baseSha } = fixture();
    const next = join(root, "no-fetch");
    execFileSync("git", ["clone", "-q", "--no-tags", "--branch", "main", "--single-branch", origin, next], { stdio: "pipe" });
    git(next, "checkout", "-q", "--detach", baseSha);
    const absent = "d".repeat(40);
    const verdict = mint(next, absent);
    expect(verdict.ok).toBe(false);
  }, 60000);
});
