/**
 * Stint #951 / L2D-04 (2026-09-26) — the fleet sweep's SHA-pinned merge call is
 * retried IN-RUN when (and only when) GitHub answers "Base branch was modified.
 * Review and try the merge again." Regression: chassis#917, boxed 16:59Z, merge
 * failed 17:24Z with that exact error, NOT retried in the run (outcome
 * merge-attempt-failed), merged 18:31Z by the NEXT sweep — 1h32m of wait on a
 * main that moves every minute (the stint flusher).
 *
 * These tests import the REAL `evaluateTrainReady` from pr-automerge-gate.ts
 * (Rule #223 — never a self-assembled copy) and drive it against a mocked
 * `node:child_process`, asserting on what the mock CAPTURED (merge count, the
 * unchanged `--match-head-commit` pin, the [merge-retry-after-base-move] log).
 *
 *   POSITIVE (#471 — the guard's non-default verdict is a MERGE): base-move on
 *             attempt 1, success on attempt 2 ⇒ outcome "merged", exactly 2 merge
 *             calls, both pinned to the SAME head sha, receipt says "on attempt 2".
 *   NEGATIVE: base-move on every attempt ⇒ "merge-attempt-failed", exactly 3 merge
 *             calls (the budget), never a 4th.
 *   NEGATIVE: a different merge error ⇒ exactly 1 merge call, no retry (the
 *             Rules #109/#161 no-same-cycle-retry law stands for every other class).
 *   NEGATIVE: base-move but the head SHA moved on the re-read ⇒ exactly 1 merge
 *             call — the real TOCTOU race aborts the retry; the pin is never chased.
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
const HEAD = "917a1b2c3d4e5f6917a1b2c3d4e5f6917a1b2c3d";
const MOVED_HEAD = "999a1b2c3d4e5f6999a1b2c3d4e5f6999a1b2c3d";

function prJson(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    author: { login: "kbibelhausen" },
    labels: [{ name: "box" }],
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    additions: 4,
    deletions: 1,
    headRefOid: HEAD,
    baseRefName: "main",
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    files: [{ path: "library/x.md" }],
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
            { __typename: "LabeledEvent", label: { name: "box" }, actor: { __typename: "User", login: "kbibelhausen" }, createdAt: "2026-09-26T16:59:00Z" },
          ],
        },
      },
    },
  },
});

const BASE_MOVE = "GraphQL: Base branch was modified. Review and try the merge again.";
const OTHER_ERROR = "GraphQL: Branch is protected by a required status check.";

type MergeStep = "ok" | "base-move" | "other";
type GhCall = string[];
let ghCalls: GhCall[];
let logSpy: ReturnType<typeof vi.spyOn>;

function dispatch(mergeScript: MergeStep[], opts: { moveHeadAfterFirstFailure?: boolean } = {}) {
  let mergeIdx = 0;
  let currentPrBody = prJson();
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    ghCalls.push([cmd, ...args]);
    if (cmd === "sleep") return ""; // mocked: the 20s beats are instant
    const a = args.join(" ");
    if (a.startsWith("pr view")) return currentPrBody;
    if (a.startsWith("api graphql")) return TIMELINE_BOX_AFTER_HEAD;
    if (a.startsWith("pr merge")) {
      const step = mergeScript[Math.min(mergeIdx++, mergeScript.length - 1)];
      if (step === "base-move") {
        if (opts.moveHeadAfterFirstFailure) currentPrBody = prJson({ headRefOid: MOVED_HEAD });
        throw new Error(`Command failed: gh ${a}\n${BASE_MOVE}`);
      }
      if (step === "other") throw new Error(`Command failed: gh ${a}\n${OTHER_ERROR}`);
      return "";
    }
    if (a.startsWith("pr comment")) return "";
    throw new Error(`unexpected gh invocation in merge-retry test: ${a}`);
  });
}

const merges = () => ghCalls.filter((c) => c.slice(1).join(" ").startsWith("pr merge"));
const retryLogs = () =>
  logSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[merge-retry-after-base-move]"));

beforeEach(() => {
  ghCalls = [];
  execFileSyncMock.mockReset();
  anthropicClientSpy.mockClear();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("evaluateTrainReady — merge-retry-after-base-move (stint #951)", () => {
  it("POSITIVE: base-move on attempt 1, success on attempt 2 — merged in-run, pin unchanged, receipt says attempt 2", async () => {
    dispatch(["base-move", "ok"]);
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(res.detail).toContain("on attempt 2");
    expect(res.detail).toContain("merge-retry-after-base-move");
    expect(merges()).toHaveLength(2);
    for (const call of merges()) expect(call.join(" ")).toContain(`--match-head-commit ${HEAD}`);
    expect(retryLogs().length).toBeGreaterThanOrEqual(1);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("NEGATIVE: base-move on every attempt — bounded at 3 merge calls, outcome merge-attempt-failed", async () => {
    dispatch(["base-move", "base-move", "base-move", "base-move"]); // the 4th entry must never be consumed
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merge-attempt-failed");
    expect(merges()).toHaveLength(3);
    expect(retryLogs().some((m) => m.includes("retry budget exhausted"))).toBe(true);
  });

  it("NEGATIVE: a different merge error — exactly 1 merge call, no retry, no retry receipt", async () => {
    dispatch(["other", "ok"]); // "ok" must never be reached
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merge-attempt-failed");
    expect(res.detail).toContain(OTHER_ERROR);
    expect(merges()).toHaveLength(1);
    expect(retryLogs()).toHaveLength(0);
  });

  it("NEGATIVE: base-move but the head moved on the re-read — exactly 1 merge call (the pin is never chased)", async () => {
    dispatch(["base-move", "ok"], { moveHeadAfterFirstFailure: true });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merge-attempt-failed");
    expect(merges()).toHaveLength(1);
    expect(retryLogs().some((m) => m.includes("head moved") && m.includes("ABORTING retry"))).toBe(true);
  });
});
