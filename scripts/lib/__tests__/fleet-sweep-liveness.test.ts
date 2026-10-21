import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintOf } from "../fleet-sweep-changed.js";
import { type GhStubRule } from "./fixtures/gate-gh-stub.js";
import { runSweep } from "./fixtures/gate-fleet-sweep-harness.js";

// Go-native Phase A, PR-A2 review finding (medium): dropping the gate sha from the fingerprint (item 3) removed the only thing that
// flushed PRs the per-repo cap had skipped — and `--record` marked every changed PR "evaluated" BEFORE the cap dropped some. Reproduced
// by the reviewer with the real scripts: 7 labeled PRs, cap 5 → tick 1 dispatched [6,7,1,2,3], ticks 2-4 dispatched [] — #4 and #5 were
// never evaluated. The fix records a PR only when the order step let it through (fleet-sweep-changed.ts --stage / --commit).
//
// Everything here runs the REAL `list` step of squasher-fleet-sweep.yml in bash (the harness), with the real fleet-sweep-changed and
// fleet-sweep-order CLIs, against a fake `gh`. One `dir` = one Actions cache: passing it to consecutive runSweep calls models consecutive
// hourly ticks (state persists in the state file inside it; RUN_OFFSET = github.run_number, increasing by one per tick).
//
// Rule #322/#471 (both directions, same instrument): the SAME harness with the pre-fix recording order spliced in (the known-bad control)
// strands PRs; the real workflow does not. And a cold start with CURRENT-format fingerprints already recorded dispatches nothing, so the
// "drains over several ticks" result below is caused by the old-format fingerprints and nothing else.

const REPO = "studio-b-ai/bolt-wms";

const prJson = (labels: string[]) => ({ headRefOid: "a".repeat(40), statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], labels: labels.map((name) => ({ name })), mergeStateStatus: "CLEAN", isDraft: false });

function rulesFor(bugsquasherPrs: number[]): GhStubRule[] {
  return [
    { match: /^api repos\/[^/ ]+\/[^/ ]+\/rulesets\?per_page=100$/, out: "[]" },
    { match: new RegExp(`^pr list --repo ${REPO} --label bugsquasher `), out: JSON.stringify(bugsquasherPrs) },
    { match: new RegExp(`^pr list --repo ${REPO} --label fleet-internal `), out: "[]" },
    { match: new RegExp(`^pr list --repo ${REPO} --label box `), out: "[]" },
    { match: new RegExp(`^pr view [0-9]+ --repo ${REPO} --json `), out: JSON.stringify(prJson(["bugsquasher"])) },
    { match: /^api -X GET search\/issues/, out: "[]" },
  ];
}

const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const nums = (entries: { pr_number: string }[] | null) => (entries ?? []).map((e) => Number(e.pr_number)).sort((a, b) => a - b);

/** One hourly tick against `dir` (the shared cache). `transformScript` splices a mutation into the real script text. */
function tick(dir: string, runNumber: number, prs: number[], transformScript?: (s: string) => string) {
  const r = runSweep({ ONLY_REPO: REPO, RUN_OFFSET: String(runNumber) }, rulesFor(prs), { dir, transformScript });
  expect(r.status, `tick ${runNumber} must succeed:\n${r.log}`).toBe(0);
  return { dispatched: nums(r.entries), log: r.log };
}

/** The PRE-FIX shape, spliced into the real script: record every changed entry right after the filter (before the order step caps). */
const RECORD_AT_ENUMERATION = (script: string): string => {
  const anchor = 'changed_count=$(jq length <<<"$entries")';
  expect(script.split(anchor), "the splice anchor must occur exactly once — the workflow was restructured; update this control deliberately").toHaveLength(2);
  return script.replace(anchor, `${anchor}\n          printf '%s' "$entries" | scripts/node_modules/.bin/tsx scripts/lib/fleet-sweep-changed.ts /tmp/fleet-sweep-state.json --commit "$STAGED" 2>/dev/null`);
};

