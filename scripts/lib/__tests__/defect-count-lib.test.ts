import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readState,
  writeState,
  increment,
  readAndReset,
  formatWrapLine,
  stateFilePath,
  type DefectState,
} from "../defect-count-lib.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dc-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = "2026-09-07T23:00:00Z";
const SHIFT_ID = "mechanic-20260907-2200";

function freshState(overrides?: Partial<DefectState>): DefectState {
  return { shift_id: SHIFT_ID, count: 0, defects: [], last_updated: NOW, ...overrides };
}

// ── readState ──────────────────────────────────────────────────────────

describe("readState", () => {
  it("returns empty sentinel when no file exists (negative control)", () => {
    const s = readState("nonexistent", tmpDir);
    expect(s).toEqual({ shift_id: "", count: 0, defects: [], last_updated: "" });
  });

  it("reads a valid state file (positive control)", () => {
    writeState(freshState({ count: 3, defects: [{ at: NOW, description: "test" }] }), "mechanic", tmpDir);
    const s = readState("mechanic", tmpDir);
    expect(s.count).toBe(3);
    expect(s.defects).toHaveLength(1);
    expect(s.defects[0].description).toBe("test");
  });

  it("sanitises seat names for the file path", () => {
    const p = stateFilePath("my seat/here", tmpDir);
    expect(p).not.toContain("/");
    expect(p).not.toContain(" ");
  });

  it("survives corrupt JSON — returns empty sentinel, never throws", () => {
    const { writeFileSync } = await import("node:fs");
    const path = stateFilePath("corrupt", tmpDir);
    writeFileSync(path, "{not json", "utf-8");
    const s = readState("corrupt", tmpDir);
    expect(s).toEqual({ shift_id: "", count: 0, defects: [], last_updated: "" });
  });

  it("survives missing count field — defaults to 0", () => {
    writeState({ shift_id: SHIFT_ID, defects: [], last_updated: NOW } as DefectState, "partial", tmpDir);
    const s = readState("partial", tmpDir);
    expect(s.count).toBe(0);
  });

  it("filters invalid defect entries", () => {
    writeState(
      {
        shift_id: SHIFT_ID,
        count: 2,
        defects: [{ at: NOW, description: "valid" }, { not_a_defect: true }, { at: NOW }, { description: "no-at" }],
        last_updated: NOW,
      },
      "mixed",
      tmpDir,
    );
    const s = readState("mixed", tmpDir);
    expect(s.defects).toHaveLength(1);
    expect(s.defects[0].description).toBe("valid");
  });

  // #322 — negative control: truly empty directory, zero state
  it("readState on empty dir returns the empty sentinel", () => {
    const s = readState("nothing", tmpDir);
    expect(s.count).toBe(0);
    expect(s.defects).toHaveLength(0);
  });
});

// ── writeState ─────────────────────────────────────────────────────────

describe("writeState", () => {
  it("writes and round-trips (positive control)", () => {
    const state = freshState({ count: 1, defects: [{ at: NOW, description: "round-trip" }] });
    expect(writeState(state, "mechanic", tmpDir)).toBe(true);
    const s = readState("mechanic", tmpDir);
    expect(s.count).toBe(1);
    expect(s.defects[0].description).toBe("round-trip");
  });

  it("returns false on unwritable path", () => {
    expect(writeState(freshState(), "mechanic", "/dev/null/defect-counts")).toBe(false);
  });
});

// ── increment ──────────────────────────────────────────────────────────

describe("increment", () => {
  it("increments from zero — first defect", () => {
    writeState(freshState(), "mechanic", tmpDir);
    const s = increment("mechanic", "Rule #4 violated", NOW, SHIFT_ID, tmpDir);
    expect(s.count).toBe(1);
    expect(s.defects).toHaveLength(1);
    expect(s.defects[0].description).toBe("Rule #4 violated");
    expect(s.defects[0].at).toBe(NOW);
    expect(s.shift_id).toBe(SHIFT_ID);
  });

  it("increments from existing — second defect appends", () => {
    writeState(freshState({ count: 1, defects: [{ at: "2026-09-07T22:00:00Z", description: "first" }] }), "mechanic", tmpDir);
    const s = increment("mechanic", "second defect", NOW, SHIFT_ID, tmpDir);
    expect(s.count).toBe(2);
    expect(s.defects).toHaveLength(2);
    expect(s.defects[1].description).toBe("second defect");
  });

  it("returns valid in-memory state even when write fails", () => {
    // Doesn't write back — just confirms the return value is sound
    writeState(freshState({ count: 2 }), "mechanic", tmpDir);
    const s = increment("mechanic", "on-disk-missing but in memory ok", NOW, SHIFT_ID, tmpDir);
    expect(s.count).toBe(3);
    // #322 negative control: disk state unchanged (we didn't call write here, just verifying increment returns)
    const disk = readState("mechanic", tmpDir);
    expect(disk.count).toBe(2);
  });

  it("increment from no prior file — starts at 1", () => {
    const s = increment("fresh", "sole defect", NOW, SHIFT_ID, tmpDir);
    expect(s.count).toBe(1);
    expect(s.defects).toHaveLength(1);
  });
});

// ── readAndReset ───────────────────────────────────────────────────────

describe("readAndReset", () => {
  it("reads, returns, and zeros — positive control", () => {
    writeState(freshState({ count: 2, defects: [{ at: NOW, description: "a" }, { at: NOW, description: "b" }] }), "mechanic", tmpDir);
    const before = readAndReset("mechanic", tmpDir);
    expect(before!.count).toBe(2);
    expect(before!.defects).toHaveLength(2);
    const after = readState("mechanic", tmpDir);
    expect(after.count).toBe(0);
    expect(after.defects).toHaveLength(0);
  });

  it("returns null when state is already zero (negative control — no false positive)", () => {
    writeState(freshState(), "mechanic", tmpDir);
    const result = readAndReset("mechanic", tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when no file exists (negative control)", () => {
    const result = readAndReset("nonexistent", tmpDir);
    expect(result).toBeNull();
  });
});

// ── formatWrapLine ─────────────────────────────────────────────────────

describe("formatWrapLine", () => {
  it("formats zero defects", () => {
    expect(formatWrapLine(null)).toBe("doctrine defects Kevin caught this shift: 0");
    expect(formatWrapLine(freshState())).toBe("doctrine defects Kevin caught this shift: 0");
  });

  it("formats one defect with sub-bullet", () => {
    const state = freshState({ count: 1, defects: [{ at: NOW, description: "Rule #4 violated: claimed deployed, was not" }] });
    const result = formatWrapLine(state);
    expect(result).toContain("doctrine defects Kevin caught this shift: 1");
    expect(result).toContain("  - Rule #4 violated: claimed deployed, was not");
  });

  it("formats multiple defects in order", () => {
    const state = freshState({
      count: 3,
      defects: [
        { at: NOW, description: "first" },
        { at: NOW, description: "second" },
        { at: NOW, description: "third" },
      ],
    });
    const result = formatWrapLine(state);
    const lines = result.split("\n");
    expect(lines[0]).toBe("doctrine defects Kevin caught this shift: 3");
    expect(lines[1]).toContain("first");
    expect(lines[2]).toContain("second");
    expect(lines[3]).toContain("third");
  });
});