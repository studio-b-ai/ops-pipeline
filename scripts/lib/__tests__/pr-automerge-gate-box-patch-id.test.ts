/**
 * ops-pipeline#190/#807 rollout step 5 amendments — the box-patch-id helpers inside
 * pr-automerge-gate.ts, newly named-exported this PR (zero behavior change; see each
 * export's own doc comment in that file). Rule #223 (spy tests call the function):
 * every test here imports the REAL function from ../../pr-automerge-gate.js and
 * asserts on what the mocked `execFileSync` CAPTURED — never a self-assembled
 * expected payload standing in for the real call.
 *
 * Mirrors train-box-override.test.ts's mocking shape: `node:child_process` and
 * `../anthropic-credentials.js` are the only two mocks (every other imported lib
 * file is safe to load for real — none of them shell out at module-load time), and
 * `PR_AUTOMERGE_GATE_NO_MAIN` suppresses the file's own main()-on-import.
 *
 * `GATE_PATCH_ID_WINS` is a module-level const, frozen from `process.env` at the
 * dynamic import below — set to "true" here (unlike train-box-override.test.ts) so
 * `refreshBoxPatchIdAfterUpdateBranch`'s early-return guard doesn't short-circuit
 * every test in that describe block.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOX_PATCH_ID_CHECK_NAME,
  BOX_PATCH_ID_PREFIX,
  BOX_PATCH_ID_UNKEYED_STATE,
  BOX_PATCH_ID_VERSION,
  type BoxPatchIdRecord,
  type GitCommandRunner,
} from "../box-patch-id.js";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";
process.env.GATE_PATCH_ID_WINS = "true";
delete process.env.BOX_PATCH_ID_KEY; // key stays unset — HMAC tag verification is out of scope for these tests

const anthropicClientSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("this suite never exercises the review leg — no Anthropic spend expected");
  }),
);
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: anthropicClientSpy }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const {
  fetchCurrentBoxLabelEventDbId,
  fetchCheckRuns,
  buildTrainAuthorityPatchIdFields,
  postBoxPatchIdCheckRun,
  refreshBoxPatchIdAfterUpdateBranch,
} = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/ops-pipeline";
const PR = 807;
const BASE_REF = "tp/807-patch-id-wins";
const LABEL_EVENT_DB_ID = 424242;
const HEAD_SHA = "c".repeat(40);
const OLD_HEAD_SHA = "1".repeat(40);
const NEW_HEAD_SHA = "2".repeat(40);
const BASE_SHA = "b".repeat(40);
const VALID_PID = "a".repeat(40);

const SAMPLE_DIFF_U0 =
  "diff --git a/foo.ts b/foo.ts\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/foo.ts\n" +
  "+++ b/foo.ts\n" +
  "@@ -1,1 +1,1 @@\n" +
  "-old\n" +
  "+new\n";

const SAMPLE_DIFF_RAW_Z =
  ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0foo.ts\0";

function goodRecord(overrides: Partial<BoxPatchIdRecord> = {}): BoxPatchIdRecord {
  return {
    patchId: `${BOX_PATCH_ID_PREFIX}${"d".repeat(64)}`,
    version: BOX_PATCH_ID_VERSION,
    headSha: HEAD_SHA,
    baseRef: BASE_REF,
    baseSha: BASE_SHA,
    labelEventDbId: LABEL_EVENT_DB_ID,
    refreshShas: [HEAD_SHA],
    pathHashes: {},
    ...overrides,
  };
}

function checkRunLine(record: unknown): string {
  return JSON.stringify({ name: BOX_PATCH_ID_CHECK_NAME, output: { text: typeof record === "string" ? record : JSON.stringify(record) } });
}

/** A fake GitCommandRunner that answers the exact 4-call recipe mintBoxPatchId
 *  issues, mirroring box-patch-id.test.ts's own fakeRunner/repliesFor convention
 *  (that file's fixtures aren't exported, so this is a local, deliberately
 *  parallel copy — not a duplicate import). */
function fakeGitRunner(pid = VALID_PID): GitCommandRunner {
  return (args: string[]): string => {
    const key = args.join(" ");
    if (key.startsWith("merge-base")) return `${BASE_SHA}\n`;
    if (key.startsWith("diff --no-color --no-ext-diff --no-textconv --no-renames -U0")) return SAMPLE_DIFF_U0;
    if (key.startsWith("patch-id --stable")) return `${pid} ${HEAD_SHA}\n`;
    if (key.startsWith("diff --raw -z")) return SAMPLE_DIFF_RAW_Z;
    throw new Error(`fakeGitRunner: no reply configured for "git ${key}"`);
  };
}

