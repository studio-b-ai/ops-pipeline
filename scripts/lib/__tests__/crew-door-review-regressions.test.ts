/**
 * Stint #928 — regression tests for the seven BLOCKING findings of the independent door review of
 * ops-pipeline#580 at a9b614c (three lenses, opus finders + adversarial verifiers that ran the real
 * `evaluate()` on the PR head and on origin/main: 37 found, 22 confirmed, verdict DO NOT SHIP).
 *
 * Every test here imports and calls the REAL functions (Rule #223) against the stateful fake GitHub
 * (fixtures/fake-gh.ts) — labels, head, timeline, comments, check runs and CI all persist and mutate
 * across sweeps, which is the only way the cross-sweep defects the review found can be expressed.
 * Each block names the finding it pins; each was mutation-checked (the fix removed ⇒ the block fails).
 *
 *   F1  over-cap crew code-fix is REFUSED, never routed to the uncapped, unlabeled fleet-internal class
 *   F2  every crew PR that resolves fleet-internal gets the tripwire label before its direct merge
 *   F3  the sticky-flag park runs BEFORE the stale-base leg (update-branch must not re-roll a FLAG)
 *   F4  the gate's bot box is never written or honored while `needs-human` is on the PR
 *   F5  the bot's box is bound to the sha the gate qualified (TOCTOU: a push around the box write)
 *   F6  (studiob's restart-train door: restart-train-crew-guards.test.ts)
 *   F7  Kevin's own box survives the gate's own update-branch merge commit — and nothing else
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { flagCardMarkersFor } from "../gate-flag-card.js";
import { authorizeAcrossGateRebase, type GateRebaseContext } from "../crew-merge-guards.js";
import { evaluateLabelAuthority, fetchAuthorityTimeline, QUEUED_LABEL_PAIR, type AuthorityInput, type AuthorityTimelineItem } from "../label-authority.js";
import { FLEET_APP_SLUG, FRESH, STALE_BY_AGE, World } from "./fixtures/fake-gh.js";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const reviewCreate = vi.hoisted(() => vi.fn());
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: () => ({ messages: { create: reviewCreate } }) }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluate, evaluateTrainReady } = await import("../../pr-automerge-gate.js");

const PR = 580;
const TW = "automerge:code-fix";
const CLEAN = { stop_reason: "end_turn", content: [{ type: "text", text: "CLEAN" }] };
const FLAG = { stop_reason: "end_turn", content: [{ type: "text", text: "FLAG: changes order totals with no test" }] };

let world: World;
let logLines: string[];

function install(init: Partial<ConstructorParameters<typeof World>[0]> & { labels: string[] }, repo = "studio-b-ai/radio"): World {
  world = new World({ repo, pr: PR, ...init });
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => world.handle(cmd, args));
  return world;
}
const receipts = () => logLines.filter((l) => l.startsWith("[gate-receipt]"));

// ───────── radio's REAL config (the one repo with a tripwire caller) from the live registry ─────────
const registry = JSON.parse(readFileSync(new URL("../../squasher-fleet.json", import.meta.url), "utf-8")) as { repos: Array<Record<string, unknown>> };
const radio = registry.repos.find((r) => r.repo === "studio-b-ai/radio") as Record<string, string>;
const csv = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const RADIO = {
  enabled: csv(radio.enabled_classes),
  sensitive: csv(radio.sensitive_path_patterns),
  globs: csv(radio.safe_path_globs),
  required: csv(radio.required_checks),
};
const radioSweep = () => evaluate("studio-b-ai/radio", PR, RADIO.enabled as never, RADIO.sensitive, RADIO.globs, RADIO.required, []);
/** A crew PR on radio with CI green for radio's own named checks. */
function radioCrewPr(extra: Partial<ConstructorParameters<typeof World>[0]>): World {
  const w = install({ labels: ["fleet-internal"], baseBehind: FRESH, ...extra });
  w.ciRows = RADIO.required.map((name) => ({ name, status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-20T09:00:00Z" }));
  return w;
}

beforeEach(() => {
  logLines = [];
  execFileSyncMock.mockReset();
  reviewCreate.mockReset();
  reviewCreate.mockResolvedValue(CLEAN);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  });
});

// ═════════════════════════════ F1 / F2 ═════════════════════════════

describe("F1 — a crew code-fix over the 200-line cap is REFUSED on radio's real config, never merged unwatched", () => {
  it("the fixture is radio's live registry entry (code-fix AND fleet-internal enabled, safe globs include src/**)", () => {
    expect(RADIO.enabled).toEqual(expect.arrayContaining(["code-fix", "fleet-internal"]));
    expect(RADIO.globs).toContain("src/**");
    expect(RADIO.required.length).toBeGreaterThan(0);
  });

  it.each([201, 450])("inside the safe globs at %i additions: line-cap refusal, and across THREE sweeps no merge, no candidate/box, no tripwire label, no vote", async (additions) => {
    const w = radioCrewPr({ files: ["src/lib/fix.ts"], additions, deletions: 0 });
    await radioSweep();
    await radioSweep();
    await radioSweep();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.labelAddAttempts().filter((l) => ["candidate", "box", TW].includes(l))).toEqual([]);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(receipts().filter((r) => r.includes("leg=line-cap"))).toHaveLength(3);
  });

  it.each([150, 200])("control: %i additions inside the globs is a normal crew candidate that merges WATCHED on sweep 2", async (additions) => {
    const w = radioCrewPr({ files: ["src/lib/fix.ts"], additions, deletions: 0 });
    await radioSweep();
    await radioSweep();
    expect(w.merges).toHaveLength(1);
    expect(w.merges[0].labels).toContain(TW);
  });
});

