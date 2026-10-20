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
 *   CAP       3 charged gate updates in 24h ⇒ `behind-cap`, NO 4th call, the decision line is enrolled
 *             through the existing door. An attempt overtaken by a GATE merge of another PR is not charged.
 *   LEASE     one gate update per repo at a time: a sibling's in-flight update ⇒ `deferred`, zero calls,
 *             nothing charged (the herd — review F3).
 *   PARK      a BEHIND PR parked for a human (code-fix flap guard, blind flap read, `needs-human`) ⇒ ZERO
 *             update-branch calls, because the gate's own merge commit would un-park it (review F1).
 *   LANE      a BEHIND PR that FAILS a lane pre-check (wrong author, hold, standing review FLAG,
 *             CI red, draft, no box, not an enabled class) ⇒ ZERO update-branch calls — the gate
 *             never touches a PR it would not merge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateMergeReadiness } from "../automerge-classify.js";
import { buildEnrollment, isDecisionLeg } from "../gate-enroll.js";
import { formatGateReceiptLine } from "../automerge-telemetry.js";
import { BEHIND_RECHECK_MS, fingerprintOf } from "../fleet-sweep-changed.js";
import {
  BEHIND_LEASE_TTL_MS,
  BEHIND_MARKER,
  BEHIND_UPDATE_CAP,
  BEHIND_UPDATE_WINDOW_MS,
  MERGED_MARKER,
  chargedAttempts,
  leaseCandidates,
  parseMarks,
  requestBehindUpdate,
} from "../behind-update.js";
import { GATE_AUTHORITY_LOGIN } from "../label-authority.js";

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
  marks?: string[]; // raw repo-wide marker lines, as the gate's jq emits them (see mark())
  states?: Record<number, string>; // sibling PR states for the lease-holder lookup (default "open")
  holderLookupFails?: boolean;
  putStderr?: string; // make the update-branch PUT fail with this gh stderr
  commentsReadFails?: boolean;
  commentPostFails?: boolean;
  reviewFlag?: boolean; // a review FLAG blue card already stands on the head
  timeline?: string; // the GraphQL authority timeline (default: Kevin's box after the head)
}

