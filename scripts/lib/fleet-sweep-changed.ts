/**
 * fleet-sweep-changed.ts — the change-driven filter for the fleet sweep (Kevin 9/13 "go straight to it").
 *
 * The sweep used to be TIME-driven: every 30 min it re-evaluated the same refused PRs (cp#277: 20 identical DIRTY verdicts
 * in 10h) and rationed the waste with a fanout cap (20, then 50) + a per-repo cap (5) — which starved the PRs it never
 * reached ("47 found, 20 evaluated"). Now it is CHANGE-driven: a PR is evaluated only when its FINGERPRINT differs from
 * the one recorded at its last evaluation. #382: key on the monotonic fact, not the clock. A sweep with nothing
 * changed evaluates nothing and SAYS so per PR (the skip is a receipt, #465).
 *
 * Fingerprint = headRefOid · every check's name+conclusion (sorted) · labels (sorted) · mergeStateStatus · isDraft.
 *
 * The gate's own sha is deliberately NOT part of it (go-native Phase A, PR-A2 item 3): it used to be, so that a door change
 * re-evaluated everything once (#381), but ops-pipeline merges constantly during the migration and every merge re-evaluated every
 * labeled PR in the fleet. A PR is now re-evaluated when ITS OWN inputs change. Landing this change is itself a one-time
 * re-evaluation: cached fingerprints carry the old trailing sha segment and no longer match — and that re-evaluation drains over
 * several ticks, because the per-repo cap in fleet-sweep-order.ts still applies (see below).
 *
 * RECORD ONLY WHAT WAS DISPATCHED (PR-A2 review finding, medium). Between this filter and the gate sits fleet-sweep-order.ts, which
 * CAPS the entries (5 per repo in the bugsquasher group, MAX_FANOUT overall). The old `--record` wrote a fingerprint for every
 * entry the filter returned — before the cap dropped some — so a PR the cap skipped was recorded as "evaluated", stayed
 * "unchanged" on every later tick, and (with the gate sha gone, which used to flush everything on each ops-pipeline merge) was
 * never evaluated until its OWN inputs changed. So recording is split in two, with the order step between them:
 *
 *   --stage <staged.json>    filter: stdout = the changed entries; writes the staged file (every enumerated key, the live
 *                            fingerprint of each changed key, and the identity of each changed entry). The state is NOT touched.
 *   --commit <staged.json>   stdin = the entries the sweep is about to dispatch (what the order step let through). Records the
 *                            staged fingerprint of a PR only when EVERY changed entry for it was dispatched (a PR carrying both
 *                            `bugsquasher` and `box` yields two entries; if the cap drops one, the PR is not yet evaluated),
 *                            and prunes PRs that left the enumeration. stdout is empty.
 *
 * Recording happens at dispatch, before the gate runs — deliberate, unchanged: a crashed gate job is re-tried next tick only if
 * something changes (the receipt of a crash is a GH failure, not silence). `--record` is gone and exits 2: it is the stranding bug.
 *
 * stdin: JSON array of enumeration entries, each {repo, pr_number, ...}  (--commit: the dispatched subset of --stage's output)
 * argv:  <state.json path> [--stage <staged.json> | --commit <staged.json>]   (no flag = read-only filter; a legacy `<gate-sha>`
 *                                        positional is ignored)
 * stdout: --stage / no flag: the entries whose fingerprint changed (the ones to evaluate); --commit: nothing
 * stderr: one line per skipped PR: `skip repo#n unchanged since <ts> (last: <verdict>)`;
 *         --commit: `record repo#n` per recorded PR, `held repo#n …` per PR left unrecorded, one summary line
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

type Entry = { repo: string; pr_number: string; [k: string]: unknown };
type Fp = { fp: string; at: string; verdict?: string };
type State = Record<string, Fp>;
/** What --stage leaves for --commit. `pending[key]` = the identity of every CHANGED entry for that PR; `fps[key]` = its live fingerprint. */
export type Staged = { keep: string[]; fps: Record<string, string>; pending: Record<string, string[]> };

export function fingerprintOf(pr: { headRefOid: string; statusCheckRollup: { name?: string; context?: string; conclusion?: string; state?: string }[]; labels: { name: string }[]; mergeStateStatus: string; isDraft: boolean }): string {
  const checks = (pr.statusCheckRollup || []).map((c) => `${c.name || c.context || "?"}=${c.conclusion || c.state || "PENDING"}`).sort().join(",");
  const labels = (pr.labels || []).map((l) => l.name).sort().join(",");
  return [pr.headRefOid, checks, labels, pr.mergeStateStatus, pr.isDraft ? "draft" : "ready"].join("|");
}

const keyOf = (e: Entry): string => `${e.repo}#${e.pr_number}`;
/** An entry's identity as it travels through the sweep: the order step only drops and reorders entries, it never rewrites one. */
export const entryId = (e: Entry): string => JSON.stringify(e);

/** Pure: given entries + their live fingerprints + prior state, split into changed / unchanged. */
export function splitChanged(entries: Entry[], live: Record<string, string>, state: State): { changed: Entry[]; unchanged: { key: string; prior: Fp }[] } {
  const changed: Entry[] = []; const unchanged: { key: string; prior: Fp }[] = [];
  for (const e of entries) {
    const key = keyOf(e); const prior = state[key];
    if (prior && prior.fp === live[key]) unchanged.push({ key, prior }); else changed.push(e);
  }
  return { changed, unchanged };
}

