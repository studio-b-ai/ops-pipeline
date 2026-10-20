/**
 * fleet-sweep-changed.ts — the change-driven filter for the fleet sweep (Kevin 9/13 "go straight to it").
 *
 * The sweep used to be TIME-driven: every 30 min it re-evaluated the same refused PRs (cp#277: 20 identical DIRTY verdicts
 * in 10h) and rationed the waste with a fanout cap (20, then 50) + a per-repo cap (5) — which starved the PRs it never
 * reached ("47 found, 20 evaluated"). Now it is CHANGE-driven: a PR is evaluated only when its FINGERPRINT differs from
 * the one recorded at its last evaluation. #382: key on the monotonic fact, not the clock. No cap — a sweep with nothing
 * changed evaluates nothing and SAYS so per PR (the skip is a receipt, #465).
 *
 * Fingerprint = headRefOid · every check's name+conclusion (sorted) · labels (sorted) · mergeStateStatus · isDraft · the
 * gate's own sha (a door change re-evaluates everything once — #381, tightening a guard is forward-only) · POLICY_VERSION
 * (below: bumping it re-evaluates every open labelled PR exactly once, on purpose, whatever else changed).
 *
 * RECORD ONLY WHAT IS EMITTED (row 928, 2026-10-20). The fingerprint used to be recorded for EVERY changed entry
 * at enumeration, BEFORE the workflow's fanout cap ran — so the entries the cap cut were marked "seen" and never
 * evaluated again (evidence: the 10/20 20:25Z sweep skipped 310 of 361 labelled PRs as "unchanged since
 * 2026-10-06T13:32:47Z" — one bulk record, while that day's run (37471040046) fanned out only 74 gate jobs). A policy
 * bump over a 300-PR pile would have evaluated ~100 and silently lost the rest. Now the cap runs HERE (the same pure
 * `orderFleetSweepEntries`), and only the entries it lets through are recorded; the deferred ones keep their prior
 * fingerprint, so they come back next sweep — the pile drains across sweeps, each PR exactly once.
 *
 * stdin: JSON array of enumeration entries, each {repo, pr_number, ...}
 * argv:  <state.json path> <gate-sha> [--record]   (--record: write the new fingerprints for the entries we RETURN;
 *                                                    the sweep records at ENUMERATION so a crashed gate job is re-tried next tick
 *                                                    only if something changes — deliberate: the receipt of a crash is a GH failure, not silence)
 * stdout: the entries whose fingerprint changed (the ones to evaluate)
 * stderr: one line per skipped PR: `skip repo#n unchanged since <ts> (last: <verdict>)`
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { orderFleetSweepEntries, type FleetSweepEntry } from "./fleet-sweep-order.js";

type Entry = { repo: string; pr_number: string; [k: string]: unknown };
type Fp = { fp: string; at: string; verdict?: string };
type State = Record<string, Fp>;

/**
 * The door's POLICY version. Part of every fingerprint, so changing this string makes EVERY open labelled PR's
 * fingerprint differ once — the sweep then re-evaluates the whole pile exactly once (spread over sweeps by the
 * fanout caps), under whatever the policy now says. Bump it in the PR that changes what the door will merge;
 * never otherwise (a bump costs one review vote x3 per open PR). The review leg's sticky-FLAG card marker is keyed
 * by the SAME constant (gate-flag-card.ts), so a bump is also the one moment a parked FLAG head is allowed a re-vote.
 */
export const POLICY_VERSION = "2026-10-20-crew-change-v1";

export function fingerprintOf(pr: { headRefOid: string; statusCheckRollup: { name?: string; context?: string; conclusion?: string; state?: string }[]; labels: { name: string }[]; mergeStateStatus: string; isDraft: boolean }, gateSha: string, policyVersion: string = POLICY_VERSION): string {
  const checks = (pr.statusCheckRollup || []).map((c) => `${c.name || c.context || "?"}=${c.conclusion || c.state || "PENDING"}`).sort().join(",");
  const labels = (pr.labels || []).map((l) => l.name).sort().join(",");
  return [pr.headRefOid, checks, labels, pr.mergeStateStatus, pr.isDraft ? "draft" : "ready", gateSha, `policy:${policyVersion}`].join("|");
}

/** Pure: given entries + their live fingerprints + prior state, split into changed / unchanged. */
export function splitChanged(entries: Entry[], live: Record<string, string>, state: State): { changed: Entry[]; unchanged: { key: string; prior: Fp }[] } {
  const changed: Entry[] = []; const unchanged: { key: string; prior: Fp }[] = [];
  for (const e of entries) {
    const key = `${e.repo}#${e.pr_number}`; const prior = state[key];
    if (prior && prior.fp === live[key]) unchanged.push({ key, prior }); else changed.push(e);
  }
  return { changed, unchanged };
}