interface Call {
  cmd: string;
  args: string[];
}

let calls: Call[];

function record(cmd: string, args: string[]): void {
  calls.push({ cmd, args });
}

const joined = (c: Call) => c.args.join(" ");
const ghCalls = () => calls.filter((c) => c.cmd === "gh");
const eventsCalls = () => ghCalls().filter((c) => joined(c).includes("/events?per_page=100"));
const checkRunsGetCalls = () => ghCalls().filter((c) => joined(c).includes("/check-runs?per_page=100"));
const checkRunsPostCalls = () => ghCalls().filter((c) => joined(c).includes("/check-runs") && c.args.includes("POST"));
const prViewCalls = () => ghCalls().filter((c) => joined(c).startsWith("pr view"));
const sleepCalls = () => calls.filter((c) => c.cmd === "sleep");

beforeEach(() => {
  calls = [];
  execFileSyncMock.mockReset();
  anthropicClientSpy.mockClear();
});

describe("fetchCurrentBoxLabelEventDbId", () => {
  it("calls the exact events endpoint/jq recipe and returns the LAST matching labeled event's numeric id (re-box safe)", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      return "111 hold\n300 box\n424242 box\n999 needs-human\n";
    });
    const id = fetchCurrentBoxLabelEventDbId(REPO, PR, "box");
    expect(id).toBe(424242);
    expect(ghCalls()).toHaveLength(1);
    expect(ghCalls()[0].args).toEqual([
      "api",
      `repos/${REPO}/issues/${PR}/events?per_page=100`,
      "--paginate",
      "--jq",
      '.[] | select(.event == "labeled") | "\\(.id) \\(.label.name)"',
    ]);
  });

  it("returns undefined when no labeled event matches the given label name", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      return "111 hold\n222 needs-human\n";
    });
    expect(fetchCurrentBoxLabelEventDbId(REPO, PR, "box")).toBeUndefined();
  });

  it("tolerates blank lines and malformed rows without throwing", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      return "\n   \nnotanumberwithoutaspace\n42 box\n\n";
    });
    expect(fetchCurrentBoxLabelEventDbId(REPO, PR, "box")).toBe(42);
  });
});

describe("fetchCheckRuns", () => {
  it("calls the exact check-runs endpoint/jq recipe and parses one CheckRunLike per JSON line", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      return [
        JSON.stringify({ name: "ci", output: { text: null } }),
        JSON.stringify({ name: BOX_PATCH_ID_CHECK_NAME, output: { text: "hello" } }),
      ].join("\n");
    });
    const runs = fetchCheckRuns(REPO, HEAD_SHA);
    expect(runs).toEqual([
      { name: "ci", output: { text: null } },
      { name: BOX_PATCH_ID_CHECK_NAME, output: { text: "hello" } },
    ]);
    expect(ghCalls()).toHaveLength(1);
    expect(ghCalls()[0].args).toEqual([
      "api",
      `repos/${REPO}/commits/${HEAD_SHA}/check-runs?per_page=100`,
      "--paginate",
      "--jq",
      ".check_runs[] | {name: .name, output: {text: .output.text}}",
    ]);
  });

  it("returns an empty array when there are no check runs on the sha", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      return "";
    });
    expect(fetchCheckRuns(REPO, HEAD_SHA)).toEqual([]);
  });
});