describe("squasher-fleet-sweep.yml `list` step — a PR the per-repo cap skips is deferred, never stranded (review finding, medium)", () => {
  it("KNOWN-GOOD: 7 labeled PRs, cap 5 — tick 1 dispatches 5, tick 2 dispatches the other 2, every PR is evaluated exactly once, then the sweep is silent", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-live-"));
    const prs = seq(7);
    const t1 = tick(dir, 1, prs);
    const t2 = tick(dir, 2, prs);
    const t3 = tick(dir, 3, prs);
    const t4 = tick(dir, 4, prs);
    expect(t1.dispatched).toHaveLength(5);
    expect(t2.dispatched).toHaveLength(2);
    expect([...t1.dispatched, ...t2.dispatched].sort((a, b) => a - b)).toEqual(prs); // every PR, exactly once
    expect(t3.dispatched).toEqual([]); // unchanged PRs are NOT re-evaluated (item 3 still holds: no churn)
    expect(t4.dispatched).toEqual([]);
    // the deferred PRs are named in the receipts, not silently dropped
    expect(t1.log).toContain("held ");
    expect(t1.log).toMatch(/Fanout applied: 7 changed PRs found, 5 evaluated this cycle/);
    expect(t1.log).toMatch(/The other 2 stay changed and are offered again next tick/);
  }, 120000);

  it("KNOWN-BAD CONTROL (same instrument): with the PRE-FIX order (record at enumeration, before the cap) the SAME 7 PRs strand 2 of them forever", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-strand-"));
    const prs = seq(7);
    const seen = new Set<number>();
    const per: number[][] = [];
    for (let n = 1; n <= 4; n++) {
      const t = tick(dir, n, prs, RECORD_AT_ENUMERATION);
      per.push(t.dispatched);
      t.dispatched.forEach((p) => seen.add(p));
    }
    expect(per[0]).toHaveLength(5);
    expect(per.slice(1)).toEqual([[], [], []]); // ticks 2-4: nothing — exactly what the reviewer reproduced
    expect(seen.size).toBe(5); // 2 PRs were never evaluated
  }, 120000);

  it("a repo with 12 labeled PRs and the cap at 5 drains in 3 ticks (5 + 5 + 2), with no PR dispatched twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-drain-"));
    const prs = seq(12);
    const ticks = [1, 2, 3, 4].map((n) => tick(dir, n, prs).dispatched);
    expect(ticks.map((t) => t.length)).toEqual([5, 5, 2, 0]);
    expect(ticks.flat().sort((a, b) => a - b)).toEqual(prs);
  }, 120000);

  it("a PR that changes after it was recorded is evaluated again (the change-driven filter still works across the cap)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-change-"));
    const prs = seq(3);
    expect(tick(dir, 1, prs).dispatched).toEqual([1, 2, 3]);
    expect(tick(dir, 2, prs).dispatched).toEqual([]);
    // PR 2 gets a new head sha: only PR 2 is offered again
    const state = join(dir, "fleet-sweep-state.json");
    const recorded = JSON.parse(readFileSync(state, "utf-8")) as Record<string, { fp: string; at: string }>;
    recorded[`${REPO}#2`].fp = "an-older-head-sha|ci=SUCCESS|bugsquasher|CLEAN|ready";
    writeFileSync(state, JSON.stringify(recorded));
    expect(tick(dir, 3, prs).dispatched).toEqual([2]);
    expect(tick(dir, 4, prs).dispatched).toEqual([]);
  }, 120000);

  it("a PR that leaves the enumeration is pruned from the state; the PRs that remain keep their records", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-prune-"));
    expect(tick(dir, 1, [1, 2, 3]).dispatched).toEqual([1, 2, 3]);
    expect(tick(dir, 2, [1, 3]).dispatched).toEqual([]); // 2 was merged/unlabeled
    const state = JSON.parse(readFileSync(join(dir, "fleet-sweep-state.json"), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual([`${REPO}#1`, `${REPO}#3`]);
  }, 120000);
});

describe("squasher-fleet-sweep.yml `list` step — the first sweep after PR-A2 lands (fingerprint format change), run for real", () => {
  const oldFormat = (n: number) => `${fingerprintOf(prJson(["bugsquasher"]))}|gate-sha-before-this-pr`; // the old fingerprint carried a trailing gate sha
  const seedState = (dir: string, prs: number[], fp: (n: number) => string) =>
    writeFileSync(join(dir, "fleet-sweep-state.json"), JSON.stringify(Object.fromEntries(prs.map((n) => [`${REPO}#${n}`, { fp: fp(n), at: "2026-10-01T00:00:00.000Z" }]))));

  it("KNOWN-GOOD: every labeled PR is re-evaluated once — over ceil(n/5) hourly ticks per repo, NOT in one burst — and none is stranded", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-first-"));
    const prs = seq(12);
    seedState(dir, prs, oldFormat);
    const ticks = [1, 2, 3, 4].map((n) => tick(dir, n, prs).dispatched);
    expect(ticks.map((t) => t.length)).toEqual([5, 5, 2, 0]); // the per-repo cap spreads the one-time re-evaluation; it is not a single burst
    expect(ticks.flat().sort((a, b) => a - b)).toEqual(prs);
  }, 120000);

  it("CONTROL (same instrument): the same cache seeded with CURRENT-format fingerprints dispatches nothing — the drain above is caused by the format change alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-first-ctl-"));
    const prs = seq(12);
    seedState(dir, prs, () => fingerprintOf(prJson(["bugsquasher"])));
    expect(tick(dir, 1, prs).dispatched).toEqual([]);
  }, 120000);
});