/** Pure: what --stage writes. `entries` = everything enumerated; `changed` = the subset the filter returns. */
export function stageChanged(entries: Entry[], changed: Entry[], live: Record<string, string>): Staged {
  const staged: Staged = { keep: [...new Set(entries.map(keyOf))], fps: {}, pending: {} };
  for (const e of changed) {
    const key = keyOf(e);
    staged.fps[key] = live[key];
    (staged.pending[key] ??= []).push(entryId(e));
  }
  return staged;
}

/**
 * Pure: the state after `dispatched` entries were let through the cap. A PR's fingerprint is recorded only when EVERY changed entry
 * staged for it is in `dispatched`; otherwise it is `held` (left exactly as it was, so it is still "changed" next tick). A dispatched
 * entry that was never staged is `unstaged` — we never record a fingerprint we did not observe. PRs that left the enumeration are pruned.
 */
export function commitDispatched(state: State, staged: Staged, dispatched: Entry[], now: string): { state: State; recorded: string[]; held: string[]; unstaged: string[] } {
  const dispatchedIds = new Set(dispatched.map(entryId));
  const next: State = { ...state };
  const recorded: string[] = []; const held: string[] = [];
  for (const [key, ids] of Object.entries(staged.pending)) {
    if (ids.every((id) => dispatchedIds.has(id))) {
      next[key] = { fp: staged.fps[key], at: now, verdict: state[key]?.verdict };
      recorded.push(key);
    } else held.push(key);
  }
  const stagedIds = new Set(Object.values(staged.pending).flat());
  const unstaged = dispatched.filter((e) => !stagedIds.has(entryId(e))).map(keyOf);
  // prune PRs that left the enumeration (closed/merged/unlabeled) — the state never grows past the open labeled set
  const keep = new Set(staged.keep);
  for (const k of Object.keys(next)) if (!keep.has(k)) delete next[k];
  return { state: next, recorded, held, unstaged };
}

function ghPr(repo: string, n: string) {
  const out = execFileSync("gh", ["pr", "view", n, "--repo", repo, "--json", "headRefOid,statusCheckRollup,labels,mergeStateStatus,isDraft"], { encoding: "utf8" });
  return JSON.parse(out);
}

function usage(msg: string): never {
  process.stderr.write(`fleet-sweep-changed: ${msg}\n`);
  process.exit(2);
}

/** argv after the state path → the one mode requested. Positionals (the legacy gate sha) are ignored; every unknown flag is refused. */
function parseMode(args: string[]): { mode: "filter" } | { mode: "stage" | "commit"; file: string } {
  let mode: "filter" | "stage" | "commit" = "filter"; let file = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--stage" || a === "--commit") {
      if (mode !== "filter") usage("--stage and --commit are mutually exclusive");
      mode = a === "--stage" ? "stage" : "commit"; file = args[++i] ?? "";
      if (!file || file.startsWith("--")) usage(`${a} needs a <staged.json> path`);
    } else if (a === "--record") {
      usage("--record was removed: it recorded a fingerprint for every changed entry BEFORE the per-repo cap dropped some, stranding them. Use --stage <file> before fleet-sweep-order.ts and --commit <file> after it.");
    } else if (a.startsWith("--")) usage(`unknown flag ${a}`);
  }
  return mode === "filter" ? { mode } : { mode, file };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [statePath, ...rest] = process.argv.slice(2);
  if (!statePath) usage("usage: fleet-sweep-changed.ts <state.json> [--stage <staged.json> | --commit <staged.json>]");
  const m = parseMode(rest);
  const entries: Entry[] = JSON.parse(readFileSync(0, "utf8") || "[]");
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

  if (m.mode === "commit") {
    if (!existsSync(m.file)) { process.stderr.write(`fleet-sweep-changed: staged file ${m.file} does not exist — refusing to record (run --stage first)\n`); process.exit(1); }
    const staged = JSON.parse(readFileSync(m.file, "utf8")) as Staged;
    const r = commitDispatched(state, staged, entries, new Date().toISOString());
    for (const k of r.recorded) process.stderr.write(`record ${k}\n`);
    for (const k of r.held) process.stderr.write(`held ${k} — a changed entry for it was not dispatched this tick (per-repo/global cap); it stays changed and is re-offered next tick\n`);
    for (const k of r.unstaged) process.stderr.write(`unstaged ${k} — dispatched but never staged; not recorded\n`);
    process.stderr.write(`commit: ${r.recorded.length} recorded, ${r.held.length} held, ${r.unstaged.length} unstaged, of ${entries.length} dispatched entries\n`);
    writeFileSync(statePath, JSON.stringify(r.state, null, 1) + "\n");
  } else {
    const live: Record<string, string> = {};
    for (const e of entries) {
      const key = keyOf(e);
      try { live[key] = fingerprintOf(ghPr(e.repo, e.pr_number)); }
      catch (err) { live[key] = `ERR|${Date.now()}`; process.stderr.write(`probe-failed ${key}: ${(err as Error).message.split("\n")[0]}\n`); }
    }
    const { changed, unchanged } = splitChanged(entries, live, state);
    for (const u of unchanged) process.stderr.write(`skip ${u.key} unchanged since ${u.prior.at}${u.prior.verdict ? ` (last: ${u.prior.verdict})` : ""}\n`);
    if (m.mode === "stage") writeFileSync(m.file, JSON.stringify(stageChanged(entries, changed, live), null, 1) + "\n");
    process.stdout.write(JSON.stringify(changed));
  }
}
