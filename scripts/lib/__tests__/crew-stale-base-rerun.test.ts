/**
 * Stint #928 (Kevin 9/27) — the STALE-BASE RE-RUN leg, driven through the REAL gate.
 *
 * Kevin's requirement on the crew-code-fix widening: any crew candidate whose base is
 * more than a day behind main, or behind by a commit touching a file the PR touches,
 * is rebased onto main with CI re-run BEFORE it is eligible — box or no box; a PR that
 * fails the re-run is returned to its crew and never merged. Cause on record: toto#131
 * was written against a 4-day-old main, merged on a box, and crashed the Linear
 * publisher every tick. GitHub cannot catch it for us (the fleet's repos are unprotected
 * or strict=false, so mergeStateStatus stays CLEAN however far behind a PR is).
 *
 * These tests import the REAL `evaluate`, `evaluateTrainReady` and `staleBaseGuard` from
 * pr-automerge-gate.ts (Rule #223 — never a self-assembled copy) and drive them against
 * a mocked `node:child_process` (every `gh` call funnels through `execFileSync`) and a
 * mocked Anthropic client (the review vote). They assert on what the mocks CAPTURED:
 * which `gh` calls were made (the update-branch PUT, the merge, the label writes), what
 * the receipt lines said, and whether the paid review fired.
 *
 *   (a) FRESH base            → the leg passes; the gate proceeds (review runs, candidate+box applied).
 *   (b) base older than 1 day → refused, update-branch PUT issued once, pinned to the head; no review, no label, no merge.
 *   (c) behind by a commit touching a PR file (base minutes old) → same.
 *   (d) a sensitive path      → still refused at class-match, the stale-base leg is never consulted.
 *   (e) over the 200-line crew cap → still not code-fix; refused where fleet-internal is not enabled.
 *   BOX OR NO BOX: the gate's own bot box, Kevin's box, and the restart-train box all hit the same leg.
 *   SCOPE CONTROLS: Kevin's `bugsquasher` lane and plain human PRs never touch the leg.
 *   FAIL-CLOSED: an unreadable compare is `unverifiable` (refused), not fresh; a refused update-branch is
 *   `rerun-failed` ("returned to its crew") with a comment, never a merge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const reviewCreate = vi.hoisted(() => vi.fn());
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: () => ({ messages: { create: reviewCreate } }) }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluate, evaluateTrainReady, staleBaseGuard } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/toto"; // the repo toto#131 crashed in
const PR = 131;
const HEAD = "131a1b2c3d4e5f6131a1b2c3d4e5f6131a1b2c3d";
const TIP = "2026-10-20T12:00:00Z";
const MERGE_BASE_4_DAYS = "2026-10-16T12:00:00Z"; // toto#131: written against a 4-day-old main
const MERGE_BASE_2_HOURS = "2026-10-20T10:00:00Z";

const DIFF = [
  "diff --git a/src/fix.ts b/src/fix.ts",
  "--- a/src/fix.ts",
  "+++ b/src/fix.ts",
  "@@ -1,2 +1,3 @@",
  "-const a = 1;",
  "+const a = 2;",
  "+export const b = 3;",
  "",
].join("\n");

type Compare = { ahead_by: number; merge_base_date: string | null; files: string[]; file_count?: number } | "throw";

const FRESH_COMPARE: Compare = { ahead_by: 0, merge_base_date: TIP, files: [] };
const STALE_AGE_COMPARE: Compare = { ahead_by: 41, merge_base_date: MERGE_BASE_4_DAYS, files: ["src/unrelated.ts"] };
const STALE_FILE_COMPARE: Compare = { ahead_by: 1, merge_base_date: MERGE_BASE_2_HOURS, files: ["README.md", "src/fix.ts"] };
const FRESH_BEHIND_UNRELATED: Compare = { ahead_by: 3, merge_base_date: MERGE_BASE_2_HOURS, files: ["src/unrelated.ts"] };

function prView(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    author: { login: "kbibelhausen" },
    createdAt: "2026-10-01T00:00:00Z", // far outside the self-box window of any label below
    labels: [{ name: "fleet-internal" }],
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    additions: 22,
    deletions: 2,
    headRefOid: HEAD,
    baseRefName: "main",
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-20T09:00:00Z" }],
    files: [{ path: "src/fix.ts" }],
    changedFiles: 1,
    ...over,
  });
}

const labelsOf = (...names: string[]) => names.map((name) => ({ name }));

function timeline(actor: { __typename: "User" | "Bot"; login: string }): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          timelineItems: {
            filteredCount: 2,
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: [
              { __typename: "PullRequestCommit" },
              { __typename: "LabeledEvent", label: { name: "box" }, actor, createdAt: "2026-10-20T10:30:00Z" },
            ],
          },
        },
      },
    },
  });
}
const KEVIN_BOX = timeline({ __typename: "User", login: "kbibelhausen" });
const BOT_BOX = timeline({ __typename: "Bot", login: "studiob-fleet-bot" });

interface Scenario {
  /** The repo the gate is driven against (default: toto). The API paths the dispatcher answers follow it. */
  repo?: string;
  pr?: string;
  compare?: Compare;
  updateBranch?: "ok" | "refuse";
  timeline?: string;
  priorMarkerComments?: number;
}

