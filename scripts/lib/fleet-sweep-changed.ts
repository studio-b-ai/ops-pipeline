/**
 * fleet-sweep-changed.ts — the change-driven filter for the fleet sweep (Kevin 9/13 "go straight to it").
 *
 * The sweep used to be TIME-driven: every 30 min it re-evaluated the same refused PRs (cp#277: 20 identical DIRTY verdicts
 * in 10h) and rationed the waste with a fanout cap (20, then 50) + a per-repo cap (5) — which starved the PRs it never
 * reached ("47 found, 20 evaluated"). Now it is CHANGE-driven: a PR is evaluated only when its FINGERPRINT differs from
 * the one recorded at its last evaluation. #382: key on the monotonic fact, not the clock. No cap — a sweep with nothing
 * changed evaluates nothing and SAYS so per PR (the skip is a receipt, #465).
 *
 * Fingerprint = headRefOid · every check's name+conclusion (sorted) · labels (sorted) · mergeStateStatus · isDraft.
 *
 * The gate's own sha is deliberately NOT part of it (go-native Phase A, PR-A2 item 3): it used to be, so that a door change
 * re-evaluated everything once (#381), but ops-pipeline merges constantly during the migration and every merge re-evaluated every
 * labeled PR in the fleet. A PR is now re-evaluated when ITS OWN inputs change. Landing this change is itself a one-time
 * re-evaluation: cached fingerprints carry the old trailing sha segment and no longer match.
 *
 * stdin: JSON array of enumeration entries, each {repo, pr_number, ...}
 * argv:  <state.json path> [--record]   (a legacy `<gate-sha>` positional between them is ignored;
 *                                        --record: write the new fingerprints for the entries we RETURN;
 *                                                    the sweep records at ENUMERATION so a crashed gate job is re-tried next tick
 *                                                    only if something changes — deliberate: the receipt of a crash is a GH failure, not silence)
 * stdout: the entries whose fingerprint changed (the ones to evaluate)
 * stderr: one line per skipped PR: `skip repo#n unchanged since <ts> (last: <verdict>)`
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

type Entry = { repo: string; pr_number: string; [k: string]: unknown };
type Fp = { fp: string; at: string; verdict?: string };
type State = Record<string, Fp>;

export function fingerprintOf(pr: { headRefOid: string; statusCheckRollup: { name?: string; context?: string; conclusion?: string; state?: string }[]; labels: { name: string }[]; mergeStateStatus: string; isDraft: boolean }): string {
  const checks = (pr.statusCheckRollup || []).map((c) => `${c.name || c.context || "?"}=${c.conclusion || c.state || "PENDING"}`).sort().join(",");
  const labels = (pr.labels || []).map((l) => l.name).sort().join(",");
  return [pr.headRefOid, checks, labels, pr.mergeStateStatus, pr.isDraft ? "draft" : "ready"].join("|");
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

function ghPr(repo: string, n: string) {
  const out = execFileSync("gh", ["pr", "view", n, "--repo", repo, "--json", "headRefOid,statusCheckRollup,labels,mergeStateStatus,isDraft"], { encoding: "utf8" });
  return JSON.parse(out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [statePath, ...flags] = process.argv.slice(2);
  const record = flags.includes("--record");
  const entries: Entry[] = JSON.parse(readFileSync(0, "utf8") || "[]");
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const live: Record<string, string> = {};
  for (const e of entries) {
    const key = `${e.repo}#${e.pr_number}`;
    try { live[key] = fingerprintOf(ghPr(e.repo, e.pr_number)); }
    catch (err) { live[key] = `ERR|${Date.now()}`; process.stderr.write(`probe-failed ${key}: ${(err as Error).message.split("\n")[0]}\n`); }
  }
  const { changed, unchanged } = splitChanged(entries, live, state);
  for (const u of unchanged) process.stderr.write(`skip ${u.key} unchanged since ${u.prior.at}${u.prior.verdict ? ` (last: ${u.prior.verdict})` : ""}\n`);
  if (record) {
    const now = new Date().toISOString();
    for (const e of changed) { const key = `${e.repo}#${e.pr_number}`; state[key] = { fp: live[key], at: now, verdict: state[key]?.verdict }; }
    // prune PRs that left the enumeration (closed/merged/unlabeled) — the state never grows past the open labeled set
    const keep = new Set(entries.map((e) => `${e.repo}#${e.pr_number}`));
    for (const k of Object.keys(state)) if (!keep.has(k)) delete state[k];
    writeFileSync(statePath, JSON.stringify(state, null, 1) + "\n");
  }
  process.stdout.write(JSON.stringify(changed));
}
