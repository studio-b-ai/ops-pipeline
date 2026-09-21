import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOX_PATCH_ID_CHECK_NAME,
  BOX_PATCH_ID_PREFIX,
  BOX_PATCH_ID_UNKEYED_STATE,
  BOX_PATCH_ID_VERSION,
  boxPatchIdKeyState,
  buildBoxPatchIdContext,
  defaultGitRunner,
  mintBoxPatchId,
  readBoxPatchIdCheckRuns,
  refreshBoxPatchId,
  touchesGitattributes,
  type BoxPatchIdContext,
  type BoxPatchIdRecord,
  type BuildBoxPatchIdContextInput,
  type CheckRunLike,
  type GitCommandRunner,
  type MintBoxPatchIdInput,
} from "../box-patch-id.js";

const VALID_PID = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);

const SAMPLE_DIFF_U0 =
  "diff --git a/foo.ts b/foo.ts\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/foo.ts\n" +
  "+++ b/foo.ts\n" +
  "@@ -1,1 +1,1 @@\n" +
  "-old\n" +
  "+new\n";

const SAMPLE_DIFF_RAW_Z =
  ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0foo.ts\0";

/**
 * A real git process's non-zero exit is what a bad/unconfigured call would surface
 * as, so an unconfigured lookup throws rather than returning "" — matching the
 * production failure mode this fake stands in for. Every call is recorded so a test
 * can assert exactly what argv the mint function issued (e.g. that merge-base was
 * run against the PR's own base, never a hardcoded origin/main).
 */
function fakeRunner(
  replies: Record<string, string>,
  calls: { args: string[]; stdin?: string }[] = [],
): GitCommandRunner {
  return (args: string[], stdin?: string): string => {
    calls.push({ args, stdin });
    const key = args.join(" ");
    for (const [prefix, value] of Object.entries(replies)) {
      if (key.startsWith(prefix)) return value;
    }
    throw new Error(`fakeRunner: no reply configured for "git ${key}" — treated as a real git non-zero exit.`);
  };
}

function repliesFor(pid = VALID_PID, diffU0 = SAMPLE_DIFF_U0, diffRawZ = SAMPLE_DIFF_RAW_Z): Record<string, string> {
  return {
    "merge-base": `${BASE_SHA}\n`,
    "diff --no-color --no-ext-diff --no-textconv --no-renames -U0": diffU0,
    "patch-id --stable": `${pid} ${HEAD_SHA}\n`,
    "diff --raw -z": diffRawZ,
  };
}

function baseMintInput(overrides: Partial<MintBoxPatchIdInput> = {}): MintBoxPatchIdInput {
  return {
    repo: "studio-b-ai/ops-pipeline",
    prNumber: 807,
    headRepo: "studio-b-ai/ops-pipeline",
    headSha: HEAD_SHA,
    baseRef: "tp/807-box-patch-id-base",
    labelEventDbId: 424242,
    changedPaths: ["scripts/lib/box-patch-id.ts"],
    ...overrides,
  };
}