type GhCall = string[];
let ghCalls: GhCall[];
let logLines: string[];

function dispatch(sc: Scenario) {
  const R = sc.repo ?? REPO;
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    ghCalls.push([cmd, ...args]);
    if (cmd === "sleep") return "";
    const a = args.join(" ");
    if (a.startsWith("api graphql")) return sc.timeline ?? KEVIN_BOX;
    if (a.startsWith("pr view") && a.includes("--json comments")) return `${sc.priorMarkerComments ?? 0}\n`;
    if (a.startsWith("pr view") && a.includes("--json headRefOid")) return `${HEAD}\n`;
    if (a.startsWith("pr view")) return sc.pr ?? prView();
    // the gate's diff fetch: compare/<base>...<head> with an Accept header
    if (a.startsWith(`api repos/${R}/compare/`) && args.includes("-H")) return DIFF;
    // the stale-base facts read: compare/<head>...<base>?per_page=1 --jq …
    if (a.startsWith(`api repos/${R}/compare/`) && a.includes("per_page=1")) {
      const c = sc.compare ?? FRESH_COMPARE;
      if (c === "throw") throw new Error("gh: HTTP 502 Bad Gateway");
      return JSON.stringify({ ahead_by: c.ahead_by, merge_base_date: c.merge_base_date, file_count: c.file_count ?? c.files.length, files: c.files });
    }
    if (a.startsWith(`api repos/${R}/commits/main`)) return `${TIP}\n`;
    if (a.startsWith(`api -X PUT repos/${R}/pulls/${PR}/update-branch`)) {
      if (sc.updateBranch === "refuse") throw new Error("gh: merge conflict between base and head (HTTP 422)\nsecond line");
      return '{"message":"Updating pull request branch."}';
    }
    if (a.startsWith("pr edit") || a.startsWith("pr comment") || a.startsWith("pr merge") || a.startsWith("api -X POST")) return "";
    throw new Error(`unexpected gh invocation in crew-stale-base-rerun test: ${a}`);
  });
}

const joined = (c: GhCall) => c.slice(1).join(" ");
const calls = (prefix: string) => ghCalls.filter((c) => joined(c).startsWith(prefix));
const factsReads = () => ghCalls.filter((c) => /^api repos\/[^/]+\/[^/]+\/compare\//.test(joined(c)) && joined(c).includes("per_page=1"));
const updateBranches = () => ghCalls.filter((c) => /^api -X PUT repos\/[^/]+\/[^/]+\/pulls\/\d+\/update-branch/.test(joined(c)));
const merges = () => calls("pr merge");
const labelAdds = () => calls("pr edit").map((c) => c[c.indexOf("--add-label") + 1]);
const botComments = () => calls("pr comment").map((c) => c[c.indexOf("--body") + 1]);
const receipts = () => logLines.filter((l) => l.startsWith("[gate-receipt]"));

const ENABLED = ["code-fix", "fleet-internal"] as const;
const runEvaluate = (over: { enabled?: readonly string[]; sensitive?: string[] } = {}) =>
  evaluate(REPO, PR, [...(over.enabled ?? ENABLED)] as never, over.sensitive ?? [], ["src/**"], ["ci"], []);

beforeEach(() => {
  ghCalls = [];
  logLines = [];
  execFileSyncMock.mockReset();
  reviewCreate.mockReset();
  reviewCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "CLEAN" }] });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  });
});

