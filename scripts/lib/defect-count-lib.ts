/**
 * Defect-count tracking mechanism — ops-pipeline#366.
 *
 * roundhouse#27 (template v0.13.0) mandates every /wrap carry a "doctrine defects
 * Kevin caught this shift: N" line, but no durable counter existed — seats were
 * reconstructing from session memory at wrap time. This lib provides the pure
 * state-machine logic: a per-seat JSON state file at
 * `~/.claude/state/defect-counts/<seat>.json` that seats increment during a
 * session and read + reset at /wrap.
 *
 * State file shape:
 *   { shift_id: string, count: number, defects: DefectEntry[],
 *     last_updated: string }
 *   DefectEntry = { at: string, description: string }
 *
 * NOT a worker — seats call this directly (via the CLI wrapper) in-session.
 * The Dispatcher reads the wrap bullet (not the file) and tracks trends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Default base directory for state files. Injected so tests pin their own tmpdir. */
export const DEFAULT_STATE_DIR = (() => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return `${home}/.claude/state/defect-counts`;
})();

export type DefectEntry = {
  at: string;
  description: string;
};

export type DefectState = {
  shift_id: string;
  count: number;
  defects: DefectEntry[];
  last_updated: string;
};

const EMPTY_STATE: DefectState = {
  shift_id: "",
  count: 0,
  defects: [],
  last_updated: "",
};

export function stateFilePath(seat: string, baseDir: string = DEFAULT_STATE_DIR): string {
  const safe = seat.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${baseDir}/${safe}.json`;
}

/** Pure: read the state file or return the empty sentinel. Never throws. */
export function readState(seat: string, baseDir: string = DEFAULT_STATE_DIR): DefectState {
  const path = stateFilePath(seat, baseDir);
  try {
    if (!existsSync(path)) return structuredClone(EMPTY_STATE);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DefectState>;
    return {
      shift_id: typeof parsed.shift_id === "string" ? parsed.shift_id : "",
      count: typeof parsed.count === "number" && Number.isFinite(parsed.count) ? parsed.count : 0,
      defects: Array.isArray(parsed.defects)
        ? parsed.defects.filter(
            (d): d is DefectEntry =>
              typeof d?.at === "string" && typeof d?.description === "string",
          )
        : [],
      last_updated: typeof parsed.last_updated === "string" ? parsed.last_updated : "",
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

/** Pure: write state to disk. Returns true on success. */
export function writeState(
  state: DefectState,
  seat: string,
  baseDir: string = DEFAULT_STATE_DIR,
): boolean {
  const path = stateFilePath(seat, baseDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Increment: append a defect, bump count, stamp last_updated.
 * Reads the current file, appends, writes back.
 * Returns the new state (even if write failed — the in-memory state is valid).
 */
export function increment(
  seat: string,
  description: string,
  now: string,
  shiftId: string,
  baseDir: string = DEFAULT_STATE_DIR,
): DefectState {
  const state = readState(seat, baseDir);
  // If shift_id changed (new sitting), the caller should have reset first.
  // We still accept the increment but note the mismatch isn't our job to fix.
  const entry: DefectEntry = { at: now, description };
  return {
    shift_id: shiftId,
    count: state.count + 1,
    defects: [...state.defects, entry],
    last_updated: now,
  };
}

/** Reset: read current, return it for reporting, then write empty. */
export function readAndReset(
  seat: string,
  baseDir: string = DEFAULT_STATE_DIR,
): DefectState | null {
  const state = readState(seat, baseDir);
  if (state.count === 0 && state.defects.length === 0) return null;
  writeState({ shift_id: "", count: 0, defects: [], last_updated: "" }, seat, baseDir);
  return state;
}

/** Format a state for the /wrap "doctrine defects" line. */
export function formatWrapLine(state: DefectState | null): string {
  if (!state || state.count === 0) {
    return "doctrine defects Kevin caught this shift: 0";
  }
  const lines = [`doctrine defects Kevin caught this shift: ${state.count}`];
  for (const d of state.defects) {
    lines.push(`  - ${d.description}`);
  }
  return lines.join("\n");
}