describe("F2 — a crew PR that resolves fleet-internal (outside radio's safe globs) merges only WITH the tripwire label", () => {
  it.each([201, 450])("%i additions outside the globs: the label is written first and holds the cycle; the direct merge on the next sweep carries it", async (additions) => {
    const w = radioCrewPr({ files: ["infra/helper.ts"], additions, deletions: 0 });
    await radioSweep();
    expect(w.mergeCalls()).toHaveLength(0); // the cycle that had to write the label never merges
    expect(w.labelAddAttempts()).toEqual([TW]);
    expect(receipts().some((r) => r.includes("class=fleet-internal") && r.includes("leg=tripwire-label"))).toBe(true);
    await radioSweep();
    expect(w.merges).toHaveLength(1);
    expect(w.merges[0].labels).toContain(TW);
    expect(w.merges.every((m) => m.labels.includes(TW))).toBe(true); // no merge, ever, without it
  });

  it("if the label cannot be written the direct merge never happens, on any sweep", async () => {
    const w = radioCrewPr({ files: ["infra/helper.ts"], additions: 450, deletions: 0 });
    w.failLabelAdd = TW;
    for (let i = 0; i < 3; i++) await radioSweep();
    expect(w.mergeCalls()).toHaveLength(0);
  });
});

// ═════════════════════════════ F3 ═════════════════════════════

describe("F3 — the sticky-flag park runs BEFORE the stale-base leg: update-branch never re-rolls a FLAG", () => {
  it("a head with a standing review card is parked — zero update-branch, zero facts reads, zero votes, zero merge-authorizing labels — even though the base is stale", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE }); // NO needs-human: only the card parks it
    w.comments.push(`${flagCardMarkersFor("review", w.head)[0]}\nthe reviewer's reason`);
    await evaluate("studio-b-ai/radio", PR, ["code-fix", "fleet-internal"] as never, [], ["src/**"], ["ci"], []);
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(w.factsReads()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(w.labelAddAttempts().filter((l) => ["candidate", "box"].includes(l))).toEqual([]);
    expect(w.checkPosts("crew-qualified")).toHaveLength(0);
    expect(receipts().some((r) => r.includes("leg=review") && r.includes("parked"))).toBe(true);
  });

  it("control: the same stale PR with NO card on its head is rebased (the park is what holds it, not the staleness)", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: STALE_BY_AGE });
    await evaluate("studio-b-ai/radio", PR, ["code-fix", "fleet-internal"] as never, [], ["src/**"], ["ci"], []);
    expect(w.updateBranchAttempts()).toHaveLength(1);
  });
});

// ═════════════════════════════ F4 ═════════════════════════════

