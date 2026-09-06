/**
 * fleet-sweep-order.ts — ops#327 (Mechanic item 4, 2026-09-05).
 *
 * Pure ordering core for the squasher fleet sweep, matching the pure-core /
 * I/O-glue split established by squasher-fleet-not-the-door.ts (ops#294) and
 * label-authority.ts: no imports, fully unit tested; the workflow bash step
 * that pipes enumerated entries through the exported CLI is thin glue.
 *
 * The defect (issue body): the sweep found 30 labeled PRs and evaluated only
 * the first 20 in a stable order (per repo, bugsquasher first then train),
 * which sliced webhook-router's `queued` PR #915 off every cycle at position
 * 28 of 30 while zero occurrences of "915" ever reached the log. Two shapes
 * of starvation:
 *
 *   1. Bugsquasher entries lined up before `queued` entries fleet-wide,
 *      so Kevin's door-word label queued behind bot PRs when a busy repo's
 *      bugsquasher count alone exceeded the fanout cap.
 *   2. The bugsquasher enumeration order was stable across runs (registry
 *      order × `gh pr list` default order), so a PR just past the cap kept
 *      landing at the same position, never evaluated — the cap's prose
 *      ("the hourly cron catches the rest") is false for a deterministic
 *      order (#412).
 *
 * The Mechanic fix has three legs, all pure list transformations:
 *
 *   A. `queued` first. Fleet-wide, every train_ready entry sorts before every
 *      bugsquasher entry. Kevin's label is the door word and never queues
 *      behind bot PRs — the reusable gate refuses a train-mode invocation
 *      for a repo whose registry entry is train:false, so mis-tagged
 *      `queued` entries are rejected at the gate, not the sort.
 *   B. Per-repo cap inside the bugsquasher group only. The train group is
 *      exempt from per-repo capping — Kevin's door-word label is never
 *      silently dropped behind a per-repo limit (the global fanout still
 *      bounds it, and the gate's own per-input validations still hold).
 *   C. Round-robin rotation of the bugsquasher group BY REPO before capping.
 *      Each repo's bugsquasher entries are rotated by `runOffset`, THEN
 *      capped — so a repo with more than `perRepoCap` entries sees a
 *      different window every run rather than the same first N forever.
 *      The train group stays in enumeration order (Kevin's ask,
 *      all-or-nothing by construction of leg A).
 *
 * Both directions per Rule #322: the "planted" test asserts the queued PR
 * that was starved (webhook-router#915 at entry 28 of 30, five repos with
 * many bugsquasher PRs) now gets evaluated in the first cycle; the "control"
 * test asserts a small input (≤ fanout, ≤ per-repo cap) is returned in the
 * ordering the queued-first + rotation shape prescribes, exactly.
 */

export interface FleetSweepEntry {
  repo: string;
  pr_number: string;
  train_ready: boolean;
  enabled_classes: string;
  sensitive_path_patterns: string;
  safe_path_globs: string;
  required_checks: string;
}

export interface OrderOptions {
  /** Global cap on entries returned this cycle. The workflow's MAX_FANOUT. */
  maxFanout: number;
  /**
   * Per-repo cap applied INSIDE each group (train, bugsquasher) before the
   * global cap. Applied independently to each group so one repo with a
   * bugsquasher backlog cannot starve a queued entry from another repo.
   */
  perRepoCap: number;
  /**
   * Integer, typically GitHub's `run_number`. Used only to rotate the
   * bugsquasher group's start position — a stable enumeration order without
   * this rotation cannot fail to starve a PR sitting just past the cap.
   * Zero, negative, and very large values are all accepted; only the value
   * mod the group length matters.
   */
  runOffset: number;
}

/**
 * Returns entries ordered for this cycle's fanout: every queued (train)
 * entry first (no per-repo cap — Kevin's door word is never silently
 * dropped), then bugsquasher entries per-repo rotated then capped.
 * Total bounded at `maxFanout`.
 *
 * Pure — no I/O, no mutation of the input array. Order-stability inside a
 * repo is preserved (`gh pr list` returns newest first by default; we do not
 * disturb that order beyond the rotation).
 */
export function orderFleetSweepEntries(entries: FleetSweepEntry[], opts: OrderOptions): FleetSweepEntry[] {
  const trainEntries = entries.filter((e) => e.train_ready);
  const bugsquasherEntries = entries.filter((e) => !e.train_ready);

  // Train group: NO per-repo cap — Kevin's door-word label is never
  // silently dropped behind a per-repo limit (the global fanout still
  // bounds it, and the gate's own per-input validations still hold).
  const rotatedBugsq = rotateAndCapBugsquasher(bugsquasherEntries, opts);

  return [...trainEntries, ...rotatedBugsq].slice(0, opts.maxFanout);
}

/**
 * Per-repo rotate-then-cap for the bugsquasher group: groups by repo in
 * first-appearance order, rotates each repo's entries by `runOffset`, then
 * takes at most `perRepoCap` from each — so a repo with more than the cap
 * sees a DIFFERENT window every run rather than the same entries forever.
 */
function rotateAndCapBugsquasher<T extends { repo: string }>(items: T[], opts: OrderOptions): T[] {
  const { perRepoCap, runOffset } = opts;
  const byRepo = new Map<string, T[]>();
  for (const item of items) {
    const arr = byRepo.get(item.repo) ?? [];
    arr.push(item);
    byRepo.set(item.repo, arr);
  }
  const result: T[] = [];
  for (const arr of byRepo.values()) {
    const rotated = rotateArray(arr, runOffset);
    const cap = Math.max(perRepoCap, 0);
    if (cap === 0) continue;
    for (let i = 0; i < rotated.length && i < cap; i++) result.push(rotated[i]);
  }
  return result;
}

/**
 * Returns a rotated copy: element at index `offset % length` becomes index 0.
 * Handles zero-length (returns []) and negative offsets (JS `%` sign-preserves).
 */
function rotateArray<T>(arr: T[], offset: number): T[] {
  const n = arr.length;
  if (n === 0) return [];
  const k = (((offset % n) + n) % n);
  if (k === 0) return arr.slice();
  return arr.slice(k).concat(arr.slice(0, k));
}

// ── CLI: read entries JSON from stdin, print ordered entries JSON to stdout.
// Invoked from .github/workflows/squasher-fleet-sweep.yml — see the workflow's
// "Order entries" step. Accepts positional args: max-fanout per-repo-cap run-offset.

function parseNonNegativeInt(name: string, raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) {
    console.error(`fleet-sweep-order: ${name} must be a non-negative integer, got '${raw ?? ""}'`);
    process.exit(2);
  }
  return Number.parseInt(raw, 10);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const [, , rawMax, rawCap, rawOffset] = process.argv;
  const maxFanout = parseNonNegativeInt("max-fanout", rawMax);
  const perRepoCap = parseNonNegativeInt("per-repo-cap", rawCap);
  const runOffset = parseNonNegativeInt("run-offset", rawOffset);

  const input = (await readAllStdin()).trim();
  const entries: unknown = input === "" ? [] : JSON.parse(input);
  if (!Array.isArray(entries)) {
    console.error("fleet-sweep-order: stdin must be a JSON array");
    process.exit(2);
  }

  const ordered = orderFleetSweepEntries(entries as FleetSweepEntry[], { maxFanout, perRepoCap, runOffset });
  process.stdout.write(JSON.stringify(ordered));
}

const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("fleet-sweep-order.ts") || process.argv[1].endsWith("fleet-sweep-order.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(`fleet-sweep-order: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
