import { describe, expect, it } from "vitest";
import {
  reconcileCondition,
  reconcileGate,
  gateCloseComment,
  gateCycleKey,
  gateTitle,
  isGateTitle,
  GATE_TITLE_BASE,
} from "../gateway-token-reconcile.js";

describe("reconcileCondition (straggler issues)", () => {
  // Negative controls first (Rule #322).
  it("does NOT re-open when condition active and issue already open (dedup by open issue)", () => {
    expect(reconcileCondition(true, true)).toBe("none");
  });
  it("does NOT close when condition cleared and no issue exists", () => {
    expect(reconcileCondition(false, false)).toBe("none");
  });

  it("opens on a new active condition", () => {
    expect(reconcileCondition(true, false)).toBe("open");
  });
  it("closes when the condition clears", () => {
    expect(reconcileCondition(false, true)).toBe("close");
  });
});

describe("reconcileGate (revocation-gate issue)", () => {
  // Negative controls first.
  it("never opens while a straggler keeps the gate CLOSED", () => {
    expect(reconcileGate(false, 10, false, false)).toEqual({ action: "none", reason: null });
  });
  it("never re-opens a human-closed gate issue on 'still green'", () => {
    expect(reconcileGate(true, 10, false, true)).toEqual({ action: "none", reason: null });
  });
  it("is vacuous with zero legacy tokens — closes a lingering issue instead of opening", () => {
    expect(reconcileGate(true, 0, true, false).action).toBe("close");
    expect(reconcileGate(true, 0, false, false)).toEqual({ action: "none", reason: null });
  });

  it("opens once when the gate first goes GREEN", () => {
    expect(reconcileGate(true, 10, false, false)).toEqual({ action: "open", reason: null });
  });
  it("closes the open gate issue when a straggler re-closes the gate", () => {
    expect(reconcileGate(false, 10, true, false).action).toBe("close");
  });
  it("leaves an open GREEN issue alone while green persists", () => {
    expect(reconcileGate(true, 10, true, false)).toEqual({ action: "none", reason: null });
  });
});

// ops-pipeline#32. The two close causes mean OPPOSITE things — "the revocation is done" vs
// "something regressed" — and the pre-#32 code returned a bare "close" for both, so the
// caller emitted one disjunctive comment. On 2026-08-04 a reader took the wrong disjunct and
// pulled a completed action off Kevin's queue as though it were newly unsafe.
describe("reconcileGate close REASON (the #412 discriminant)", () => {
  it("distinguishes the two causes — they are never the same reason", () => {
    const done = reconcileGate(true, 0, true, false);
    const regressed = reconcileGate(false, 10, true, false);
    expect(done.reason).toBe("legacy-set-empty");
    expect(regressed.reason).toBe("gate-un-greened");
    expect(done.reason).not.toBe(regressed.reason);
  });

  // Negative control: a reason is only meaningful on a close. Anything else must be null, so
  // a caller cannot render a cause for an action that never happened.
  it("reports NO reason on open or none", () => {
    expect(reconcileGate(true, 10, false, false).reason).toBeNull();
    expect(reconcileGate(true, 10, true, false).reason).toBeNull();
    expect(reconcileGate(false, 10, false, false).reason).toBeNull();
    expect(reconcileGate(true, 0, false, false).reason).toBeNull();
  });

  // The empty-legacy branch wins even when the gate is not green: with nothing left to
  // revoke the gate is vacuous regardless, and "done" is the honest cause.
  it("prefers legacy-set-empty over gate-un-greened when both could apply", () => {
    expect(reconcileGate(false, 0, true, false)).toEqual({
      action: "close",
      reason: "legacy-set-empty",
    });
  });
});

describe("gateCloseComment", () => {
  const done = gateCloseComment("legacy-set-empty", 0, 0);
  const regressed = gateCloseComment("gate-un-greened", 10, 1);

  it("says the job is DONE for legacy-set-empty, and says so unambiguously", () => {
    expect(done).toContain("Every legacy gateway token is revoked");
    expect(done).toContain("not a regression");
    expect(done).not.toMatch(/straggler token was used again/);
  });

  it("says a consumer would BREAK for gate-un-greened, and says so unambiguously", () => {
    expect(regressed).toContain("no longer GREEN");
    expect(regressed).toContain("break a live consumer");
    expect(regressed).not.toContain("Every legacy gateway token is revoked");
  });

  // THE regression test. The defect was not wrong wording — it was ONE comment that covered
  // both causes, so no reader could tell which had happened.
  it("never emits the disjunction that caused the 2026-08-04 misread", () => {
    for (const c of [done, regressed]) {
      expect(c).not.toMatch(/a straggler appeared or the legacy set changed/i);
      expect(c).not.toMatch(/straggler.*\bor\b.*legacy set/i);
    }
    expect(done).not.toBe(regressed);
  });

  // #34 is fixed by per-cycle titles, but close comments STILL make no reopen promise —
  // the cycle mechanics are documented in gateBody, where the reader deciding whether to
  // ack lives. A close comment describing future behavior is a #412 claim waiting to drift.
  it("makes no promise that the issue will reopen", () => {
    for (const c of [done, regressed]) {
      expect(c).not.toMatch(/reopen/i);
    }
  });

  it("carries the counts so the receipt travels with the notification", () => {
    expect(done).toContain("**0 legacy**");
    expect(done).toContain("**0 straggler(s)**");
    expect(regressed).toContain("**10 legacy**");
    expect(regressed).toContain("**1 straggler(s)**");
  });
});

