/**
 * Review F3 (high) — the herd. With strict protection every merge makes every other open PR in the
 * repo BEHIND. Before this fix each eligible PR re-updated after every sibling merge (O(k²) update-branch
 * calls, CI runs and paid reviews), the gate's own merges spent every sibling's 3/24h cap, 'update the
 * branch by hand' asks reached Kevin from routine crew work, and a capped PR was never looked at again
 * (its fingerprint never changed — the sweep skipped it forever).
 *
 * This is a MULTI-SWEEP simulation through the real pieces, in the hourly cadence of the real sweep:
 *   - the real `evaluate()` (pr-automerge-gate.ts) for every changed entry, in enumeration order;
 *   - the real sweep filter `fingerprintOf` + `splitChanged` (fleet-sweep-changed.ts), recorded at
 *     enumeration exactly as `--record` does;
 *   - a stateful fake GitHub with strict-protection semantics: a PR is CLEAN only when its base is
 *     main's tip and its CI has landed, a merge of a non-CLEAN PR is REFUSED, update-branch mints a new
 *     head and restarts CI, comments carry author + time (so the gate's markers are what it reads back).
 * Only `node:child_process` (gh) and the Anthropic client are mocked. The jq the gate sends is emulated
 * by the fake (its shape is verified separately against live gh).
 *
 *   POSITIVE  k = 4, 5, 6 eligible PRs, all BEHIND, one strict repo, run to quiescence: every PR merges,
 *             at most ONE update-branch per sweep, exactly k in total (each PR updated once), every PR
 *             charged exactly one attempt, ZERO decision lines enrolled — nothing reaches Kevin.
 *   CAP       one PR whose base is moved by a HUMAN every sweep (not the gate): updates 1-3, capped on
 *             the 4th (one decision, idempotent key), then — with nothing on the PR changing — it is
 *             looked at again every sweep and updated again once the 24h window has rolled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintOf, splitChanged } from "../fleet-sweep-changed.js";
import { BEHIND_MARKER, BEHIND_UPDATE_CAP, MERGED_MARKER } from "../behind-update.js";
import { GATE_AUTHORITY_LOGIN } from "../label-authority.js";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const anthropicClientSpy = vi.hoisted(() => vi.fn());
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: anthropicClientSpy }));
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluate } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/power-unit";
const HOUR = 3_600_000;
const GATE_SHA = "gate-sha";

interface SimPr { n: number; head: string; base: number; ciDone: boolean; open: boolean; merged: boolean }
interface SimComment { n: number; user: string; body: string; at: number }

let main: number;
let prs: SimPr[];
let comments: SimComment[];
let t: number;
let headSeq: number;
let sweepNo: number;
let putLog: { sweep: number; pr: number }[];
let mergeLog: { sweep: number; pr: number }[];
let evalLog: { sweep: number; pr: number }[];
let doorCalls: { url: string; key?: string }[];
let state: Record<string, { fp: string; at: string }>;

const find = (n: number): SimPr => {
  const p = prs.find((x) => x.n === n);
  if (!p) throw new Error(`sim: no PR ${n}`);
  return p;
};
const statusOf = (p: SimPr): string => (!p.open ? "CLOSED" : p.base !== main ? "BEHIND" : !p.ciDone ? "BLOCKED" : "CLEAN");
// pg-enum-drift-exempt: GitHub check-run status field, not a Postgres enum
const rollupOf = (p: SimPr) => (p.ciDone ? [{ name: "syntax", status: "COMPLETED", conclusion: "SUCCESS" }] : [{ name: "syntax", status: "IN_PROGRESS" }]);
const prJson = (p: SimPr) => ({
  author: { login: "kbibelhausen" }, labels: [{ name: "fleet-internal" }], state: "OPEN", isDraft: false, mergeStateStatus: statusOf(p),
  additions: 2, deletions: 0, headRefOid: p.head, baseRefName: "main", statusCheckRollup: rollupOf(p), files: [{ path: "hook_x.py" }], changedFiles: 1,
});
const DIFF = ["diff --git a/hook_x.py b/hook_x.py", "index 1111111..2222222 100644", "--- a/hook_x.py", "+++ b/hook_x.py", "@@ -1 +1,3 @@", " import os", "+import sys", "+print(sys.argv)", ""].join("\n");
const NEUTRAL_TIMELINE = JSON.stringify({
  data: { repository: { pullRequest: { timelineItems: { filteredCount: 1, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [{ __typename: "PullRequestCommit" }] } } } },
});

function installGitHub(): void {
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "sleep") return "";
    const a = args.join(" ");
    let m: RegExpExecArray | null;
    if (/^pr view \d+ --repo \S+ --json comments/.test(a)) return "0";
    if ((m = /^pr view (\d+) --repo \S+ --json author/.exec(a))) return JSON.stringify(prJson(find(Number(m[1]))));
    if (a.includes("/compare/")) return DIFF;
    if (a.startsWith("api graphql")) return NEUTRAL_TIMELINE;
    if (a.includes("/issues/comments?since=")) {
      // emulates the gate's jq: one tab-separated line per marker comment, any author (the gate filters the login)
      return comments
        .filter((c) => c.body.startsWith(BEHIND_MARKER) || c.body.startsWith(MERGED_MARKER))
        .map((c) => `${c.user}\t${c.body.startsWith(MERGED_MARKER) ? "merged" : "update"}\t${c.n}\t${new Date(c.at).toISOString()}`)
        .join("\n");
    }
    if ((m = /^api repos\/\S+\/pulls\/(\d+) --jq \.state$/.exec(a))) return find(Number(m[1])).open ? "open\n" : "closed\n";
    if ((m = /^pr comment (\d+) --repo \S+ --body/.exec(a))) {
      comments.push({ n: Number(m[1]), user: GATE_AUTHORITY_LOGIN, body: args[args.indexOf("--body") + 1], at: t });
      return "";
    }
    if ((m = /^api -X PUT repos\/\S+\/pulls\/(\d+)\/update-branch -f expected_head_sha=(\S+)$/.exec(a))) {
      const p = find(Number(m[1]));
      if (p.head !== m[2]) throw Object.assign(new Error("Command failed: gh api"), { stderr: "gh: expected head sha didn't match (HTTP 422)" });
      p.head = `head-${++headSeq}`;
      p.base = main;
      p.ciDone = false; // CI restarts on the merge commit; it lands within the hour
      putLog.push({ sweep: sweepNo, pr: p.n });
      return '{"message":"Updating pull request branch."}';
    }
    if ((m = /^pr merge (\d+) --repo \S+ --squash --match-head-commit (\S+)$/.exec(a))) {
      const p = find(Number(m[1]));
      if (p.head !== m[2] || statusOf(p) !== "CLEAN") throw Object.assign(new Error("Command failed: gh pr merge"), { stderr: "GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge." });
      p.merged = true;
      p.open = false;
      main += 1; // every other open PR is now BEHIND
      mergeLog.push({ sweep: sweepNo, pr: p.n });
      return "";
    }
    if (a.startsWith("pr edit") || a.includes("/labels")) return "";
    throw new Error(`unexpected gh invocation in the herd sim: ${a}`);
  });
}

/** One hourly sweep, the way squasher-fleet-sweep.yml runs it: enumerate → fingerprint filter (recorded at enumeration) → gate each changed entry. */
async function sweep(humanMergesFirst = false): Promise<void> {
  sweepNo += 1;
  t += HOUR;
  vi.setSystemTime(t);
  if (humanMergesFirst) main += 1; // a HUMAN lands something on main — not the gate
  for (const p of prs) if (p.open) p.ciDone = true; // CI always lands within the hour
  const entries = prs.filter((p) => p.open).map((p) => ({ repo: REPO, pr_number: String(p.n) }));
  const live: Record<string, string> = {};
  for (const e of entries) {
    const p = find(Number(e.pr_number));
    live[`${e.repo}#${e.pr_number}`] = fingerprintOf({ headRefOid: p.head, statusCheckRollup: rollupOf(p) as never, labels: [{ name: "fleet-internal" }], mergeStateStatus: statusOf(p), isDraft: false }, GATE_SHA, t);
  }
  const { changed } = splitChanged(entries, live, state);
  for (const e of changed) state[`${e.repo}#${e.pr_number}`] = { fp: live[`${e.repo}#${e.pr_number}`], at: new Date(t).toISOString() };
  for (const e of changed) {
    evalLog.push({ sweep: sweepNo, pr: Number(e.pr_number) });
    await evaluate(REPO, Number(e.pr_number), ["fleet-internal"] as never, [], [], ["syntax"], []);
  }
}

