/**
 * Row 928 redesign (Kevin 10/20 "protect main") — strict branch protection reports
 * `mergeStateStatus=BEHIND` for a PR whose base moved; the gate brings an ELIGIBLE one
 * current via update-branch instead of stalling it forever. GitHub's protection owns the
 * freshness check; the gate only updates the branch (ops-pipeline#580's custom freshness
 * code is abandoned).
 *
 * Rule #223: every test imports the REAL `evaluate` / `evaluateTrainReady` (pr-automerge-gate.ts)
 * and `requestBehindUpdate` (behind-update.ts) and asserts on what the mocked `gh`
 * (`node:child_process`.execFileSync) CAPTURED — never a self-assembled payload.
 *
 *   POSITIVE  BEHIND + passed every lane pre-check ⇒ exactly ONE update-branch PUT pinned to the
 *             evaluated head, ZERO merges, ZERO label writes, ZERO paid review, receipt
 *             `verdict=missed leg=behind reasons="update-branch requested"` (squasher, box-override
 *             and train lanes).
 *   CONTROL   CLEAN ⇒ the existing path, byte-for-byte: review runs, merge fires, no update-branch.
 *   NEGATIVE  update-branch fails (422 conflict, moved head, any error) ⇒ refused with the error in
 *             the receipt, no merge. Attempt count unreadable / attempt unrecordable ⇒ refused, no PUT.
 *   CAP       3 gate-requested calls in 24h ⇒ `behind-cap`, NO 4th call, the decision line is enrolled
 *             through the existing door.
 *   LANE      a BEHIND PR that FAILS a lane pre-check (wrong author, hold, standing review FLAG,
 *             CI red, draft, no box, not an enabled class) ⇒ ZERO update-branch calls — the gate
 *             never touches a PR it would not merge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateMergeReadiness } from "../automerge-classify.js";
import { buildEnrollment, isDecisionLeg } from "../gate-enroll.js";
import { formatGateReceiptLine } from "../automerge-telemetry.js";
import { fingerprintOf } from "../fleet-sweep-changed.js";
import { BEHIND_MARKER, BEHIND_UPDATE_CAP, BEHIND_UPDATE_WINDOW_MS, countRecentRequests, requestBehindUpdate } from "../behind-update.js";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const anthropicClientSpy = vi.hoisted(() => vi.fn());
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: anthropicClientSpy }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluate, evaluateTrainReady } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/claude-hooks";
const PR = 700;
const HEAD = "a1".repeat(20);

// A GitHub statusCheckRollup entry. pg-enum-drift-exempt: GitHub check-run status field, not a Postgres enum
const check = (name: string, conclusion: string) => ({ name, status: "COMPLETED", conclusion });

const DIFF = [
  "diff --git a/hook_x.py b/hook_x.py",
  "index 1111111..2222222 100644",
  "--- a/hook_x.py",
  "+++ b/hook_x.py",
  "@@ -1 +1,3 @@",
  " import os",
  "+import sys",
  "+print(sys.argv)",
  "",
].join("\n");

const TIMELINE_BOX_AFTER_HEAD = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        timelineItems: {
          filteredCount: 2,
          pageInfo: { hasPreviousPage: false, startCursor: null },
          nodes: [
            { __typename: "PullRequestCommit" },
            { __typename: "LabeledEvent", label: { name: "box" }, actor: { __typename: "User", login: "kbibelhausen" }, createdAt: "2026-10-19T07:00:00Z" },
          ],
        },
      },
    },
  },
});

interface World {
  pr?: Record<string, unknown>;
  markers?: string[]; // created_at of this PR's existing gate-update-branch comments
  putStderr?: string; // make the update-branch PUT fail with this gh stderr
  commentsReadFails?: boolean;
  commentPostFails?: boolean;
  reviewFlag?: boolean; // a review FLAG blue card already stands on the head
}

type Call = string[];
let calls: Call[];
let logSpy: ReturnType<typeof vi.spyOn>;

function prJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    author: { login: "kbibelhausen" },
    labels: [{ name: "fleet-internal" }],
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "BEHIND",
    additions: 2,
    deletions: 0,
    headRefOid: HEAD,
    baseRefName: "main",
    statusCheckRollup: [check("syntax", "SUCCESS")],
    files: [{ path: "hook_x.py" }],
    changedFiles: 1,
    ...over,
  });
}

function install(w: World = {}): void {
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === "sleep") return "";
    const a = args.join(" ");
    if (a.startsWith("pr view") && a.includes("--json comments")) return w.reviewFlag ? "1" : "0";
    if (a.startsWith("pr view")) return prJson(w.pr);
    if (a.includes("/compare/")) return DIFF;
    if (a.startsWith("api graphql")) return TIMELINE_BOX_AFTER_HEAD;
    if (a.includes(`/issues/${PR}/comments`)) {
      if (w.commentsReadFails) throw Object.assign(new Error("Command failed: gh api comments"), { stderr: "gh: HTTP 502" });
      return (w.markers ?? []).join("\n");
    }
    if (a.startsWith("pr comment")) {
      if (w.commentPostFails) throw Object.assign(new Error("Command failed: gh pr comment"), { stderr: "gh: HTTP 403" });
      return "";
    }
    if (a.startsWith("api -X PUT") && a.includes("/update-branch")) {
      if (w.putStderr) throw Object.assign(new Error(`Command failed: gh ${a}`), { stderr: w.putStderr });
      return '{"message":"Updating pull request branch."}';
    }
    if (a.startsWith("pr merge")) return "";
    if (a.startsWith("pr edit") || a.includes("/labels")) return "";
    throw new Error(`unexpected gh invocation in behind-update test: ${a}`);
  });
}

const on = (re: RegExp) => calls.filter((c) => re.test(c.slice(1).join(" ")));
const puts = () => on(/^api -X PUT .*\/update-branch/);
const merges = () => on(/^pr merge/);
const labelWrites = () => on(/^pr edit|\/labels/);
const markerComments = () => on(/^pr comment/).filter((c) => c.join(" ").includes(BEHIND_MARKER));
const out = () => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

const run = (over: Partial<{ classes: string[]; checks: string[] }> = {}) =>
  evaluate(REPO, PR, (over.classes ?? ["fleet-internal"]) as never, [], [], over.checks ?? ["syntax"], []);

beforeEach(() => {
  calls = [];
  execFileSyncMock.mockReset();
  anthropicClientSpy.mockReset();
  anthropicClientSpy.mockImplementation(() => ({
    messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "CLEAN" }] }) },
  }));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.unstubAllGlobals();
  delete process.env.WEBHOOK_ROUTER_URL;
  delete process.env.SEAT_INBOX_TOKEN;
});

// ───────────────────────────── the squasher lane (bugsquasher / fleet-internal) ─────────────────────────────

describe("evaluate — BEHIND PR that passed every lane pre-check", () => {
  it("POSITIVE: exactly one update-branch PUT pinned to the evaluated head; no merge, no label, no paid review; the exact receipt", async () => {
    install();
    await run();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].join(" ")).toContain(`repos/${REPO}/pulls/${PR}/update-branch -f expected_head_sha=${HEAD}`);
    expect(merges()).toHaveLength(0);
    expect(labelWrites()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
    expect(markerComments()).toHaveLength(1);
    // the attempt is recorded BEFORE the call (so a failed attempt still counts toward the cap)
    const order = calls.map((c) => c.slice(1).join(" "));
    expect(order.findIndex((s) => s.startsWith("pr comment"))).toBeLessThan(order.findIndex((s) => s.startsWith("api -X PUT")));
    expect(out()).toContain(
      formatGateReceiptLine({ repo: REPO, pr: PR, prClass: "fleet-internal", verdict: "missed", leg: "behind", reasons: ["update-branch requested"] }),
    );
    expect(out()).toContain(`[gate-receipt] repo=${REPO} pr=${PR} class=fleet-internal verdict=missed leg=behind reasons="update-branch requested"`);
  });

  it("CONTROL: CLEAN takes the existing path unchanged — review runs, the SHA-pinned merge fires, no update-branch", async () => {
    install({ pr: { mergeStateStatus: "CLEAN" } });
    await run();
    expect(puts()).toHaveLength(0);
    expect(markerComments()).toHaveLength(0);
    expect(anthropicClientSpy).toHaveBeenCalled();
    expect(merges()).toHaveLength(1);
    expect(merges()[0].join(" ")).toContain(`--match-head-commit ${HEAD}`);
    expect(out()).toContain("verdict=qualified");
  });

  it("NEGATIVE: update-branch 422 (conflict) ⇒ refused with gh's error in the receipt, no merge, no label", async () => {
    install({ putStderr: "gh: Merge conflict between base and head (HTTP 422)" });
    await run();
    expect(puts()).toHaveLength(1);
    expect(merges()).toHaveLength(0);
    expect(labelWrites()).toHaveLength(0);
    expect(out()).toMatch(/\[gate-receipt\] .*verdict=missed leg=behind reasons="update-branch refused: gh: Merge conflict between base and head \(HTTP 422\)"/);
    expect(out()).not.toContain("update-branch requested");
  });

  it("NEGATIVE: the attempt count is unreadable ⇒ refused fail-closed, no update-branch call", async () => {
    install({ commentsReadFails: true });
    await run();
    expect(puts()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(out()).toMatch(/leg=behind reasons="update-branch not requested — the attempt count is unreadable \(fail-closed\): gh: HTTP 502"/);
  });

  it("NEGATIVE: the attempt cannot be recorded ⇒ refused fail-closed, no update-branch call", async () => {
    install({ commentPostFails: true });
    await run();
    expect(puts()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(out()).toMatch(/leg=behind reasons="update-branch not requested — the attempt could not be recorded \(fail-closed\): gh: HTTP 403"/);
  });

  it("CAP: three gate-requested calls inside 24h ⇒ `behind-cap`, no 4th call, no comment, the decision line enrolled through the existing door", async () => {
    process.env.WEBHOOK_ROUTER_URL = "http://door.test";
    process.env.SEAT_INBOX_TOKEN = "test-token";
    const fetchSpy = vi.fn(async () => ({ status: 200, text: async () => '{"created":true}' }));
    vi.stubGlobal("fetch", fetchSpy);
    install({ markers: [ago(HOUR), ago(5 * HOUR), ago(23 * HOUR)] });
    await run();
    expect(puts()).toHaveLength(0);
    expect(markerComments()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(out()).toMatch(/verdict=missed leg=behind-cap reasons="behind-cap: 3 gate-requested update-branch calls/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("http://door.test/internal/cos/decisions");
    const body = JSON.parse(init.body);
    expect(body.enrollment_key).toBe(`gate-refusal:${REPO}#${PR}@${HEAD.slice(0, 12)}`);
    expect(body.detail).toContain("behind-cap:");
    expect(body.detail).not.toContain("label `box` to merge"); // #412: box does not open this leg
  });

  it("CAP: markers older than 24h do not count — two recent + one stale ⇒ a request goes out", async () => {
    install({ markers: [ago(HOUR), ago(2 * HOUR), ago(25 * HOUR)] });
    await run();
    expect(puts()).toHaveLength(1);
    expect(out()).toContain('leg=behind reasons="update-branch requested"');
  });
});

describe("evaluate — a BEHIND PR the gate would never merge is never touched (zero update-branch calls)", () => {
  const untouched = () => {
    expect(puts()).toHaveLength(0);
    expect(markerComments()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  };

  it("wrong author (eligibility leg)", async () => {
    install({ pr: { author: { login: "someone-else" } } });
    await run();
    untouched();
    expect(out()).toContain("leg=eligibility");
  });

  it("`hold` present", async () => {
    install({ pr: { labels: [{ name: "fleet-internal" }, { name: "hold" }] } });
    await run();
    untouched();
    expect(out()).toContain("leg=held");
  });

  it("`needs-human` present on the fleet-internal class (a human's decision already)", async () => {
    install({ pr: { labels: [{ name: "fleet-internal" }, { name: "needs-human" }] } });
    await run();
    untouched();
    expect(out()).toContain("leg=eligibility");
  });

  it("class not enabled for this caller (class-match leg)", async () => {
    install();
    await run({ classes: ["docs-comment"] });
    untouched();
    expect(out()).toContain("leg=class-match");
  });

  it("a named required check is not green (named-checks leg)", async () => {
    install();
    await run({ checks: ["syntax", "not-present"] });
    untouched();
    expect(out()).toContain("leg=named-checks");
  });

  it("a review FLAG already stands on this head — parked; the gate must not mint a new head that re-rolls the vote (stint #724)", async () => {
    install({ reviewFlag: true });
    await run();
    untouched();
    expect(out()).toContain("leg=review");
  });

  it("CI red (the floor stands)", async () => {
    install({ pr: { statusCheckRollup: [check("syntax", "FAILURE")] } });
    await run();
    untouched();
    expect(out()).toMatch(/leg=ci-rollup reasons="state=OPEN isDraft=false ciClean=false mergeStateStatus=BEHIND"/);
  });

  it("draft (the floor stands)", async () => {
    install({ pr: { isDraft: true } });
    await run();
    untouched();
    expect(out()).toContain("leg=ci-rollup");
  });
});

describe("evaluate — Kevin's box on a BEHIND squasher-lane PR (evaluateQueuedOverride)", () => {
  it("POSITIVE: an authorized, revalidated box + BEHIND ⇒ one update-branch PUT, no merge", async () => {
    install({ pr: { labels: [{ name: "fleet-internal" }, { name: "box" }] } });
    await run();
    expect(puts()).toHaveLength(1);
    expect(merges()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
    expect(out()).toContain('leg=behind reasons="update-branch requested"');
  });

  it("CONTROL: the same box on a CLEAN head merges as before (SHA-pinned) with no update-branch", async () => {
    install({ pr: { labels: [{ name: "fleet-internal" }, { name: "box" }], mergeStateStatus: "CLEAN" } });
    await run();
    expect(puts()).toHaveLength(0);
    expect(merges()).toHaveLength(1);
    expect(merges()[0].join(" ")).toContain(`--match-head-commit ${HEAD}`);
  });
});

// ───────────────────────────── the train lane (box on a human PR) ─────────────────────────────

describe("evaluateTrainReady — Kevin's box on an otherwise-ready BEHIND PR", () => {
  const train = (over: Record<string, unknown> = {}, w: World = {}) => {
    install({ ...w, pr: { labels: [{ name: "box" }], files: [{ path: "src/x.ts" }], ...over } });
    return evaluateTrainReady(REPO, PR, { door: null });
  };

  it("POSITIVE: authorized box + green rollup + BEHIND ⇒ one update-branch PUT, outcome refused (never merged), train receipt names it", async () => {
    const res = await train();
    expect(res.outcome).toBe("refused");
    expect(res.detail).toBe("behind: update-branch requested");
    expect(puts()).toHaveLength(1);
    expect(puts()[0].join(" ")).toContain(`expected_head_sha=${HEAD}`);
    expect(merges()).toHaveLength(0);
    expect(labelWrites()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
    expect(out()).toContain(`[train-gate-receipt] repo=${REPO} pr=${PR} outcome=refused detail="behind: update-branch requested"`);
  });

  it("CONTROL: the same box on a CLEAN head merges, no update-branch", async () => {
    const res = await train({ mergeStateStatus: "CLEAN" });
    expect(res.outcome).toBe("merged");
    expect(puts()).toHaveLength(0);
    expect(merges()).toHaveLength(1);
  });

  it("NEGATIVE: 422 ⇒ refused with the error, no merge", async () => {
    const res = await train({}, { putStderr: "gh: Merge conflict between base and head (HTTP 422)" });
    expect(res.outcome).toBe("refused");
    expect(res.detail).toContain("update-branch refused: gh: Merge conflict between base and head (HTTP 422)");
    expect(merges()).toHaveLength(0);
  });

  it("CAP: three recent requests ⇒ behind-cap, no 4th call, no merge", async () => {
    const res = await train({}, { markers: [ago(HOUR), ago(2 * HOUR), ago(3 * HOUR)] });
    expect(res.outcome).toBe("refused");
    expect(res.detail).toContain("behind: behind-cap:");
    expect(puts()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
  });

  it("LANE: NO box label ⇒ the authority leg refuses first — zero update-branch calls", async () => {
    const res = await train({ labels: [{ name: "needs-human" }] });
    expect(res.outcome).toBe("refused");
    expect(puts()).toHaveLength(0);
    expect(markerComments()).toHaveLength(0);
  });

  it("LANE: box + BEHIND but CI red ⇒ the floor refuses first — zero update-branch calls", async () => {
    const res = await train({ statusCheckRollup: [check("ci", "FAILURE")] });
    expect(res.outcome).toBe("refused");
    expect(puts()).toHaveLength(0);
  });
});

// ───────────────────────────── the library, its seams, and the pure edges ─────────────────────────────

describe("requestBehindUpdate / countRecentRequests (the real functions)", () => {
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it("counts only markers inside the 24h window; the boundary is exclusive; an unparseable stamp counts (fail closed)", () => {
    expect(countRecentRequests([iso(1), iso(BEHIND_UPDATE_WINDOW_MS - 1)], NOW)).toBe(2);
    expect(countRecentRequests([iso(BEHIND_UPDATE_WINDOW_MS), iso(BEHIND_UPDATE_WINDOW_MS + 1000)], NOW)).toBe(0);
    expect(countRecentRequests(["not-a-date"], NOW)).toBe(1);
  });

  it("makes exactly the three calls, in order, with the pinned head — and the 4th attempt makes none", () => {
    const seen: string[][] = [];
    const markers: string[] = [];
    const gh = (args: string[]) => {
      seen.push(args);
      if (args[0] === "api" && args[1].includes("/comments")) return markers.join("\n");
      if (args[0] === "pr") markers.push(iso(0));
      return "";
    };
    for (let i = 1; i <= BEHIND_UPDATE_CAP; i++) {
      expect(requestBehindUpdate(gh, REPO, PR, HEAD, NOW)).toEqual({ kind: "requested", used: i });
    }
    const putCount = () => seen.filter((a) => a[0] === "api" && a[1] === "-X").length;
    expect(putCount()).toBe(BEHIND_UPDATE_CAP);
    expect(requestBehindUpdate(gh, REPO, PR, HEAD, NOW)).toEqual({ kind: "capped", used: BEHIND_UPDATE_CAP });
    expect(putCount()).toBe(BEHIND_UPDATE_CAP); // no 4th PUT
    expect(seen.filter((a) => a[0] === "pr").length).toBe(BEHIND_UPDATE_CAP); // no 4th marker
  });
});

describe("the pure edges", () => {
  it("evaluateMergeReadiness: BEHIND is ready ONLY with allowBehind, and only when open + not draft + CI clean", () => {
    const base = { state: "OPEN", isDraft: false, ciClean: true, mergeStateStatus: "BEHIND" };
    expect(evaluateMergeReadiness(base).ready).toBe(false); // every caller that does not opt in: unchanged
    expect(evaluateMergeReadiness({ ...base, allowBehind: true }).ready).toBe(true);
    expect(evaluateMergeReadiness({ ...base, allowBehind: true, ciClean: false }).ready).toBe(false);
    expect(evaluateMergeReadiness({ ...base, allowBehind: true, isDraft: true }).ready).toBe(false);
    expect(evaluateMergeReadiness({ ...base, allowBehind: true, mergeStateStatus: "DIRTY" }).ready).toBe(false);
    expect(evaluateMergeReadiness({ ...base, allowBehind: true, mergeStateStatus: "BLOCKED" }).ready).toBe(false);
  });

  it("behind-cap is a decision leg (enrolled); plain behind is a wait — and the enroll copy names the door that works", () => {
    expect(isDecisionLeg("behind-cap")).toBe(true);
    expect(isDecisionLeg("behind")).toBe(false);
    const d = buildEnrollment({ repo: REPO, pr: PR, headSha: HEAD, leg: "behind-cap", reasons: ["behind-cap: 3 calls"], additions: 2, deletions: 0 }).detail;
    expect(d).toContain("update the branch by hand");
    expect(d).not.toContain("label `box` to merge");
    expect(buildEnrollment({ repo: REPO, pr: PR, headSha: HEAD, leg: "review", reasons: ["x"], additions: 1, deletions: 0 }).detail).toContain("label `box` to merge");
  });

  it("sweep fingerprint: the head sha an update-branch mints makes the PR 'changed' (so the next sweep re-evaluates it)", () => {
    const pr = { headRefOid: HEAD, statusCheckRollup: [{ name: "syntax", conclusion: "SUCCESS" }], labels: [{ name: "fleet-internal" }], mergeStateStatus: "BEHIND", isDraft: false };
    expect(fingerprintOf({ ...pr, headRefOid: "b2".repeat(20) }, "g1")).not.toBe(fingerprintOf(pr, "g1"));
    // even if CI had not yet registered on the new head, BEHIND → CLEAN alone also changes it
    expect(fingerprintOf({ ...pr, mergeStateStatus: "CLEAN" }, "g1")).not.toBe(fingerprintOf(pr, "g1"));
  });
});
