import { describe, expect, it } from "vitest";
import {
  formatStaleLabelRemovalReceipt,
  hasAuthoritySnapshotDrifted,
  GATE_AUTHORITY_LOGIN,
  GATE_AUTHORITY_REQUIRED_LABELS,
  MERGE_AUTHORITY_LOGINS,
  resolveAuthorityLogins,
  TRAIN_HOLD_LABEL,
  TRAIN_READY_LABEL,
  QUEUED_LABEL,
  HOLD_LABEL,
  QUEUED_LABEL_PAIR,
  evaluateLabelAuthority,
  normalizeActorLogin,
  fetchAuthorityTimeline,
  AUTHORITY_TIMELINE_PAGE_SIZE,
  AUTHORITY_TIMELINE_MAX_PAGES,
  type AuthorityInput,
  type AuthorityTimelineItem,
  type AuthoritySnapshot,
  type StaleLabelAuthorityVerdict,
} from "../label-authority.js";

// ───────────────────────────── fixture builders ─────────────────────────────

function labeledBy(actorLogin: string, position: number, label = TRAIN_READY_LABEL): AuthorityTimelineItem {
  return { type: "LABELED", label, actorLogin, position };
}
function unlabeledBy(actorLogin: string, position: number, label = TRAIN_READY_LABEL): AuthorityTimelineItem {
  return { type: "UNLABELED", label, actorLogin, position };
}
function commitAt(position: number): AuthorityTimelineItem {
  return { type: "PULL_REQUEST_COMMIT", position };
}
function forcePushAt(position: number): AuthorityTimelineItem {
  return { type: "HEAD_REF_FORCE_PUSHED", position };
}

// A baseline "authorized happy path" input — commit BEFORE the authorizing label, by a
// roster actor, no hold, non-truncated, non-empty — so each negative-control test
// flips exactly one thing to prove that ONE thing alone gates the decision (Rule
// #322: negative controls first).
function baseAuthorityInput(overrides: Partial<AuthorityInput> = {}): AuthorityInput {
  return {
    currentLabels: [TRAIN_READY_LABEL],
    timeline: [commitAt(0), labeledBy("kbibelhausen", 1)],
    authorityLogins: MERGE_AUTHORITY_LOGINS,
    truncated: false,
    ...overrides,
  };
}

// 2026-09-06 (live, studiob#642/#666): GraphQL names a GitHub-App actor `Bot:studiob-fleet-bot`
// without the `[bot]` suffix REST shows — every `[bot]` check downstream was blind to it.
describe("normalizeActorLogin", () => {
  it("suffixes a GraphQL Bot actor's login with [bot] (the REST spelling every check expects)", () => {
    expect(normalizeActorLogin({ __typename: "Bot", login: "studiob-fleet-bot" })).toBe("studiob-fleet-bot[bot]");
    expect(normalizeActorLogin({ __typename: "Bot", login: "studiob-fleet-bot" })).toBe(GATE_AUTHORITY_LOGIN);
  });
  it("leaves an already-suffixed Bot login and a User login unchanged", () => {
    expect(normalizeActorLogin({ __typename: "Bot", login: "github-actions[bot]" })).toBe("github-actions[bot]");
    expect(normalizeActorLogin({ __typename: "User", login: "kbibelhausen" })).toBe("kbibelhausen");
    expect(normalizeActorLogin({ login: "kbibelhausen" })).toBe("kbibelhausen");
  });
  it("returns undefined for a missing or empty login", () => {
    expect(normalizeActorLogin(null)).toBeUndefined();
    expect(normalizeActorLogin({ __typename: "Bot" })).toBeUndefined();
    expect(normalizeActorLogin({ __typename: "User", login: "" })).toBeUndefined();
  });
  it("end to end: the gate's GraphQL-spelled queued (with bugsquasher + candidate) is authorized once normalized", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: [TRAIN_READY_LABEL, ...GATE_AUTHORITY_REQUIRED_LABELS],
        timeline: [commitAt(0), labeledBy(normalizeActorLogin({ __typename: "Bot", login: "studiob-fleet-bot" }) as string, 1)],
      }),
    );
    expect(verdict.authorized).toBe(true);
  });
  it("negative control: the UN-normalized GraphQL spelling is refused (the exact live failure)", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: [TRAIN_READY_LABEL, ...GATE_AUTHORITY_REQUIRED_LABELS],
        timeline: [commitAt(0), labeledBy("studiob-fleet-bot", 1)],
      }),
    );
    expect(verdict.authorized).toBe(false);
  });
});