describe("F4 — the gate's bot box is never written or honored while needs-human is on the PR", () => {
  const run = (repo = "studio-b-ai/radio") => evaluate(repo, PR, ["code-fix", "fleet-internal"] as never, [], ["src/**"], ["ci"], []);

  it("normal legs: a flagged crew code-fix PR (needs-human, card on an OLDER head) is refused before any vote, rebase or label", async () => {
    const w = install({ labels: ["fleet-internal", "needs-human"], baseBehind: STALE_BY_AGE });
    await run();
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(w.labelAddAttempts()).toEqual([]);
    expect(receipts().some((r) => r.includes("leg=eligibility") && r.includes("needs-human"))).toBe(true);
  });

  it("END TO END (the reviewer's probe): flag → main moves → re-evaluate ⇒ 0 update-branch, no new vote, no candidate/box, no merge", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH });
    reviewCreate.mockResolvedValue(FLAG);
    await run(); // sweep 1: 0/3 CLEAN → blue card + needs-human
    expect(w.labels).toContain("needs-human");
    expect(w.commentsMatching(flagCardMarkersFor("review", w.head)[0])).toHaveLength(1);
    const votesAfterFlag = reviewCreate.mock.calls.length;
    expect(votesAfterFlag).toBe(3);

    reviewCreate.mockResolvedValue(CLEAN); // the non-deterministic vote WOULD land clean on a re-roll
    await run(); // sweep 2: parked
    w.mainMoves(STALE_BY_AGE); // main moves; the PR is now >24h behind
    await run(); // sweep 3
    await run(); // sweep 4
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(reviewCreate.mock.calls.length).toBe(votesAfterFlag); // no re-roll
    expect(w.labelAddAttempts().filter((l) => ["candidate", "box"].includes(l))).toEqual([]);
    expect(w.mergeCalls()).toHaveLength(0);
  });

  it("box door: the bot's box on a candidate carrying needs-human is NOT honored (no merge); Kevin's own box on the same PR still opens it", async () => {
    const flagged = ["fleet-internal", "candidate", "box", TW, "needs-human"];
    const w = install({ labels: flagged, boxBy: "bot", baseBehind: FRESH });
    w.injectCheck({ name: "crew-qualified", head_sha: w.head, app: FLEET_APP_SLUG });
    await run();
    expect(w.mergeCalls()).toHaveLength(0);

    const k = install({ labels: flagged, boxBy: "kevin", baseBehind: FRESH }); // Kevin's key opens a flagged PR (the card says "Accept = box")
    await run();
    expect(k.mergeCalls()).toHaveLength(1);
  });

  it("train door: the bot's box with needs-human is refused; Kevin's own box is not", async () => {
    const flagged = ["fleet-internal", "candidate", "box", TW, "needs-human"];
    const w = install({ labels: flagged, boxBy: "bot", baseBehind: FRESH }, "studio-b-ai/studiob");
    w.injectCheck({ name: "crew-qualified", head_sha: w.head, app: FLEET_APP_SLUG });
    const res = await evaluateTrainReady("studio-b-ai/studiob", PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(res.detail).toContain("needs-human");
    expect(w.mergeCalls()).toHaveLength(0);

    const k = install({ labels: flagged, boxBy: "kevin", baseBehind: FRESH }, "studio-b-ai/studiob");
    expect((await evaluateTrainReady("studio-b-ai/studiob", PR, { door: null })).outcome).toBe("merged");
    expect(k.mergeCalls()).toHaveLength(1);
  });

  it("train block: a flagged crew code-fix PR in a train repo gets no candidate and no box", async () => {
    const w = install({ labels: ["fleet-internal", "needs-human"], baseBehind: FRESH }, "studio-b-ai/studiob");
    await evaluate("studio-b-ai/studiob", PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(w.labelAddAttempts()).toEqual([]);
  });
});

// ═════════════════════════════ F5 ═════════════════════════════

