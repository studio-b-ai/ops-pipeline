import { describe, expect, it } from "vitest";
import { reconcileCondition, reconcileGate } from "../gateway-token-reconcile.js";

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
    expect(reconcileGate(false, 10, false, false)).toBe("none");
  });
  it("never re-opens a human-closed gate issue on 'still green'", () => {
    expect(reconcileGate(true, 10, false, true)).toBe("none");
  });
  it("is vacuous with zero legacy tokens — closes a lingering issue instead of opening", () => {
    expect(reconcileGate(true, 0, true, false)).toBe("close");
    expect(reconcileGate(true, 0, false, false)).toBe("none");
  });

  it("opens once when the gate first goes GREEN", () => {
    expect(reconcileGate(true, 10, false, false)).toBe("open");
  });
  it("closes the open gate issue when a straggler re-closes the gate", () => {
    expect(reconcileGate(false, 10, true, false)).toBe("close");
  });
  it("leaves an open GREEN issue alone while green persists", () => {
    expect(reconcileGate(true, 10, true, false)).toBe("none");
  });
});
