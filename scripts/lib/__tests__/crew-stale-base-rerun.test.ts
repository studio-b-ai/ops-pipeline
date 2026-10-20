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
 * pr-automerge-gate.ts (Rule #223 — never a self-assembled copy) and drive them against the
 * stateful fake GitHub in fixtures/fake-gh.ts (a mocked `node:child_process`) and a mocked
 * Anthropic client (the review vote). They assert on what the world CAPTURED: which gh calls
 * were made (the update-branch PUT, the merge, the label writes), what the receipt lines said,
 * and whether the paid review fired.
 *
 *   (a) FRESH base            → the leg passes; the gate proceeds (review runs, candidate+box applied).
 *   (b) base older than 1 day → refused, update-branch PUT issued once, pinned to the head; no review, no label, no merge.
 *   (c) behind by a commit touching a PR file (base minutes old) → same.
 *   (d) a sensitive path      → still refused at class-match, the stale-base leg is never consulted.
 *   (e) over the 200-line crew cap → REFUSED (line-cap), never routed to the uncapped fleet-internal class.
 *   BOX OR NO BOX: the gate's own bot box, Kevin's box, and the sweep's `--train-ready` door all hit the same leg.
 *   SCOPE CONTROLS: Kevin's `bugsquasher` lane and plain human PRs never touch the leg.
 *   FAIL-CLOSED: an unreadable compare is `unverifiable` (refused), not fresh; a refused update-branch is
 *   `rerun-failed` ("returned to its crew") with a comment, never a merge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FLEET_APP_SLUG, FRESH, STALE_BY_AGE, STALE_BY_FILE, World, type Compare } from "./fixtures/fake-gh.js";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const reviewCreate = vi.hoisted(() => vi.fn());
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: () => ({ messages: { create: reviewCreate } }) }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluate, evaluateTrainReady, staleBaseGuard } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/toto"; // the repo toto#131 crashed in
const PR = 131;
const CODE_FIX = "automerge:code-fix";

let world: World;
let logLines: string[];

function install(init: Partial<ConstructorParameters<typeof World>[0]> & { labels: string[] }, repo = REPO): World {
  world = new World({ repo, pr: PR, ...init });
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => world.handle(cmd, args));
  return world;
}
/** The state a bot-boxed candidate is in after a qualifying sweep: labels, box by the bot, qualified on the head. */
function botBoxedCandidate(over: Partial<ConstructorParameters<typeof World>[0]> = {}, repo = REPO): World {
  const w = install({ labels: ["fleet-internal", "candidate", "box", CODE_FIX], boxBy: "bot", ...over }, repo);
  w.injectCheck({ name: "crew-qualified", head_sha: w.head, app: FLEET_APP_SLUG });
  return w;
}

const receipts = () => logLines.filter((l) => l.startsWith("[gate-receipt]"));
const ENABLED = ["code-fix", "fleet-internal"] as never;
const runEvaluate = (over: { enabled?: readonly string[]; sensitive?: string[]; repo?: string } = {}) =>
  evaluate(over.repo ?? REPO, PR, [...(over.enabled ?? ENABLED)] as never, over.sensitive ?? [], ["src/**"], ["ci"], []);

beforeEach(() => {
  logLines = [];
  execFileSyncMock.mockReset();
  reviewCreate.mockReset();
  reviewCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "CLEAN" }] });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  });
});

