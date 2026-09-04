import { describe, expect, it } from "vitest";
import { formatMergeDoorLine, formatTrainMergeReceipt, mergeDoorFrom, type MergeDoor } from "../merge-door.js";

// Rule #412: the `queued` — MERGED receipt used to hardcode "MERGED by the
// restart train" regardless of which workflow actually executed the merge —
// the RUNG (who's authorized) and the DOOR (which run did it) are different
// facts, and only the rung was ever named. Three seats inferred the door from
// that wrong name on webhook-router#891/#900 (15:24Z) and bolt-wms#2148
// (19:17Z); the real door was squasher-fleet-sweep.yml. Every case here is a
// planted, both-directions control (#322/#471): a known-good door renders the
// real facts, a known-absent door renders honestly as unknown, and the
// "restart train" phrasing is proven present ONLY for the one door it is
// actually true of and absent for every other.

const SQUASHER_ENV = {
  GITHUB_WORKFLOW_REF: "studio-b-ai/ops-pipeline/.github/workflows/squasher-automerge.yml@refs/heads/main",
  GITHUB_RUN_ID: "33909123456",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "studio-b-ai/ops-pipeline",
};

const RESTART_TRAIN_ENV = {
  GITHUB_WORKFLOW_REF: "studio-b-ai/ops-pipeline/.github/workflows/heritage-restart-train.yml@refs/heads/main",
  GITHUB_RUN_ID: "33910000001",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "studio-b-ai/ops-pipeline",
};

describe("mergeDoorFrom", () => {
  it("planted: all four env facts present resolves the real door (workflow file + run link)", () => {
    const door = mergeDoorFrom(SQUASHER_ENV);
    expect(door).toEqual({
      workflowFile: "squasher-automerge.yml",
      runId: "33909123456",
      runUrl: "https://github.com/studio-b-ai/ops-pipeline/actions/runs/33909123456",
    });
  });

  it("control: a trailing slash on GITHUB_SERVER_URL doesn't double up in the run URL", () => {
    const door = mergeDoorFrom({ ...SQUASHER_ENV, GITHUB_SERVER_URL: "https://github.com/" });
    expect(door?.runUrl).toBe("https://github.com/studio-b-ai/ops-pipeline/actions/runs/33909123456");
  });

  it.each([
    ["GITHUB_WORKFLOW_REF", { ...SQUASHER_ENV, GITHUB_WORKFLOW_REF: "" }],
    ["GITHUB_RUN_ID", { ...SQUASHER_ENV, GITHUB_RUN_ID: "" }],
    ["GITHUB_SERVER_URL", { ...SQUASHER_ENV, GITHUB_SERVER_URL: "" }],
    ["GITHUB_REPOSITORY", { ...SQUASHER_ENV, GITHUB_REPOSITORY: "" }],
  ])("control: missing %s ⇒ null (a local/dry-run invocation outside Actions)", (_name, env) => {
    expect(mergeDoorFrom(env)).toBeNull();
  });

  it("control: an empty env object (no Actions vars at all) ⇒ null", () => {
    expect(mergeDoorFrom({})).toBeNull();
  });

  it("control: a GITHUB_WORKFLOW_REF that doesn't carry a .github/workflows/ segment ⇒ null", () => {
    expect(mergeDoorFrom({ ...SQUASHER_ENV, GITHUB_WORKFLOW_REF: "studio-b-ai/ops-pipeline@refs/heads/main" })).toBeNull();
  });
});