function newRepo(k: number): void {
  main = 1;
  prs = Array.from({ length: k }, (_, i) => ({ n: 100 + i, head: `head-0-${i}`, base: 0, ciDone: true, open: true, merged: false })); // all BEHIND at t0
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  t = Date.parse("2026-10-20T00:11:00Z");
  vi.setSystemTime(t);
  comments = [];
  headSeq = 0;
  sweepNo = 0;
  putLog = [];
  mergeLog = [];
  evalLog = [];
  doorCalls = [];
  state = {};
  execFileSyncMock.mockReset();
  anthropicClientSpy.mockReset();
  anthropicClientSpy.mockImplementation(() => ({ messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "CLEAN" }] }) } }));
  process.env.WEBHOOK_ROUTER_URL = "http://door.test";
  process.env.SEAT_INBOX_TOKEN = "test-token";
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    doorCalls.push({ url, key: JSON.parse(init.body).enrollment_key });
    return { status: 200, text: async () => '{"created":true}' };
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  installGitHub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.WEBHOOK_ROUTER_URL;
  delete process.env.SEAT_INBOX_TOKEN;
});

const asks = () => doorCalls.filter((c) => c.url.endsWith("/internal/cos/decisions")); // Kevin-facing decision lines (not the merge-time resolve)
const attemptsBy = (n: number) => comments.filter((c) => c.n === n && c.body.startsWith(BEHIND_MARKER)).length;