describe("normal legs — a crew code-fix candidate (class code-fix)", () => {
  it("(a) FRESH base: the leg passes, the review runs, the filter label + candidate + box are applied in that order, nothing is rebased or merged", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH });
    const head = w.head;
    await runEvaluate();
    expect(w.factsReads()).toHaveLength(1); // the leg really looked
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(reviewCreate).toHaveBeenCalledTimes(3); // 2-of-3 vote ran
    expect(w.labelAddAttempts()).toEqual([CODE_FIX, "candidate", "box"]);
    expect(w.mergeCalls()).toHaveLength(0); // the merge is the NEXT sweep's box override
    expect(w.checkPosts("crew-qualified")).toHaveLength(1); // the gate attests the sha it qualified
    expect(w.checkRuns.find((c) => c.name === "crew-qualified")?.head_sha).toBe(head);
    expect(receipts().some((r) => r.includes("class=code-fix") && r.includes("verdict=candidate"))).toBe(true);
    expect(w.commentsMatching("Kevin's `box` key")).toHaveLength(0); // #412: the prose names the real signal
  });

  it("(a) FRESH base: behind by a few unrelated commits inside the day is still fresh", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: { ahead_by: 3, merge_base_date: "2026-10-20T10:00:00Z", files: ["src/unrelated.ts"] } });
    await runEvaluate();
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(w.labelAddAttempts()).toEqual([CODE_FIX, "candidate", "box"]);
  });

  it("(b) base older than one day (the toto#131 shape, 4 days): refused, update-branch requested ONCE pinned to the head, no review spend, no merge-authorizing label, no merge", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE });
    const head = w.head;
    await runEvaluate();
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(w.updateBranchAttempts()[0].join(" ")).toContain(`expected_head_sha=${head}`);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(w.labelAddAttempts()).toEqual([]); // not even the tripwire label: the stale leg is first
    expect(w.mergeCalls()).toHaveLength(0);
    const r = receipts().filter((l) => l.includes("leg=stale-base"));
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("verdict=missed");
    expect(r[0]).toContain("stale-base-rerun-requested");
    expect(r[0]).toContain("96h older than the base tip");
    expect(w.comments.some((c) => c.includes(`<!-- stale-base-rerun:requested:${head.slice(0, 7)} -->`) && c.includes("a `box` does not skip the re-run"))).toBe(true);
    // the gate attests its own rebase request on the OLD head (App-only provenance for Kevin's box)
    expect(w.checkRuns.some((c) => c.name === "crew-rebase" && c.head_sha === head && c.app === FLEET_APP_SLUG)).toBe(true);
  });

  it("(c) behind by a commit touching a file the PR touches — base only 2h old — is refused and rebased", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_FILE });
    await runEvaluate();
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(w.labelAddAttempts()).toEqual([]);
    expect(w.mergeCalls()).toHaveLength(0);
    const r = receipts().find((l) => l.includes("leg=stale-base"));
    expect(r).toContain("stale-base-rerun-requested");
    expect(r).toContain("src/fix.ts");
  });

  it("idempotent per head: a marker comment already on this head is not posted again (the update-branch is still requested)", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE });
    w.comments.push(`<!-- stale-base-rerun:requested:${w.head.slice(0, 7)} -->\nearlier`);
    const before = w.comments.length;
    await runEvaluate();
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(w.comments).toHaveLength(before);
  });

  it("(d) a sensitive path is refused at class-match REGARDLESS of freshness — the stale-base leg is never consulted, nothing is rebased", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE, files: ["src/auth/login.ts"] });
    await runEvaluate();
    expect(receipts().some((r) => r.includes("verdict=missed") && r.includes("leg=class-match"))).toBe(true);
    expect(w.factsReads()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(w.labelAddAttempts()).toEqual([]); // no candidate / box written
    expect(w.mergeCalls()).toHaveLength(0);
  });

  it("(d) a caller sensitive_path_patterns hit is refused the same way, with a FRESH base", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH, files: ["config/settings.json"] });
    await runEvaluate({ sensitive: ["settings\\.json$"] });
    expect(receipts().some((r) => r.includes("leg=class-match"))).toBe(true);
    expect(w.factsReads()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
  });

  it("(e) over the 200-line crew cap is a REFUSAL (line-cap) in a repo with fleet-internal enabled — no rebase, no review, no merge (it used to route to the uncapped class)", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE, additions: 201, deletions: 0 });
    await runEvaluate();
    const r = receipts().find((l) => l.includes("leg=line-cap"));
    expect(r).toBeDefined();
    expect(r).toContain("additions 201 > 200");
    expect(w.factsReads()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(w.mergeCalls()).toHaveLength(0);
  });

  it("(e) at exactly the cap (200 additions) the PR is still a code-fix candidate (boundary control)", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH, additions: 200, deletions: 0 });
    await runEvaluate({ enabled: ["code-fix"] });
    expect(w.labelAddAttempts()).toEqual([CODE_FIX, "candidate", "box"]);
  });

  it("a crew PR that resolves the fleet-internal class (outside the safe globs) is guarded by the same leg — no unattended merge past a stale base", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE, files: ["tools/helper.ts"] });
    await runEvaluate();
    expect(receipts().some((r) => r.includes("class=fleet-internal") && r.includes("leg=stale-base"))).toBe(true);
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(w.mergeCalls()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
  });

  it("SCOPE CONTROL: Kevin's lane (bugsquasher) never touches the leg — no facts read, no update-branch", async () => {
    // studiob is a train-class repo, so a passing code-fix ends in candidate + box (no merge) — the
    // point is that a STALE base planted in the compare is never even read for a non-crew PR.
    const w = install({ labels: ["bugsquasher"], baseBehind: STALE_BY_AGE }, "studio-b-ai/studiob");
    await evaluate("studio-b-ai/studiob", PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(w.factsReads()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(0);
  });

  it("SCOPE CONTROL: fleet-internal + bugsquasher together is Kevin's lane, not crew — the leg does not apply", async () => {
    const w = install({ labels: ["fleet-internal", "bugsquasher"], baseBehind: STALE_BY_AGE }, "studio-b-ai/studiob");
    await evaluate("studio-b-ai/studiob", PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(w.factsReads()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(0);
  });
});

describe("box or no box — the leg holds on every door that can merge a crew PR (Kevin 9/27)", () => {
  it("the gate's OWN bot box on a candidate with a STALE base: nothing merges, update-branch requested, receipt leg=stale-base", async () => {
    const w = botBoxedCandidate({ baseBehind: STALE_BY_AGE });
    await runEvaluate();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(receipts().some((r) => r.includes("leg=stale-base") && r.includes("stale-base-rerun-requested"))).toBe(true);
    expect(receipts().some((r) => r.includes("verdict=qualified"))).toBe(false);
  });

  it("KEVIN'S box on a crew PR with a STALE base: the box does not skip the re-run", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_FILE });
    await runEvaluate();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(receipts().some((r) => r.includes("leg=stale-base"))).toBe(true);
  });

  it("POSITIVE CONTROL: the same bot-boxed candidate with a FRESH base merges, sha-pinned — the leg does not over-block", async () => {
    const w = botBoxedCandidate({ baseBehind: FRESH });
    const head = w.head;
    await runEvaluate();
    expect(w.factsReads()).toHaveLength(1);
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(w.mergeCalls()).toHaveLength(1);
    expect(w.merges[0].pin).toBe(head);
  });

  it("SCOPE CONTROL: a plain human PR (no fleet-internal) with Kevin's box merges even over a stale base planted in the compare — the leg is crew-only", async () => {
    const w = install({ labels: ["box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    await runEvaluate();
    expect(w.factsReads()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(w.mergeCalls()).toHaveLength(1);
  });

  it("the sweep's --train-ready door, crew + Kevin's box + STALE base: refused with the stale-base detail, update-branch requested, no merge", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(res.detail).toContain("stale-base-rerun-requested");
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(w.mergeCalls()).toHaveLength(0);
  });

  it("the sweep's --train-ready door, crew + Kevin's box + FRESH base: merges (positive control)", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: FRESH });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(w.mergeCalls()).toHaveLength(1);
  });

  it("the sweep's --train-ready door SCOPE CONTROL: a human PR with Kevin's box merges and the leg never reads the base", async () => {
    const w = install({ labels: ["box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(w.factsReads()).toHaveLength(0);
  });

  it("the sweep's --train-ready door FLOOR: red CI is refused BEFORE any update-branch (no rebasing a PR that cannot merge anyway)", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE, ci: "red" });
    w.mergeStateStatus = "UNSTABLE";
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(w.factsReads()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(0);
  });
});

