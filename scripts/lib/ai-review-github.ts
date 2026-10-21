/**
 * ai-review-github.ts — the GitHub REST surface of the central AI review check (go-native, native-plan §4), behind one injectable
 * function so every leg is testable against a fake that records what it was asked (#223).
 *
 * Reads (review job, a read-only fleet installation token scoped to the manifest repos):
 *   GET repos/R/pulls                      enumerate open PRs, newest first
 *   GET repos/R/pulls/N                    the facts, re-derived every sweep (#398): head sha, base ref + the repo's default branch, head repo, labels, size
 *   GET repos/R/pulls/N/reviews            the waiver
 *   GET repos/R/codeowners/errors?ref=SHA  CODEOWNERS errors at the head (404 when the repo has no CODEOWNERS file — probed live on toto)
 *   GET repos/R/contents/<codeowners path>?ref=SHA   only to tell "no CODEOWNERS" from a blind 404
 *   GET repos/R/compare/BASE...SHA         (JSON) the merge base of the PR's base ref and the head: the one fact the head SHA alone does not pin
 *   GET repos/R/compare/MERGEBASE...SHA    the diff, pinned by TWO SHAs (ABA-safe: the bytes reviewed are a pure function of the merge base and
 *                                          the head the verdict is bound to — a base ref is a moving name and is never used to fetch the diff)
 *   GET repos/R/commits/SHA/check-runs     the reviewer's earlier verdicts (cache + dedupe)
 * Writes (post job only, the reviewer App installation token):
 *   POST repos/R/check-runs                the verdict
 *
 * `gh` failures surface as GhError{status} with a FIXED message — gh's stderr (private repo names, paths) is never forwarded, because
 * ops-pipeline is a public repo and a thrown message can reach a log.
 */
import { execFileSync } from "node:child_process";

export interface GhRequest {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
  /** `application/vnd.github.diff` makes the response a string */
  accept?: string;
}
export type GhApi = (req: GhRequest) => Promise<unknown>;

export class GhError extends Error {
  constructor(public readonly status: number | null) {
    super(`github api request failed${status ? ` (HTTP ${status})` : ""}`);
  }
}

export const CHECK_NAME = "studiob-ai-review";

/** The default transport: the `gh` CLI with GH_TOKEN in the environment. The body goes on stdin, never argv. */
export const ghCli: GhApi = async (req) => {
  const query = req.query ? "?" + Object.entries(req.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
  const args = ["api", req.path + query, "-X", req.method ?? "GET"];
  if (req.accept) args.push("-H", `Accept: ${req.accept}`);
  if (req.body !== undefined) args.push("--input", "-");
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf-8",
      input: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (req.accept && /diff/.test(req.accept)) return out;
    return out.trim() === "" ? null : JSON.parse(out);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString() ?? "";
    const m = /HTTP (\d{3})/.exec(stderr);
    throw new GhError(m ? Number(m[1]) : null);
  }
};

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function checkRepo(repo: string): void {
  if (!REPO_RE.test(repo)) throw new Error("invalid repo name");
}
function checkSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error("invalid sha");
}
function rec(x: unknown): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("unexpected response shape");
  return x as Record<string, unknown>;
}
function arr(x: unknown): unknown[] {
  if (!Array.isArray(x)) throw new Error("unexpected response shape");
  return x;
}

// ───────────────────────────── pull requests ─────────────────────────────

/** Open PRs, NEWEST FIRST (created desc) — the order the shadow cap ("3 most-recent") is defined over. One page of 100. */
export async function listOpenPrs(gh: GhApi, repo: string): Promise<Array<{ number: number; draft: boolean }>> {
  checkRepo(repo);
  const rows = arr(await gh({ path: `repos/${repo}/pulls`, query: { state: "open", sort: "created", direction: "desc", per_page: 100 } }));
  return rows.map((r) => {
    const o = rec(r);
    if (!Number.isInteger(o.number)) throw new Error("unexpected response shape");
    return { number: o.number as number, draft: o.draft === true };
  });
}

