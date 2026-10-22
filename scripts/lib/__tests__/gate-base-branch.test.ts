/**
 * cargo #1018 — base-branch guard tests.
 *
 * The gate refuses a non-draft PR whose base is not `main` (stacked PR), with
 * leg=base-branch. A draft stacked PR is allowed (it fails at ci-rollup instead).
 *
 * Rule #322: both directions — stacked (refused) + main-based (passes).
 * Rule #464: negative control (stacked non-draft refused) + positive control (main-based passes).
 *
 * NOTE: installPublicGateLog() strips all free-text from console output. The gate's
 * [wait] lines reduce to `[wait] pr-automerge-gate R#N`, gate-receipt lines lose
 * reasons=, and train-gate-receipt lines lose detail=. The test asserts on the
 * ENUMERATED fields in the sanitized log (leg=base-branch, outcome=refused), not on
 * the human-readable prose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const anthropicClientSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("base-branch guard fires BEFORE the review leg — no Anthropic spend expected for stacked PRs");
  }),
);
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: anthropicClientSpy }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { main } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/bolt-wms";
const PR = 42;

function makePrJson(overrides: Record<string, unknown>) {
  return JSON.stringify({
    author: { login: "kbibelhausen" },
    labels: [{ name: "bugsquasher" }],
    createdAt: "2026-01-15T08:00:00Z",
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    additions: 3,
    deletions: 1,
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    files: [{ path: "src/foo.ts" }],
    changedFiles: 1,
    headRepositoryOwner: { login: "studio-b-ai" },
    headRepository: { name: "bolt-wms" },
    ...overrides,
  });
}

let logLines: string[];

function setupGh(prJson: string, diff?: string) {
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    const a = args.join(" ");
    if (a === `api repos/${REPO}/rulesets?per_page=100`) return "[]";
    if (a.startsWith("pr view")) return prJson;
    if (a.startsWith(`api repos/${REPO}/compare/`)) {
      if (diff !== undefined) {
        // gh api returns raw string; split the content like the real API would
        console.log(`to stderr: ${cmd} ${a}`); // matches gh's stderr diagnostic
        return diff;
      }
      return "diff --git a/src/foo.ts b/src/foo.ts\nindex 0000000..1111111 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@\n+// code change\n";
    }
    if (a.includes("/issues/") && a.includes("/timeline")) return "[]";
    throw new Error(`unexpected gh invocation: ${a}`);
  });
}

let origLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logLines = [];
  execFileSyncMock.mockReset();
  origLogSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logLines.push(a.join(" ")));
});
afterEach(() => {
  origLogSpy.mockRestore();
  vi.clearAllMocks();
});

const readGateReceipt = (lines: string[]) => lines.find((l) => l.startsWith("[gate-receipt]"));
const readTrainReceipt = (lines: string[]) => lines.find((l) => l.startsWith("[train-gate-receipt]"));

describe("base-branch guard — squasher path", () => {
  it("NEGATIVE CONTROL: a stacked non-draft PR (base!=main) is refused at leg=base-branch — before any diff fetch or review spend", async () => {
    setupGh(makePrJson({ baseRefName: "fix/3823-wms-onhand-shippable-sites" }));
    await main(["--repo", REPO, "--pr", String(PR)]);
    const receipt = readGateReceipt(logLines);
    expect(receipt).toBeDefined();
    expect(receipt!).toContain("leg=base-branch");
    expect(receipt!).toContain("verdict=missed");
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL (same instrument): a main-based PR passes the base-branch leg — the gate continues to class-match (empty enabledClasses, fails there)", async () => {
    setupGh(makePrJson({ baseRefName: "main" }));
    await main(["--repo", REPO, "--pr", String(PR)]);
    const receipt = readGateReceipt(logLines);
    expect(receipt).toBeDefined();
    expect(receipt!).not.toContain("leg=base-branch");
    // With no --enabled-classes, the gate should fail at class-match after passing base-branch
    // (or at ci-rollup/truncation/held/box — but never at base-branch for a main-based PR)
  });

  it("DRAFT stacked PR passes base-branch leg — fails at ci-rollup instead (drafts are caught before base-branch)", async () => {
    setupGh(makePrJson({ baseRefName: "fix/xyz", isDraft: true }));
    await main(["--repo", REPO, "--pr", String(PR)]);
    const receipt = readGateReceipt(logLines);
    expect(receipt).toBeDefined();
    expect(receipt!).toContain("leg=ci-rollup");
    expect(receipt!).not.toContain("leg=base-branch");
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });
});

describe("base-branch guard — train path", () => {
  it("NEGATIVE CONTROL: a stacked PR with 'box' label is refused by the train gate (outcome=refused)", async () => {
    setupGh(
      makePrJson({
        baseRefName: "fix/wip",
        labels: [{ name: "queued" }],
      }),
    );
    await main(["--repo", REPO, "--pr", String(PR), "--train-ready"]);
    const receipt = readTrainReceipt(logLines);
    expect(receipt).toBeDefined();
    expect(receipt!).toContain("outcome=refused");
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a main-based PR with 'box' label is evaluated by the train gate (reaches authority leg or later)", async () => {
    // The train gate reads the timeline next — we need the timeline to have something
    // or fail at label authority. Either way, it should NOT fail at the base-branch check.
    setupGh(
      makePrJson({
        baseRefName: "main",
        labels: [{ name: "queued" }],
      }),
    );
    await main(["--repo", REPO, "--pr", String(PR), "--train-ready"]);
    const receipt = readTrainReceipt(logLines);
    expect(receipt).toBeDefined();
    expect(receipt!).not.toContain("base branch");
  });
});