/**
 * Stint #951 (2026-09-27) — the fleet sweep's merge call now retries the DIAGNOSED
 * "Base branch was modified" stale-base recompute IN-RUN instead of bouncing the
 * boxed PR to the next hourly sweep. Live regression: squasher-fleet-sweep run
 * 36258616307 refused studio-b-ai/chassis#917 with
 * `GraphQL: Base branch was modified. Review and try the merge again.
 * (mergePullRequest)` while the head pin (c94e310…) never moved — the same sha
 * merged 67 minutes later on the next sweep, a full hour per collision on a main
 * that lands seat receipts every minute.
 *
 * These tests import the REAL `evaluateTrainReady` from pr-automerge-gate.ts
 * (Rule #223 — never a self-assembled copy) and drive it against a mocked
 * `node:child_process` (every `gh` call, including mergePr's REST head re-read and
 * the settle `sleep`, funnels through `execFileSync`).
 *
 *   POSITIVE (#322 known-good): base-modified once, head re-read SAME sha, retry
 *             merges ⇒ outcome "merged", 2 merge calls, retry happened in-run.
 *   NEGATIVE (undiagnosed class): a branch-protection error is NEVER retried —
 *             exactly 1 merge call, no head re-read, "merge-attempt-failed".
 *   NEGATIVE (real TOCTOU): base-modified but the head re-read returns a DIFFERENT
 *             sha ⇒ abort immediately, exactly 1 merge call (the sha pin's reason
 *             for existing is never retried past, Rules #109/#161).
 *   NEGATIVE (exhaustion): base-modified on all 3 attempts ⇒ 3 merge calls then
 *             "merge-attempt-failed" — the bound holds, next sweep owns the PR.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const anthropicClientSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("train path must NEVER build an Anthropic client (stint #372)");
  }),
);
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: anthropicClientSpy }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluateTrainReady } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/chassis";
const PR = 917;
const HEAD = "c94e3104076a164c95232957127019d38ce2b55e"; // the live run's pin — it never moved
const OTHER_HEAD = "1111111111111111111111111111111111111111";
const BASE_MODIFIED_ERROR =
  'Command failed: gh pr merge 917 --repo studio-b-ai/chassis --squash --match-head-commit ' +
  `${HEAD}\nGraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)`;

function prJson(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    author: { login: "kbibelhausen" },
    labels: [{ name: "box" }],
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    additions: 10,
    deletions: 2,
    headRefOid: HEAD,
    baseRefName: "main",
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    files: [{ path: "receipts/x.md" }],
    changedFiles: 1,
    ...over,
  });
}

const TIMELINE_BOX_AFTER_HEAD = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        timelineItems: {
          filteredCount: 2,
          pageInfo: { hasPreviousPage: false, startCursor: null },
          nodes: [
            { __typename: "PullRequestCommit" },
            { __typename: "LabeledEvent", label: { name: "box" }, actor: { __typename: "User", login: "kbibelhausen" }, createdAt: "2026-09-26T17:00:00Z" },
          ],
        },
      },
    },
  },
});

type GhCall = string[];
let ghCalls: GhCall[];

/** mergeBehavior: array of per-attempt outcomes — "ok" succeeds, any other string
 *  is thrown as the merge error. Length caps the merge calls the test allows. */
function dispatch(opts: { mergeBehavior: string[]; headOnReRead?: string }) {
  let mergeAttempt = 0;
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    ghCalls.push([cmd, ...args]);
    if (cmd === "sleep") return "";
    const a = args.join(" ");
    if (a.startsWith("pr view")) return prJson();
    if (a.startsWith("api graphql")) return TIMELINE_BOX_AFTER_HEAD;
    if (a.startsWith(`api repos/${REPO}/pulls/${PR}`)) return `${opts.headOnReRead ?? HEAD}\n`;
    if (a.startsWith("pr merge")) {
      mergeAttempt += 1;
      const behavior = opts.mergeBehavior[mergeAttempt - 1];
      if (behavior === undefined) throw new Error(`test fixture exhausted: merge attempt ${mergeAttempt} was not scripted`);
      if (behavior !== "ok") throw new Error(behavior);
      return "";
    }
    if (a.startsWith("pr comment")) return "";
    throw new Error(`unexpected gh invocation in base-modified retry test: ${a}`);
  });
}

const merges = () => ghCalls.filter((c) => c.slice(1).join(" ").startsWith("pr merge"));
const headReReads = () => ghCalls.filter((c) => c.slice(1).join(" ").startsWith(`api repos/${REPO}/pulls/${PR}`));
const sleeps = () => ghCalls.filter((c) => c[0] === "sleep");

beforeEach(() => {
  ghCalls = [];
  execFileSyncMock.mockReset();
  anthropicClientSpy.mockClear();
});

describe("mergePr — in-run retry on the diagnosed 'Base branch was modified' stale-base recompute (stint #951)", () => {
  it("POSITIVE: base-modified once + head unchanged ⇒ the retry merges in-run (the chassis#917 regression fixed)", async () => {
    dispatch({ mergeBehavior: [BASE_MODIFIED_ERROR, "ok"] });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(merges()).toHaveLength(2);
    expect(merges()[0].join(" ")).toContain(`--match-head-commit ${HEAD}`);
    expect(merges()[1].join(" ")).toContain(`--match-head-commit ${HEAD}`); // SAME pin on the retry
    expect(headReReads()).toHaveLength(1); // one settle + head re-read between attempts
    expect(sleeps().length).toBeGreaterThanOrEqual(1); // a real wait for the recompute (#382)
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("NEGATIVE: an undiagnosed failure class (branch protection) is NEVER retried — the #109/#161 contract stands", async () => {
    dispatch({ mergeBehavior: ["Command failed: gh pr merge …\nGraphQL: Branch is protected. (mergePullRequest)"] });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merge-attempt-failed");
    expect(merges()).toHaveLength(1);
    expect(headReReads()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("NEGATIVE: base-modified but the head MOVED on the re-read ⇒ real TOCTOU, aborted not retried", async () => {
    dispatch({ mergeBehavior: [BASE_MODIFIED_ERROR], headOnReRead: OTHER_HEAD });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merge-attempt-failed");
    expect(res.detail).toContain("real TOCTOU");
    expect(merges()).toHaveLength(1); // the retry merge never fires once the pin's sha is gone
    expect(headReReads()).toHaveLength(1);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("NEGATIVE: base-modified on every attempt ⇒ bounded at 3, then deferred to the next sweep", async () => {
    dispatch({ mergeBehavior: [BASE_MODIFIED_ERROR, BASE_MODIFIED_ERROR, BASE_MODIFIED_ERROR] });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merge-attempt-failed");
    expect(res.detail).toContain("all 3 attempts");
    expect(merges()).toHaveLength(3);
    expect(headReReads()).toHaveLength(2); // settle + re-read before attempts 2 and 3 only
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });
});