describe("evaluateLabelAuthority", () => {
  // ───── 2026-09-06 (Kevin "that works"): the HUMAN review receipt — the `reviewed`/`hold` pair ─────

  it("authorizes a roster human's `reviewed` applied after the head (the review receipt)", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: ["reviewed", "bugsquasher"],
        timeline: [commitAt(0), labeledBy("kbibelhausen", 1, "reviewed")],
        labels: { ready: "reviewed", hold: TRAIN_HOLD_LABEL },
      }),
    );
    expect(verdict).toEqual({ authorized: true, authorizingEvent: { actorLogin: "kbibelhausen", position: 1 } });
  });

  it("the fleet bot's `reviewed` never counts — the gate exception is `queued`-only, even with bugsquasher + candidate", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: ["reviewed", ...GATE_AUTHORITY_REQUIRED_LABELS],
        timeline: [commitAt(0), labeledBy(GATE_AUTHORITY_LOGIN, 1, "reviewed")],
        labels: { ready: "reviewed", hold: TRAIN_HOLD_LABEL },
      }),
    );
    expect(verdict.authorized).toBe(false);
    expect((verdict as { reason: string }).reason).toBe("bot-actor");
  });

  it("a `reviewed` older than the head is stale (a commit after it)", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: ["reviewed"],
        timeline: [commitAt(0), labeledBy("kbibelhausen", 1, "reviewed"), commitAt(2)],
        labels: { ready: "reviewed", hold: TRAIN_HOLD_LABEL },
      }),
    );
    expect(verdict.authorized).toBe(false);
  });

  it("`hold` still wins over a valid `reviewed`", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: ["reviewed", TRAIN_HOLD_LABEL],
        timeline: [commitAt(0), labeledBy("kbibelhausen", 1, "reviewed")],
        labels: { ready: "reviewed", hold: TRAIN_HOLD_LABEL },
      }),
    );
    expect(verdict.authorized).toBe(false);
    expect((verdict as { reason: string }).reason).toBe("hold-present");
  });

  // ───── 2026-09-06: the gate's own `queued` (Kevin "go") — both verdicts planted (#471) ─────

  it("authorizes the fleet bot's queued when the PR carries bugsquasher + candidate (the gate's tripwire)", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: [TRAIN_READY_LABEL, ...GATE_AUTHORITY_REQUIRED_LABELS],
        timeline: [commitAt(0), labeledBy(GATE_AUTHORITY_LOGIN, 1)],
      }),
    );
    expect(verdict).toEqual({ authorized: true, authorizingEvent: { actorLogin: GATE_AUTHORITY_LOGIN, position: 1 } });
  });

  it("still refuses the fleet bot's queued when `candidate` is missing (no gate tripwire)", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: [TRAIN_READY_LABEL, "bugsquasher"],
        timeline: [commitAt(0), labeledBy(GATE_AUTHORITY_LOGIN, 1)],
      }),
    );
    expect(verdict.authorized).toBe(false);
    expect((verdict as { reason: string }).reason).toBe("bot-actor");
  });

  it("still refuses any OTHER bot even with both labels present", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: [TRAIN_READY_LABEL, ...GATE_AUTHORITY_REQUIRED_LABELS],
        timeline: [commitAt(0), labeledBy("github-actions[bot]", 1)],
      }),
    );
    expect(verdict.authorized).toBe(false);
    expect((verdict as { reason: string }).reason).toBe("bot-actor");
  });

  it("the gate's queued is still stale when a commit lands after it", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: [TRAIN_READY_LABEL, ...GATE_AUTHORITY_REQUIRED_LABELS],
        timeline: [commitAt(0), labeledBy(GATE_AUTHORITY_LOGIN, 1), commitAt(2)],
      }),
    );
    expect(verdict.authorized).toBe(false);
  });

  it("`hold` still wins over the gate's queued", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        currentLabels: [TRAIN_READY_LABEL, TRAIN_HOLD_LABEL, ...GATE_AUTHORITY_REQUIRED_LABELS],
        timeline: [commitAt(0), labeledBy(GATE_AUTHORITY_LOGIN, 1)],
      }),
    );
    expect(verdict.authorized).toBe(false);
    expect((verdict as { reason: string }).reason).toBe("hold-present");
  });

  // ───── Positive baseline + negative controls (Rule #322) ─────

  it("authorizes when train:ready was labeled by a roster actor with no later commit/force-push", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput());
    expect(verdict).toEqual({ authorized: true, authorizingEvent: { actorLogin: "kbibelhausen", position: 1 } });
  });

  it("refuses a bot actor categorically, even when the bot login is (hypothetically) present in the roster", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        timeline: [commitAt(0), labeledBy("github-actions[bot]", 1)],
        authorityLogins: ["github-actions[bot]", "kbibelhausen"], // bot deliberately present in roster
      }),
    );
    expect(verdict).toEqual({
      authorized: false,
      reason: "bot-actor",
      detail: expect.stringContaining("github-actions[bot]"),
    });
  });

  it("refuses an actor not in the roster", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ timeline: [commitAt(0), labeledBy("some-rando", 1)] }));
    expect(verdict).toEqual({
      authorized: false,
      reason: "unauthorized-actor",
      detail: expect.stringContaining("some-rando"),
    });
  });

  it("flags stale-label when a commit lands AFTER the authorizing label", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ timeline: [labeledBy("kbibelhausen", 0), commitAt(1)] }));
    expect(verdict).toEqual({
      authorized: false,
      reason: "stale-label",
      detail: expect.stringContaining("PULL_REQUEST_COMMIT"),
    });
  });

  it("flags stale-label when a force-push lands AFTER the authorizing label", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ timeline: [labeledBy("kbibelhausen", 0), forcePushAt(1)] }));
    expect(verdict).toEqual({
      authorized: false,
      reason: "stale-label",
      detail: expect.stringContaining("HEAD_REF_FORCE_PUSHED"),
    });
  });

  it("authorizes on label -> unlabel -> relabel by an authorized actor with no later commits (last event wins)", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        timeline: [commitAt(0), labeledBy("kbibelhausen", 1), unlabeledBy("kbibelhausen", 2), labeledBy("kbibelhausen", 3)],
      }),
    );
    expect(verdict).toEqual({ authorized: true, authorizingEvent: { actorLogin: "kbibelhausen", position: 3 } });
  });

  it("flags stale-label on relabel followed by a commit", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        timeline: [labeledBy("kbibelhausen", 0), unlabeledBy("kbibelhausen", 1), labeledBy("kbibelhausen", 2), commitAt(3)],
      }),
    );
    expect(verdict).toEqual({
      authorized: false,
      reason: "stale-label",
      detail: expect.stringContaining("position 3"),
    });
  });

  it("refuses with hold-present when train:hold is present, even though every other leg would pass", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ currentLabels: [TRAIN_READY_LABEL, TRAIN_HOLD_LABEL] }));
    expect(verdict).toEqual({ authorized: false, reason: "hold-present", detail: expect.any(String) });
  });

  it("fails closed on a truncated timeline regardless of what the visible window shows", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ truncated: true }));
    expect(verdict).toEqual({ authorized: false, reason: "timeline-truncated", detail: expect.any(String) });
  });

  it("fails closed on an empty timeline", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ timeline: [] }));
    expect(verdict).toEqual({ authorized: false, reason: "no-authorizing-event", detail: expect.any(String) });
  });

  it("refuses a login present only in a caller-narrowed list — never widens past MERGE_AUTHORITY_LOGINS", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        timeline: [commitAt(0), labeledBy("someone-else", 1)],
        authorityLogins: resolveAuthorityLogins(["someone-else"]),
      }),
    );
    expect(verdict).toEqual({
      authorized: false,
      reason: "unauthorized-actor",
      detail: expect.stringContaining("someone-else"),
    });
  });

  // ───── Additional coverage beyond the brief's minimum list ─────

  it("refuses no-ready-label when train:ready is absent from currentLabels", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ currentLabels: [] }));
    expect(verdict).toEqual({ authorized: false, reason: "no-ready-label", detail: expect.any(String) });
  });

  it("reports hold-present (not no-ready-label) when both hold is present and ready is absent — hold wins the REASON too", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ currentLabels: [TRAIN_HOLD_LABEL] }));
    expect(verdict).toEqual({ authorized: false, reason: "hold-present", detail: expect.any(String) });
  });

  it("fails closed with no-authorizing-event when every LabeledEvent for train:ready was superseded by an UnlabeledEvent", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ timeline: [labeledBy("kbibelhausen", 0), unlabeledBy("kbibelhausen", 1)] }));
    expect(verdict).toEqual({ authorized: false, reason: "no-authorizing-event", detail: expect.any(String) });
  });

  it("ignores LABELED/UNLABELED events for OTHER labels when locating the train:ready applier", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({
        timeline: [labeledBy("kbibelhausen", 0, "bugsquasher"), labeledBy("kbibelhausen", 1, TRAIN_READY_LABEL)],
      }),
    );
    expect(verdict).toEqual({ authorized: true, authorizingEvent: { actorLogin: "kbibelhausen", position: 1 } });
  });

  it("ignores multiple commits BEFORE the authorizing label (only a LATER one makes it stale)", () => {
    const verdict = evaluateLabelAuthority(
      baseAuthorityInput({ timeline: [commitAt(0), commitAt(1), forcePushAt(2), labeledBy("kbibelhausen", 3)] }),
    );
    expect(verdict).toEqual({ authorized: true, authorizingEvent: { actorLogin: "kbibelhausen", position: 3 } });
  });
});

