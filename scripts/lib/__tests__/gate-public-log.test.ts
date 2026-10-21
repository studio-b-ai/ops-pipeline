/**
 * Go-native Phase A, PR-A2 item 5, end to end: the REAL gate (`main`, and the exported `evaluateTrainReady` for the control) against a
 * mocked `node:child_process`, with the console captured at the sink. Rule #223: nothing here assembles its own log line.
 *
 * The control comes FIRST (#322): `evaluateTrainReady` called directly — outside main(), so nothing is installed — still prints the
 * raw refusal text. That proves the leak exists at the source, so "no reason text reached stdout" below is not a vacuous pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const anthropicClientSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("the public-log suite never reaches the review leg — no Anthropic spend expected");
  }),
);
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: anthropicClientSpy }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { main, evaluateTrainReady } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/bolt-wms";
const PR = 3936;
const HEAD = "6c39cf6" + "a".repeat(33);

function prJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    author: { login: "app/studiob-fleet-bot" },
    labels: [{ name: "box" }, { name: "fleet-internal" }],
    createdAt: "2026-01-15T08:00:00Z",
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "BEHIND",
    additions: 3,
    deletions: 1,
    headRefOid: HEAD,
    baseRefName: "main",
    // pg-enum-drift-exempt: GitHub statusCheckRollup `status` literal in a mocked `gh pr view` payload — not a Postgres enum
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    files: [{ path: "src/pricing/engine.ts" }],
    changedFiles: 1,
    // headRepositoryOwner/headRepository deliberately absent (as in train-box-override.test.ts): no head repo ⇒ the box-patch-id leg is skipped
    ...over,
  });
}
const TIMELINE = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        timelineItems: {
          filteredCount: 2,
          pageInfo: { hasPreviousPage: false, startCursor: null },
          nodes: [
            { __typename: "PullRequestCommit" },
            { __typename: "LabeledEvent", label: { name: "box" }, actor: { __typename: "User", login: "kbibelhausen" }, createdAt: "2026-01-15T09:00:00Z" },
          ],
        },
      },
    },
  },
});

/** words that only appear in the gate's refusal REASONS — if one reaches the log, a reason did */
const REASON_TEXT = /mergeStateStatus|isDraft|ciClean|short-circuit|not merge-ready|No diff fetch|Could not resolve|private-secret/;
/** the only shapes the public log may carry (a superset of the grammar in lib/gate-log-enum.ts, as regexes) */
const PUBLIC_SHAPES = [
  /^\[gate-receipt\] repo=\S+ pr=\d+ class=\S+ verdict=(qualified|missed|candidate)( leg=[a-z-]+)?$/,
  /^\[train-gate-receipt\] repo=\S+ pr=\d+ outcome=(merged|stale-label-removed|refused|merge-attempt-failed)$/,
  /^\[[a-z][a-z0-9-]*\]( (pr-automerge-gate )?\S+#\d+)?( leg=[a-z-]+)?( sha=[0-9a-f]{40})?$/,
  /^excluded: /,
  /^pr-automerge-gate failed \(detail withheld from the public log\)$/,
];

let saved: Record<string, unknown>;
let captured: string[];

beforeEach(() => {
  execFileSyncMock.mockReset();
  saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  captured = [];
  // the SINK: whatever reaches these is what would reach the Actions log
  for (const m of ["log", "info", "warn", "error", "debug"] as const) console[m] = (...a: unknown[]) => void captured.push(a.map(String).join(" "));
});
afterEach(() => {
  Object.assign(console, saved);
});

function gh(prViewBody: string | Error) {
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    const a = args.join(" ");
    if (cmd === "sleep") return "";
    if (a.startsWith("api repos/") && a.includes("/rulesets")) return "[]"; // not native
    if (a.startsWith("pr view")) {
      if (prViewBody instanceof Error) throw prViewBody;
      return prViewBody;
    }
    if (a.startsWith("api graphql")) return TIMELINE;
    if (a.startsWith("pr comment") || a.startsWith("pr merge")) return "";
    throw new Error(`unexpected gh invocation in the public-log test: ${a}`);
  });
}

describe("CONTROL — without the install the refusal text IS printed (so the absence below is a real result)", () => {
  it("evaluateTrainReady called directly prints the raw `detail=` reason", async () => {
    gh(prJson({ mergeStateStatus: "DIRTY" }));
    await evaluateTrainReady(REPO, PR, { door: null });
    const raw = captured.filter((l) => l.startsWith("[train-gate-receipt]"));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatch(/detail="not merge-ready \(state=OPEN isDraft=false ciClean=true mergeStateStatus=DIRTY\)"/);
  });
});

describe("pr-automerge-gate main() — the public log carries only repo, PR, SHA and a verdict enum", () => {
  it("squasher path, ci-rollup refusal: the [wait] sentence and the receipt's reasons= are gone; the verdict + leg survive", async () => {
    gh(prJson());
    await main(["--repo", REPO, "--pr", String(PR)]);
    expect(captured).toContain(`[wait] pr-automerge-gate ${REPO}#${PR}`);
    expect(captured).toContain(`[gate-receipt] repo=${REPO} pr=${PR} class=unclassified verdict=missed leg=ci-rollup`);
    expect(captured.join("\n")).not.toMatch(REASON_TEXT);
    for (const line of captured) expect(PUBLIC_SHAPES.some((re) => re.test(line)), `not a public shape: ${line}`).toBe(true);
  });

  it("train path refusal: `detail=` is gone; the outcome enum survives", async () => {
    gh(prJson({ mergeStateStatus: "DIRTY" }));
    await main(["--repo", REPO, "--pr", String(PR), "--train-ready"]);
    expect(captured).toContain(`[train-gate-receipt] repo=${REPO} pr=${PR} outcome=refused`);
    expect(captured.join("\n")).not.toMatch(REASON_TEXT);
    for (const line of captured) expect(PUBLIC_SHAPES.some((re) => re.test(line)), `not a public shape: ${line}`).toBe(true);
  });

  it("a crash: the receipt says leg=other WITHOUT the error text; the non-zero-exit contract (the rethrow) is intact", async () => {
    gh(new Error("gh: GraphQL: Could not resolve to a Repository with the name 'studio-b-ai/private-secret-repo-xyz'"));
    await expect(main(["--repo", REPO, "--pr", String(PR)])).rejects.toThrow(/private-secret-repo-xyz/); // the error itself still propagates to exit 1
    expect(captured).toEqual([`[gate-receipt] repo=${REPO} pr=${PR} class=unclassified verdict=missed leg=other`]);
    expect(captured.join("\n")).not.toMatch(REASON_TEXT);
  });
});