describe("the herd — k eligible PRs in one strict repo, all BEHIND, across many sweeps", () => {
  it.each([4, 5, 6])("POSITIVE: k=%i ⇒ every PR merges, at most ONE update-branch per sweep, exactly k in total, one attempt charged per PR, nothing enrolled for Kevin", async (k) => {
    newRepo(k);
    for (let i = 0; i < 2 * k + 4 && prs.some((p) => p.open); i++) await sweep();

    expect(prs.every((p) => p.merged)).toBe(true); // quiescence: the queue drained
    expect(mergeLog.map((m) => m.pr).sort()).toEqual(prs.map((p) => p.n)); // each merged exactly once, never refused-then-retried into a duplicate
    expect(putLog).toHaveLength(k); // O(k), not O(k²)
    for (let s = 1; s <= sweepNo; s++) expect(putLog.filter((p) => p.sweep === s).length).toBeLessThanOrEqual(1); // one gate update per repo per sweep
    for (const p of prs) expect(attemptsBy(p.n)).toBe(1); // a deferred PR is never charged
    expect(asks()).toHaveLength(0); // the routine case never reaches Kevin
    expect(anthropicClientSpy.mock.calls.length).toBe(k); // a paid review per PR that merges — none burned on a head that was about to be replaced
  });
});

describe("the cap — a PR whose base is moved by a HUMAN every sweep", () => {
  it("CAP: three updates, then capped with ONE decision line; looked at every sweep with nothing on the PR changing; updated again once the 24h window has rolled", async () => {
    newRepo(1);
    for (let i = 0; i < 27; i++) await sweep(true);

    const putSweeps = putLog.map((p) => p.sweep);
    expect(putSweeps.slice(0, BEHIND_UPDATE_CAP + 1)).toEqual([1, 2, 3, 25]); // 1-3 charged; 4..24 capped; 25: the first attempt aged out
    expect(new Set(asks().map((c) => c.key)).size).toBe(1); // one decision line (idempotent per head), not a stream
    // nothing on the PR changed between sweeps 4 and 24 (same head, same checks, BEHIND) — yet it was evaluated at every one of them
    for (let s = 4; s <= 24; s++) expect(evalLog.some((e) => e.sweep === s && e.pr === 100)).toBe(true);
    expect(prs[0].merged).toBe(false); // the human keeps moving main faster than CI; the gate never merged it
  });
});