describe("mintBoxPatchId", () => {
  it("known-GOOD: a clean diff mints a bp2 patch-id keyed by repo/pr/base/label-event and tags it", () => {
    const verdict = mintBoxPatchId({ ...baseMintInput(), runner: fakeRunner(repliesFor()), key: "test-key" });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.record.patchId.startsWith(BOX_PATCH_ID_PREFIX)).toBe(true);
    expect(verdict.record.patchId.length).toBe(BOX_PATCH_ID_PREFIX.length + 64);
    expect(verdict.record.baseSha).toBe(BASE_SHA);
    expect(verdict.record.headSha).toBe(HEAD_SHA);
    expect(verdict.record.refreshShas).toEqual([HEAD_SHA]);
    expect(verdict.record.tag).toBe(createHmac("sha256", "test-key").update(verdict.record.patchId).digest("hex"));
    expect(boxPatchIdKeyState(verdict.record)).toBe("tagged");
    expect(verdict.record.version).toBe(BOX_PATCH_ID_VERSION);
  });

  it("known-GOOD: pathHashes maps each changed path to its post-image blob sha, parsed positionally from the raw -z record (not the '..'-joined form that only appears in --raw WITHOUT -z)", () => {
    const verdict = mintBoxPatchId({ ...baseMintInput(), runner: fakeRunner(repliesFor()) });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    // SAMPLE_DIFF_RAW_Z: ":100644 100644 <old 40x'1'> <new 40x'2'> M\0foo.ts\0" — field 3
    // (0-indexed) is the new/post-image blob sha.
    expect(verdict.record.pathHashes).toEqual({ "foo.ts": "2".repeat(40) });
  });

  it("negative control: BOX_PATCH_ID_KEY absent still mints successfully and returns the record UNTAGGED — never a refusal", () => {
    const verdict = mintBoxPatchId({ ...baseMintInput(), runner: fakeRunner(repliesFor()) });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.record.tag).toBeUndefined();
    expect(boxPatchIdKeyState(verdict.record)).toBe(BOX_PATCH_ID_UNKEYED_STATE);
  });

  it("known-BAD, control: a non-hex/short pid from git patch-id refuses as box-patch-id-uncomputable", () => {
    const verdict = mintBoxPatchId({ ...baseMintInput(), runner: fakeRunner(repliesFor("not-a-real-pid")) });
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-uncomputable" });
  });

  it("known-BAD, control: an empty -U0 diff refuses as box-patch-id-uncomputable, never a hollow patch-id", () => {
    const verdict = mintBoxPatchId({ ...baseMintInput(), runner: fakeRunner(repliesFor(VALID_PID, "   \n")) });
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-uncomputable" });
  });

  it("known-BAD, control: a merge-base result that isn't a 40-hex sha refuses as box-patch-id-uncomputable", () => {
    const verdict = mintBoxPatchId({
      ...baseMintInput(),
      runner: fakeRunner({ ...repliesFor(), "merge-base": "fatal: ambiguous argument 'H'\n" }),
    });
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-uncomputable" });
  });

  it("known-BAD, control: a PR touching .gitattributes is refused to mint, before any git call runs", () => {
    const calls: { args: string[] }[] = [];
    const runner = fakeRunner(repliesFor(), calls);
    const verdict = mintBoxPatchId({
      ...baseMintInput({ changedPaths: ["scripts/lib/box-patch-id.ts", ".gitattributes"] }),
      runner,
    });
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-uncomputable" });
    expect(calls.length).toBe(0);
  });

  it("touchesGitattributes: matches a nested path, not just a repo-root one, and doesn't false-positive on a lookalike name", () => {
    expect(touchesGitattributes(["a/b/.gitattributes"])).toBe(true);
    expect(touchesGitattributes([".gitattributes"])).toBe(true);
    expect(touchesGitattributes(["a/b/notgitattributes", "a/.gitattributes.bak"])).toBe(false);
  });

  it("known-GOOD: merge-base is computed against the PR's OWN baseRefName, never a hardcoded origin/main", () => {
    const calls: { args: string[] }[] = [];
    const runner = fakeRunner(repliesFor(), calls);
    mintBoxPatchId({ ...baseMintInput({ baseRef: "release/2026.09" }), runner });
    const mergeBaseCall = calls.find((c) => c.args[0] === "merge-base");
    expect(mergeBaseCall?.args).toEqual(["merge-base", "origin/release/2026.09", HEAD_SHA]);
    expect(mergeBaseCall?.args).not.toContain("origin/main");
  });

  it("control: a git step throwing (the PIPESTATUS-equivalent non-zero exit) surfaces as box-patch-id-uncomputable, never a truncated pid", () => {
    const runner: GitCommandRunner = (args) => {
      if (args[0] === "merge-base") throw new Error("fatal: no merge base (simulated non-zero exit)");
      return "";
    };
    const verdict = mintBoxPatchId({ ...baseMintInput(), runner });
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-uncomputable" });
  });

  it("known-GOOD: replaying the identical diff onto a different PR number never produces the same patch-id or tag", () => {
    const a = mintBoxPatchId({ ...baseMintInput({ prNumber: 807 }), runner: fakeRunner(repliesFor()), key: "test-key" });
    const b = mintBoxPatchId({ ...baseMintInput({ prNumber: 999 }), runner: fakeRunner(repliesFor()), key: "test-key" });
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.record.patchId).not.toBe(b.record.patchId);
    expect(a.record.tag).not.toBe(b.record.tag);
  });

  it("known-GOOD: replaying the identical diff onto a different label-event id never produces the same patch-id", () => {
    const a = mintBoxPatchId({ ...baseMintInput({ labelEventDbId: 1 }), runner: fakeRunner(repliesFor()) });
    const b = mintBoxPatchId({ ...baseMintInput({ labelEventDbId: 2 }), runner: fakeRunner(repliesFor()) });
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.record.patchId).not.toBe(b.record.patchId);
  });
});