describe("the re-run fails or cannot be checked — never merged, returned to the crew", () => {
  it("update-branch REFUSED (conflict): rerun-failed, a 'returned to crew' comment with the failure, no merge, no labels", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE });
    w.updateBranchMode = "refuse";
    const head = w.head;
    await runEvaluate();
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.labelAddAttempts()).toEqual([]);
    const r = receipts().find((l) => l.includes("leg=stale-base"));
    expect(r).toContain("stale-base-rerun-failed");
    expect(r).toContain("returned to its crew, never merged");
    const c = w.comments.find((b) => b.includes(`<!-- stale-base-rerun:failed:${head.slice(0, 7)} -->`));
    expect(c).toBeDefined();
    expect(c).toContain("returned to crew");
    expect(c).toContain("merge conflict between base and head"); // the failure itself, first line only
    expect(c).not.toContain("second line");
    // a refused update-branch posts NO rebase attestation (nothing was rebased)
    expect(w.checkRuns.some((x) => x.name === "crew-rebase")).toBe(false);
  });

  it("compare UNREADABLE: unverifiable — refused, NO update-branch, never read as fresh (Rule #322)", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE });
    w.compareThrows = true;
    await runEvaluate();
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(w.labelAddAttempts()).toEqual([]);
    expect(w.mergeCalls()).toHaveLength(0);
    const r = receipts().find((l) => l.includes("leg=stale-base"));
    expect(r).toContain("stale-base-unverifiable");
  });

  it("compare UNREADABLE on the box door: the boxed crew PR is NOT merged", async () => {
    const w = botBoxedCandidate({ baseBehind: STALE_BY_AGE });
    w.compareThrows = true;
    await runEvaluate();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(0);
  });

  it("truncated base-side file list (>=300 files): cannot prove no overlap → stale, rebased", async () => {
    const trunc: Compare = { ahead_by: 2, merge_base_date: "2026-10-20T10:00:00Z", files: ["src/unrelated.ts"], file_count: 300 };
    const w = install({ labels: ["fleet-internal"], baseBehind: trunc });
    await runEvaluate();
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(receipts().find((l) => l.includes("leg=stale-base"))).toContain("truncated");
  });
});

