import { describe, expect, it } from "vitest";
import { mintBoxPatchId, type BoxPatchIdRecord, type CheckRunLike, type GitCommandRunner } from "../box-patch-id.js";
import { buildCheckRunApiArgs, observeBoxPatchId, type ShaWithCheckRuns } from "../box-patch-id-observe.js";

// ───── Fixture plumbing ─────
//
// Rule #223: these tests import the REAL observeBoxPatchId/mintBoxPatchId and assert on what they
// actually compute — no hand-rolled re-implementation of the patch-id or verdict math. The
// "current" patch-id in every scenario below comes from a real mintBoxPatchId() call against a
// mocked GitCommandRunner (matched on args[0] only, so it stays correct regardless of the exact
// flag list box-patch-id.ts passes) — never a value invented by the test.

const REPO = "studio-b-ai/ops-pipeline";
const HEAD_REPO = "studio-b-ai/ops-pipeline";
const BASE_REF = "main";
const LABEL_EVENT_DB_ID = 4242;
const HEAD_SHA = "b".repeat(40);
const BASE_MERGE_BASE_SHA = "c".repeat(40);

function runnerFixture(pidHash: string, diffU0: string): GitCommandRunner {
  return (args: string[]) => {
    if (args[0] === "merge-base") return `${BASE_MERGE_BASE_SHA}\n`;
    if (args[0] === "diff" && args.includes("--raw")) return `${diffU0.length}\tdocs/plants/fixture.md\0`;
    if (args[0] === "diff") return diffU0;
    if (args[0] === "patch-id") return `${pidHash} deadbeef${"0".repeat(32)}\n`;
    throw new Error(`unexpected git args in test fixture: ${JSON.stringify(args)}`);
  };
}

const RUNNER_A = runnerFixture("a".repeat(40), "@@ -1,0 +1,1 @@\n+line A\n");
const RUNNER_B = runnerFixture("f".repeat(40), "@@ -1,0 +1,1 @@\n+line B (different content)\n");
const RUNNER_C = runnerFixture("c".repeat(40), "@@ -1,0 +1,1 @@\n+mint-dry probe\n");
/** Throws at merge-base — the nonexistent-ref path control 5 proves. */
const RUNNER_NONEXISTENT_REF: GitCommandRunner = (args: string[]) => {
  if (args[0] === "merge-base") throw new Error("fatal: Not a valid object name nonexistent-ref");
  throw new Error("unexpected — mint-dry with nonexistent ref should fail at merge-base");
};

function mintFixture(runner: GitCommandRunner, changedPaths: string[] = ["docs/plants/fixture.md"]): BoxPatchIdRecord {
  const verdict = mintBoxPatchId({
    repo: REPO,
    prNumber: 900,
    headRepo: HEAD_REPO,
    headSha: HEAD_SHA,
    baseRef: BASE_REF,
    labelEventDbId: LABEL_EVENT_DB_ID,
    changedPaths,
    runner,
  });
  if (!verdict.ok) throw new Error(`test fixture setup: expected mintBoxPatchId to succeed, got refusal ${verdict.reason}: ${verdict.detail}`);
  return verdict.record;
}

function recordedCheckRun(record: BoxPatchIdRecord): CheckRunLike {
  return { name: "box-patch-id", output: { text: JSON.stringify(record) } };
}

function shas(...entries: Array<[string, readonly CheckRunLike[]]>): ShaWithCheckRuns[] {
  return entries.map(([sha, checkRuns]) => ({ sha, checkRuns }));
}

const BASE_INPUT_FIELDS = {
  repo: REPO,
  prNumber: 900,
  control: "3",
  mode: "observe",
  runId: "123456",
  headSha: HEAD_SHA,
  headRepo: HEAD_REPO,
  baseRef: BASE_REF,
  changedPaths: ["docs/plants/fixture.md"],
};

