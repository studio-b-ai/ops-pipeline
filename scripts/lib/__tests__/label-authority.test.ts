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
