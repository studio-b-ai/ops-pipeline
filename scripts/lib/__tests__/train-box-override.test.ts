/**
 * Stint #372 (2026-09-19) — the box ruling on the TRAIN path, both directions (#322):
 * `box` opens EVERY decision leg (review included); only the CI rollup / mergeable
 * floor stands. Regression: client-asthetik#391 refused 07:0xZ on "review verdict
 * FLAG 0/3" with Kevin's box present (run 34939031962 job 104283427915).
 *
 * These tests import the REAL `evaluateTrainReady` from pr-automerge-gate.ts
 * (Rule #223 — never a self-assembled copy) and drive it against a mocked
 * `node:child_process` (every `gh` call in this file AND in lib/label-authority.ts
 * funnels through `execFileSync`). The Anthropic client is a throwing spy: the
 * train path must NEVER spend on the model vote again.
 *
 *   POSITIVE: box + green rollup + CLEAN, carrying the post-FLAG `needs-human`
 *             label (the #391 state) ⇒ outcome "merged", SHA-pinned merge fired.
 *   NEGATIVE: box + DIRTY mergeStateStatus (brain#160 this run) ⇒ "refused", no merge.
 *   NEGATIVE: box + red rollup / UNSTABLE (client-asthetik#372 this run) ⇒
 *             "refused", no merge.
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

const REPO = "studio-b-ai/client-asthetik";
const PR = 391;
const HEAD = "391a1b2c3d4e5f6391a1b2c3d4e5f6391a1b2c3d";

function prJson(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    author: { login: "kbibelhausen" },
    labels: [{ name: "box" }, { name: "needs-human" }], // needs-human = the standing FLAG card state from run 34939031962
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    additions: 10,
    deletions: 2,
    headRefOid: HEAD,
    baseRefName: "main",
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    files: [{ path: "src/x.ts" }],
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
            { __typename: "LabeledEvent", label: { name: "box" }, actor: { __typename: "User", login: "kbibelhausen" }, createdAt: "2026-09-19T07:00:00Z" },
          ],
        },
      },
    },
  },
});

type GhCall = string[];
let ghCalls: GhCall[];

function dispatch(prViewBody: string) {
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    ghCalls.push([cmd, ...args]);
    if (cmd === "sleep") return "";
    const a = args.join(" ");
    if (a.startsWith("pr view")) return prViewBody;
    if (a.startsWith("api graphql")) return TIMELINE_BOX_AFTER_HEAD;
    if (a.startsWith("pr merge")) return "";
    if (a.startsWith("pr comment")) return "";
    throw new Error(`unexpected gh invocation in train-path test: ${a}`);
  });
}

const merges = () => ghCalls.filter((c) => c.slice(1).join(" ").startsWith("pr merge"));
const comments = () => ghCalls.filter((c) => c.slice(1).join(" ").startsWith("pr comment"));

beforeEach(() => {
  ghCalls = [];
  execFileSyncMock.mockReset();
  anthropicClientSpy.mockClear();
});

describe("evaluateTrainReady — box opens the review leg (stint #372)", () => {
  it("POSITIVE: box + green rollup + CLEAN merges even carrying the post-FLAG needs-human — and never touches Anthropic", async () => {
    dispatch(prJson());
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(merges()).toHaveLength(1);
    expect(merges()[0].join(" ")).toContain(`--match-head-commit ${HEAD}`);
    expect(comments().length).toBeGreaterThanOrEqual(1); // the merge receipt
    expect(comments()[0].join(" ")).toContain("overridden by `box`");
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("NEGATIVE: box + DIRTY mergeStateStatus still refuses (the mergeable floor stands)", async () => {
    dispatch(prJson({ mergeStateStatus: "DIRTY" }));
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(merges()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("NEGATIVE: box + red rollup (UNSTABLE, failing check) still refuses (the CI floor stands)", async () => {
    dispatch(
      prJson({
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    );
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(merges()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });
});