export interface PrFacts {
  number: number;
  state: string;
  draft: boolean;
  headSha: string;
  baseRef: string;
  /** the repository's default branch, read from the same response (`base.repo.default_branch`); a PR whose base is anything else is not reviewed */
  defaultBranch: string;
  baseRepo: string;
  /** null when the head repository is gone (a deleted fork) */
  headRepo: string | null;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
}

export async function getPr(gh: GhApi, repo: string, number: number): Promise<PrFacts> {
  checkRepo(repo);
  const o = rec(await gh({ path: `repos/${repo}/pulls/${number}` }));
  const head = rec(o.head);
  const base = rec(o.base);
  const headSha = head.sha;
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) throw new Error("unexpected response shape");
  const baseRepoObj = rec(base.repo);
  const baseRepo = baseRepoObj.full_name;
  const defaultBranch = baseRepoObj.default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch === "") throw new Error("unexpected response shape");
  const headRepoObj = head.repo === null || head.repo === undefined ? null : rec(head.repo);
  if (typeof baseRepo !== "string" || typeof base.ref !== "string" || typeof o.state !== "string") throw new Error("unexpected response shape");
  const num = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("unexpected response shape");
    return v;
  };
  return {
    number,
    state: o.state,
    draft: o.draft === true,
    headSha,
    baseRef: base.ref,
    defaultBranch,
    baseRepo,
    headRepo: headRepoObj && typeof headRepoObj.full_name === "string" ? headRepoObj.full_name : null,
    labels: arr(o.labels ?? []).map((l) => {
      const name = rec(l).name;
      if (typeof name !== "string") throw new Error("unexpected response shape");
      return name;
    }),
    additions: num(o.additions),
    deletions: num(o.deletions),
    changedFiles: num(o.changed_files),
  };
}

export interface ReviewRecord {
  id: number;
  login: string;
  state: string;
  commitId: string | null;
}

export async function listReviews(gh: GhApi, repo: string, number: number): Promise<ReviewRecord[]> {
  checkRepo(repo);
  const all: ReviewRecord[] = [];
  for (let page = 1; page <= 5; page++) {
    const rows = arr(await gh({ path: `repos/${repo}/pulls/${number}/reviews`, query: { per_page: 100, page } }));
    for (const r of rows) {
      const o = rec(r);
      const user = o.user === null || o.user === undefined ? null : rec(o.user);
      if (!Number.isInteger(o.id) || typeof o.state !== "string") throw new Error("unexpected response shape");
      all.push({
        id: o.id as number,
        login: user && typeof user.login === "string" ? user.login : "",
        state: o.state,
        commitId: typeof o.commit_id === "string" ? o.commit_id : null,
      });
    }
    if (rows.length < 100) return all;
  }
  throw new Error("review list too long to read completely");
}

/**
 * The merge base of `baseRef` and `headSha` — the commit the reviewed diff starts from. `per_page: 1` trims the commit list (the files the
 * PR's own size caps already bound are still returned; only `merge_base_commit.sha` is read). Probed live: a 40-hex sha.
 * Throws on any failure, a missing/short sha included; the caller then has no merge base and therefore no verdict it can bind.
 */
export async function fetchMergeBase(gh: GhApi, repo: string, baseRef: string, headSha: string): Promise<string> {
  checkRepo(repo);
  checkSha(headSha);
  const o = rec(await gh({ path: `repos/${repo}/compare/${encodeURIComponent(baseRef)}...${headSha}`, query: { per_page: 1 } }));
  const sha = rec(o.merge_base_commit).sha;
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("unexpected response shape");
  return sha;
}

/**
 * The diff from `mergeBaseSha` to `headSha`, pinned by both SHAs (probed live: byte-identical to the three-dot diff of the base ref, because
 * the merge base is an ancestor of the head). Never takes a ref name: a branch can move between two reads, a SHA cannot.
 */
export async function fetchDiffBySha(gh: GhApi, repo: string, mergeBaseSha: string, headSha: string): Promise<string> {
  checkRepo(repo);
  checkSha(mergeBaseSha);
  checkSha(headSha);
  const out = await gh({ path: `repos/${repo}/compare/${mergeBaseSha}...${headSha}`, accept: "application/vnd.github.diff" });
  if (typeof out !== "string") throw new Error("unexpected response shape");
  return out;
}