describe("formatMergeDoorLine", () => {
  it("planted: a known door (squasher-automerge.yml) names the workflow file and links the run — never the restart-train phrase", () => {
    const door: MergeDoor = {
      workflowFile: "squasher-automerge.yml",
      runId: "33909123456",
      runUrl: "https://github.com/studio-b-ai/ops-pipeline/actions/runs/33909123456",
    };
    const line = formatMergeDoorLine(door);
    expect(line).toContain("`squasher-automerge.yml`");
    expect(line).toContain("33909123456");
    expect(line).toContain("https://github.com/studio-b-ai/ops-pipeline/actions/runs/33909123456");
    expect(line).toContain("rung: label-authority v2, ops#190 rung A1; one vocabulary 9/02");
    expect(line).not.toContain("MERGED by the restart train");
  });

  it("planted: the restart-train door is the ONE case that keeps the restart-train phrasing", () => {
    const door: MergeDoor = {
      workflowFile: "heritage-restart-train.yml",
      runId: "33910000001",
      runUrl: "https://github.com/studio-b-ai/ops-pipeline/actions/runs/33910000001",
    };
    const line = formatMergeDoorLine(door);
    expect(line).toContain("MERGED by the restart train");
    expect(line).toContain("`heritage-restart-train.yml`");
    expect(line).toContain("33910000001");
    expect(line).toContain("rung: label-authority v2, ops#190 rung A1; one vocabulary 9/02");
  });

  it("control: a null door (env absent) renders honestly as unknown, and still names the rung", () => {
    const line = formatMergeDoorLine(null);
    expect(line).toContain("(unknown — not run under Actions)");
    expect(line).toContain("rung: label-authority v2, ops#190 rung A1; one vocabulary 9/02");
    expect(line).not.toContain("MERGED by the restart train");
  });
});

describe("formatTrainMergeReceipt", () => {
  const baseFacts = {
    authorizingLogin: "kbibelhausen",
    authorizingPosition: 4,
    headRefOid: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  };

  it("integration: the door line is the ONLY line that changes vs the prior fixed-text receipt — every other line is byte-identical", () => {
    const door: MergeDoor = mergeDoorFrom(SQUASHER_ENV)!;
    const receipt = formatTrainMergeReceipt({ ...baseFacts, door });
    const lines = receipt.split("\n");

    // Prior (pre-#412) hardcoded first line, retained here only as the
    // comparison baseline this test proves is now GONE.
    const OLD_FIRST_LINE = "**`queued` — MERGED by the restart train** (label-authority v2, ops#190 rung A1; one vocabulary 9/02)";
    expect(lines[0]).not.toBe(OLD_FIRST_LINE);
    expect(lines[0]).toBe(formatMergeDoorLine(door));

    // Every other line is untouched, verbatim, from the original template.
    expect(lines.slice(1)).toEqual([
      "",
      "| Leg | Result |",
      "|---|---|",
      "| authority (label-authority v2, revalidated pre-merge) | ✅ authorized by `kbibelhausen` (timeline position 4) |",
      "| merge-ready (OPEN, not draft, mergeStateStatus CLEAN) + CI rollup clean | ✅ |",
      "| independent review (Claude Sonnet 5) | ✅ CLEAN |",
      "| revalidate: PR snapshot (labels/sha/state/mergeStateStatus) | ✅ no drift |",
      "| revalidate: authority timeline re-check | ✅ still authorized |",
      "",
      "Evaluated sha: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2` (merge was SHA-pinned via `--match-head-commit`).",
      "",
      "This comment is a write-only receipt — no automation reads it back.",
    ]);
  });

  it("control: a null door still produces the full byte-identical body below the first line", () => {
    const receipt = formatTrainMergeReceipt({ ...baseFacts, door: null });
    const lines = receipt.split("\n");
    expect(lines[0]).toContain("(unknown — not run under Actions)");
    expect(lines.slice(1)).toEqual([
      "",
      "| Leg | Result |",
      "|---|---|",
      "| authority (label-authority v2, revalidated pre-merge) | ✅ authorized by `kbibelhausen` (timeline position 4) |",
      "| merge-ready (OPEN, not draft, mergeStateStatus CLEAN) + CI rollup clean | ✅ |",
      "| independent review (Claude Sonnet 5) | ✅ CLEAN |",
      "| revalidate: PR snapshot (labels/sha/state/mergeStateStatus) | ✅ no drift |",
      "| revalidate: authority timeline re-check | ✅ still authorized |",
      "",
      "Evaluated sha: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2` (merge was SHA-pinned via `--match-head-commit`).",
      "",
      "This comment is a write-only receipt — no automation reads it back.",
    ]);
  });
});