// ───────────────────────────── QUEUED_LABEL_PAIR (ops-pipeline#260 leg 4) ─────────────────────────────

describe("evaluateLabelAuthority — the queued/hold pair (ops-pipeline#260 leg 4)", () => {
  const queuedInput = (overrides: Partial<AuthorityInput> = {}): AuthorityInput =>
    baseAuthorityInput({
      currentLabels: [QUEUED_LABEL],
      timeline: [commitAt(0), labeledBy("kbibelhausen", 1, QUEUED_LABEL)],
      labels: QUEUED_LABEL_PAIR,
      ...overrides,
    });

  it("authorizes Kevin's `queued` with no later commit — the same predicate, a different pair", () => {
    expect(evaluateLabelAuthority(queuedInput())).toEqual({ authorized: true, authorizingEvent: { actorLogin: "kbibelhausen", position: 1 } });
  });

  it("`hold` wins over `queued`, always, and wins the REASON", () => {
    const verdict = evaluateLabelAuthority(queuedInput({ currentLabels: [QUEUED_LABEL, HOLD_LABEL] }));
    expect(verdict).toMatchObject({ authorized: false, reason: "hold-present" });
    expect((verdict as { detail: string }).detail).toContain(HOLD_LABEL);
  });

  it("a push after Kevin's `queued` is stale — the code changed after his word", () => {
    const verdict = evaluateLabelAuthority(queuedInput({ timeline: [labeledBy("kbibelhausen", 0, QUEUED_LABEL), commitAt(1)] }));
    expect(verdict).toMatchObject({ authorized: false, reason: "stale-label" });
  });

  it("a bot's `queued` never authorizes, roster or not", () => {
    const verdict = evaluateLabelAuthority(queuedInput({ timeline: [labeledBy("studiob-fleet-bot[bot]", 0, QUEUED_LABEL)] }));
    expect(verdict).toMatchObject({ authorized: false, reason: "bot-actor" });
  });

  it("ONE vocabulary (Kevin 2026-09-02): the train pair IS the queued/hold pair — same labels, one predicate", () => {
    expect(TRAIN_READY_LABEL).toBe("queued");
    expect(TRAIN_HOLD_LABEL).toBe("hold");
    expect({ ready: TRAIN_READY_LABEL, hold: TRAIN_HOLD_LABEL }).toEqual(QUEUED_LABEL_PAIR);
    // A stale `train:ready` (the OLD name) on a PR is invisible to the predicate — the cutover
    // re-labels open PRs; anything missed simply never authorizes (fail-closed, never a merge).
    const old = evaluateLabelAuthority(
      baseAuthorityInput({ currentLabels: ["train:ready"], timeline: [commitAt(0), labeledBy("kbibelhausen", 1, "train:ready")] }),
    );
    expect(old).toMatchObject({ authorized: false, reason: "no-ready-label" });
  });

  it("the omitted pair is the train pair — every pre-existing caller is unchanged", () => {
    expect(evaluateLabelAuthority(baseAuthorityInput())).toEqual(evaluateLabelAuthority(baseAuthorityInput({ labels: { ready: TRAIN_READY_LABEL, hold: TRAIN_HOLD_LABEL } })));
  });

  it("formatStaleLabelRemovalReceipt names the label it removed (default = queued, the train's label)", () => {
    const verdict: StaleLabelAuthorityVerdict = { authorized: false, reason: "stale-label", detail: "d" };
    expect(formatStaleLabelRemovalReceipt(verdict, "abc", QUEUED_LABEL)).toContain("**`queued` removed — stale label**");
    expect(formatStaleLabelRemovalReceipt(verdict, "abc", QUEUED_LABEL)).toContain("Re-apply `queued`");
    expect(formatStaleLabelRemovalReceipt(verdict, "abc")).toContain("**`queued` removed — stale label**");
  });

  it("restart-train-fire's constants agree with label-authority's (two files, one vocabulary — #235)", async () => {
    const fire = await import("../restart-train-fire.js");
    expect(fire.TRAIN_READY_LABEL).toBe(TRAIN_READY_LABEL);
    expect(fire.TRAIN_HOLD_LABEL).toBe(TRAIN_HOLD_LABEL);
    expect(fire.TRAIN_IN_FLIGHT_LABEL).toBe("underway");
  });
});

