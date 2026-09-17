import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 2026-09-15 ruling (stint #372), BEHAVIORAL half — the source-shape guards in
// train-gate-box-ruling.test.ts pin the gate file's text; THIS suite drives the
// ACTUAL deployed entrypoint (`tsx pr-automerge-gate.ts --train-ready`, the exact
// invocation squasher-fleet-sweep.yml makes) end-to-end with a `gh` shim on PATH,
// proving the stint's two controls against the real leg sequence (#223 — the test
// invokes the real function, never a re-assembly; #322/#471 — both directions):
//
//   POSITIVE: a box-only PR (Kevin's label, roster-attributed timeline, green CI
//   rollup, mergeStateStatus CLEAN) now MERGES — no review-model vote stands
//   between the authority leg and the merge. The shim answers every `gh` call and
//   fails LOUD on any unexpected one, so a resurrected review leg (which would
//   call `gh api repos/.../compare/...` for the diff) turns this suite red.
//
//   NEGATIVE: the floor stands — a box-only PR with a red rollup or a
//   DIRTY/UNSTABLE mergeStateStatus still REFUSES at the merge-readiness leg and
//   `gh pr merge` is never attempted (the stint's live examples: brain#160 DIRTY,
//   client-asthetik#372 UNSTABLE, refused at exactly that leg on run 34939031962's
//   successors).
//
// The shim records every invocation to $GH_CALLS_LOG; merge assertions grep that
// log, so "merged" means the SHA-pinned `gh pr merge --match-head-commit` actually
// fired and "refused" proves it never did.

const SCRIPTS_DIR = join(__dirname, "..", "..");
const TSX = join(SCRIPTS_DIR, "node_modules", ".bin", "tsx");
const GATE = join(SCRIPTS_DIR, "pr-automerge-gate.ts");
const REPO = "studio-b-ai/fixture-repo";
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const BOX_TIMELINE = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        timelineItems: {
          filteredCount: 1,
          pageInfo: { hasPreviousPage: false, startCursor: null },
          nodes: [
            {
              __typename: "LabeledEvent",
              label: { name: "box" },
              actor: { __typename: "User", login: "kbibelhausen" },
              createdAt: "2026-09-17T20:00:00Z",
            },
          ],
        },
      },
    },
  },
});

function prFixture(overrides: { mergeStateStatus?: string; conclusion?: string }): string {
  return JSON.stringify({
    author: { login: "kbibelhausen" },
    labels: [{ name: "box" }],
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: overrides.mergeStateStatus ?? "CLEAN",
    additions: 1,
    deletions: 1,
    headRefOid: HEAD_SHA,
    baseRefName: "main",
    statusCheckRollup: [
      {
        name: "ci",
        status: "COMPLETED",
        conclusion: overrides.conclusion ?? "SUCCESS",
        completedAt: "2026-09-17T19:00:00Z",
      },
    ],
    files: [],
    changedFiles: 0,
  });
}

const SHIM = `#!/bin/bash
# gh shim — answers ONLY the train gate's four call shapes; anything else exits
# loud so a resurrected review leg (compare-diff fetch) or any new gh dependency
# turns this suite red instead of passing silently.
echo "$@" >> "$GH_CALLS_LOG"
case "$1 $2" in
  "pr view") cat "$FIXTURE_PR" ;;
  "api graphql") cat "$FIXTURE_TIMELINE" ;;
  "pr merge") exit 0 ;;
  "pr comment") exit 0 ;;
  *) echo "gh shim: unexpected call: $@" >&2; exit 1 ;;
esac
`;

const work = mkdtempSync(join(tmpdir(), "train-gate-box-ruling-"));
const shimBin = join(work, "bin");
mkdirSync(shimBin);
writeFileSync(join(shimBin, "gh"), SHIM);
chmodSync(join(shimBin, "gh"), 0o755);
const callsLog = join(work, "gh-calls.log");
const timelineFile = join(work, "timeline.json");
writeFileSync(timelineFile, BOX_TIMELINE);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function runGate(prJson: string): { stdout: string; calls: string } {
  const prFile = join(work, `pr-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(prFile, prJson);
  writeFileSync(callsLog, "");
  const stdout = execFileSync(TSX, [GATE, "--repo", REPO, "--pr", "1", "--train-ready"], {
    cwd: SCRIPTS_DIR,
    env: {
      ...process.env,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      GH_CALLS_LOG: callsLog,
      FIXTURE_PR: prFile,
      FIXTURE_TIMELINE: timelineFile,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { stdout, calls: readFileSync(callsLog, "utf8") };
}

describe("train-gate box ruling (2026-09-15, stint #372) — behavioral, actual CLI", () => {
  it(
    "POSITIVE control: box-only + green CI + CLEAN merges — no review vote between box and the merge",
    { timeout: 180_000 },
    () => {
      const { stdout, calls } = runGate(prFixture({}));
      expect(stdout).toContain(`[train-gate-receipt] repo=${REPO} pr=1 outcome=merged`);
      // The merge is SHA-pinned to the head Kevin's box authorized (#398/#46).
      expect(calls).toContain(`pr merge 1 --repo ${REPO} --squash --match-head-commit ${HEAD_SHA}`);
      // The write-only MERGED receipt posts; the review machinery never fired
      // (a compare-diff fetch would have exited the shim loud and failed the run).
      expect(calls).toContain("pr comment 1");
      expect(calls).not.toContain("compare");
    },
  );

  it(
    "NEGATIVE control: box-only + mergeStateStatus DIRTY refuses at the floor — merge never attempted",
    { timeout: 180_000 },
    () => {
      const { stdout, calls } = runGate(prFixture({ mergeStateStatus: "DIRTY" }));
      expect(stdout).toContain(`[train-gate-receipt] repo=${REPO} pr=1 outcome=refused`);
      expect(stdout).toContain("not merge-ready");
      expect(calls).not.toContain("pr merge");
    },
  );

  it(
    "NEGATIVE control: box-only + mergeStateStatus UNSTABLE refuses at the floor — merge never attempted",
    { timeout: 180_000 },
    () => {
      const { stdout, calls } = runGate(prFixture({ mergeStateStatus: "UNSTABLE" }));
      expect(stdout).toContain(`[train-gate-receipt] repo=${REPO} pr=1 outcome=refused`);
      expect(stdout).toContain("not merge-ready");
      expect(calls).not.toContain("pr merge");
    },
  );

  it(
    "NEGATIVE control: box-only + red CI rollup refuses at the floor — merge never attempted",
    { timeout: 180_000 },
    () => {
      const { stdout, calls } = runGate(prFixture({ conclusion: "FAILURE" }));
      expect(stdout).toContain(`[train-gate-receipt] repo=${REPO} pr=1 outcome=refused`);
      expect(stdout).toContain("not merge-ready");
      expect(calls).not.toContain("pr merge");
    },
  );
});