describe("buildTrainAuthorityPatchIdFields", () => {
  function dispatch(eventsOut: string, checkRunsOut: string) {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      const j = args.join(" ");
      if (cmd === "gh" && j.includes("/events?per_page=100")) return eventsOut;
      if (cmd === "gh" && j.includes("/check-runs?per_page=100")) return checkRunsOut;
      throw new Error(`unexpected exec in buildTrainAuthorityPatchIdFields test: ${cmd} ${j}`);
    });
  }

  it("resolves box-patch-id-uncomputable when called WITHOUT repoDir/runner — a valid record is on file but mint has no git access (this PR's #1 open finding)", () => {
    dispatch(`${LABEL_EVENT_DB_ID} box\n`, `${checkRunLine(goodRecord())}\n`);
    const fields = buildTrainAuthorityPatchIdFields(REPO, PR, HEAD_SHA, REPO, BASE_REF, ["scripts/lib/box-patch-id.ts"]);
    expect(fields.boxPatchIdWins).toBe(true);
    expect(fields.boxPatchId?.failure).toBe("box-patch-id-uncomputable");
    expect(fields.boxPatchId?.recordedPatchId).toBe(goodRecord().patchId);
    expect(fields.boxPatchId?.currentPatchId).toBeUndefined();
  });

  it("resolves a genuinely COMPUTED current patch-id when a GitCommandRunner IS supplied — same record, only the git-access seam differs", () => {
    dispatch(`${LABEL_EVENT_DB_ID} box\n`, `${checkRunLine(goodRecord())}\n`);
    const fields = buildTrainAuthorityPatchIdFields(
      REPO,
      PR,
      HEAD_SHA,
      REPO,
      BASE_REF,
      ["scripts/lib/box-patch-id.ts"],
      undefined,
      fakeGitRunner(),
    );
    expect(fields.boxPatchIdWins).toBe(true);
    expect(fields.boxPatchId?.failure).toBeUndefined();
    expect(fields.boxPatchId?.recordedPatchId).toBe(goodRecord().patchId);
    expect(fields.boxPatchId?.currentPatchId).toBeDefined();
    expect(fields.boxPatchId?.currentPatchId?.startsWith(BOX_PATCH_ID_PREFIX)).toBe(true);
  });

  it("omits boxPatchId entirely (never a failure) when headRepo is undefined — a deleted fork — and never calls gh at all", () => {
    const fields = buildTrainAuthorityPatchIdFields(REPO, PR, HEAD_SHA, undefined, BASE_REF, []);
    expect(fields.boxPatchId).toBeUndefined();
    expect(ghCalls()).toHaveLength(0);
  });

  it("omits boxPatchId (amendment 6 grandfathering) when the current box label has no matching labeled event", () => {
    dispatch("111 hold\n222 needs-human\n", "");
    const fields = buildTrainAuthorityPatchIdFields(REPO, PR, HEAD_SHA, REPO, BASE_REF, []);
    expect(fields.boxPatchId).toBeUndefined();
    expect(checkRunsGetCalls()).toHaveLength(0); // never fetches check runs once there's no label event to key off
  });
});

describe("postBoxPatchIdCheckRun", () => {
  it("POSTs a neutral-conclusion check run named box-patch-id carrying the given title/text (Rule #223: asserts on the CAPTURED gh call, never a re-assembled expectation)", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      return "";
    });
    postBoxPatchIdCheckRun(REPO, HEAD_SHA, "bp2:deadbeef (tagged)", '{"patchId":"bp2:deadbeef"}');
    expect(ghCalls()).toHaveLength(1);
    expect(ghCalls()[0].args).toEqual([
      "api",
      `repos/${REPO}/check-runs`,
      "-X",
      "POST",
      "-f",
      `name=${BOX_PATCH_ID_CHECK_NAME}`,
      "-f",
      `head_sha=${HEAD_SHA}`,
      "-f",
      "status=completed",
      "-f",
      "conclusion=neutral",
      "-f",
      "output[title]=bp2:deadbeef (tagged)",
      "-f",
      "output[summary]=bp2:deadbeef (tagged)",
      "-f",
      'output[text]={"patchId":"bp2:deadbeef"}',
    ]);
  });
});