describe("observeBoxPatchId", () => {
  // ───── Negative controls first (Rule #322): the two "would obviously read wrong" paths ─────

  it("fails closed on mint-dry when no headShaOverride is provided", () => {
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      mode: "mint-dry",
      shasWithCheckRuns: shas(["deadbeef", [recordedCheckRun(mintFixture(RUNNER_A))]]),
    });
    expect(result.verdict).toBe("box-patch-id-observe-unsupported-mode");
    expect(result.recordedPatchId).toBeNull();
    expect(result.headShaOverride).toBeNull();
    expect(result.line).toBe(
      "[box-patch-id observe-only] control=3 repo=studio-b-ai/ops-pipeline pr=900 mode=mint-dry recorded=none current=none verdict=box-patch-id-observe-unsupported-mode unrefreshed=[] moved=[] run=123456",
    );
  });

  // ───── Mint-dry mode (plan section E, crew mechanic stint #865) ─────

  it("mint-dry: surfaces box-patch-id-uncomputable when pointed at a nonexistent ref (control 5 shape)", () => {
    const nonexistentSha = "d".repeat(40);
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      mode: "mint-dry",
      headShaOverride: nonexistentSha,
      runner: RUNNER_NONEXISTENT_REF,
      shasWithCheckRuns: shas(),
    });
    expect(result.verdict).toBe("box-patch-id-uncomputable");
    expect(result.recordedPatchId).toBeNull();
    expect(result.currentPatchId).toBeNull();
    expect(result.headShaOverride).toBe(nonexistentSha);
    expect(result.line).toContain(`overridden=${nonexistentSha}`);
    expect(result.line).toContain("verdict=box-patch-id-uncomputable");
    expect(result.line).toContain("mode=mint-dry");
  });

  it("mint-dry: returns kept with the minted patch-id when pointed at a valid ref", () => {
    const validSha = "b".repeat(40);
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      mode: "mint-dry",
      headShaOverride: validSha,
      runner: RUNNER_C,
      shasWithCheckRuns: shas(),
    });
    expect(result.verdict).toBe("kept");
    expect(result.recordedPatchId).toBeNull(); // never boxed — no recorded check run
    expect(result.currentPatchId).not.toBeNull();
    expect(result.currentPatchId).toContain("bp2:");
    expect(result.headShaOverride).toBe(validSha);
    expect(result.line).toContain(`overridden=${validSha}`);
    expect(result.line).toContain("verdict=kept");
    expect(result.line).toContain("mode=mint-dry");
  });

  it("mint-dry: never reads recorded check runs (control 5 never boxed — the path would be box-patch-id-missing otherwise)", () => {
    // Plant a recorded check run on a sha — mint-dry must not read it.
    const record = mintFixture(RUNNER_A);
    const overrideSha = "d".repeat(40);
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      mode: "mint-dry",
      headShaOverride: overrideSha,
      runner: RUNNER_NONEXISTENT_REF,
      shasWithCheckRuns: shas(["deadbeef", [recordedCheckRun(record)]]),
    });
    // The recorded check run exists but mint-dry never reads it — it goes straight
    // to mintBoxPatchId with the override, which fails at merge-base.
    expect(result.verdict).toBe("box-patch-id-uncomputable");
    expect(result.recordedPatchId).toBeNull();
  });

  it("returns box-patch-id-missing when no commit carries a box-patch-id check run", () => {
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      shasWithCheckRuns: shas(["deadbeef", [{ name: "some-other-check", output: { text: "irrelevant" } }]]),
    });
    expect(result.verdict).toBe("box-patch-id-missing");
    expect(result.recordedPatchId).toBeNull();
    expect(result.currentPatchId).toBeNull();
  });

  // ───── Positive path, split into the scenarios control 2/3/4/6 exist to prove ─────

  it("returns kept when the current patch-id matches and no sha moved (control 4/1 shape)", () => {
    const record = mintFixture(RUNNER_A);
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      runner: RUNNER_A,
      shasWithCheckRuns: shas([record.headSha, [recordedCheckRun(record)]]),
    });
    expect(result.verdict).toBe("kept");
    expect(result.recordedPatchId).toBe(record.patchId);
    expect(result.currentPatchId).toBe(record.patchId);
    expect(result.movedShas).toEqual([]);
    expect(result.unrefreshedShas).toEqual([]);
    expect(result.line).toContain("verdict=kept");
    expect(result.line).toContain("moved=[]");
    expect(result.line).toContain("unrefreshed=[]");
  });

  it("returns kept when a moved sha IS present in the recorded record's refreshShas (a legitimate refresh)", () => {
    const record = mintFixture(RUNNER_A);
    // refreshShas always contains at least the sha it was minted against (record.headSha); a real
    // refresh push would append the new sha too — simulate that here directly.
    const refreshedRecord: BoxPatchIdRecord = { ...record, refreshShas: [...record.refreshShas, "refreshed-sha-1"] };
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      runner: RUNNER_A,
      shasWithCheckRuns: shas(
        [record.headSha, [recordedCheckRun(refreshedRecord)]],
        ["refreshed-sha-1", []],
      ),
    });
    expect(result.verdict).toBe("kept");
    expect(result.movedShas).toEqual(["refreshed-sha-1"]);
    expect(result.unrefreshedShas).toEqual([]);
  });

  it("returns stripped when the current patch-id disagrees with the recorded one (control 2/3 shape)", () => {
    const record = mintFixture(RUNNER_A);
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      runner: RUNNER_B, // different diff content ⇒ different computed patch-id
      shasWithCheckRuns: shas([record.headSha, [recordedCheckRun(record)]]),
    });
    expect(result.verdict).toBe("stripped");
    expect(result.recordedPatchId).toBe(record.patchId);
    expect(result.currentPatchId).not.toBe(record.patchId);
    expect(result.currentPatchId).not.toBeNull();
  });

  it("returns stripped when the patch-id agrees but a moved sha is absent from refreshShas (control 6 — THE control the refresh-shas leg exists for)", () => {
    const record = mintFixture(RUNNER_A);
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      runner: RUNNER_A, // SAME diff content ⇒ net-diff-unchanged, patch-id agrees
      shasWithCheckRuns: shas(
        [record.headSha, [recordedCheckRun(record)]],
        ["commit-b-sha", []],
        ["commit-c-sha", []],
      ),
    });
    expect(result.verdict).toBe("stripped");
    expect(result.currentPatchId).toBe(record.patchId); // patch-id equality alone…
    expect(result.movedShas).toEqual(["commit-b-sha", "commit-c-sha"]);
    expect(result.unrefreshedShas).toEqual(["commit-b-sha", "commit-c-sha"]); // …is not sufficient
  });

  it("finds the recorded check run on the newest matching sha, not the oldest, and computes movedShas relative to it", () => {
    const recordOld = mintFixture(RUNNER_A);
    const recordNew: BoxPatchIdRecord = { ...recordOld, headSha: "sha-2", patchId: "bp2:re-recorded" };
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      runner: RUNNER_A,
      shasWithCheckRuns: shas(
        ["sha-1", [recordedCheckRun(recordOld)]],
        ["sha-2", [recordedCheckRun(recordNew)]],
        ["sha-3", []],
      ),
    });
    expect(result.recordedPatchId).toBe("bp2:re-recorded");
    expect(result.movedShas).toEqual(["sha-3"]);
  });

  it("surfaces a typed refusal from the CURRENT mint (e.g. box-patch-id-uncomputable) rather than forcing kept/stripped", () => {
    const record = mintFixture(RUNNER_A);
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      runner: RUNNER_A,
      changedPaths: [".gitattributes"], // touchesGitattributes() refuses before any git call
      shasWithCheckRuns: shas([record.headSha, [recordedCheckRun(record)]]),
    });
    expect(result.verdict).toBe("box-patch-id-uncomputable");
    expect(result.recordedPatchId).toBe(record.patchId);
    expect(result.currentPatchId).toBeNull();
  });

  it("surfaces box-patch-id-unreadable when the recorded check run's output.text is malformed", () => {
    const result = observeBoxPatchId({
      ...BASE_INPUT_FIELDS,
      shasWithCheckRuns: shas(["deadbeef", [{ name: "box-patch-id", output: { text: "{not valid json" } }]]),
    });
    expect(result.verdict).toBe("box-patch-id-unreadable");
  });

  it("never throws for well-typed input on any of the paths above (exit-0 contract)", () => {
    const scenarios: Array<Partial<Parameters<typeof observeBoxPatchId>[0]>> = [
      { mode: "unknown-mode" },
      { shasWithCheckRuns: [] },
      { shasWithCheckRuns: shas(["x", [{ name: "box-patch-id", output: null }]]) },
    ];
    for (const overrides of scenarios) {
      expect(() => observeBoxPatchId({ ...BASE_INPUT_FIELDS, shasWithCheckRuns: [], ...overrides })).not.toThrow();
    }
  });
});

