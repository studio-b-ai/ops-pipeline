/**
 * Stint #928, review finding F6 — studiob's REAL box door runs the crew guards.
 *
 * `scripts/restart-train.ts` (`fireQueueHead`) is where studiob's `box` PRs actually merge: the fleet
 * sweep sets owns_box=false for studiob, so it never routes studiob box PRs to the gate's own doors
 * (the review's probe of the PR head showed `evaluateTrainReady` never sees them). The first cut put
 * the stale-base leg only in the gate, so "box or no box" stopped at the fleet sweep and the toto#131
 * shape — a crew PR with a 4-day-old base, merged on a box — could still merge here. `fireQueueHead`
 * now runs lib/crew-merge-guards.ts's `crewMergeDoorGuard` for crew tickets before the merge, and
 * `fetchTickets` authorizes a crew PR's box across the gate's own update-branch merge commit.
 *
 * These tests import the REAL `fireQueueHead` and `fetchTickets` from restart-train.ts (Rule #223) and
 * drive them against the stateful fake GitHub (fixtures/fake-gh.ts). Each stale / unqualified / flagged
 * ticket has a fresh / qualified / unflagged CONTROL that does merge, so a guard that blocks everything
 * cannot pass (Rule #322).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { clampTicketsToNow, orderQueue, repoClassFor, type Ticket } from "../restart-train-lib.js";
import { FLEET_APP_SLUG, FRESH, STALE_BY_AGE, World } from "./fixtures/fake-gh.js";

process.env.RESTART_TRAIN_NO_MAIN = "1";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { fireQueueHead, fetchTickets } = await import("../../restart-train.js");

const REPO = "studio-b-ai/studiob";
const PR = 748;
const TW = "automerge:code-fix";
const TARGET = { repo: "studio-b-ai/ops-pipeline", number: 172 };
const NOW = "2026-10-20T15:00:00.000Z";

let world: World;
let logLines: string[];

function install(init: Partial<ConstructorParameters<typeof World>[0]> & { labels: string[] }): World {
  world = new World({ repo: REPO, pr: PR, ...init });
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => world.handle(cmd, args));
  return world;
}
const ticketFor = (w: World, over: Partial<Ticket> = {}): Ticket => ({
  repo: REPO,
  number: PR,
  repoClass: repoClassFor(REPO),
  labeledAt: "2026-10-20T10:30:00Z",
  pinnedHeadSha: w.head,
  currentHeadSha: w.head,
  afterTokens: [],
  consolidate: false,
  ...over,
});
/** What `maybePage` hands fireQueueHead: the fresh PR view the readiness gate just passed. */
const viewOf = (w: World) => w.prJson() as never;
const fire = (w: World, ticket: Ticket) => fireQueueHead(TARGET, ticket, viewOf(w), NOW, true);
const heldLine = () => logLines.find((l) => l.includes("crew guard"));