describe("readBoxPatchIdCheckRuns", () => {
  function goodRecord(overrides: Partial<BoxPatchIdRecord> = {}): BoxPatchIdRecord {
    return {
      patchId: `${BOX_PATCH_ID_PREFIX}${"d".repeat(64)}`,
      version: BOX_PATCH_ID_VERSION,
      headSha: HEAD_SHA,
      baseRef: "tp/807-box-patch-id-base",
      baseSha: BASE_SHA,
      labelEventDbId: 424242,
      refreshShas: [HEAD_SHA],
      pathHashes: {},
      ...overrides,
    };
  }
  function runWith(record: unknown): CheckRunLike {
    return { name: BOX_PATCH_ID_CHECK_NAME, output: { text: typeof record === "string" ? record : JSON.stringify(record) } };
  }

  it("known-GOOD: a single well-formed record on the sha reads back ok", () => {
    const verdict = readBoxPatchIdCheckRuns([runWith(goodRecord())]);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.record.labelEventDbId).toBe(424242);
  });

  it("negative control: a differently-named check run on the same sha is invisible to the reader — no box-patch-id run at all is box-patch-id-missing", () => {
    const verdict = readBoxPatchIdCheckRuns([{ name: "Scripts — typecheck + tests", output: { text: "ok" } }]);
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-missing" });
  });

  it("known-BAD: a box-patch-id check run present with unparseable JSON is box-patch-id-unreadable, never box-patch-id-missing (a record was found, it just can't be trusted)", () => {
    const verdict = readBoxPatchIdCheckRuns([runWith("{not json")]);
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-unreadable" });
  });

  it("known-BAD: a box-patch-id check run with no output text at all is box-patch-id-missing", () => {
    const verdict = readBoxPatchIdCheckRuns([{ name: BOX_PATCH_ID_CHECK_NAME, output: { text: null } }]);
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-missing" });
  });

  it("known-BAD, control: two valid records on the same sha is box-patch-id-unreadable — ambiguous, never pick one", () => {
    const verdict = readBoxPatchIdCheckRuns([runWith(goodRecord()), runWith(goodRecord({ labelEventDbId: 555 }))]);
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-unreadable" });
  });

  // ─────── amendment 8 ("a re-box must not poison the PR forever") ───────
  // These fixtures replay the exact scenarios above but supply a 3rd
  // `currentLabelEventDbId` argument — every test above them passes only 2 args and
  // must keep behaving identically (proven by the fact that they were not touched).

  it("amendment 8: with currentLabelEventDbId, the two-records ambiguity above resolves to the ONE record minted for the current labeling instead of refusing", () => {
    const verdict = readBoxPatchIdCheckRuns(
      [runWith(goodRecord()), runWith(goodRecord({ labelEventDbId: 555 }))],
      undefined,
      555,
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.record.labelEventDbId).toBe(555);
  });

  it("amendment 8: a SINGLE record left over from an earlier box/unbox cycle (a different labelEventDbId) reads as box-patch-id-missing for the current labeling, never as that stale record", () => {
    const verdict = readBoxPatchIdCheckRuns([runWith(goodRecord({ labelEventDbId: 111111 }))], undefined, 424242);
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-missing" });
  });

  it("amendment 8: two records that BOTH carry the current labelEventDbId (a genuine duplicate) still refuse as ambiguous", () => {
    const verdict = readBoxPatchIdCheckRuns(
      [runWith(goodRecord({ patchId: `${BOX_PATCH_ID_PREFIX}${"1".repeat(64)}` })), runWith(goodRecord({ patchId: `${BOX_PATCH_ID_PREFIX}${"2".repeat(64)}` }))],
      undefined,
      424242,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-unreadable" });
    if (!verdict.ok) expect(verdict.detail).toMatch(/share the current LabeledEvent databaseId/);
  });

  it("amendment 8: a malformed record alongside a clean one for the current labeling still fails closed (narrowing never forgives a structural problem)", () => {
    const verdict = readBoxPatchIdCheckRuns([runWith(goodRecord()), runWith("{not json")], undefined, 424242);
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-unreadable" });
  });

  it("amendment 8: omitting currentLabelEventDbId reproduces the pre-amendment-8 single-record behavior even when its labelEventDbId would not have matched anything", () => {
    const verdict = readBoxPatchIdCheckRuns([runWith(goodRecord({ labelEventDbId: 111111 }))]);
    expect(verdict.ok).toBe(true);
  });

  it("known-BAD, control: a tag that fails HMAC verification against BOX_PATCH_ID_KEY is box-patch-id-unreadable", () => {
    const record = goodRecord({ tag: "0".repeat(64) });
    const verdict = readBoxPatchIdCheckRuns([runWith(record)], "test-key");
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-unreadable" });
  });

  it("known-GOOD: a tag that DOES verify against BOX_PATCH_ID_KEY reads back ok (the tag-check's positive control)", () => {
    const record = goodRecord();
    const tag = createHmac("sha256", "test-key").update(record.patchId).digest("hex");
    const verdict = readBoxPatchIdCheckRuns([runWith({ ...record, tag })], "test-key");
    expect(verdict.ok).toBe(true);
  });

  it("known-GOOD: a tagged record reads back ok when no key is supplied — verification is skipped, not failed", () => {
    const record = goodRecord({ tag: "f".repeat(64) });
    const verdict = readBoxPatchIdCheckRuns([runWith(record)]);
    expect(verdict.ok).toBe(true);
  });

  it("known-BAD, control: an untagged record minted under the current tag-enforcement version is box-patch-id-unreadable when BOX_PATCH_ID_KEY IS supplied — a live key does not honor an untagged record (Rule #381, finding 5)", () => {
    const record = goodRecord(); // tag left undefined, version defaults to BOX_PATCH_ID_VERSION
    const verdict = readBoxPatchIdCheckRuns([runWith(record)], "test-key");
    expect(verdict).toMatchObject({ ok: false, reason: "box-patch-id-unreadable" });
  });
});