// ───────────────────────────── CODEOWNERS ─────────────────────────────

export type CodeownersState =
  | { kind: "ok" }
  | { kind: "errors"; items: string[] }
  /** No CODEOWNERS file exists at the ref in any of the three places GitHub looks (confirmed, not assumed from a 404) */
  | { kind: "absent" };

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/**
 * `GET codeowners/errors?ref=<head>` has errors → `errors`. A 404 is ambiguous (no file, or no access), so it is resolved against the
 * contents API: all three CODEOWNERS locations also 404 → `absent`; any of them answers → the endpoint is inconsistent → throws.
 * Any other failure throws (the caller leaves no verdict).
 */
export async function codeownersState(gh: GhApi, repo: string, headSha: string): Promise<CodeownersState> {
  checkRepo(repo);
  checkSha(headSha);
  try {
    const o = rec(await gh({ path: `repos/${repo}/codeowners/errors`, query: { ref: headSha } }));
    const errors = arr(o.errors ?? []);
    if (errors.length === 0) return { kind: "ok" };
    const items = errors.slice(0, 20).map((e) => {
      const x = rec(e);
      const line = Number.isInteger(x.line) ? `line ${x.line}` : "line ?";
      const kind = typeof x.kind === "string" ? x.kind : "error";
      const message = typeof x.message === "string" ? x.message.split("\n")[0].slice(0, 160) : "";
      return `${line}: ${kind}${message ? ` — ${message}` : ""}`;
    });
    return { kind: "errors", items };
  } catch (err) {
    if (!(err instanceof GhError) || err.status !== 404) throw err;
  }
  for (const p of CODEOWNERS_PATHS) {
    try {
      await gh({ path: `repos/${repo}/contents/${p}`, query: { ref: headSha } });
      throw new Error("CODEOWNERS exists but its error report is unavailable");
    } catch (err) {
      if (err instanceof GhError && err.status === 404) continue;
      throw err;
    }
  }
  return { kind: "absent" };
}

// ───────────────────────────── check runs ─────────────────────────────

export interface CheckRunRecord {
  id: number;
  status: string;
  conclusion: string | null;
  externalId: string | null;
  appId: number | null;
  appSlug: string | null;
}

/**
 * Every `studiob-ai-review` check run on the SHA (any source), as records. The caller filters by app.
 * `filter: "all"` is load-bearing: the endpoint's default is `latest` — one run per check name — so after a deterministic failure (a hold)
 * the earlier MODEL verdict would be invisible, and lifting the hold would cost a new model review instead of re-using the cache.
 */
export async function listReviewCheckRuns(gh: GhApi, repo: string, headSha: string): Promise<CheckRunRecord[]> {
  checkRepo(repo);
  checkSha(headSha);
  const o = rec(await gh({ path: `repos/${repo}/commits/${headSha}/check-runs`, query: { check_name: CHECK_NAME, filter: "all", per_page: 100 } }));
  return arr(o.check_runs ?? []).map((r) => {
    const x = rec(r);
    const app = x.app === null || x.app === undefined ? null : rec(x.app);
    if (!Number.isInteger(x.id) || typeof x.status !== "string") throw new Error("unexpected response shape");
    return {
      id: x.id as number,
      status: x.status,
      conclusion: typeof x.conclusion === "string" ? x.conclusion : null,
      externalId: typeof x.external_id === "string" ? x.external_id : null,
      appId: app && Number.isInteger(app.id) ? (app.id as number) : null,
      appSlug: app && typeof app.slug === "string" ? app.slug : null,
    };
  });
}

export interface CheckRunPayload {
  headSha: string;
  conclusion: "success" | "failure";
  externalId: string;
  title: string;
  summary: string;
}

export async function createCheckRun(gh: GhApi, repo: string, p: CheckRunPayload): Promise<void> {
  checkRepo(repo);
  checkSha(p.headSha);
  await gh({
    method: "POST",
    path: `repos/${repo}/check-runs`,
    body: {
      name: CHECK_NAME,
      head_sha: p.headSha,
      status: "completed",
      conclusion: p.conclusion,
      external_id: p.externalId,
      output: { title: p.title.slice(0, 255), summary: p.summary },
    },
  });
}
