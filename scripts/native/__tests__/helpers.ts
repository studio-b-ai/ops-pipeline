/**
 * Shared fixtures for the ai-review tests (go-native P1). NOT a test file.
 *
 * `makeWorld()` is a fake GitHub that RECORDS every request it receives; the tests assert on what the real functions asked for and sent
 * (#223), never on a payload the test assembled itself. An unknown path throws, so a leg that starts calling an endpoint nobody planned
 * for fails loudly instead of quietly returning undefined. POSTs to `check-runs` land in the world, so a second sweep sees the first
 * one's verdicts exactly as GitHub would show them.
 */
import { vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { GhError, type GhApi, type GhRequest } from "../../lib/ai-review-github.js";

export const REPO = "studio-b-ai/toto";
export const REVIEWER = { id: 777001, slug: "studiob-reviewer" };
export const sha = (c: string): string => c.repeat(40).slice(0, 40);
export const HEAD = sha("a");
export const OLD_HEAD = sha("b");
/** Two distinct merge bases (full 40-hex): the commit a PR's diff starts from. A PR's merge base moves when it is retargeted or its parent lands. */
export const MB1 = sha("1");
export const MB2 = sha("2");

export interface ReviewFixture {
  id: number;
  login: string;
  state: string;
  commit_id: string | null;
}
export interface PrFixture {
  number: number;
  draft?: boolean;
  state?: string;
  sha?: string;
  /** the PR's base ref; defaults to the repo's default branch. Mutable between sweeps: a retarget. */
  baseRef?: string;
  /** what `compare/<base>...<head>` reports as `merge_base_commit.sha`; defaults to MB1. `diff` is the diff FROM this merge base. */
  mergeBase?: string;
  headRepo?: string | null;
  labels?: string[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviews?: ReviewFixture[];
  diff?: string;
}
export interface CheckRunFixture {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  external_id?: string | null;
  app?: { id: number; slug: string } | null;
}
export interface RepoFixture {
  /** newest first, as `GET pulls?sort=created&direction=desc` returns them */
  prs: PrFixture[];
  /** `base.repo.default_branch` on every PR response; defaults to "main" */
  defaultBranch?: string;
  /** what `GET codeowners/errors` does at any ref */
  codeowners?: "ok" | "errors" | "absent" | "inconsistent" | "down";
}
export interface World {
  repos: Record<string, RepoFixture>;
  /** keyed `repo@sha` */
  checkRuns: Record<string, CheckRunFixture[]>;
  /** return an HTTP status to make a request fail like GitHub would */
  failOn?: (req: GhRequest) => number | null;
}

export function makeWorld(repo: string = REPO, fixture: RepoFixture = { prs: [] }): World {
  return { repos: { [repo]: fixture }, checkRuns: {} };
}

export const CLEAN_DIFF = "diff --git a/docs/x.md b/docs/x.md\n--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1 +1 @@\n-old\n+new\n";

export function makeGh(world: World, postAs: { id: number; slug: string } = REVIEWER): { gh: GhApi; calls: GhRequest[]; posts: GhRequest[] } {
  const calls: GhRequest[] = [];
  const posts: GhRequest[] = [];
  let nextRunId = 9000;
  const gh: GhApi = async (req) => {
    calls.push(req);
    const status = world.failOn?.(req) ?? null;
    if (status !== null) throw new GhError(status);
    const method = req.method ?? "GET";
    const path = req.path;

    let m = /^repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
    if (m && method === "GET") {
      const repo = world.repos[m[1]];
      if (!repo) throw new GhError(404);
      return repo.prs.map((p) => ({ number: p.number, draft: p.draft === true }));
    }
    m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
    if (m && method === "GET") {
      const pr = world.repos[m[1]]?.prs.find((p) => p.number === Number(m![2]));
      if (!pr) throw new GhError(404);
      return {
        number: pr.number,
        state: pr.state ?? "open",
        draft: pr.draft === true,
        head: { sha: pr.sha ?? HEAD, repo: pr.headRepo === null ? null : { full_name: pr.headRepo ?? m[1] } },
        base: { ref: pr.baseRef ?? world.repos[m[1]].defaultBranch ?? "main", repo: { full_name: m[1], default_branch: world.repos[m[1]].defaultBranch ?? "main" } },
        labels: (pr.labels ?? []).map((name) => ({ name })),
        additions: pr.additions ?? 3,
        deletions: pr.deletions ?? 1,
        changed_files: pr.changedFiles ?? 1,
      };
    }
    m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(path);
    if (m && method === "GET") {
      const pr = world.repos[m[1]]?.prs.find((p) => p.number === Number(m![2]));
      if (!pr) throw new GhError(404);
      const page = Number(req.query?.page ?? 1);
      return page === 1 ? (pr.reviews ?? []).map((r) => ({ id: r.id, state: r.state, commit_id: r.commit_id, user: { login: r.login } })) : [];
    }
    m = /^repos\/([^/]+\/[^/]+)\/codeowners\/errors$/.exec(path);
    if (m && method === "GET") {
      const mode = world.repos[m[1]]?.codeowners ?? "ok";
      if (mode === "ok") return { errors: [] };
      if (mode === "errors") return { errors: [{ line: 3, column: 1, kind: "Unknown owner", message: "Unknown owner on line 3: SECRET-CANARY-codeowners", path: ".github/CODEOWNERS" }] };
      if (mode === "down") throw new GhError(500);
      throw new GhError(404); // absent + inconsistent: the endpoint 404s (probed live on toto with no CODEOWNERS)
    }
    m = /^repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(path);
    if (m && method === "GET") {
      const mode = world.repos[m[1]]?.codeowners;
      if (mode === "inconsistent" && m[2] === ".github/CODEOWNERS") return { path: m[2] };
      throw new GhError(404);
    }
    m = /^repos\/([^/]+\/[^/]+)\/compare\/([^/]+)\.\.\.([0-9a-f]{40})$/.exec(path);
    if (m && method === "GET") {
      const pr = world.repos[m[1]]?.prs.find((p) => (p.sha ?? HEAD) === m![3]);
      if (!pr) throw new GhError(404);
      const base = decodeURIComponent(m[2]);
      const mergeBase = pr.mergeBase ?? MB1;
      if (req.accept && /diff/.test(req.accept)) {
        // The diff is fetched by TWO SHAs, and only by the merge base the PR has right now. A ref name here is the unpinned fetch (a
        // regression); any other sha is a stale or invented merge base.
        if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`unplanned request: diff fetched by ref name ${base}`);
        if (base !== mergeBase) throw new GhError(404);
        return pr.diff ?? CLEAN_DIFF;
      }
      // JSON compare: the merge base of the PR's base ref and its head (what the review job reads before it can bind a verdict)
      return { status: "ahead", ahead_by: 1, merge_base_commit: { sha: mergeBase }, commits: [], files: [] };
    }
    m = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})\/check-runs$/.exec(path);
    if (m && method === "GET") {
      let runs = (world.checkRuns[`${m[1]}@${m[2]}`] ?? []).filter((r) => (r.name ?? "studiob-ai-review") === req.query?.check_name);
      // GitHub's default is `filter=latest`: ONE run per check name (per app). Only `filter=all` returns the history.
      if (req.query?.filter !== "all") {
        const newest = new Map<number | null, CheckRunFixture>();
        for (const r of runs) {
          const k = r.app?.id ?? null;
          if (!newest.has(k) || r.id > newest.get(k)!.id) newest.set(k, r);
        }
        runs = [...newest.values()];
      }
      return { total_count: runs.length, check_runs: runs.map((r) => ({ name: "studiob-ai-review", status: "completed", conclusion: null, external_id: null, app: null, ...r })) };
    }
    m = /^repos\/([^/]+\/[^/]+)\/check-runs$/.exec(path);
    if (m && method === "POST") {
      posts.push(req);
      const body = req.body as { head_sha: string; name: string; conclusion: string; external_id: string };
      const key = `${m[1]}@${body.head_sha}`;
      (world.checkRuns[key] ??= []).push({ id: ++nextRunId, name: body.name, status: "completed", conclusion: body.conclusion, external_id: body.external_id, app: postAs });
      return { id: nextRunId };
    }
    throw new Error(`unplanned request: ${method} ${path}`);
  };
  return { gh, calls, posts };
}

// ───────────────────────────── a fake Anthropic client ─────────────────────────────

export type ModelScript = Array<string | Error> | ((callIndex: number) => string | Error);

/** Resolves each `messages.create` from the script (a string is the model's text, an Error is a thrown API error) and records the request. */
export function makeClient(script: ModelScript): { client: () => Anthropic; requests: Array<Record<string, unknown>>; built: () => number } {
  const requests: Array<Record<string, unknown>> = [];
  let built = 0;
  const create = vi.fn(async (req: Record<string, unknown>) => {
    const i = requests.length;
    requests.push(req);
    const next = typeof script === "function" ? script(i) : script[Math.min(i, script.length - 1)];
    if (next instanceof Error) throw next;
    return { content: [{ type: "text", text: next }], stop_reason: "end_turn" };
  });
  const fake = { messages: { create } } as unknown as Anthropic;
  return { client: () => (built++, fake), requests, built: () => built };
}

export const PASS = "PASS";
export const block = (cats: string, reasons = "src/a.ts: a plain bug"): string => `BLOCK\nCATEGORIES: ${cats}\n${reasons}`;
export const noSleep = async (): Promise<void> => undefined;