const GATE = GATE_AUTHORITY_LOGIN;
let nowAt = Date.now();
/** One line of the gate's repo-wide marker read: login, kind, PR number, created_at. */
const mark = (kind: "update" | "merged", pr: number, msAgo: number, who: string = GATE) => `${who}\t${kind}\t${pr}\t${new Date(nowAt - msAgo).toISOString()}`;

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
    if (a.startsWith("api graphql")) {
      if (w.timeline === "THROW") throw Object.assign(new Error("Command failed: gh api graphql"), { stderr: "gh: HTTP 502" });
      return w.timeline ?? TIMELINE_BOX_AFTER_HEAD;
    }
    if (a.includes("/issues/comments?since=")) {
      if (w.commentsReadFails) throw Object.assign(new Error("Command failed: gh api comments"), { stderr: "gh: HTTP 502" });
      return (w.marks ?? []).join("\n");
    }
    const holder = /^api repos\/[^/]+\/[^/]+\/pulls\/(\d+) --jq \.state$/.exec(a);
    if (holder) {
      if (w.holderLookupFails) throw Object.assign(new Error("Command failed: gh api pulls"), { stderr: "gh: HTTP 500" });
      return `${w.states?.[Number(holder[1])] ?? "open"}\n`;
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
const commentBodies = () => on(/^pr comment/).map((c) => c[c.indexOf("--body") + 1]);
const out = () => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
const HOUR = 3_600_000;

const run = (over: Partial<{ classes: string[]; checks: string[] }> = {}) =>
  evaluate(REPO, PR, (over.classes ?? ["fleet-internal"]) as never, [], [], over.checks ?? ["syntax"], []);

beforeEach(() => {
  nowAt = Date.now();
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
    // the merge receipt carries the MERGED marker, so a sibling's cap can see the base moved by a gate merge
    expect(commentBodies().filter((b) => b.startsWith(`${MERGED_MARKER} -->\n`))).toHaveLength(1);
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

  it("NEGATIVE: the attempt record is unreadable ⇒ refused fail-closed, no update-branch call", async () => {
    install({ commentsReadFails: true });
    await run();
    expect(puts()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(out()).toMatch(/leg=behind reasons="update-branch not requested — the attempt record is unreadable \(fail-closed\): gh: HTTP 502"/);
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
    install({ marks: [mark("update", PR, HOUR), mark("update", PR, 5 * HOUR), mark("update", PR, 23 * HOUR)] });
    await run();
    expect(puts()).toHaveLength(0);
    expect(markerComments()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(out()).toMatch(/verdict=missed leg=behind-cap reasons="behind-cap: 3 gate updates on this PR in the last 24h/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("http://door.test/internal/cos/decisions");
    const body = JSON.parse(init.body);
    expect(body.enrollment_key).toBe(`gate-refusal:${REPO}#${PR}@${HEAD.slice(0, 12)}`);
    expect(body.detail).toContain("behind-cap:");
    expect(body.detail).not.toContain("label `box` to merge"); // #412: box does not open this leg
  });

  it("CAP: markers older than 24h do not count — two recent + one stale ⇒ a request goes out", async () => {
    install({ marks: [mark("update", PR, HOUR), mark("update", PR, 2 * HOUR), mark("update", PR, 25 * HOUR)] });
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
    expect(commentBodies().filter((b) => b.startsWith(`${MERGED_MARKER} -->\n`))).toHaveLength(1);
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
    expect(commentBodies().filter((b) => b.startsWith(`${MERGED_MARKER} -->\n`))).toHaveLength(1);
  });

  it("NEGATIVE: 422 ⇒ refused with the error, no merge", async () => {
    const res = await train({}, { putStderr: "gh: Merge conflict between base and head (HTTP 422)" });
    expect(res.outcome).toBe("refused");
    expect(res.detail).toContain("update-branch refused: gh: Merge conflict between base and head (HTTP 422)");
    expect(merges()).toHaveLength(0);
  });

  it("CAP: three recent requests ⇒ behind-cap, no 4th call, no merge", async () => {
    const res = await train({}, { marks: [mark("update", PR, HOUR), mark("update", PR, 2 * HOUR), mark("update", PR, 3 * HOUR)] });
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

// ───────────────────────────── review F1: a parked head is never un-parked by the gate's own merge commit ─────────────────────────────

const tl = (nodes: unknown[]) =>
  JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { filteredCount: nodes.length, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes } } } } });
const lab = (name: string) => ({ __typename: "LabeledEvent", label: { name }, actor: { __typename: "User", login: "kbibelhausen" }, createdAt: "2026-10-19T07:00:00Z" });
const unlab = (name: string) => ({ __typename: "UnlabeledEvent", label: { name }, actor: { __typename: "User", login: "kbibelhausen" }, createdAt: "2026-10-19T07:01:00Z" });
// the bolt-wms#2120 shape: one commit, then the merge label added 3 times against that head
const FLAP_TIMELINE = tl([{ __typename: "PullRequestCommit" }, lab("automerge:code-fix"), unlab("automerge:code-fix"), lab("automerge:code-fix"), unlab("automerge:code-fix"), lab("automerge:code-fix"), unlab("automerge:code-fix")]);
const HEALTHY_TIMELINE = tl([{ __typename: "PullRequestCommit" }, lab("automerge:code-fix")]);

describe("evaluate — a BEHIND code-fix PR parked at the flap guard is never un-parked by the gate's own merge commit (review F1)", () => {
  const codeFix = (w: World = {}) => {
    install({ ...w, pr: { labels: [{ name: "bugsquasher" }], ...w.pr } });
    return evaluate(REPO, PR, ["code-fix"] as never, [], ["*.py"], ["syntax"], []);
  };
  const flapReceipt = () => formatGateReceiptLine({ repo: REPO, pr: PR, prClass: "code-fix", verdict: "missed", leg: "flap-guard", reasons: [] }).replace(/ reasons="[^"]*"$/, "");
  const fetchSpyWithDoor = () => {
    process.env.WEBHOOK_ROUTER_URL = "http://door.test";
    process.env.SEAT_INBOX_TOKEN = "test-token";
    const spy = vi.fn(async () => ({ status: 200, text: async () => '{"created":true}' }));
    vi.stubGlobal("fetch", spy);
    return spy;
  };
  const enrolledLegs = (spy: ReturnType<typeof fetchSpyWithDoor>) =>
    (spy.mock.calls as unknown as [string, { body: string }][]).map(([, init]) => JSON.parse(init.body).detail as string);

  it("CONTROL: CLEAN + flapping ⇒ refused at flap-guard, decision enrolled, no merge (the existing leg)", async () => {
    const door = fetchSpyWithDoor();
    await codeFix({ pr: { mergeStateStatus: "CLEAN" }, timeline: FLAP_TIMELINE });
    expect(merges()).toHaveLength(0);
    expect(puts()).toHaveLength(0);
    expect(out()).toContain(flapReceipt());
    expect(enrolledLegs(door).some((d) => d.includes("flap-guard:"))).toBe(true);
  });

  it("POSITIVE: BEHIND + flapping ⇒ ZERO update-branch calls, the same flap-guard receipt and enrollment; a second cycle never merges", async () => {
    const door = fetchSpyWithDoor();
    await codeFix({ timeline: FLAP_TIMELINE });
    await codeFix({ timeline: FLAP_TIMELINE }); // the next sweep: nothing was un-parked, so nothing changed
    expect(puts()).toHaveLength(0);
    expect(markerComments()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(labelWrites()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled(); // parked before the paid review
    expect(out().split(flapReceipt()).length - 1).toBe(2); // one flap-guard receipt per cycle, identical to the CLEAN control's
    expect(enrolledLegs(door).filter((d) => d.includes("flap-guard:")).length).toBe(2); // idempotent per head at the door
    expect(out()).not.toContain("leg=behind");
  });

  it("NEGATIVE: BEHIND + an unreadable timeline ⇒ the flap read is blind ⇒ treated as flapping ⇒ zero update-branch calls", async () => {
    fetchSpyWithDoor();
    await codeFix({ timeline: "THROW" });
    expect(puts()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(out()).toMatch(/leg=flap-guard reasons="the authority timeline could not be read, so the flap guard is blind/);
  });

  it("CONTROL: BEHIND + code-fix + NOT flapping ⇒ the guard is not blanket — exactly one update-branch PUT, still no merge", async () => {
    await codeFix({ timeline: HEALTHY_TIMELINE });
    expect(puts()).toHaveLength(1);
    expect(merges()).toHaveLength(0);
    expect(out()).toContain('class=code-fix verdict=missed leg=behind reasons="update-branch requested"');
  });

  it("`needs-human` on a BEHIND PR of a class that does not park on it ⇒ a human's ask is open ⇒ zero update-branch calls, no merge, no enrollment", async () => {
    const door = fetchSpyWithDoor();
    await codeFix({ timeline: HEALTHY_TIMELINE, pr: { labels: [{ name: "bugsquasher" }, { name: "needs-human" }] } });
    expect(puts()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(door).not.toHaveBeenCalled();
    expect(out()).toMatch(/class=code-fix verdict=missed leg=behind reasons="`needs-human` is present — a human's ask is open/);
  });

  it("but Kevin's box answers the ask: box + needs-human + BEHIND on the train lane still gets its update (box opens every decision leg)", async () => {
    install({ pr: { labels: [{ name: "box" }, { name: "needs-human" }], files: [{ path: "src/x.ts" }] } });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.detail).toBe("behind: update-branch requested");
    expect(puts()).toHaveLength(1);
  });
});

// ───────────────────────────── review F3: one gate update per repo at a time ─────────────────────────────

describe("evaluate — the repo lease: a sibling's in-flight update defers this one (zero calls, nothing charged)", () => {
  const SIBLING = 701;
  const spyDoor = () => {
    process.env.WEBHOOK_ROUTER_URL = "http://door.test";
    process.env.SEAT_INBOX_TOKEN = "test-token";
    const spy = vi.fn(async () => ({ status: 200, text: async () => '{"created":true}' }));
    vi.stubGlobal("fetch", spy);
    return spy;
  };
  const nothingCalled = () => {
    expect(puts()).toHaveLength(0);
    expect(markerComments()).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  };

  it("POSITIVE: a sibling updated 10 minutes ago and is still open ⇒ deferred with a wait receipt; no call, no marker, no enrollment", async () => {
    const door = spyDoor();
    install({ marks: [mark("update", SIBLING, 10 * 60_000)] });
    await run();
    nothingCalled();
    expect(door).not.toHaveBeenCalled(); // the routine case never reaches Kevin
    expect(out()).toContain(`leg=behind reasons="waiting: PR #${SIBLING} holds this repo's update-branch lease`);
    expect(out()).not.toContain("leg=behind-cap");
  });

  it("the lease is released when the holder merged since (its MERGED marker follows its update) ⇒ this PR is updated", async () => {
    install({ marks: [mark("update", SIBLING, 40 * 60_000), mark("merged", SIBLING, 5 * 60_000)] });
    await run();
    expect(puts()).toHaveLength(1);
  });

  it("the lease is released when the holder was closed unmerged ⇒ this PR is updated", async () => {
    install({ marks: [mark("update", SIBLING, 10 * 60_000)], states: { [SIBLING]: "closed" } });
    await run();
    expect(puts()).toHaveLength(1);
  });

  it("the lease expires after the TTL even if the holder is still open (a stuck holder cannot block the repo forever)", async () => {
    install({ marks: [mark("update", SIBLING, BEHIND_LEASE_TTL_MS + 60_000)] });
    await run();
    expect(puts()).toHaveLength(1);
  });

  it("NEGATIVE: the holder cannot be looked up ⇒ refused fail-closed, zero calls", async () => {
    install({ marks: [mark("update", SIBLING, 10 * 60_000)], holderLookupFails: true });
    await run();
    nothingCalled();
    expect(out()).toMatch(/leg=behind reasons="update-branch not requested — the lease holder #701 is unreadable \(fail-closed\): gh: HTTP 500"/);
  });

  it("train lane: a sibling's in-flight update defers Kevin's boxed PR too (one update per repo, any lane) — refused, nothing charged", async () => {
    install({ marks: [mark("update", SIBLING, 10 * 60_000)], pr: { labels: [{ name: "box" }], files: [{ path: "src/x.ts" }] } });
    const res = await evaluateTrainReady(REPO, PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(res.detail).toContain(`behind: waiting: PR #${SIBLING} holds this repo's update-branch lease`);
    nothingCalled();
  });

  it("F4: an OUTSIDER's look-alike markers neither cap this PR nor hold the lease", async () => {
    const door = spyDoor();
    install({
      marks: [
        mark("update", PR, HOUR, "drive-by-commenter"),
        mark("update", PR, 2 * HOUR, "drive-by-commenter"),
        mark("update", PR, 3 * HOUR, "drive-by-commenter"),
        mark("update", SIBLING, 5 * 60_000, "drive-by-commenter"),
      ],
    });
    await run();
    expect(puts()).toHaveLength(1);
    expect(door).not.toHaveBeenCalled();
  });

  it("cap refund: three attempts overtaken by a gate merge of a sibling are not charged ⇒ not capped ⇒ updated", async () => {
    install({ marks: [mark("update", PR, 5 * HOUR), mark("update", PR, 4 * HOUR), mark("update", PR, 3 * HOUR), mark("merged", SIBLING, HOUR)] });
    await run();
    expect(puts()).toHaveLength(1);
    expect(out()).not.toContain("behind-cap");
  });

  it("cap, control: the same three attempts with NO gate merge since ⇒ capped (a human moved the base, or nothing did)", async () => {
    spyDoor();
    install({ marks: [mark("update", PR, 5 * HOUR), mark("update", PR, 4 * HOUR), mark("update", PR, 3 * HOUR)] });
    await run();
    expect(puts()).toHaveLength(0);
    expect(out()).toContain("leg=behind-cap");
  });
});

// ───────────────────────────── the library, its seams, and the pure edges ─────────────────────────────

describe("requestBehindUpdate / parseMarks / chargedAttempts / leaseCandidates (the real functions)", () => {
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const at = (msAgo: number) => NOW - msAgo;
  const upd = (pr: number, msAgo: number) => ({ kind: "update" as const, pr, at: at(msAgo) });
  const mrg = (pr: number, msAgo: number) => ({ kind: "merged" as const, pr, at: at(msAgo) });

  it("charges only this PR's attempts inside the 24h window; the boundary is exclusive; an unparseable stamp counts (fail closed)", () => {
    expect(chargedAttempts([upd(PR, 1), upd(PR, BEHIND_UPDATE_WINDOW_MS - 1)], PR, NOW)).toBe(2);
    expect(chargedAttempts([upd(PR, BEHIND_UPDATE_WINDOW_MS), upd(PR, BEHIND_UPDATE_WINDOW_MS + 1000)], PR, NOW)).toBe(0);
    expect(chargedAttempts([{ kind: "update", pr: PR, at: Number.NaN }], PR, NOW)).toBe(1);
    expect(chargedAttempts([upd(PR + 1, 1)], PR, NOW)).toBe(0); // someone else's attempt is not mine
  });

  it("does NOT charge an attempt that a gate merge of ANOTHER PR overtook; does charge one after the last merge; an unparseable merge stamp refunds nothing", () => {
    // my attempts 5h and 3h ago; a sibling merged 4h ago (overtakes the 5h one); none after
    expect(chargedAttempts([upd(PR, 5 * HOUR), mrg(PR + 1, 4 * HOUR), upd(PR, 3 * HOUR)], PR, NOW)).toBe(1);
    // the sibling merged after both ⇒ neither is charged
    expect(chargedAttempts([upd(PR, 5 * HOUR), upd(PR, 3 * HOUR), mrg(PR + 1, HOUR)], PR, NOW)).toBe(0);
    // my OWN merge marker cannot refund my own attempts
    expect(chargedAttempts([upd(PR, 5 * HOUR), mrg(PR, HOUR)], PR, NOW)).toBe(1);
    // a merge marker with a garbage stamp must not refund anything (fail closed)
    expect(chargedAttempts([upd(PR, 5 * HOUR), { kind: "merged", pr: PR + 1, at: Number.NaN }], PR, NOW)).toBe(1);
  });

  it("lease: an in-flight sibling update holds it; stale, own, merged-since, or older-than-TTL updates do not", () => {
    expect(leaseCandidates([upd(701, 10 * 60_000)], PR, NOW)).toEqual([701]);
    expect(leaseCandidates([upd(PR, 10 * 60_000)], PR, NOW)).toEqual([]); // my own update is not a lease against me
    expect(leaseCandidates([upd(701, BEHIND_LEASE_TTL_MS)], PR, NOW)).toEqual([]); // exactly TTL old: expired
    expect(leaseCandidates([upd(701, BEHIND_LEASE_TTL_MS - 1)], PR, NOW)).toEqual([701]);
    expect(leaseCandidates([upd(701, 30 * 60_000), mrg(701, 10 * 60_000)], PR, NOW)).toEqual([]); // it merged since
    expect(leaseCandidates([upd(701, 30 * 60_000), upd(701, 20 * 60_000), upd(702, 5 * 60_000)], PR, NOW)).toEqual([701, 702]);
  });

  it("parseMarks keeps ONLY the gate's own login (an outsider's look-alike marker is ignored — F4) and drops malformed lines", () => {
    const out = [
      `${GATE}\tupdate\t701\t2026-10-20T11:00:00Z`,
      `someone-else\tupdate\t701\t2026-10-20T11:00:00Z`,
      `${GATE}[bot]\tupdate\t701\t2026-10-20T11:00:00Z`, // near-miss login
      `${GATE}\tbogus\t701\t2026-10-20T11:00:00Z`,
      `${GATE}\tupdate\tNaN\t2026-10-20T11:00:00Z`,
      `${GATE}\tmerged\t702\t2026-10-20T11:30:00Z`,
      "",
    ].join("\n");
    expect(parseMarks(out)).toEqual([
      { kind: "update", pr: 701, at: Date.parse("2026-10-20T11:00:00Z") },
      { kind: "merged", pr: 702, at: Date.parse("2026-10-20T11:30:00Z") },
    ]);
  });

  it("makes exactly the three calls, in order, with the pinned head — and the 4th attempt makes none", () => {
    const seen: string[][] = [];
    const lines: string[] = [];
    const gh = (args: string[]) => {
      seen.push(args);
      if (args[0] === "api" && args[1].includes("/issues/comments?since=")) return lines.join("\n");
      if (args[0] === "pr") lines.push(`${GATE}\tupdate\t${PR}\t${new Date(NOW).toISOString()}`);
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

  it("the repo-wide read asks GitHub only for the last 24h, and a lease holder's state is read before deferring", () => {
    const seen: string[] = [];
    const gh = (args: string[]) => {
      seen.push(args.join(" "));
      if (args[1]?.includes("/issues/comments?since=")) return `${GATE}\tupdate\t701\t${new Date(NOW - 600_000).toISOString()}`;
      if (args[1]?.includes("/pulls/701")) return "open\n";
      return "";
    };
    expect(requestBehindUpdate(gh, REPO, PR, HEAD, NOW)).toEqual({ kind: "deferred", holder: 701 });
    expect(seen[0]).toContain(`repos/${REPO}/issues/comments?since=2026-10-19T12:00:00Z&per_page=100`);
    expect(seen[1]).toBe(`api repos/${REPO}/pulls/701 --jq .state`);
    expect(seen).toHaveLength(2); // nothing recorded, nothing called
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
    expect(fingerprintOf({ ...pr, headRefOid: "b2".repeat(20) }, "g1", 0)).not.toBe(fingerprintOf(pr, "g1", 0));
    // even if CI had not yet registered on the new head, BEHIND → CLEAN alone also changes it
    expect(fingerprintOf({ ...pr, mergeStateStatus: "CLEAN" }, "g1", 0)).not.toBe(fingerprintOf(pr, "g1", 0));
    // and the status field itself is part of the print (neither side carries the BEHIND clock term here)
    expect(fingerprintOf({ ...pr, mergeStateStatus: "BLOCKED" }, "g1", 0)).not.toBe(fingerprintOf({ ...pr, mergeStateStatus: "CLEAN" }, "g1", 0));
  });

  it("sweep fingerprint: a BEHIND PR is 'changed' every hour with nothing else moving (a deferred / refused / capped PR is looked at again); every other state is clock-free and byte-identical", () => {
    const pr = { headRefOid: HEAD, statusCheckRollup: [{ name: "syntax", conclusion: "SUCCESS" }], labels: [{ name: "fleet-internal" }], mergeStateStatus: "BEHIND", isDraft: false };
    const t0 = 1_000_000 * 3_600_000; // an hour boundary, literal on purpose: the cadence is pinned, not derived from the constant under test
    expect(BEHIND_RECHECK_MS).toBe(3_600_000);
    expect(fingerprintOf(pr, "g1", t0)).toBe(fingerprintOf(pr, "g1", t0 + 3_600_000 - 1)); // same hour: unchanged
    expect(fingerprintOf(pr, "g1", t0)).not.toBe(fingerprintOf(pr, "g1", t0 + 3_600_000)); // next hour: changed
    expect(fingerprintOf(pr, "g1", t0)).not.toBe(fingerprintOf(pr, "g1", t0 + 24 * 3_600_000)); // after the 24h window rolls: changed
    const clean = { ...pr, mergeStateStatus: "CLEAN" };
    expect(fingerprintOf(clean, "g1", t0)).toBe(fingerprintOf(clean, "g1", t0 + 99 * 3_600_000));
    expect(fingerprintOf(clean, "g1", t0)).toBe("a1".repeat(20) + "|syntax=SUCCESS|fleet-internal|CLEAN|ready|g1");
  });
});