beforeEach(() => {
  logLines = [];
  execFileSyncMock.mockReset();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("fireQueueHead — stale base, box or no box (Kevin 9/27)", () => {
  it("a crew ticket on Kevin's box with a 4-day-old base (the toto#131 shape) is NOT merged; the gate requests the rebase instead", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    await fire(w, ticketFor(w, { authorizingActor: "kbibelhausen" }));
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(1);
    expect(heldLine()).toContain("stale-base");
  });

  it("CONTROL: the same crew ticket with a FRESH base merges, sha-pinned", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: FRESH });
    await fire(w, ticketFor(w, { authorizingActor: "kbibelhausen" }));
    expect(w.updateBranchAttempts()).toHaveLength(0);
    expect(w.mergeCalls()).toHaveLength(1);
    expect(w.merges[0].pin).toBe(w.head);
  });

  it("the gate's bot box on a candidate that went stale while it waited in the queue is NOT merged", async () => {
    const w = install({ labels: ["fleet-internal", "candidate", "box", TW], boxBy: "bot", baseBehind: STALE_BY_AGE });
    w.injectCheck({ name: "crew-qualified", head_sha: w.head, app: FLEET_APP_SLUG });
    await fire(w, ticketFor(w, { authorizingActor: "studiob-fleet-bot[bot]" }));
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(1);
  });

  it("an unreadable compare is refused, never read as fresh", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: FRESH });
    w.compareThrows = true;
    await fire(w, ticketFor(w, { authorizingActor: "kbibelhausen" }));
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(0);
  });

  it("SCOPE: a plain human ticket with a stale base merges as before — the guard never reads its base", async () => {
    const w = install({ labels: ["box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    await fire(w, ticketFor(w, { authorizingActor: "kbibelhausen" }));
    expect(w.factsReads()).toHaveLength(0);
    expect(w.mergeCalls()).toHaveLength(1);
  });

  it("SCOPE: Kevin's bugsquasher lane (even with fleet-internal) is untouched", async () => {
    const w = install({ labels: ["fleet-internal", "bugsquasher", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    await fire(w, ticketFor(w, { authorizingActor: "kbibelhausen" }));
    expect(w.factsReads()).toHaveLength(0);
    expect(w.mergeCalls()).toHaveLength(1);
  });
});

describe("fireQueueHead — the bot's box is honored only on a head the gate qualified, never under needs-human, and only with the tripwire label", () => {
  const botTicket = (w: World) => ticketFor(w, { authorizingActor: "studiob-fleet-bot[bot]" });
  const botCandidate = (over: { labels?: string[]; qualified?: boolean } = {}): World => {
    const w = install({ labels: over.labels ?? ["fleet-internal", "candidate", "box", TW], boxBy: "bot", baseBehind: FRESH });
    if (over.qualified !== false) w.injectCheck({ name: "crew-qualified", head_sha: w.head, app: FLEET_APP_SLUG });
    return w;
  };

  it("CONTROL: qualified head, no needs-human, label present ⇒ merges", async () => {
    const w = botCandidate();
    await fire(w, botTicket(w));
    expect(w.mergeCalls()).toHaveLength(1);
  });

  it("a head that carries no crew-qualified attestation (a push around the box write) is NOT merged", async () => {
    const w = botCandidate({ qualified: false });
    await fire(w, botTicket(w));
    expect(w.mergeCalls()).toHaveLength(0);
    expect(heldLine()).toContain("unqualified");
  });

  it("needs-human on the PR: the bot's box is not honored (Kevin's own box on the same PR is)", async () => {
    const flagged = ["fleet-internal", "candidate", "box", TW, "needs-human"];
    const w = botCandidate({ labels: flagged });
    await fire(w, botTicket(w));
    expect(w.mergeCalls()).toHaveLength(0);
    expect(heldLine()).toContain("needs-human");

    const k = install({ labels: flagged, boxBy: "kevin", baseBehind: FRESH });
    await fire(k, ticketFor(k, { authorizingActor: "kbibelhausen" }));
    expect(k.mergeCalls()).toHaveLength(1);
  });

  it("a bot-boxed crew ticket lacking automerge:code-fix gets it written and is NOT merged this tick; the next tick merges it with the label", async () => {
    const w = botCandidate({ labels: ["fleet-internal", "candidate", "box"] });
    await fire(w, botTicket(w));
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.labelAddAttempts()).toEqual([TW]);
    await fire(w, botTicket(w));
    expect(w.merges).toHaveLength(1);
    expect(w.merges[0].labels).toContain(TW);
  });

  it("a ticket that names no authorizing actor on a crew PR is treated as the bot's (strictest checks): unqualified ⇒ NOT merged", async () => {
    const w = install({ labels: ["fleet-internal", "candidate", "box", TW], boxBy: "bot", baseBehind: FRESH }); // no qualified check
    await fire(w, ticketFor(w)); // authorizingActor undefined
    expect(w.mergeCalls()).toHaveLength(0);
  });
});

describe("fetchTickets — Kevin's box survives the gate's own update-branch merge commit (multi-tick)", () => {
  it("tick 1 builds the ticket and the guard rebases; tick 2 STILL has the ticket (box intact) and merges the re-run head with the same box", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    const boxedHead = w.head;

    const tick1 = await fetchTickets(NOW, true);
    expect(tick1).toHaveLength(1);
    expect(tick1[0].authorizingActor).toBe("kbibelhausen");
    await fire(w, tick1[0]);
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.updateBranchAttempts()).toHaveLength(1);
    const rerun = w.head;
    expect(rerun).not.toBe(boxedHead);

    const tick2 = await fetchTickets(NOW, true);
    expect(tick2).toHaveLength(1); // not excluded as stale
    expect(tick2[0].pinnedHeadSha).toBe(rerun);
    expect(w.labels).toContain("box"); // not stripped
    await fire(w, tick2[0]);
    expect(w.merges).toHaveLength(1);
    expect(w.merges[0].pin).toBe(rerun);
  });

  it("a crew push after the gate's rebase voids the box: the ticket is excluded and the box stripped (the stale rule is intact)", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: STALE_BY_AGE });
    const t1 = (await fetchTickets(NOW, true))[0];
    await fire(w, t1);
    w.push();
    const tick2 = await fetchTickets(NOW, true);
    expect(tick2).toHaveLength(0);
    expect(w.labels).not.toContain("box");
  });

  it("the ticket's authorizing actor survives the queue pipeline (clamp + order) intact — a dropped field would make every Kevin-boxed crew ticket read as the bot's", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: FRESH });
    const [t] = await fetchTickets(NOW, true);
    const entry = orderQueue(clampTicketsToNow([t], NOW))[0];
    expect(entry.status).toBe("queued");
    expect(entry.ticket.authorizingActor).toBe("kbibelhausen");
    await fire(w, entry.ticket);
    expect(w.mergeCalls()).toHaveLength(1); // read as Kevin's own box: no qualification attestation demanded
  });

  it("a plain human PR's box gets no such benefit: a post-label merge commit still excludes it", async () => {
    const w = install({ labels: ["box"], boxBy: "kevin", baseBehind: FRESH });
    w.pushForeignMerge({ signed: true });
    expect(await fetchTickets(NOW, true)).toHaveLength(0);
  });
});