describe("refreshBoxPatchIdAfterUpdateBranch", () => {
  it("uses the CALLER-supplied `start` for its polling budget — an already-expired start gives up with ZERO polling (Rule #382: the wait must be honored, not recomputed internally)", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      const j = args.join(" ");
      if (cmd === "gh" && j.includes("/events?per_page=100")) return `${LABEL_EVENT_DB_ID} box\n`;
      if (cmd === "gh" && j.includes("/check-runs?per_page=100")) return `${checkRunLine(goodRecord({ headSha: OLD_HEAD_SHA }))}\n`;
      throw new Error(`unexpected exec: ${cmd} ${j}`);
    });
    // 70s in the past — already past the 60s budget before the function even checks once.
    const expiredStart = process.hrtime.bigint() - BigInt(70_000) * BigInt(1e6);
    refreshBoxPatchIdAfterUpdateBranch(REPO, PR, OLD_HEAD_SHA, expiredStart);
    expect(sleepCalls()).toHaveLength(0);
    expect(prViewCalls()).toHaveLength(0);
    expect(checkRunsPostCalls()).toHaveLength(0);
  });

  it("detects a new head sha on the first poll and PATCHes-by-necessity via exactly ONE POST to the new sha (never a double-POST)", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      if (cmd === "sleep") return "";
      const j = args.join(" ");
      if (cmd === "gh" && j.includes("/events?per_page=100")) return `${LABEL_EVENT_DB_ID} box\n`;
      // A record whose current headSha is the OLD sha must itself carry that sha in
      // refreshShas (mintBoxPatchId always seeds refreshShas: [headSha] — see box-patch-id.ts:318);
      // leaving this at goodRecord()'s HEAD_SHA default would desync the fixture from
      // what a real minted-then-recorded check run actually looks like.
      if (cmd === "gh" && j.includes("/check-runs?per_page=100")) {
        return `${checkRunLine(goodRecord({ headSha: OLD_HEAD_SHA, refreshShas: [OLD_HEAD_SHA] }))}\n`;
      }
      if (cmd === "gh" && j.startsWith("pr view")) return JSON.stringify({ headRefOid: NEW_HEAD_SHA });
      if (cmd === "gh" && j.includes("/check-runs") && args.includes("POST")) return "";
      throw new Error(`unexpected exec: ${cmd} ${j}`);
    });
    const start = process.hrtime.bigint();
    refreshBoxPatchIdAfterUpdateBranch(REPO, PR, OLD_HEAD_SHA, start);
    expect(sleepCalls()).toHaveLength(1);
    expect(prViewCalls()).toHaveLength(1);
    expect(checkRunsPostCalls()).toHaveLength(1);
    const post = checkRunsPostCalls()[0];
    expect(post.args).toContain(`head_sha=${NEW_HEAD_SHA}`);
    const title = post.args.find((a) => a.startsWith("output[title]="));
    expect(title).toContain(goodRecord().patchId);
    expect(title).toContain(BOX_PATCH_ID_UNKEYED_STATE); // no BOX_PATCH_ID_KEY configured in this test
    const text = post.args.find((a) => a.startsWith("output[text]="));
    const refreshedRecord = JSON.parse(text!.slice("output[text]=".length));
    expect(refreshedRecord.headSha).toBe(NEW_HEAD_SHA);
    expect(refreshedRecord.refreshShas).toEqual([OLD_HEAD_SHA, NEW_HEAD_SHA]);
    // append-only: every other field survives untouched from the record read off the OLD sha
    expect(refreshedRecord.patchId).toBe(goodRecord().patchId);
    expect(refreshedRecord.baseRef).toBe(BASE_REF);
    expect(refreshedRecord.labelEventDbId).toBe(LABEL_EVENT_DB_ID);
  });

  it("skips the poll entirely (no sleep, no pr view, no POST) when the pre-update-branch head has no readable box-patch-id record", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      const j = args.join(" ");
      if (cmd === "gh" && j.includes("/events?per_page=100")) return `${LABEL_EVENT_DB_ID} box\n`;
      if (cmd === "gh" && j.includes("/check-runs?per_page=100")) return ""; // no check runs at all on the old sha
      throw new Error(`unexpected exec: ${cmd} ${j}`);
    });
    refreshBoxPatchIdAfterUpdateBranch(REPO, PR, OLD_HEAD_SHA, process.hrtime.bigint());
    expect(sleepCalls()).toHaveLength(0);
    expect(prViewCalls()).toHaveLength(0);
    expect(checkRunsPostCalls()).toHaveLength(0);
  });

  it("does nothing at all (not even an events fetch) when there is no current box labeling to key off (amendment 6 grandfathering)", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      record(cmd, args);
      const j = args.join(" ");
      if (cmd === "gh" && j.includes("/events?per_page=100")) return "111 hold\n"; // no "box" line
      throw new Error(`unexpected exec: ${cmd} ${j}`);
    });
    refreshBoxPatchIdAfterUpdateBranch(REPO, PR, OLD_HEAD_SHA, process.hrtime.bigint());
    expect(checkRunsGetCalls()).toHaveLength(0);
    expect(sleepCalls()).toHaveLength(0);
    expect(checkRunsPostCalls()).toHaveLength(0);
  });
});