describe("staleBaseGuard — the leg's I/O, called directly", () => {
  const files = [{ path: "src/fix.ts" }];

  it("returns proceed ONLY for a positively-read fresh base", () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH });
    expect(staleBaseGuard(REPO, PR, { baseRefName: "main", headRefOid: w.head, files })).toEqual({ action: "proceed" });
    expect(w.updateBranchAttempts()).toHaveLength(0);
  });

  it("returns rerun-requested with the receipt vocabulary for a stale base and issues exactly one PUT", () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE });
    const res = staleBaseGuard(REPO, PR, { baseRefName: "main", headRefOid: w.head, files });
    expect(res.action).toBe("rerun-requested");
    if (res.action === "proceed") throw new Error("unreachable");
    expect(res.reasons[0]).toMatch(/^stale-base-rerun-requested: /);
    expect(w.updateBranchAttempts()).toHaveLength(1);
  });

  it("reads the facts from the API the gate already uses: compare <head>...<base> and the base tip's commit", () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH });
    staleBaseGuard(REPO, PR, { baseRefName: "main", headRefOid: w.head, files });
    expect(w.factsReads()[0].join(" ")).toContain(`compare/${w.head}...main?per_page=1`);
    expect(w.callsMatching(`api repos/${REPO}/commits/main`)).toHaveLength(1);
  });
});