// ───────────── defaultGitRunner against a REAL git (the one seam the fakes never touch) ─────────────

/** A throwaway repo with two commits: `base` has foo.ts=old, `head` has foo.ts=new. Identity
 *  and config come from env only, so the test is as hermetic as the runner it exercises. */
function tempRepoWithTwoCommits(): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "box-patch-id-realgit-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", env, stdio: ["pipe", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "foo.ts"), "old\n");
  git("add", "foo.ts");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "foo.ts"), "new\n");
  git("commit", "-q", "-am", "head");
  const head = git("rev-parse", "HEAD").trim();
  return { dir, base, head };
}

const RECIPE_DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0"];

describe("defaultGitRunner (real git)", () => {
  it("known-GOOD: every hermetic -c flag is accepted by a real git and the -U0 diff comes back (2026-09-20 live fatal on `diff.orderFile=` — run 35527162406)", () => {
    const { dir, base, head } = tempRepoWithTwoCommits();
    try {
      const out = defaultGitRunner(dir)([...RECIPE_DIFF_ARGS, base, head]);
      expect(out).toContain("-old");
      expect(out).toContain("+new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("known-BAD, control: the empty-string form `-c diff.orderFile=` is what git refuses, so the test above can tell the two apart (Rule #322)", () => {
    const { dir, base, head } = tempRepoWithTwoCommits();
    try {
      expect(() =>
        execFileSync("git", ["-C", dir, "-c", "diff.orderFile=", ...RECIPE_DIFF_ARGS, base, head], {
          encoding: "utf-8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ).toThrow(/orderfile/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────── ops-pipeline#190 rollout step 5 (the patch-id-wins flip) ─────────────────

describe("refreshBoxPatchId", () => {
  function baseRecord(overrides: Partial<BoxPatchIdRecord> = {}): BoxPatchIdRecord {
    return {
      patchId: `${BOX_PATCH_ID_PREFIX}${"d".repeat(64)}`,
      version: BOX_PATCH_ID_VERSION,
      headSha: HEAD_SHA,
      baseRef: "tp/807-box-patch-id-base",
      baseSha: BASE_SHA,
      labelEventDbId: 424242,
      refreshShas: [HEAD_SHA],
      pathHashes: {},
      ...overrides,
    };
  }
  const NEW_HEAD_SHA = "e".repeat(40);

  it("known-GOOD: appends the new head sha to refreshShas and updates headSha, leaving every other field untouched", () => {
    const record = baseRecord();
    const refreshed = refreshBoxPatchId(record, NEW_HEAD_SHA);
    expect(refreshed).toEqual({ ...record, headSha: NEW_HEAD_SHA, refreshShas: [HEAD_SHA, NEW_HEAD_SHA] });
  });

  it("is append-only: the patchId, tag, baseRef, baseSha, labelEventDbId and pathHashes never change", () => {
    const record = baseRecord({ tag: "f".repeat(64) });
    const refreshed = refreshBoxPatchId(record, NEW_HEAD_SHA);
    expect(refreshed.patchId).toBe(record.patchId);
    expect(refreshed.tag).toBe(record.tag);
    expect(refreshed.baseRef).toBe(record.baseRef);
    expect(refreshed.baseSha).toBe(record.baseSha);
    expect(refreshed.labelEventDbId).toBe(record.labelEventDbId);
    expect(refreshed.pathHashes).toBe(record.pathHashes);
  });

  it("dedups: refreshing twice against the same sha (a retried PATCH) does not grow refreshShas a second time", () => {
    const record = baseRecord();
    const once = refreshBoxPatchId(record, NEW_HEAD_SHA);
    const twice = refreshBoxPatchId(once, NEW_HEAD_SHA);
    expect(twice.refreshShas).toEqual([HEAD_SHA, NEW_HEAD_SHA]);
  });

  it("known-BAD: throws on a newHeadSha that is not a 40-hex sha, rather than silently recording garbage", () => {
    expect(() => refreshBoxPatchId(baseRecord(), "not-a-sha")).toThrow(/40-hex sha/);
  });
});

describe("buildBoxPatchIdContext", () => {
  function goodRecord(overrides: Partial<BoxPatchIdRecord> = {}): BoxPatchIdRecord {
    return {
      patchId: `${BOX_PATCH_ID_PREFIX}${"d".repeat(64)}`,
      version: BOX_PATCH_ID_VERSION,
      headSha: HEAD_SHA,
      baseRef: "tp/807-box-patch-id-base",
      baseSha: BASE_SHA,
      labelEventDbId: 424242,
      refreshShas: [HEAD_SHA],
      pathHashes: {},
      ...overrides,
    };
  }
  function runWith(record: unknown): CheckRunLike {
    return { name: BOX_PATCH_ID_CHECK_NAME, output: { text: typeof record === "string" ? record : JSON.stringify(record) } };
  }
  function baseContextInput(overrides: Partial<BuildBoxPatchIdContextInput> = {}): BuildBoxPatchIdContextInput {
    return {
      checkRuns: [runWith(goodRecord())],
      currentLabelEventDbId: 424242,
      repo: "studio-b-ai/ops-pipeline",
      prNumber: 807,
      headRepo: "studio-b-ai/ops-pipeline",
      headSha: HEAD_SHA,
      changedPaths: ["scripts/lib/box-patch-id.ts"],
      ...overrides,
    };
  }

  it("known-GOOD: recorded and current agree when the mint recomputes to the SAME patch-id (mint is deterministic on identical inputs)", () => {
    // Mint once, up front, to learn the exact patchId this recipe produces for these
    // inputs — then record THAT id, so the assertion below is a real equality check
    // against a freshly-computed value, never a hardcoded guess at the hash.
    const minted = mintBoxPatchId(baseMintInput({ runner: fakeRunner(repliesFor()), labelEventDbId: 424242, baseRef: "tp/807-box-patch-id-base" }));
    if (!minted.ok) throw new Error("unreachable: fixture mint must succeed");

    const runner = fakeRunner(repliesFor());
    const context = buildBoxPatchIdContext(
      baseContextInput({
        checkRuns: [runWith(goodRecord({ patchId: minted.record.patchId, baseRef: "tp/807-box-patch-id-base", labelEventDbId: 424242 }))],
        runner,
      }),
    );
    expect(context.failure).toBeUndefined();
    expect(context.recordedPatchId).toBe(minted.record.patchId);
    expect(context.currentPatchId).toBe(minted.record.patchId);
    expect(context.recordedPatchId).toBe(context.currentPatchId);
  });

  it("recomputes against the RECORDED record's own baseRef/labelEventDbId, never the caller's — a differing recorded labelEventDbId still recomputes under that recorded id", () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const runner = fakeRunner(repliesFor(), calls);
    buildBoxPatchIdContext(
      baseContextInput({
        checkRuns: [runWith(goodRecord({ baseRef: "tp/some-other-base", labelEventDbId: 999999 }))],
        currentLabelEventDbId: 999999,
        runner,
      }),
    );
    const mergeBaseCall = calls.find((c) => c.args[0] === "merge-base");
    expect(mergeBaseCall?.args).toEqual(["merge-base", "origin/tp/some-other-base", HEAD_SHA]);
  });

  it("known-BAD: surfaces the read step's refusal as an explicit `failure`, never a silent empty context (amendment 7)", () => {
    const context = buildBoxPatchIdContext(baseContextInput({ checkRuns: [runWith("{not json")] }));
    expect(context).toEqual({ failure: "box-patch-id-unreadable" });
  });

  it("grandfathering: no record at all for the current labeling is box-patch-id-missing, carried straight through as `failure`", () => {
    const context = buildBoxPatchIdContext(baseContextInput({ checkRuns: [] }));
    expect(context).toEqual({ failure: "box-patch-id-missing" });
  });

  it("known-BAD: a record found but the CURRENT mint is uncomputable (e.g. a .gitattributes-touching diff) surfaces `failure` while still carrying the recordedPatchId and refreshShas", () => {
    const context = buildBoxPatchIdContext(
      baseContextInput({
        checkRuns: [runWith(goodRecord({ refreshShas: [HEAD_SHA, "f".repeat(40)] }))],
        changedPaths: [".gitattributes"],
      }),
    );
    expect(context.failure).toBe("box-patch-id-uncomputable");
    expect(context.recordedPatchId).toBeDefined();
    expect(context.currentPatchId).toBeUndefined();
    expect(context.refreshShas).toEqual([HEAD_SHA, "f".repeat(40)]);
  });

  it("amendment 8 wiring: a re-box's stale leftover record (different labelEventDbId) surfaces box-patch-id-missing via the narrowing, not a mismatched comparison", () => {
    const context = buildBoxPatchIdContext(
      baseContextInput({
        checkRuns: [runWith(goodRecord({ labelEventDbId: 111111 }))],
        currentLabelEventDbId: 424242,
      }),
    );
    expect(context).toEqual({ failure: "box-patch-id-missing" });
  });

  it("passes the recorded refreshShas straight through on a successful comparison", () => {
    const runner = fakeRunner(repliesFor());
    const context = buildBoxPatchIdContext(
      baseContextInput({ checkRuns: [runWith(goodRecord({ refreshShas: [HEAD_SHA, "e".repeat(40)] }))], runner }),
    );
    expect(context.refreshShas).toEqual([HEAD_SHA, "e".repeat(40)]);
  });
});
