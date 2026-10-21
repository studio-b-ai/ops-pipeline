import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { commitDispatched, entryId, fingerprintOf, splitChanged, stageChanged } from "../fleet-sweep-changed.js";
import { orderFleetSweepEntries, type FleetSweepEntry } from "../fleet-sweep-order.js";
import { makeGhStub } from "./fixtures/gate-gh-stub.js";

const pr = (over: Partial<Parameters<typeof fingerprintOf>[0]> = {}) => ({
  headRefOid: "abc123", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], labels: [{ name: "fleet-internal" }], mergeStateStatus: "CLEAN", isDraft: false, ...over,
});

describe("change-driven sweep — the fingerprint is the reason to look (#382)", () => {
  it("identical PR → identical fingerprint (order of checks/labels irrelevant)", () => {
    const a = fingerprintOf(pr({ statusCheckRollup: [{ name: "b", conclusion: "SUCCESS" }, { name: "a", conclusion: "FAILURE" }], labels: [{ name: "y" }, { name: "x" }] }));
    const b = fingerprintOf(pr({ statusCheckRollup: [{ name: "a", conclusion: "FAILURE" }, { name: "b", conclusion: "SUCCESS" }], labels: [{ name: "x" }, { name: "y" }] }));
    expect(a).toBe(b);
  });
  it.each([
    ["new head sha", pr({ headRefOid: "def456" })],
    ["a check flipped", pr({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })],
    ["a label added", pr({ labels: [{ name: "fleet-internal" }, { name: "hold" }] })],
    ["mergeState changed", pr({ mergeStateStatus: "DIRTY" })],
    ["draft toggled", pr({ isDraft: true })],
  ])("known-bad control: %s → fingerprint changes", (_n, changed) => {
    expect(fingerprintOf(changed)).not.toBe(fingerprintOf(pr()));
  });
  it("PR-A2 item 3: the gate sha is NOT part of the fingerprint — the fingerprint is exactly the PR's own five inputs", () => {
    // fingerprintOf takes ONE argument now; an extra (legacy) gate-sha argument must not leak into the string either
    const legacyCall = fingerprintOf as unknown as (p: unknown, gateSha: string) => string;
    expect(fingerprintOf(pr())).toBe("abc123|ci=SUCCESS|fleet-internal|CLEAN|ready");
    expect(legacyCall(pr(), "g1")).toBe(legacyCall(pr(), "g2"));
    expect(legacyCall(pr(), "g1")).toBe(fingerprintOf(pr()));
  });
  it("splitChanged: unchanged PRs are skipped WITH their prior receipt; changed + never-seen are evaluated", () => {
    const entries = [{ repo: "r", pr_number: "1" }, { repo: "r", pr_number: "2" }, { repo: "r", pr_number: "3" }];
    const live = { "r#1": "same", "r#2": "moved", "r#3": "new" };
    const state = { "r#1": { fp: "same", at: "t0", verdict: "DIRTY" }, "r#2": { fp: "old", at: "t0", verdict: "missed" } };
    const { changed, unchanged } = splitChanged(entries, live, state);
    expect(changed.map((e) => e.pr_number)).toEqual(["2", "3"]);
    expect(unchanged).toEqual([{ key: "r#1", prior: { fp: "same", at: "t0", verdict: "DIRTY" } }]);
  });
  it("known-good control: empty state → everything is evaluated (first run after the door change)", () => {
    const entries = [{ repo: "r", pr_number: "1" }];
    expect(splitChanged(entries, { "r#1": "x" }, {}).changed).toHaveLength(1);
  });
});