export interface SweepOrderOpts { maxFanout: number; perRepoCap: number; runOffset: number }

/**
 * Pure: the whole sweep decision. Splits changed/unchanged, applies the fanout cap (when given), and returns the next
 * state with fingerprints recorded ONLY for entries that will actually be evaluated this tick. A deferred entry keeps
 * its prior record (or none), so it is "changed" again next sweep. A PR enumerated twice (bugsquasher + box variants)
 * whose variants are split across the cap is NOT recorded — it must come back until every variant has been emitted.
 * PRs that left the enumeration are pruned, as before.
 */
export function selectAndRecord(entries: Entry[], live: Record<string, string>, state: State, now: string, order?: SweepOrderOpts): { emitted: Entry[]; deferred: Entry[]; unchanged: { key: string; prior: Fp }[]; nextState: State } {
  const { changed, unchanged } = splitChanged(entries, live, state);
  const emitted = order ? (orderFleetSweepEntries(changed as unknown as FleetSweepEntry[], order) as unknown as Entry[]) : changed;
  const emittedSet = new Set(emitted);
  const deferred = changed.filter((e) => !emittedSet.has(e));
  const deferredKeys = new Set(deferred.map((e) => `${e.repo}#${e.pr_number}`));
  const nextState: State = { ...state };
  for (const e of emitted) {
    const key = `${e.repo}#${e.pr_number}`;
    if (deferredKeys.has(key)) continue;
    nextState[key] = { fp: live[key], at: now, verdict: state[key]?.verdict };
  }
  const keep = new Set(entries.map((e) => `${e.repo}#${e.pr_number}`));
  for (const k of Object.keys(nextState)) if (!keep.has(k)) delete nextState[k];
  return { emitted, deferred, unchanged, nextState };
}

function ghPr(repo: string, n: string) {
  const out = execFileSync("gh", ["pr", "view", n, "--repo", repo, "--json", "headRefOid,statusCheckRollup,labels,mergeStateStatus,isDraft"], { encoding: "utf8" });
  return JSON.parse(out);
}

function intFlag(argv: string[], name: string): number | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const raw = argv[i + 1];
  if (!raw || !/^\d+$/.test(raw)) { process.stderr.write(`fleet-sweep-changed: ${name} must be a non-negative integer, got '${raw ?? ""}'\n`); process.exit(2); }
  return Number.parseInt(raw, 10);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [statePath, gateSha] = process.argv.slice(2);
  const flags = process.argv.slice(4);
  const record = flags.includes("--record");
  const maxFanout = intFlag(flags, "--max-fanout");
  const perRepoCap = intFlag(flags, "--per-repo-cap");
  const runOffset = intFlag(flags, "--run-offset");
  const capFlags = [maxFanout, perRepoCap, runOffset].filter((v) => v !== undefined).length;
  if (capFlags !== 0 && capFlags !== 3) { process.stderr.write("fleet-sweep-changed: --max-fanout, --per-repo-cap and --run-offset must be given together\n"); process.exit(2); }
  const order: SweepOrderOpts | undefined = capFlags === 3 ? { maxFanout: maxFanout!, perRepoCap: perRepoCap!, runOffset: runOffset! } : undefined;
  const entries: Entry[] = JSON.parse(readFileSync(0, "utf8") || "[]");
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const live: Record<string, string> = {};
  for (const e of entries) {
    const key = `${e.repo}#${e.pr_number}`;
    try { live[key] = fingerprintOf(ghPr(e.repo, e.pr_number), gateSha); }
    catch (err) { live[key] = `ERR|${Date.now()}`; process.stderr.write(`probe-failed ${key}: ${(err as Error).message.split("\n")[0]}\n`); }
  }
  const { emitted, deferred, unchanged, nextState } = selectAndRecord(entries, live, state, new Date().toISOString(), order);
  for (const u of unchanged) process.stderr.write(`skip ${u.key} unchanged since ${u.prior.at}${u.prior.verdict ? ` (last: ${u.prior.verdict})` : ""}\n`);
  const changedCount = emitted.length + deferred.length;
  process.stderr.write(`Change-driven filter: ${changedCount} of ${entries.length} labeled PRs have new fingerprints (fleet-sweep-changed.ts, ops#836). Skipped entries printed to stderr above.\n`);
  if (order && deferred.length > 0) {
    process.stderr.write(`::warning::Fanout applied: ${changedCount} changed PRs found, ${emitted.length} evaluated this cycle (per-repo cap=${order.perRepoCap}, global cap=${order.maxFanout}, run_offset=${order.runOffset}; #327). The ${deferred.length} deferred entries are left UNRECORDED and return next sweep (row 928: record only what is emitted).\n`);
  }
  if (record) writeFileSync(statePath, JSON.stringify(nextState, null, 1) + "\n");
  process.stdout.write(JSON.stringify(emitted));
}