describe("normal legs — a crew code-fix candidate (class code-fix)", () => {
  it("(a) FRESH base: the leg passes, the review runs, candidate + box are applied, nothing is rebased or merged", async () => {
    dispatch({ compare: FRESH_COMPARE });
    await runEvaluate();
    expect(factsReads()).toHaveLength(1); // the leg really looked
    expect(updateBranches()).toHaveLength(0);
    expect(reviewCreate).toHaveBeenCalledTimes(3); // 2-of-3 vote ran
    expect(labelAdds()).toEqual(["candidate", "box"]);
    expect(merges()).toHaveLength(0); // the merge is the NEXT sweep's box override
    expect(receipts().some((r) => r.includes("class=code-fix") && r.includes("verdict=candidate"))).toBe(true);
    expect(botComments().join("\n")).not.toContain("Kevin's `box` key"); // #412: the prose names the real signal
  });

  it("(a) FRESH base: behind by a few unrelated commits inside the day is still fresh", async () => {
    dispatch({ compare: FRESH_BEHIND_UNRELATED });
    await runEvaluate();
    expect(updateBranches()).toHaveLength(0);
    expect(labelAdds()).toEqual(["candidate", "box"]);
  });

  it("(b) base older than one day (the toto#131 shape, 4 days): refused, update-branch requested ONCE pinned to the head, no review spend, no labels, no merge", async () => {
    dispatch({ compare: STALE_AGE_COMPARE });
    await runEvaluate();
    expect(updateBranches()).toHaveLength(1);
    expect(updateBranches()[0].join(" ")).toContain(`expected_head_sha=${HEAD}`);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(labelAdds()).toEqual([]);
    expect(merges()).toHaveLength(0);
    const r = receipts().filter((l) => l.includes("leg=stale-base"));
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("verdict=missed");
    expect(r[0]).toContain("stale-base-rerun-requested");
    expect(r[0]).toContain("96h older than the base tip");
    expect(botComments().some((c) => c.includes("<!-- stale-base-rerun:requested:131a1b2 -->") && c.includes("a `box` does not skip the re-run"))).toBe(true);
  });

  it("(c) behind by a commit touching a file the PR touches — base only 2h old — is refused and rebased", async () => {
    dispatch({ compare: STALE_FILE_COMPARE });
    await runEvaluate();
    expect(updateBranches()).toHaveLength(1);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(labelAdds()).toEqual([]);
    expect(merges()).toHaveLength(0);
    const r = receipts().find((l) => l.includes("leg=stale-base"));
    expect(r).toContain("stale-base-rerun-requested");
    expect(r).toContain("src/fix.ts");
  });

  it("idempotent per head: a marker comment already on this head is not posted again (the update-branch is still requested)", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, priorMarkerComments: 1 });
    await runEvaluate();
    expect(updateBranches()).toHaveLength(1);
    expect(calls("pr comment")).toHaveLength(0);
  });

  it("(d) a sensitive path is refused at class-match REGARDLESS of freshness — the stale-base leg is never consulted, nothing is rebased", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, pr: prView({ files: [{ path: "src/auth/login.ts" }] }) });
    await runEvaluate();
    expect(receipts().some((r) => r.includes("verdict=missed") && r.includes("leg=class-match"))).toBe(true);
    expect(factsReads()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(labelAdds()).toEqual([]); // no candidate / box written
    expect(merges()).toHaveLength(0);
  });

  it("(d) a caller sensitive_path_patterns hit is refused the same way, with a FRESH base", async () => {
    dispatch({ compare: FRESH_COMPARE, pr: prView({ files: [{ path: "config/settings.json" }] }) });
    await runEvaluate({ sensitive: ["settings\\.json$"] });
    expect(receipts().some((r) => r.includes("leg=class-match"))).toBe(true);
    expect(factsReads()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
  });

  it("(e) over the 200-line crew cap where fleet-internal is NOT enabled: refused at class-match, no rebase, no review", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, pr: prView({ additions: 201, deletions: 0 }) });
    await runEvaluate({ enabled: ["code-fix"] });
    const r = receipts().find((l) => l.includes("leg=class-match"));
    expect(r).toBeDefined();
    expect(r).toContain("--enabled-classes");
    expect(factsReads()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(merges()).toHaveLength(0);
  });

  it("(e) at exactly the cap (200 additions) the PR is still a code-fix candidate (boundary control)", async () => {
    dispatch({ compare: FRESH_COMPARE, pr: prView({ additions: 200, deletions: 0 }) });
    await runEvaluate({ enabled: ["code-fix"] });
    expect(labelAdds()).toEqual(["candidate", "box"]);
  });

  it("an over-cap crew PR that DOES resolve the pre-existing fleet-internal class is guarded by the same leg — no unattended merge past a stale base", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, pr: prView({ additions: 201, deletions: 0 }) });
    await runEvaluate();
    expect(receipts().some((r) => r.includes("class=fleet-internal") && r.includes("leg=stale-base"))).toBe(true);
    expect(updateBranches()).toHaveLength(1);
    expect(merges()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
  });

  it("SCOPE CONTROL: Kevin's lane (bugsquasher) never touches the leg — no facts read, no update-branch", async () => {
    // studiob is a train-class repo, so a passing code-fix ends in candidate + queued (no merge) — the
    // point is that a STALE base planted in the compare is never even read for a non-crew PR.
    dispatch({ repo: "studio-b-ai/studiob", compare: STALE_AGE_COMPARE, pr: prView({ labels: labelsOf("bugsquasher") }) });
    await evaluate("studio-b-ai/studiob", PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(factsReads()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(0);
  });

  it("SCOPE CONTROL: fleet-internal + bugsquasher together is Kevin's lane, not crew — the leg does not apply", async () => {
    dispatch({ repo: "studio-b-ai/studiob", compare: STALE_AGE_COMPARE, pr: prView({ labels: labelsOf("fleet-internal", "bugsquasher") }) });
    await evaluate("studio-b-ai/studiob", PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(factsReads()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(0);
  });
});

describe("box or no box — the leg holds on every door that can merge a crew PR (Kevin 9/27)", () => {
  it("the gate's OWN bot box on a candidate with a STALE base: nothing merges, update-branch requested, receipt leg=stale-base", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, timeline: BOT_BOX, pr: prView({ labels: labelsOf("fleet-internal", "candidate", "box") }) });
    await runEvaluate();
    expect(merges()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(1);
    expect(receipts().some((r) => r.includes("leg=stale-base") && r.includes("stale-base-rerun-requested"))).toBe(true);
    expect(receipts().some((r) => r.includes("verdict=qualified"))).toBe(false);
  });

  it("KEVIN'S box on a crew PR with a STALE base: the box does not skip the re-run", async () => {
    dispatch({ compare: STALE_FILE_COMPARE, timeline: KEVIN_BOX, pr: prView({ labels: labelsOf("fleet-internal", "box") }) });
    await runEvaluate();
    expect(merges()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(1);
    expect(receipts().some((r) => r.includes("leg=stale-base"))).toBe(true);
  });

  it("POSITIVE CONTROL: the same bot-boxed candidate with a FRESH base merges, sha-pinned — the leg does not over-block", async () => {
    dispatch({ compare: FRESH_COMPARE, timeline: BOT_BOX, pr: prView({ labels: labelsOf("fleet-internal", "candidate", "box") }) });
    await runEvaluate();
    expect(factsReads()).toHaveLength(1);
    expect(updateBranches()).toHaveLength(0);
    expect(merges()).toHaveLength(1);
    expect(merges()[0].join(" ")).toContain(`--match-head-commit ${HEAD}`);
  });

  it("SCOPE CONTROL: a plain human PR (no fleet-internal) with Kevin's box merges even over a stale base planted in the compare — the leg is crew-only", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, timeline: KEVIN_BOX, pr: prView({ labels: labelsOf("box") }) });
    await runEvaluate();
    expect(factsReads()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(0);
    expect(merges()).toHaveLength(1);
  });

  it("restart-train door, crew + Kevin's box + STALE base: refused with the stale-base detail, update-branch requested, no merge", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, timeline: KEVIN_BOX, pr: prView({ labels: labelsOf("fleet-internal", "box") }) });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(res.detail).toContain("stale-base-rerun-requested");
    expect(updateBranches()).toHaveLength(1);
    expect(merges()).toHaveLength(0);
  });

  it("restart-train door, crew + Kevin's box + FRESH base: merges (positive control)", async () => {
    dispatch({ compare: FRESH_COMPARE, timeline: KEVIN_BOX, pr: prView({ labels: labelsOf("fleet-internal", "box") }) });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(updateBranches()).toHaveLength(0);
    expect(merges()).toHaveLength(1);
  });

  it("restart-train door SCOPE CONTROL: a human PR with Kevin's box merges and the leg never reads the base", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, timeline: KEVIN_BOX, pr: prView({ labels: labelsOf("box") }) });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(factsReads()).toHaveLength(0);
  });

  it("restart-train door FLOOR: red CI is refused BEFORE any update-branch (no rebasing a PR that cannot merge anyway)", async () => {
    dispatch({
      compare: STALE_AGE_COMPARE,
      timeline: KEVIN_BOX,
      pr: prView({ labels: labelsOf("fleet-internal", "box"), mergeStateStatus: "UNSTABLE", statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] }),
    });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(factsReads()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(0);
  });
});