// PR-A2 review finding (medium) — record only what was dispatched. Pure core first: the cap sits BETWEEN the filter and the record.
describe("stageChanged / commitDispatched — a PR is recorded only when every changed entry for it was dispatched", () => {
  const e = (n: number, over: Record<string, unknown> = {}) => ({ repo: "o/r", pr_number: String(n), train_ready: false, ...over });
  const ENTRIES = [1, 2, 3, 4, 5, 6, 7].map((n) => e(n));
  const LIVE = Object.fromEntries(ENTRIES.map((x) => [`o/r#${x.pr_number}`, `fp-${x.pr_number}`]));
  const NOW = "2026-10-21T00:00:00.000Z";

  it("stage writes every enumerated key, the live fingerprint of each CHANGED key, and the identity of each changed entry", () => {
    const state = { "o/r#1": { fp: "fp-1", at: "t0" } }; // PR 1 is unchanged
    const { changed } = splitChanged(ENTRIES, LIVE, state);
    const staged = stageChanged(ENTRIES, changed, LIVE);
    expect(staged.keep).toEqual(ENTRIES.map((x) => `o/r#${x.pr_number}`));
    expect(Object.keys(staged.fps)).toEqual(["o/r#2", "o/r#3", "o/r#4", "o/r#5", "o/r#6", "o/r#7"]);
    expect(staged.pending["o/r#2"]).toEqual([entryId(e(2))]);
    expect(staged.pending["o/r#1"]).toBeUndefined();
  });

  it("KNOWN-GOOD: dispatched entries are recorded; entries the cap dropped are HELD — their state is untouched, so they are still changed next tick", () => {
    const { changed } = splitChanged(ENTRIES, LIVE, {});
    const staged = stageChanged(ENTRIES, changed, LIVE);
    const ordered = orderFleetSweepEntries(changed as unknown as FleetSweepEntry[], { maxFanout: 100, perRepoCap: 5, runOffset: 1 }) as unknown as typeof ENTRIES; // the REAL cap
    expect(ordered).toHaveLength(5);
    const r = commitDispatched({}, staged, ordered, NOW);
    expect(r.recorded.sort()).toEqual(ordered.map((x) => `o/r#${x.pr_number}`).sort());
    expect(r.held).toHaveLength(2);
    for (const k of r.held) expect(r.state[k]).toBeUndefined();
    // next tick: exactly the held PRs are changed
    const next = splitChanged(ENTRIES, LIVE, r.state).changed.map((x) => `o/r#${x.pr_number}`).sort();
    expect(next).toEqual([...r.held].sort());
  });

  it("KNOWN-BAD CONTROL (the pre-fix shape): committing the PRE-cap list records the capped-out PRs too, and they never come back", () => {
    const { changed } = splitChanged(ENTRIES, LIVE, {});
    const staged = stageChanged(ENTRIES, changed, LIVE);
    const r = commitDispatched({}, staged, changed, NOW); // what `--record` effectively did: record everything the filter returned
    expect(r.held).toEqual([]);
    expect(splitChanged(ENTRIES, LIVE, r.state).changed).toEqual([]); // nothing is changed any more, although 2 of the 7 were never dispatched
  });

  it("a PR carrying BOTH labels yields two entries: if the cap drops one of them the PR is NOT recorded (held), and is recorded once both go through", () => {
    const sq = e(9, { train_ready: false });
    const box = e(9, { train_ready: true });
    const entries = [sq, box];
    const live = { "o/r#9": "fp-9" };
    const staged = stageChanged(entries, entries, live);
    expect(staged.pending["o/r#9"]).toHaveLength(2);
    const partial = commitDispatched({}, staged, [box], NOW);
    expect(partial.recorded).toEqual([]);
    expect(partial.held).toEqual(["o/r#9"]);
    expect(commitDispatched({}, staged, [sq, box], NOW).recorded).toEqual(["o/r#9"]);
  });

  it("an unchanged PR keeps its record through a commit; a PR that left the enumeration is pruned; the prior verdict is carried; a dispatched entry that was never staged is refused", () => {
    const state = { "o/r#1": { fp: "fp-1", at: "t0", verdict: "DIRTY" }, "o/r#2": { fp: "old", at: "t0", verdict: "missed" }, "o/r#gone": { fp: "x", at: "t0" } };
    const live = { "o/r#1": "fp-1", "o/r#2": "fp-2" };
    const entries = [e(1), e(2)];
    const { changed } = splitChanged(entries, live, state);
    const staged = stageChanged(entries, changed, live);
    const stranger = e(99);
    const r = commitDispatched(state, staged, [e(2), stranger], NOW);
    expect(r.state["o/r#1"]).toEqual({ fp: "fp-1", at: "t0", verdict: "DIRTY" });
    expect(r.state["o/r#2"]).toEqual({ fp: "fp-2", at: NOW, verdict: "missed" });
    expect(r.state["o/r#gone"]).toBeUndefined();
    expect(r.state["o/r#99"]).toBeUndefined();
    expect(r.unstaged).toEqual(["o/r#99"]);
  });
});