describe("buildCheckRunApiArgs", () => {
  const base = { repo: REPO, headSha: HEAD_SHA, conclusion: "neutral" as const, title: "box-patch-id-observe: kept", text: "{}" };

  it("POSTs exactly one check run when none exists yet, carrying head_sha and conclusion=neutral", () => {
    const action = buildCheckRunApiArgs(base);
    expect(action.kind).toBe("post");
    expect(action.args).toEqual([
      "api",
      `repos/${REPO}/check-runs`,
      "-X",
      "POST",
      "-f",
      `head_sha=${HEAD_SHA}`,
      "-f",
      "name=box-patch-id-observe",
      "-f",
      "status=completed",
      "-f",
      "conclusion=neutral",
      "-f",
      "output[title]=box-patch-id-observe: kept",
      "-f",
      "output[summary]=box-patch-id-observe: kept",
      "-f",
      "output[text]={}",
    ]);
  });

  it("PATCHes the existing check run by id when one already exists on that head, and never includes head_sha", () => {
    const action = buildCheckRunApiArgs({ ...base, existingId: 555 });
    expect(action.kind).toBe("patch");
    if (action.kind !== "patch") throw new Error("unreachable");
    expect(action.id).toBe(555);
    expect(action.args[0]).toBe("api");
    expect(action.args[1]).toBe(`repos/${REPO}/check-runs/555`);
    expect(action.args).toContain("PATCH");
    expect(action.args).not.toContain(`head_sha=${HEAD_SHA}`);
    expect(action.args).toContain("conclusion=neutral");
    expect(action.args).toContain("name=box-patch-id-observe");
  });
});