describe("F5 — the bot's box is bound to the sha the gate qualified (TOCTOU: a push around the box write)", () => {
  const run = () => evaluate("studio-b-ai/radio", PR, ["code-fix", "fleet-internal"] as never, [], ["src/**"], ["ci"], []);
  /** After the writes, was `sha` ever merged without a `crew-qualified` check on it? (the invariant, whatever the interleaving) */
  const mergedUnqualified = (w: World) => w.merges.filter((m) => !w.checkRuns.some((c) => c.name === "crew-qualified" && c.head_sha === m.pin && c.app === FLEET_APP_SLUG));

  // The three label writes of a qualifying sweep, in order: the tripwire label (n=1, before the vote),
  // candidate (n=2), box (n=3). A crew pushes just before each.
  it.each([1, 2, 3])("a push just before label write #%i ⇒ nothing merges on the next sweep, and nothing ever merges unqualified", async (n) => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH });
    w.beforeLabelWrite = (_label, nth, world) => {
      if (nth === n) world.push();
    };
    const qualified = w.head;
    await run(); // sweep 1: the push lands mid-qualification
    await run(); // sweep 2
    expect(w.head).not.toBe(qualified); // the push really happened
    expect(w.mergeCalls()).toHaveLength(0);
    expect(mergedUnqualified(w)).toEqual([]);
  });

  it.each([2, 3])("after the push around write #%i the gate STRIPS candidate and box (hygiene; the check run is the proof)", async (n) => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH });
    w.beforeLabelWrite = (_label, nth, world) => {
      if (nth === n) world.push();
    };
    await run();
    expect(w.labels).not.toContain("box");
    expect(w.labels).not.toContain("candidate");
    expect(receipts().some((r) => r.includes("leg=head-moved"))).toBe(true);
  });

  it.each([2, 3])("even if the strip FAILS, the box on the unqualified head is not honored: sweep 2 merges nothing (push before write #%i)", async (n) => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH });
    w.failRemoveLabel = true;
    w.beforeLabelWrite = (_label, nth, world) => {
      if (nth === n) world.push();
    };
    await run();
    expect(w.labels).toContain("box"); // the strip failed: a bot box stands on an unqualified head
    await run();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(mergedUnqualified(w)).toEqual([]);
  });

  it("a check run a CREW forged (a PAT cannot create check runs — but if one appeared under another app) does not qualify the head", async () => {
    const w = install({ labels: ["fleet-internal", "candidate", TW], baseBehind: FRESH });
    w.push(); // the crew's commit lands BEFORE the bot's box event, so the timeline reads the box as fresh
    w.botLabels("box");
    w.injectCheck({ name: "crew-qualified", head_sha: w.head, app: "kbibelhausen" });
    await run();
    expect(w.mergeCalls()).toHaveLength(0);
  });

  it("control: a genuine fleet-App attestation on the CURRENT head IS honored — the requirement does not over-block", async () => {
    const w = install({ labels: ["fleet-internal", "candidate", TW], baseBehind: FRESH });
    w.push();
    w.botLabels("box");
    w.injectCheck({ name: "crew-qualified", head_sha: w.head, app: FLEET_APP_SLUG });
    await run();
    expect(w.mergeCalls()).toHaveLength(1);
  });

  it("the sweep's --train-ready door requires the same attestation (no check on the head ⇒ refused)", async () => {
    const w = install({ labels: ["fleet-internal", "candidate", TW], baseBehind: FRESH }, "studio-b-ai/studiob");
    w.push();
    w.botLabels("box");
    const res = await evaluateTrainReady("studio-b-ai/studiob", PR, { door: null });
    expect(res.outcome).toBe("refused");
    expect(res.detail).toContain("crew-qualified");
    expect(w.mergeCalls()).toHaveLength(0);
  });

  it("an attestation that cannot be POSTED writes no merge-authorizing label at all", async () => {
    const w = install({ labels: ["fleet-internal"], baseBehind: FRESH });
    w.failCheckRunPost = true;
    await run();
    expect(w.labelAddAttempts().filter((l) => ["candidate", "box"].includes(l))).toEqual([]);
    expect(w.mergeCalls()).toHaveLength(0);
  });

  it("train-repo crew candidate whose box was stripped re-qualifies instead of being stranded (the candidate short-circuit does not apply to crew)", async () => {
    const w = install({ labels: ["fleet-internal", "candidate", TW], baseBehind: FRESH }, "studio-b-ai/studiob"); // candidate, NO box
    await evaluate("studio-b-ai/studiob", PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(w.checkPosts("crew-qualified")).toHaveLength(1);
    expect(w.labels).toContain("box");
  });
});

