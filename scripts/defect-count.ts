#!/usr/bin/env tsx
/**
 * Defect-count CLI — ops-pipeline#366.
 *
 * Called by seats during a session to record doctrine defects Kevin catches,
 * and at /wrap to read + reset. Thin I/O glue over lib/defect-count-lib.js.
 *
 * Usage:
 *   tsx defect-count.ts inc <seat> "<description>"
 *   tsx defect-count.ts read <seat>
 *   tsx defect-count.ts reset <seat>   (read + report + zero, for /wrap)
 *
 * State files live at ~/.claude/state/defect-counts/<seat>.json.
 * The shift_id is derived from the SEAT env var (or the seat arg).
 *
 * Exit codes: 0 = ok, 1 = usage error, 2 = state read/write failure.
 */

import { increment, readState, readAndReset, writeState, formatWrapLine } from "./lib/defect-count-lib.js";

function usage(): never {
  console.error("Usage: defect-count <inc|read|reset> <seat> [description]");
  process.exit(1);
}

const cmd = process.argv[2];
const seat = process.argv[3];
if (!cmd || !seat) usage();

const now = new Date().toISOString();
const shiftId = process.env.SEAT_SHIFT_ID ?? `${seat}-${now.slice(0, 16).replace("T", "-")}`;

switch (cmd) {
  case "inc": {
    const description = process.argv[4];
    if (!description) {
      console.error("defect-count inc: description required");
      process.exit(1);
    }
    const state = increment(seat, description, now, shiftId);
    const ok = writeState(state, seat);
    if (!ok) {
      console.error("defect-count inc: failed to write state file");
      process.exit(2);
    }
    console.log(`defect-count: recorded defect #${state.count} for ${seat}`);
    break;
  }

  case "read": {
    const state = readState(seat);
    console.log(JSON.stringify(state, null, 2));
    break;
  }

  case "reset": {
    const state = readAndReset(seat);
    console.log(formatWrapLine(state));
    break;
  }

  default:
    usage();
}