// ───────────────────────────── resolveAuthorityLogins ─────────────────────────────

describe("resolveAuthorityLogins", () => {
  it("returns the full default roster when callerLogins is omitted", () => {
    expect(resolveAuthorityLogins()).toEqual(MERGE_AUTHORITY_LOGINS);
  });

  it("intersects a caller-supplied list against MERGE_AUTHORITY_LOGINS — never widens it", () => {
    expect(resolveAuthorityLogins(["someone-else", "kbibelhausen"])).toEqual(["kbibelhausen"]);
  });

  it("returns an empty roster when the caller-supplied list shares nothing with MERGE_AUTHORITY_LOGINS", () => {
    expect(resolveAuthorityLogins(["someone-else"])).toEqual([]);
  });

  it("returns an empty roster when the caller passes an empty list (not the default)", () => {
    expect(resolveAuthorityLogins([])).toEqual([]);
  });
});

// ───────────────────────────── hasAuthoritySnapshotDrifted ─────────────────────────────

function baseSnapshot(overrides: Partial<AuthoritySnapshot> = {}): AuthoritySnapshot {
  return {
    labels: [TRAIN_READY_LABEL],
    headRefOid: "abc123",
    state: "OPEN",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

describe("hasAuthoritySnapshotDrifted", () => {
  it("reports no drift when both snapshots are identical", () => {
    expect(hasAuthoritySnapshotDrifted(baseSnapshot(), baseSnapshot())).toBe(false);
  });

  it("ignores label array ORDER (not semantically meaningful — must never false-positive-abort)", () => {
    expect(hasAuthoritySnapshotDrifted(baseSnapshot({ labels: ["a", "b"] }), baseSnapshot({ labels: ["b", "a"] }))).toBe(false);
  });

  it("reports drift when headRefOid changes", () => {
    expect(hasAuthoritySnapshotDrifted(baseSnapshot(), baseSnapshot({ headRefOid: "def456" }))).toBe(true);
  });

  it("reports drift when state changes", () => {
    expect(hasAuthoritySnapshotDrifted(baseSnapshot(), baseSnapshot({ state: "CLOSED" }))).toBe(true);
  });

  it("reports drift when mergeStateStatus changes", () => {
    expect(hasAuthoritySnapshotDrifted(baseSnapshot(), baseSnapshot({ mergeStateStatus: "DIRTY" }))).toBe(true);
  });

  it("reports drift when the label SET changes, not just order", () => {
    expect(hasAuthoritySnapshotDrifted(baseSnapshot({ labels: ["a"] }), baseSnapshot({ labels: ["a", "b"] }))).toBe(true);
  });

  it("reports drift when train:hold is added between snapshots", () => {
    expect(
      hasAuthoritySnapshotDrifted(
        baseSnapshot({ labels: [TRAIN_READY_LABEL] }),
        baseSnapshot({ labels: [TRAIN_READY_LABEL, TRAIN_HOLD_LABEL] }),
      ),
    ).toBe(true);
  });
});

// ───────────────────────────── formatStaleLabelRemovalReceipt ─────────────────────────────

describe("formatStaleLabelRemovalReceipt", () => {
  it("embeds the verdict detail, the evaluated sha, and a write-only disclosure", () => {
    const verdict = evaluateLabelAuthority(baseAuthorityInput({ timeline: [labeledBy("kbibelhausen", 0), commitAt(1)] }));
    // Runtime-verified (not a blind cast) via two SEQUENTIAL guards — proves the
    // fixture actually produced the stale-label branch before feeding it to the
    // formatter under test. The `as` below is then a documented, post-verified
    // assertion: TS's control-flow analysis narrows a direct read of `verdict.reason`
    // after the guard, but does not retroactively widen the WHOLE-OBJECT reference
    // `verdict` to a differently-shaped interface on assignment — a known CFA
    // limitation, not a gap in the runtime check above it.
    if (verdict.authorized) {
      throw new Error(`fixture setup bug: expected an unauthorized verdict, got authorized=true`);
    }
    if (verdict.reason !== "stale-label") {
      throw new Error(`fixture setup bug: expected reason "stale-label", got "${verdict.reason}"`);
    }
    const staleVerdict = verdict as StaleLabelAuthorityVerdict;

    const body = formatStaleLabelRemovalReceipt(staleVerdict, "abc123");
    expect(body).toContain(staleVerdict.detail);
    expect(body).toContain("abc123");
    expect(body.toLowerCase()).toContain("write-only");
  });
});


// ───── 2026-09-06 (the bolt-wms#2120 label-loop incident): paginated authority timeline ─────
//
// A runaway relabel loop pushed one PR to 311 relevant events; the single `last: 250`
// window reported `truncated` and the roster human's `reviewed` at position 2 became
// unreadable through EVERY door (fail-closed by design, but permanently). The fetch now
// walks `before: startCursor` back to the connection's start. Both verdicts are planted
// (Rules #322/#471): a complete walk that AUTHORIZES the old receipt, and a walk past the
// page bound that still REFUSES.
type PageNode = { __typename: string; label?: { name: string }; actor?: { login: string }; createdAt?: string };
function pageJson(nodes: PageNode[], filteredCount: number, hasPreviousPage: boolean, startCursor: string | null = "cur"): string {
  return JSON.stringify({
    data: { repository: { pullRequest: { timelineItems: { filteredCount, pageInfo: { hasPreviousPage, startCursor }, nodes } } } },
  });
}
const labeledNode = (login: string, label: string, createdAt = "2026-09-06T05:05:53Z"): PageNode => ({
  __typename: "LabeledEvent", label: { name: label }, actor: { login }, createdAt,
});
const unlabeledNode = (login: string, label: string): PageNode => ({ __typename: "UnlabeledEvent", label: { name: label }, actor: { login } });
const commitNode: PageNode = { __typename: "PullRequestCommit" };

describe("fetchAuthorityTimeline pagination (bolt-wms#2120 label loop, 2026-09-06)", () => {
  it("control: a single complete page is returned oldest-first and NOT truncated, with before=null on the only call", () => {
    const calls: Array<string | null> = [];
    const run = (v: { before: string | null }) => { calls.push(v.before); return pageJson([commitNode, labeledNode("kbibelhausen", "reviewed")], 2, false, null); };
    const { timeline, truncated } = fetchAuthorityTimeline("studio-b-ai/bolt-wms", 2120, run);
    expect(calls).toEqual([null]);
    expect(truncated).toBe(false);
    expect(timeline.map((t) => [t.type, t.label, t.position])).toEqual([["PULL_REQUEST_COMMIT", undefined, 0], ["LABELED", "reviewed", 1]]);
  });

  it("planted (#2120 shape): 311 relevant events across two pages — the human `reviewed` on the OLDEST page is assembled at position 1 and AUTHORIZES", () => {
    // newest page: 250 churn events (the loop); oldest page: commit, reviewed, then 59 churn events
    const churn = (n: number): PageNode[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? labeledNode("kbibelhausen", "automerge:code-fix", "2026-09-06T06:10:00Z") : unlabeledNode("kbibelhausen", "automerge:code-fix")));
    const newest = churn(AUTHORITY_TIMELINE_PAGE_SIZE);
    const oldest = [commitNode, labeledNode("kbibelhausen", "reviewed"), ...churn(59)];
    const calls: Array<string | null> = [];
    const run = (v: { before: string | null }) => {
      calls.push(v.before);
      if (v.before === null) return pageJson(newest, 311, true, "CURSOR-OLDEST-OF-NEWEST-PAGE");
      if (v.before === "CURSOR-OLDEST-OF-NEWEST-PAGE") return pageJson(oldest, 311, false, null);
      throw new Error(`unexpected cursor ${v.before}`);
    };
    const { timeline, truncated } = fetchAuthorityTimeline("studio-b-ai/bolt-wms", 2120, run);
    expect(calls).toEqual([null, "CURSOR-OLDEST-OF-NEWEST-PAGE"]);
    expect(truncated).toBe(false);
    expect(timeline).toHaveLength(311);
    expect(timeline[0].type).toBe("PULL_REQUEST_COMMIT");
    expect(timeline[1]).toMatchObject({ type: "LABELED", label: "reviewed", actorLogin: "kbibelhausen", position: 1 });
    expect(timeline[310].position).toBe(310);
    const verdict = evaluateLabelAuthority({
      currentLabels: ["reviewed", "bugsquasher", "automerge:code-fix"],
      timeline,
      authorityLogins: MERGE_AUTHORITY_LOGINS,
      truncated,
      labels: { ready: "reviewed", hold: TRAIN_HOLD_LABEL },
    });
    expect(verdict).toEqual({ authorized: true, authorizingEvent: { actorLogin: "kbibelhausen", position: 1 } });
  });

  it("planted (fail-closed): a timeline deeper than the page bound is still reported truncated and the evaluator REFUSES", () => {
    let calls = 0;
    const run = (_v: { before: string | null }) => { calls += 1; return pageJson([commitNode], 100000, true, `cur-${calls}`); };
    const { timeline, truncated } = fetchAuthorityTimeline("studio-b-ai/bolt-wms", 2120, run);
    expect(calls).toBe(AUTHORITY_TIMELINE_MAX_PAGES);
    expect(truncated).toBe(true);
    const verdict = evaluateLabelAuthority({ currentLabels: ["reviewed"], timeline, authorityLogins: MERGE_AUTHORITY_LOGINS, truncated, labels: { ready: "reviewed", hold: TRAIN_HOLD_LABEL } });
    expect(verdict).toMatchObject({ authorized: false, reason: "timeline-truncated" });
  });

  it("control: filteredCount larger than the assembled window reports truncated even when no previous page is claimed", () => {
    const run = () => pageJson([commitNode, labeledNode("kbibelhausen", "reviewed")], 3, false, null);
    expect(fetchAuthorityTimeline("studio-b-ai/bolt-wms", 2120, run).truncated).toBe(true);
  });

  it("control: a connection that changes under the walk (filteredCount moves between pages) throws rather than stitching", () => {
    const run = (v: { before: string | null }) => (v.before === null ? pageJson([commitNode], 5, true, "c1") : pageJson([commitNode], 6, false, null));
    expect(() => fetchAuthorityTimeline("studio-b-ai/bolt-wms", 2120, run)).toThrow(/changed during pagination/);
  });

  it("control: a page that claims a previous page without a startCursor (or with an empty page) throws", () => {
    expect(() => fetchAuthorityTimeline("studio-b-ai/bolt-wms", 2120, () => pageJson([commitNode], 5, true, null))).toThrow(/startCursor/);
    expect(() => fetchAuthorityTimeline("studio-b-ai/bolt-wms", 2120, () => pageJson([], 5, true, "c"))).toThrow(/empty page/);
  });
});