// ═════════════════════════════ F7 ═════════════════════════════

describe("F7 — Kevin's own box survives the gate's own update-branch merge commit, and nothing else", () => {
  const run = () => evaluate("studio-b-ai/radio", PR, ["code-fix", "fleet-internal"] as never, [], ["src/**"], ["ci"], []);
  /** Who applied the box that currently stands (the last box event), or null when none stands. */
  const standingBoxActor = (w: World): string | null => {
    const events = w.timeline.filter((n) => (n.label as { name?: string } | undefined)?.name === "box" && (n.__typename === "LabeledEvent" || n.__typename === "UnlabeledEvent"));
    const last = events.at(-1);
    return last && last.__typename === "LabeledEvent" ? (last.actor as { login: string }).login : null;
  };
  /** Kevin's box was voided: stripped as stale. (The PR may legitimately re-qualify and get the BOT's box — that is not Kevin's.) */
  const kevinsBoxVoided = (w: World): boolean =>
    w.timeline.some((n) => n.__typename === "UnlabeledEvent" && (n.label as { name: string }).name === "box") && standingBoxActor(w) !== "kbibelhausen";

  it("MULTI-SWEEP: Kevin boxes a stale crew PR → sweep 1 rebases it → sweep 2 merges the RE-RUN head with the SAME box (no second box)", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    const boxed = w.head;
    await run(); // sweep 1: stale → update-branch (box is NOT skipped)
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(w.mergeCalls()).toHaveLength(0);
    const rerun = w.head;
    expect(rerun).not.toBe(boxed);
    expect(w.checkRuns.some((c) => c.name === "crew-rebase" && c.head_sha === boxed && c.app === FLEET_APP_SLUG)).toBe(true);

    await run(); // sweep 2: the merge commit does not void Kevin's box
    expect(w.merges).toHaveLength(1);
    expect(w.merges[0].pin).toBe(rerun); // merged the head that was RE-RUN, not the one he boxed
    expect(w.labels).toContain("box"); // still Kevin's one box
    const boxEvents = w.timeline.filter((n) => n.__typename === "LabeledEvent" && (n.label as { name: string }).name === "box");
    expect(boxEvents).toHaveLength(1); // no second box was ever needed
    expect(logLines.some((l) => l.includes("stale") && l.includes("removed"))).toBe(false);
    expect(logLines.some((l) => l.includes("the box survives the gate's own update-branch merge commit"))).toBe(true);
  });

  it("a crew push AFTER the box still voids it, even though the gate also rebased (the stale rule is intact)", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    await run(); // gate rebases
    w.push(); // then a crew commits on top of the gate's merge commit
    await run();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(kevinsBoxVoided(w)).toBe(true); // stripped as stale
  });

  it("a crew's hand-built (unsigned) merge of base does not ride the box", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: FRESH });
    w.pushForeignMerge({ signed: false });
    await run();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(kevinsBoxVoided(w)).toBe(true);
  });

  it("a GitHub-SIGNED merge the gate never asked for (a crew's UI 'resolve conflicts') does not ride the box — no attestation on its first parent", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: FRESH });
    w.pushForeignMerge({ signed: true });
    await run();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(kevinsBoxVoided(w)).toBe(true);
  });

  it("if the gate could not post its rebase attestation the box simply goes stale as before (safe fallback), never merges", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    w.failCheckRunPostFor = "crew-rebase";
    await run();
    await run();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(kevinsBoxVoided(w)).toBe(true);
  });

  it("the sweep's --train-ready door: Kevin's box on a stale crew PR is rebased once and merges on the re-run head with the same box", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE }, "studio-b-ai/studiob");
    expect((await evaluateTrainReady("studio-b-ai/studiob", PR, { door: null })).outcome).toBe("refused");
    const rerun = w.head;
    const second = await evaluateTrainReady("studio-b-ai/studiob", PR, { door: null });
    expect(second.outcome).toBe("merged");
    expect(w.merges[0].pin).toBe(rerun);
  });

  it("a plain human PR's box is NOT given the benefit: a post-label merge commit still voids it (the survival is crew-only)", async () => {
    const w = install({ labels: ["box"], boxBy: "kevin", baseBehind: FRESH });
    w.pushForeignMerge({ signed: true });
    await run();
    expect(w.mergeCalls()).toHaveLength(0);
  });
});

