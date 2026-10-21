import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { fingerprintOf, splitChanged } from "../fleet-sweep-changed.js";
import { makeGhStub } from "./fixtures/gh-stub.js";

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

// PR-A2 item 3, process level (#223): the REAL CLI file, a fake `gh` returning one PR. The sweep used to pass its own git sha as the
// 2nd positional; the fingerprint must neither contain it nor change when it does (every ops-pipeline merge changes that sha).
describe("fleet-sweep-changed CLI — the gate sha no longer re-evaluates the fleet (PR-A2 item 3)", () => {
  const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const TSX = join(SCRIPTS, "node_modules", ".bin", "tsx");
  const CLI = join(SCRIPTS, "lib", "fleet-sweep-changed.ts");
  const prView = JSON.stringify({ headRefOid: "abc123", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], labels: [{ name: "box" }], mergeStateStatus: "CLEAN", isDraft: false });
  function sweep(dir: string, args: string[], movedHead = false) {
    const stub = makeGhStub(dir, [{ match: /^pr view 7 --repo o\/r --json /, out: movedHead ? prView.replace("abc123", "def456") : prView }]);
    const out = execFileSync(TSX, [CLI, ...args], {
      cwd: SCRIPTS,
      env: { ...process.env, PATH: stub.path, GH_STUB_LOG: stub.logPath },
      input: JSON.stringify([{ repo: "o/r", pr_number: "7" }]),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out) as unknown[];
  }
  it("known-bad: first sight is evaluated; known-good: unchanged PR is skipped even though the legacy gate-sha positional differs every run", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-sweep-changed-"));
    const state = join(dir, "state.json");
    expect(sweep(dir, [state, "--record"])).toHaveLength(1); // never seen → evaluate
    expect(sweep(dir, [state, "--record"])).toHaveLength(0); // unchanged → skipped
    expect(sweep(dir, [state, "sha-after-another-ops-pipeline-merge", "--record"])).toHaveLength(0); // legacy positional ignored, --record still honored
    expect(Object.values(JSON.parse(readFileSync(state, "utf-8")) as Record<string, { fp: string }>)[0].fp).toBe("abc123|ci=SUCCESS|box|CLEAN|ready");
    expect(sweep(dir, [state, "--record"], true)).toHaveLength(1); // the PR's OWN head moved → evaluate again
  });
});
