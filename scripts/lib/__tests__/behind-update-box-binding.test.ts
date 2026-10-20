/**
 * Row 928 redesign — does Kevin's `box` survive a GATE-MADE update-branch (a merge commit of
 * base into the PR branch)? This file answers it with the REAL recipe on a REAL git repo,
 * not a mocked runner (box-patch-id.test.ts mocks git; this is the one place that does not):
 *
 *   1. PATCH-ID. `mintBoxPatchId` hashes `git diff -U0 <merge-base(origin/<base>, head)> <head>`
 *      (patch-id --stable + hunk-header-normalized diff + the raw blob list). A merge-from-main
 *      moves the merge-base up to the new base tip, so the diff is the PR's own change against
 *      the new base. UNCHANGED when base moved in files the PR does not touch; CHANGED when base
 *      moved in a file the PR also touches (the `--raw` blob shas for that path differ) — the
 *      recipe is deliberately blunt there, and a changed id means the box is stripped.
 *   2. THE VERDICT. `evaluateLabelAuthority` Step 3 treats ANY commit after the authorizing
 *      LabeledEvent as stale. The only thing that keeps the box is the patch-id predicate
 *      (`boxPatchIdWins`) AND the gate having refreshed the record to cover the update-branch
 *      commit (`refreshBoxPatchId`, via refreshBoxPatchIdAfterUpdateBranch). With
 *      `boxPatchIdWins` false — what every real environment runs today — the box is stale after
 *      ANY update-branch, whoever makes it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BOX_PATCH_ID_CHECK_NAME, buildBoxPatchIdContext, mintBoxPatchId, refreshBoxPatchId, type BoxPatchIdRecord } from "../box-patch-id.js";
import { evaluateLabelAuthority, resolveAuthorityLogins, type AuthorityTimelineItem } from "../label-authority.js";

const REPO = "studio-b-ai/claude-hooks";
const HEAD_REPO = REPO;
const PR = 700;
const LABEL_EVENT = 4242;

let dir: string;
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
const write = (f: string, text: string) => writeFileSync(join(dir, f), text);
const lines = (n: number, tweak?: (i: number) => string | undefined) =>
  Array.from({ length: n }, (_, i) => tweak?.(i + 1) ?? `line ${i + 1}`).join("\n") + "\n";

const mint = (headSha: string): { record: BoxPatchIdRecord } => {
  const v = mintBoxPatchId({ repo: REPO, prNumber: PR, headRepo: HEAD_REPO, headSha, baseRef: "main", labelEventDbId: LABEL_EVENT, changedPaths: ["a.txt"], repoDir: dir });
  if (!v.ok) throw new Error(`mint failed: ${v.detail}`);
  return v;
};

let H1: string; // the PR head Kevin boxed
let H2: string; // after the gate's update-branch (base moved in b.txt — a file the PR does not touch)
let H3: string; // after a second update-branch (base moved in a.txt — a file the PR also touches)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "behind-box-binding-"));
  git("init", "-q", "-b", "main");
  write("a.txt", lines(20));
  write("b.txt", "b\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-q", "-b", "feature");
  write("a.txt", lines(20, (i) => (i === 3 ? "line 3 CHANGED BY THE PR" : undefined)));
  git("commit", "-q", "-am", "the PR's change");
  H1 = git("rev-parse", "HEAD");
  // base moves in a file the PR does not touch, then the gate's update-branch (a merge commit of base into the branch)
  git("checkout", "-q", "main");
  write("b.txt", "b moved\n");
  git("commit", "-q", "-am", "main moves: b.txt");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-edit", "main");
  H2 = git("rev-parse", "HEAD");
  // base moves AGAIN, this time in a.txt (far from the PR's hunk — merges cleanly), and another update-branch
  git("checkout", "-q", "main");
  write("a.txt", lines(20, (i) => (i === 18 ? "line 18 MOVED ON MAIN" : undefined)));
  git("commit", "-q", "-am", "main moves: a.txt");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-edit", "main");
  H3 = git("rev-parse", "HEAD");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the PR's own patch-id across a merge-from-main (update-branch), on a real repo", () => {
  it("is UNCHANGED when base moved only in files the PR does not touch", () => {
    // minted at H1 against origin/main as it stood THEN: re-point the ref for an honest 'at the time' mint
    const baseNow = git("rev-parse", "refs/remotes/origin/main");
    const baseThen = git("rev-parse", `${H1}~1`);
    git("update-ref", "refs/remotes/origin/main", baseThen);
    const before = mint(H1).record.patchId;
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "main~1")); // base as of the first update-branch (b.txt moved)
    const after = mint(H2).record.patchId;
    git("update-ref", "refs/remotes/origin/main", baseNow);
    expect(after).toBe(before);
  });

  it("CHANGES when base moved in a file the PR also touches (the raw-blob component) — the box would be stripped", () => {
    const baseNow = git("rev-parse", "refs/remotes/origin/main");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", `${H1}~1`));
    const before = mint(H1).record.patchId;
    git("update-ref", "refs/remotes/origin/main", baseNow);
    const after = mint(H3).record.patchId;
    expect(after).not.toBe(before);
  });
});

describe("the box verdict after a gate-made update-branch (evaluateLabelAuthority Step 3, real predicate)", () => {
  const timelineWith = (updateOid: string): AuthorityTimelineItem[] => [
    { type: "PULL_REQUEST_COMMIT", position: 0, oid: H1 },
    { type: "LABELED", label: "box", actorLogin: "kbibelhausen", position: 1, createdAt: "2026-10-20T10:00:00Z", databaseId: LABEL_EVENT },
    { type: "PULL_REQUEST_COMMIT", position: 2, oid: updateOid }, // the merge commit update-branch made
  ];
  const verdictFor = (opts: { updateOid: string; baseRefAtMint: string; baseRefNow: string; recordRefreshedTo?: string; wins: boolean }) => {
    git("update-ref", "refs/remotes/origin/main", opts.baseRefAtMint);
    let record = mint(H1).record; // what box-patch-id-labeled.yml recorded when Kevin boxed
    if (opts.recordRefreshedTo) record = refreshBoxPatchId(record, opts.recordRefreshedTo); // refreshBoxPatchIdAfterUpdateBranch
    git("update-ref", "refs/remotes/origin/main", opts.baseRefNow);
    const ctx = buildBoxPatchIdContext({
      checkRuns: [{ name: BOX_PATCH_ID_CHECK_NAME, output: { text: JSON.stringify(record) } }],
      currentLabelEventDbId: LABEL_EVENT, repo: REPO, prNumber: PR, headRepo: HEAD_REPO, headSha: opts.updateOid, changedPaths: ["a.txt"], repoDir: dir,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return evaluateLabelAuthority({
        currentLabels: ["box"], timeline: timelineWith(opts.updateOid), authorityLogins: resolveAuthorityLogins(), truncated: false,
        boxPatchId: ctx, boxPatchIdWins: opts.wins,
      });
    } finally {
      errSpy.mockRestore();
    }
  };
  const baseAtBoxTime = () => git("rev-parse", `${H1}~1`);
  const baseAfterFirstUpdate = () => git("rev-parse", "main~1");
  const baseAfterSecondUpdate = () => git("rev-parse", "main");

  it("TODAY (boxPatchIdWins=false, the default in every real environment): the box is STALE after an update-branch — a re-box is needed", () => {
    const v = verdictFor({ updateOid: H2, baseRefAtMint: baseAtBoxTime(), baseRefNow: baseAfterFirstUpdate(), recordRefreshedTo: H2, wins: false });
    expect(v.authorized).toBe(false);
    expect(v.authorized === false && v.reason).toBe("stale-label");
  });

  it("patch-id-wins ON + the gate refreshed the record + patch-id unchanged ⇒ the box SURVIVES", () => {
    const v = verdictFor({ updateOid: H2, baseRefAtMint: baseAtBoxTime(), baseRefNow: baseAfterFirstUpdate(), recordRefreshedTo: H2, wins: true });
    expect(v.authorized).toBe(true);
  });

  it("patch-id-wins ON but the record was NOT refreshed to the update-branch sha ⇒ stale (the refresh is load-bearing)", () => {
    const v = verdictFor({ updateOid: H2, baseRefAtMint: baseAtBoxTime(), baseRefNow: baseAfterFirstUpdate(), wins: true });
    expect(v.authorized).toBe(false);
  });

  it("patch-id-wins ON, refreshed, but base moved in a file the PR touches (patch-id changed) ⇒ stale — a re-box is needed", () => {
    const v = verdictFor({ updateOid: H3, baseRefAtMint: baseAtBoxTime(), baseRefNow: baseAfterSecondUpdate(), recordRefreshedTo: H3, wins: true });
    expect(v.authorized).toBe(false);
  });
});