// ───────── the proof itself, one rejection per condition (authorizeAcrossGateRebase, injected seams) ─────────

describe("authorizeAcrossGateRebase — each condition of the proof is load-bearing", () => {
  const KEVIN = "kbibelhausen";
  const commit = (position: number, oid: string, parents: string[], signedByGitHub: boolean): AuthorityTimelineItem => ({ type: "PULL_REQUEST_COMMIT", position, oid, parents, signedByGitHub });
  const box: AuthorityTimelineItem = { type: "LABELED", position: 1, label: "box", actorLogin: KEVIN, createdAt: "2026-10-20T10:00:00Z" };
  const boxed = commit(0, "h0", ["base-old"], false);
  const gateMerge = commit(2, "m1", ["h0", "b1"], true);
  const input = (timeline: AuthorityTimelineItem[]): AuthorityInput => ({ currentLabels: ["fleet-internal", "box"], timeline, authorityLogins: [KEVIN], truncated: false, labels: QUEUED_LABEL_PAIR });
  const ctx = (over: Partial<GateRebaseContext> = {}): GateRebaseContext => ({
    repo: "studio-b-ai/radio",
    headOid: "m1",
    baseRefName: "main",
    hasRebaseAttestation: (sha) => sha === "h0" || sha === "m1",
    isBaseAncestor: (oid) => oid === "b1" || oid === "b2",
    ...over,
  });
  const verdictOf = (timeline: AuthorityTimelineItem[], c: GateRebaseContext = ctx()) => authorizeAcrossGateRebase(input(timeline), c);

  it("control: the PLAIN predicate calls the gate's merge commit 'stale-label' (so the proof is what changes the verdict)", () => {
    expect(evaluateLabelAuthority(input([boxed, box, gateMerge]))).toMatchObject({ authorized: false, reason: "stale-label" });
  });
  it("the gate's merge commit, fully proven ⇒ authorized (Kevin's box intact)", () => {
    const v = verdictOf([boxed, box, gateMerge]);
    expect(v.authorized).toBe(true);
    if (v.authorized) expect(v.authorizingEvent.actorLogin).toBe(KEVIN);
  });
  it("two chained gate merges (h0 → m1 → m2) are accepted when each is attested and the chain reaches the head", () => {
    const m2 = commit(3, "m2", ["m1", "b2"], true);
    expect(verdictOf([boxed, box, gateMerge, m2], ctx({ headOid: "m2" })).authorized).toBe(true);
  });
  it.each([
    ["not GitHub-signed", [boxed, box, commit(2, "m1", ["h0", "b1"], false)], ctx()],
    ["first parent is not the boxed sha", [boxed, box, commit(2, "m1", ["other", "b1"], true)], ctx()],
    ["second parent is not on the base branch", [boxed, box, commit(2, "m1", ["h0", "not-base"], true)], ctx()],
    ["no rebase attestation on the boxed sha", [boxed, box, gateMerge], ctx({ hasRebaseAttestation: () => false })],
    ["a single-parent (plain) commit", [boxed, box, commit(2, "c1", ["h0"], false)], ctx({ headOid: "c1" })],
    ["a three-parent octopus", [boxed, box, commit(2, "m1", ["h0", "b1", "b2"], true)], ctx()],
    ["the chain does not reach the current head", [boxed, box, gateMerge], ctx({ headOid: "elsewhere" })],
    ["a crew commit on top of the gate's merge", [boxed, box, gateMerge, commit(3, "c9", ["m1"], false)], ctx({ headOid: "c9" })],
    ["a force-push after the label", [boxed, box, { type: "HEAD_REF_FORCE_PUSHED", position: 2, oid: "f1" } as AuthorityTimelineItem], ctx({ headOid: "f1" })],
    // a force-push item that LOOKS like a clean gate merge in every other field: the explicit rule (any post-label force-push voids the box) is what rejects it
    ["a force-push item dressed as a gate merge", [boxed, box, { type: "HEAD_REF_FORCE_PUSHED", position: 2, oid: "m1", parents: ["h0", "b1"], signedByGitHub: true } as AuthorityTimelineItem], ctx()],
    ["a post-label commit without an oid", [boxed, box, { type: "PULL_REQUEST_COMMIT", position: 2, parents: ["h0", "b1"], signedByGitHub: true } as AuthorityTimelineItem], ctx()],
    ["the boxed sha cannot be named (no oid on the pre-label commit)", [{ type: "PULL_REQUEST_COMMIT", position: 0 } as AuthorityTimelineItem, box, gateMerge], ctx()],
    ["a seam that throws (an unreadable compare) fails closed", [boxed, box, gateMerge], ctx({ isBaseAncestor: () => { throw new Error("gh: HTTP 502"); } })],
  ])("REJECTED — %s ⇒ the box stays stale", (_name, timeline, c) => {
    expect(verdictOf(timeline as AuthorityTimelineItem[], c as GateRebaseContext)).toMatchObject({ authorized: false, reason: "stale-label" });
  });

  it("only stale-label is upgraded: hold still wins and a missing box is still 'no-ready-label'", () => {
    expect(authorizeAcrossGateRebase({ ...input([boxed, box, gateMerge]), currentLabels: ["fleet-internal", "box", "hold"] }, ctx())).toMatchObject({ authorized: false, reason: "hold-present" });
    expect(authorizeAcrossGateRebase({ ...input([boxed, box, gateMerge]), currentLabels: ["fleet-internal"] }, ctx())).toMatchObject({ authorized: false, reason: "no-ready-label" });
  });
  it("a bot-applied box is still refused by the roster rules after the upgrade path (the proof opens staleness only)", () => {
    const botBox: AuthorityTimelineItem = { ...box, actorLogin: "somebody-else" };
    expect(authorizeAcrossGateRebase(input([boxed, botBox, gateMerge]), ctx())).toMatchObject({ authorized: false, reason: "unauthorized-actor" });
  });
});