// ops-pipeline#34: gate issue identity is per-cycle. `everClosed` used to match one
// immortal title, so a single human ack (like #17's close on 2026-08-04) suppressed the
// gate FOREVER — a regrown legacy set would never have surfaced.
describe("gateCycleKey (cycle identity, #34)", () => {
  const base = [
    { name: "old-token-a", lastUsedIso: "2026-07-29T10:00:00.000Z" },
    { name: "old-token-b", lastUsedIso: null },
  ];

  it("is deterministic and order-insensitive", () => {
    const k1 = gateCycleKey(base);
    const k2 = gateCycleKey([base[1], base[0]]);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when a token's usage moves (a straggler episode)", () => {
    const after = [{ ...base[0], lastUsedIso: "2026-08-05T00:00:00.000Z" }, base[1]];
    expect(gateCycleKey(after)).not.toBe(gateCycleKey(base));
  });

  it("changes when the set changes (remediation or regrowth)", () => {
    expect(gateCycleKey([base[0]])).not.toBe(gateCycleKey(base)); // token revoked/allowlisted
    expect(gateCycleKey([...base, { name: "new-legacy", lastUsedIso: null }])).not.toBe(gateCycleKey(base));
  });
});

describe("gateTitle / isGateTitle", () => {
  it("recognizes BOTH formats — the pre-#34 bare title (#17's shape) and cycle-keyed", () => {
    expect(isGateTitle(GATE_TITLE_BASE)).toBe(true);
    expect(isGateTitle(gateTitle("a1b2c3d4"))).toBe(true);
  });

  it("never matches straggler or blind titles (negative control)", () => {
    expect(isGateTitle("[token-watch] straggler: webhook-router-prod (minted 2026-06-10)")).toBe(false);
    expect(isGateTitle("[token-watch] MONITOR BLIND — token table unreadable")).toBe(false);
  });
});

// THE #34 fix, both directions (#471: the non-default verdict is "the gate opens AGAIN").
describe("reopen across cycles", () => {
  const cycle1 = [{ name: "regrown-legacy", lastUsedIso: "2026-09-01T00:00:00.000Z" }];
  const cycle2 = [{ name: "regrown-legacy", lastUsedIso: "2026-09-10T00:00:00.000Z" }];

  it("a human ack suppresses ONLY its own cycle — a new cycle opens fresh", () => {
    const closedTitles = new Set([GATE_TITLE_BASE, gateTitle(gateCycleKey(cycle1))]);
    // Same cycle: acked → suppressed (negative control).
    const same = reconcileGate(true, cycle1.length, false, closedTitles.has(gateTitle(gateCycleKey(cycle1))));
    expect(same).toEqual({ action: "none", reason: null });
    // New cycle (usage moved): the old acks — INCLUDING the pre-#34 bare-title close — no
    // longer match, so the gate opens. This exact input returned "none" forever before #34.
    const fresh = reconcileGate(true, cycle2.length, false, closedTitles.has(gateTitle(gateCycleKey(cycle2))));
    expect(fresh).toEqual({ action: "open", reason: null });
  });

  it("#17's bare-title close can never suppress a cycle-keyed title", () => {
    const closedTitles = new Set([GATE_TITLE_BASE]);
    expect(closedTitles.has(gateTitle(gateCycleKey(cycle1)))).toBe(false);
  });
});

describe("gateCloseComment: cycle-superseded", () => {
  const c = gateCloseComment("cycle-superseded", 2, 1);
  it("names supersession and points at the fresh issue, without claiming DONE or regression-only", () => {
    expect(c).toContain("Superseded");
    expect(c).toContain("fresh gate issue");
    expect(c).not.toContain("Every legacy gateway token is revoked");
    expect(c).not.toMatch(/reopen/i);
    expect(c).toContain("**2 legacy**");
    expect(c).toContain("**1 straggler(s)**");
  });
});