// PR-A2 item 3 + the review finding, process level (#223): the REAL CLI file, a fake `gh` returning one PR. The sweep used to pass its own git
// sha as the 2nd positional; the fingerprint must neither contain it nor change when it does (every ops-pipeline merge changes that sha).
describe("fleet-sweep-changed CLI — stage → (order) → commit; the gate sha no longer re-evaluates the fleet", () => {
  const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const TSX = join(SCRIPTS, "node_modules", ".bin", "tsx");
  const CLI = join(SCRIPTS, "lib", "fleet-sweep-changed.ts");
  const prView = JSON.stringify({ headRefOid: "abc123", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], labels: [{ name: "box" }], mergeStateStatus: "CLEAN", isDraft: false });
  type Run = { status: number | null; stdout: string; stderr: string };
  function cli(dir: string, args: string[], input: unknown[], movedHead = false): Run {
    const stub = makeGhStub(dir, [{ match: /^pr view [0-9]+ --repo o\/r --json /, out: movedHead ? prView.replace("abc123", "def456") : prView }]);
    const r = spawnSync(TSX, [CLI, ...args], { cwd: SCRIPTS, env: { ...process.env, PATH: stub.path, GH_STUB_LOG: stub.logPath }, input: JSON.stringify(input), encoding: "utf-8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const entries = (...ns: number[]) => ns.map((n) => ({ repo: "o/r", pr_number: String(n) }));
  const changedOf = (r: Run) => (JSON.parse(r.stdout) as { pr_number: string }[]).map((x) => Number(x.pr_number));

  it("known-bad: first sight is evaluated; known-good: unchanged PR is skipped even though the legacy gate-sha positional differs every run", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sweep-changed-"));
    const state = join(dir, "state.json"); const staged = join(dir, "staged.json");
    const tickOnce = (legacySha: string[], moved = false) => {
      const s = cli(dir, [state, ...legacySha, "--stage", staged], entries(7), moved);
      expect(s.status).toBe(0);
      const changed = changedOf(s);
      const c = cli(dir, [state, ...legacySha, "--commit", staged], entries(...changed), moved);
      expect(c.status).toBe(0);
      expect(c.stdout).toBe(""); // --commit prints nothing on stdout
      return changed;
    };
    expect(tickOnce([])).toEqual([7]); // never seen → evaluate
    expect(tickOnce([])).toEqual([]); // unchanged → skipped
    expect(tickOnce(["sha-after-another-ops-pipeline-merge"])).toEqual([]); // legacy positional ignored
    expect(Object.values(JSON.parse(readFileSync(state, "utf-8")) as Record<string, { fp: string }>)[0].fp).toBe("abc123|ci=SUCCESS|box|CLEAN|ready");
    expect(tickOnce([], true)).toEqual([7]); // the PR's OWN head moved → evaluate again
  });

  it("--stage never writes the state file; only --commit does, and only for the entries it is handed", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sweep-changed-"));
    const state = join(dir, "state.json"); const staged = join(dir, "staged.json");
    expect(changedOf(cli(dir, [state, "--stage", staged], entries(1, 2, 3)))).toEqual([1, 2, 3]);
    expect(existsSync(state)).toBe(false); // staging recorded nothing
    expect(JSON.parse(readFileSync(staged, "utf-8")).keep).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
    const c = cli(dir, [state, "--commit", staged], entries(1, 2)); // the cap let 1 and 2 through; 3 was dropped
    expect(Object.keys(JSON.parse(readFileSync(state, "utf-8")) as object).sort()).toEqual(["o/r#1", "o/r#2"]);
    expect(c.stderr).toMatch(/held o\/r#3 /);
    expect(c.stderr).toMatch(/commit: 2 recorded, 1 held, 0 unstaged, of 2 dispatched entries/);
    expect(changedOf(cli(dir, [state, "--stage", staged], entries(1, 2, 3)))).toEqual([3]); // the dropped PR is offered again
  });

  it("KNOWN-BAD CONTROL: committing the pre-cap list (the old --record behavior) strands the dropped PR across later ticks", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sweep-changed-"));
    const state = join(dir, "state.json"); const staged = join(dir, "staged.json");
    cli(dir, [state, "--stage", staged], entries(1, 2, 3));
    cli(dir, [state, "--commit", staged], entries(1, 2, 3)); // recorded everything, though only 1 and 2 would be dispatched
    for (let i = 0; i < 3; i++) expect(changedOf(cli(dir, [state, "--stage", staged], entries(1, 2, 3)))).toEqual([]); // 3 never comes back
  });

  it("--record is refused (exit 2) with a message that names the replacement; it must not silently behave like the old recorder", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sweep-changed-"));
    const state = join(dir, "state.json");
    const r = cli(dir, [state, "--record"], entries(7));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--record was removed/);
    expect(r.stderr).toMatch(/--stage/);
    expect(existsSync(state)).toBe(false);
  });

  it("--commit without a staged file refuses to record (exit 1); --stage + --commit together, an unknown flag, and a flag without a path are usage errors (exit 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sweep-changed-"));
    const state = join(dir, "state.json");
    expect(cli(dir, [state, "--commit", join(dir, "nope.json")], entries(1)).status).toBe(1);
    expect(existsSync(state)).toBe(false);
    expect(cli(dir, [state, "--stage", join(dir, "a.json"), "--commit", join(dir, "a.json")], entries(1)).status).toBe(2);
    expect(cli(dir, [state, "--bogus"], entries(1)).status).toBe(2);
    expect(cli(dir, [state, "--stage"], entries(1)).status).toBe(2);
  });

  it("no flag = the read-only filter: it prints the changed entries and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sweep-changed-"));
    const state = join(dir, "state.json");
    expect(changedOf(cli(dir, [state], entries(1)))).toEqual([1]);
    expect(existsSync(state)).toBe(false);
    writeFileSync(state, "{}"); // (an existing empty state is read, not rewritten)
    expect(changedOf(cli(dir, [state], entries(1)))).toEqual([1]);
    expect(readFileSync(state, "utf-8")).toBe("{}");
  });
});