// ───────── the timeline fetch reads each commit's shape (the proof's input), through the REAL fetchAuthorityTimeline ─────────

describe("fetchAuthorityTimeline — commit oid, parents and who signed", () => {
  const page = (nodes: unknown[]) =>
    JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { filteredCount: nodes.length, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes } } } } });
  const commitNode = (oid: string, parents: string[], signature: unknown) => ({ __typename: "PullRequestCommit", commit: { oid, parents: { nodes: parents.map((p) => ({ oid: p })) }, signature } });
  const read = (nodes: unknown[]) => fetchAuthorityTimeline("studio-b-ai/radio", PR, () => page(nodes)).timeline;

  it("maps oid and the two parents", () => {
    const [c] = read([commitNode("aaa", ["p1", "p2"], null)]);
    expect(c.oid).toBe("aaa");
    expect(c.parents).toEqual(["p1", "p2"]);
  });
  it("GitHub's own signature (web-flow) and the fleet App's own signature are gate/GitHub-made", () => {
    const [webFlow, appSigned] = read([
      commitNode("a", ["p"], { isValid: true, wasSignedByGitHub: true, signer: { login: "web-flow" } }),
      commitNode("b", ["p"], { isValid: true, wasSignedByGitHub: false, signer: { login: "studiob-fleet-bot" } }),
    ]);
    expect(webFlow.signedByGitHub).toBe(true);
    expect(appSigned.signedByGitHub).toBe(true);
  });
  it("NOT gate/GitHub-made: unsigned, an invalid signature, or a valid signature by someone else's key", () => {
    const [unsigned, invalid, theirKey] = read([
      commitNode("a", ["p"], null),
      commitNode("b", ["p"], { isValid: false, wasSignedByGitHub: true, signer: { login: "web-flow" } }),
      commitNode("c", ["p"], { isValid: true, wasSignedByGitHub: false, signer: { login: "kbibelhausen" } }),
    ]);
    expect(unsigned.signedByGitHub).not.toBe(true);
    expect(invalid.signedByGitHub).toBe(false);
    expect(theirKey.signedByGitHub).toBe(false);
  });
  it("a commit node carrying no commit data (an older fixture) leaves every field undefined — 'cannot prove', never a default", () => {
    const [c] = read([{ __typename: "PullRequestCommit" }]);
    expect(c.oid).toBeUndefined();
    expect(c.parents).toBeUndefined();
    expect(c.signedByGitHub).toBeUndefined();
  });
});