describe("the re-run fails or cannot be checked — never merged, returned to the crew", () => {
  it("update-branch REFUSED (conflict): rerun-failed, a 'returned to crew' comment with the failure, no merge, no labels", async () => {
    dispatch({ compare: STALE_AGE_COMPARE, updateBranch: "refuse" });
    await runEvaluate();
    expect(updateBranches()).toHaveLength(1);
    expect(merges()).toHaveLength(0);
    expect(labelAdds()).toEqual([]);
    const r = receipts().find((l) => l.includes("leg=stale-base"));
    expect(r).toContain("stale-base-rerun-failed");
    expect(r).toContain("returned to its crew, never merged");
    const c = botComments().find((b) => b.includes("<!-- stale-base-rerun:failed:131a1b2 -->"));
    expect(c).toBeDefined();
    expect(c).toContain("returned to crew");
    expect(c).toContain("merge conflict between base and head"); // the failure itself, first line only
    expect(c).not.toContain("second line");
  });

  it("compare UNREADABLE: unverifiable — refused, NO update-branch, never read as fresh (Rule #322)", async () => {
    dispatch({ compare: "throw" });
    await runEvaluate();
    expect(updateBranches()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(labelAdds()).toEqual([]);
    expect(merges()).toHaveLength(0);
    const r = receipts().find((l) => l.includes("leg=stale-base"));
    expect(r).toContain("stale-base-unverifiable");
  });

  it("compare UNREADABLE on the box door: the boxed crew PR is NOT merged", async () => {
    dispatch({ compare: "throw", timeline: BOT_BOX, pr: prView({ labels: labelsOf("fleet-internal", "candidate", "box") }) });
    await runEvaluate();
    expect(merges()).toHaveLength(0);
    expect(updateBranches()).toHaveLength(0);
  });

  it("truncated base-side file list (>=300 files): cannot prove no overlap → stale, rebased", async () => {
    dispatch({ compare: { ahead_by: 2, merge_base_date: MERGE_BASE_2_HOURS, files: ["src/unrelated.ts"], file_count: 300 } });
    await runEvaluate();
    expect(updateBranches()).toHaveLength(1);
    expect(receipts().find((l) => l.includes("leg=stale-base"))).toContain("truncated");
  });
});

describe("staleBaseGuard — the leg's I/O, called directly", () => {
  const prJson = { baseRefName: "main", headRefOid: HEAD, files: [{ path: "src/fix.ts" }] };

  it("returns proceed ONLY for a positively-read fresh base", () => {
    dispatch({ compare: FRESH_COMPARE });
    expect(staleBaseGuard(REPO, PR, prJson)).toEqual({ action: "proceed" });
    expect(updateBranches()).toHaveLength(0);
  });

  it("returns rerun-requested with the receipt vocabulary for a stale base and issues exactly one PUT", () => {
    dispatch({ compare: STALE_AGE_COMPARE });
    const res = staleBaseGuard(REPO, PR, prJson);
    expect(res.action).toBe("rerun-requested");
    if (res.action === "proceed") throw new Error("unreachable");
    expect(res.reasons[0]).toMatch(/^stale-base-rerun-requested: /);
    expect(updateBranches()).toHaveLength(1);
  });

  it("reads the facts from the API the gate already uses: compare <head>...<base> and the base tip's commit", () => {
    dispatch({ compare: FRESH_COMPARE });
    staleBaseGuard(REPO, PR, prJson);
    expect(factsReads()[0].join(" ")).toContain(`compare/${HEAD}...main?per_page=1`);
    expect(calls(`api repos/${REPO}/commits/main`)).toHaveLength(1);
  });
});
