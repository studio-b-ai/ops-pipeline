/**
 * scripts/lib/box-patch-id.ts — ops-pipeline#190 rollout step 3: mints and reads back
 * the "bp2" patch-id per Kevin's ruling on board card 808 ("A", 2026-09-19 ~19:2xZ —
 * brain library/supplementary-regulations/2026-09-19-the-box-binds-to-the-patch-id.md).
 *
 * OBSERVE-ONLY THIS LAP: nothing exported from this file strips or keeps a label.
 * label-authority.ts's `boxPatchIdWins` flag defaults false and this rung never flips
 * it — see that file's Step 3 comment. This module only computes the patch-id and
 * reads back a previously-recorded one; the labeled-handler workflow records it on a
 * check run and the release check keeps evaluating the position predicate exactly as
 * before.
 *
 * Pure/impure split mirrors label-authority.ts (`evaluateLabelAuthority` vs.
 * `fetchAuthorityTimeline`): `mintBoxPatchId` and `readBoxPatchIdCheckRuns` are pure —
 * every git byte they need arrives through the injectable `GitCommandRunner` seam, so
 * no test in box-patch-id.test.ts shells out to a real git process. `defaultGitRunner`
 * is the one place that does, wired only when a caller omits `runner` and supplies
 * `repoDir` — a scratch clone the CALLER made (Rule #466: one scratch clone per repo
 * per lap; this file does not clone anything itself).
 *
 * The recipe, verbatim from the ruling:
 *
 *   BASE=$(git merge-base origin/<baseRefName> H)      // never origin/main — three
 *                                                       // open PRs stack on non-main
 *                                                       // bases
 *   G(){ GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git \
 *    -c core.attributesFile=/dev/null -c core.autocrlf=false -c core.quotePath=true \
 *    -c diff.algorithm=myers -c diff.noprefix=false -c diff.mnemonicPrefix=false \
 *    -c diff.orderFile= -c diff.renames=false "$@"; }
 *   D(){ G diff --no-color --no-ext-diff --no-textconv --no-renames -U0 "$BASE" H; }
 *   pid   = D | git patch-id --stable | cut -d' ' -f1
 *   ws    = D | sed -E 's|^@@ .*|@@|' | sed -E '/^index [0-9a-f]+\.\./d' | shasum -a 256
 *          (piped through sed with a pipe delimiter above only so this doc comment
 *          itself never embeds a literal star-slash two-character sequence; the
 *          ruling's own recipe uses an equivalent forward-slash-delimited form — see
 *          normalizeHunkHeaders below, which implements this step directly in JS
 *          rather than shelling out to sed)
 *   blobs = G diff --raw -z "$BASE" H | shasum -a 256
 *   patch-id = "bp2:" + sha256(repo \0 pr \0 head_repo \0 base_ref \0 label_event_db_id \0 pid:ws:blobs)
 *   tag   = HMAC-SHA256(patch-id, BOX_PATCH_ID_KEY)
 *
 * `set -euo pipefail` with `PIPESTATUS` checked at every pipe stage is the ruling's
 * bash framing for "no stage may fail silently"; this file is TypeScript, not a shell
 * one-liner, so the equivalent is: every git invocation is a separate, synchronous
 * `execFileSync` call, and ANY of them throwing (non-zero exit, exactly what a
 * PIPESTATUS check would catch in the shell version) is caught in one place and
 * surfaced as `box-patch-id-uncomputable` — never a partially-computed, silently-wrong
 * pid.
 */

import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";

// ───────────────────────────── constants ─────────────────────────────

/** The recipe version rides this prefix, per Rule #381 (tightening/changing the
 *  recipe is forward-only: bump this, don't silently reinterpret old records). */
export const BOX_PATCH_ID_PREFIX = "bp2:";

/** The check-run name the labeled handler creates on the head sha (ops-pipeline#190
 *  rollout step 3, item 2 in the ruling's "Where the patch-id is recorded" section). */
export const BOX_PATCH_ID_CHECK_NAME = "box-patch-id";

/** Telemetry/log-only state for a successfully-minted-but-untagged record (Open item 1
 *  declined, or BOX_PATCH_ID_KEY simply absent this lap). This is my own proposal, not
 *  the ruling's own vocabulary — the ruling names no refusal code for a missing key,
 *  only "the patch-id ships untagged and relies on the check run alone." It MUST NOT be
 *  used as a `BoxPatchIdRefusalReason` — an untagged mint is still `ok: true`. */
export const BOX_PATCH_ID_UNKEYED_STATE = "box-patch-id-unkeyed";

/** Rule #381 (tightening a guard is forward-only): the tag-ENFORCEMENT policy's own
 *  version, stamped onto every record at mint time. Distinct from BOX_PATCH_ID_PREFIX
 *  (the hash recipe's version) — this one versions readBoxPatchIdCheckRuns's rule for
 *  when an untagged record is acceptable. Bump this only when that rule changes, so a
 *  later tightening forces exactly one re-evaluation of records minted under the prior
 *  version instead of silently grandfathering them forever. */
export const BOX_PATCH_ID_VERSION = 1;

const HEX40 = /^[0-9a-f]{40}$/;
const GITATTRIBUTES_PATTERN = /(^|\/)\.gitattributes$/;

/** `-c` flags for the hermetic wrapper `G()` in the ruling's recipe. `GIT_CONFIG_GLOBAL`
 *  / `GIT_CONFIG_SYSTEM` are environment variables, not `-c` flags — set on the child
 *  process by `defaultGitRunner`, below. */
const HERMETIC_CONFIG_ARGS: readonly string[] = [
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.autocrlf=false",
  "-c", "core.quotePath=true",
  "-c", "diff.algorithm=myers",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.orderFile=",
  "-c", "diff.renames=false",
];

// ───────────────────────────── types ─────────────────────────────

export type BoxPatchIdRefusalReason =
  | "box-patch-id-uncomputable"
  | "box-patch-id-unreadable"
  | "box-patch-id-missing";

/** One `box-patch-id` check run's record, exactly the fields the ruling names:
 *  "the patch-id, the tag, the head, the base ref and sha, the numeric label event id,
 *  refresh_shas and the per-path map." The per-path map's SHAPE is unspecified by the
 *  ruling — `pathHashes` (path → the diff's raw post-image blob sha, or a sha256 of the
 *  raw diff-line metadata for a delete) is this build's proposal, left for a later rung
 *  to finalize if it disagrees; it exists to back a future "changed since the key was
 *  applied" rejection receipt (ruling §5, second example) without a second git read. */
export interface BoxPatchIdRecord {
  /** "bp2:" + 64 lowercase hex chars (sha256). */
  patchId: string;
  /** HMAC-SHA256(patchId, BOX_PATCH_ID_KEY), lowercase hex. Absent/undefined — never a
   *  refusal — when BOX_PATCH_ID_KEY wasn't configured at mint time (see
   *  BOX_PATCH_ID_UNKEYED_STATE). */
  tag?: string;
  /** BOX_PATCH_ID_VERSION at mint time — lets readBoxPatchIdCheckRuns tell a record
   *  minted under the CURRENT tag-enforcement policy (must be tagged whenever the
   *  reader has a key) from one minted under a prior, looser policy (grandfathered). */
  version: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
  labelEventDbId: number;
  /** Initialized to `[headSha]` at mint time. The refresh leg (ruling §3, rollout step
   *  4/5 — NOT this file) appends the sha of every sweep-performed refresh push. */
  refreshShas: string[];
  pathHashes: Record<string, string>;
}

export type BoxPatchIdVerdict =
  | { ok: true; record: BoxPatchIdRecord }
  | { ok: false; reason: BoxPatchIdRefusalReason; detail: string };

/** Mirrors `AuthorityTimelineQueryRunner` in label-authority.ts: the one seam between
 *  this file's logic and a real subprocess. `stdin`, when given, is piped to the
 *  command — only `patch-id --stable` needs it (the ruling's `D | git patch-id
 *  --stable`). A test supplies a fake `GitCommandRunner`; nothing in
 *  box-patch-id.test.ts ever shells out. */
export type GitCommandRunner = (args: string[], stdin?: string) => string;

export interface MintBoxPatchIdInput {
  /** "owner/repo", e.g. "studio-b-ai/ops-pipeline". */
  repo: string;
  prNumber: number;
  /** The head repo (differs from `repo` for a fork PR) — inside the hash per the
   *  ruling so "repo, pull request, base ref and label event are inside the hash." */
  headRepo: string;
  headSha: string;
  /** The PR's OWN `baseRefName` — NEVER a hardcoded "main". Three open PRs on
   *  ops-pipeline are stacked on non-main bases as of this ruling. */
  baseRef: string;
  labelEventDbId: number;
  /** The PR's changed-file paths (for the `.gitattributes` refusal check, below —
   *  checked before any git process runs). */
  changedPaths: readonly string[];
  /** Injectable seam. Omit to use `defaultGitRunner(repoDir)`. */
  runner?: GitCommandRunner;
  /** Required when `runner` is omitted — the scratch clone the caller already made
   *  (Rule #466). */
  repoDir?: string;
  /** BOX_PATCH_ID_KEY, read from the environment by the CALLER (the workflow handler),
   *  never read from `process.env` inside this library file — so a test never has to
   *  fight global process state, matching this repo's existing convention of passing
   *  secrets as explicit function params rather than reading env inline (Rule #79). */
  key?: string;
}

// ───────────────────────────── refuse-to-mint gate ─────────────────────────────

/** Refuse to mint OR honor a patch-id on any PR whose changed-path list includes a
 *  ".gitattributes" file, anywhere in the tree — the ruling's own words, checked
 *  first and unconditionally, before any git process runs or any existing check run
 *  is read. */
export function touchesGitattributes(changedPaths: readonly string[]): boolean {
  return changedPaths.some((p) => GITATTRIBUTES_PATTERN.test(p));
}

// ───────────────────────────── minting ─────────────────────────────

function normalizeHunkHeaders(diff: string): string {
  // sed -E 's/^@@ .*/@@/'  then  sed -E '/^index [0-9a-f]+\.\./d'
  return diff
    .split("\n")
    .filter((line) => !/^index [0-9a-f]+\.\./.test(line))
    .map((line) => (line.startsWith("@@ ") ? "@@" : line))
    .join("\n");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** `git diff --raw -z <base> <head>` output is NUL-separated records of the form
 *  `:<old-mode> <new-mode> <old-sha> <new-sha> <status>\0<path>\0` (renames/copies are
 *  disabled via `-c diff.renames=false` in `HERMETIC_CONFIG_ARGS`, so every record has
 *  exactly one path field, never two) — old and new sha are SPACE-separated fields,
 *  never `..`-joined (that's `git diff --raw` WITHOUT `-z`'s human-readable rendering,
 *  a different format this file never invokes). Extracts a path →
 *  post-image-blob-sha map by splitting the meta record positionally: field 0 is
 *  `:<old-mode>`, field 1 `<new-mode>`, field 2 `<old-sha>`, field 3 `<new-sha>`,
 *  field 4 `<status>`. Falls back to hashing the whole meta record only if a field is
 *  missing or not hex (defensive — the format above is stable, but this must never
 *  throw on a real git record). */
function extractPathHashes(diffRawZ: string): Record<string, string> {
  const fields = diffRawZ.split("\0").filter((f) => f.length > 0);
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const meta = fields[i];
    const path = fields[i + 1];
    if (meta === undefined || path === undefined) continue;
    const metaFields = meta.trim().split(/\s+/);
    const newBlobSha = metaFields[3];
    out[path] = newBlobSha !== undefined && /^[0-9a-f]+$/.test(newBlobSha) ? newBlobSha : sha256Hex(meta);
  }
  return out;
}

/** Wraps a real `git`, hermetically, rooted at `repoDir` — the scratch clone the
 *  caller made. Not used by any test in box-patch-id.test.ts (Rule #223's twin for
 *  I/O glue: tests inject a fake `GitCommandRunner` instead — mirrors
 *  `fetchAuthorityTimeline`'s `runQuery` param in label-authority.ts). */
export function defaultGitRunner(repoDir: string): GitCommandRunner {
  return (args: string[], stdin?: string): string => {
    return execFileSync("git", ["-C", repoDir, ...HERMETIC_CONFIG_ARGS, ...args], {
      encoding: "utf-8",
      input: stdin,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
}

/**
 * Computes the bp2 patch-id for one PR head against its own base, per the ruling's
 * exact recipe. Fail-closed doctrine matches label-authority.ts: every ambiguous,
 * empty, or errored input resolves to `ok: false`, never a best-effort guess.
 */
export function mintBoxPatchId(input: MintBoxPatchIdInput): BoxPatchIdVerdict {
  const { repo, prNumber, headRepo, headSha, baseRef, labelEventDbId, changedPaths } = input;

  if (touchesGitattributes(changedPaths)) {
    const hit = changedPaths.filter((p) => GITATTRIBUTES_PATTERN.test(p));
    return {
      ok: false,
      reason: "box-patch-id-uncomputable",
      detail: `refusing to mint — this PR touches .gitattributes (${hit.join(", ")}), which the ruling forbids categorically.`,
    };
  }

  const run: GitCommandRunner | undefined = input.runner ?? (input.repoDir ? defaultGitRunner(input.repoDir) : undefined);
  if (!run) {
    return {
      ok: false,
      reason: "box-patch-id-uncomputable",
      detail: "no GitCommandRunner and no repoDir supplied — nothing to compute the patch-id from.",
    };
  }

  let baseSha: string;
  let diffU0: string;
  let diffRawZ: string;
  let pidLine: string;
  try {
    baseSha = run(["merge-base", `origin/${baseRef}`, headSha]).trim();
    if (!HEX40.test(baseSha)) {
      return { ok: false, reason: "box-patch-id-uncomputable", detail: `merge-base against origin/${baseRef} did not return a 40-hex sha (got "${baseSha}").` };
    }
    diffU0 = run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", baseSha, headSha]);
    if (diffU0.trim().length === 0) {
      return { ok: false, reason: "box-patch-id-uncomputable", detail: "the -U0 diff between base and head is empty — an empty or errored diff must never hash to a valid patch-id." };
    }
    pidLine = run(["patch-id", "--stable"], diffU0);
    diffRawZ = run(["diff", "--raw", "-z", baseSha, headSha]);
  } catch (err) {
    // Any stage throwing (non-zero exit) is exactly what a shell PIPESTATUS check
    // would have caught — never let a later stage run on a prior stage's garbage.
    return {
      ok: false,
      reason: "box-patch-id-uncomputable",
      detail: `a git step in the recipe failed: ${err instanceof Error ? err.message : String(err)}.`,
    };
  }

  const pid = (pidLine.trim().split(/\s+/)[0] ?? "");
  if (!HEX40.test(pid)) {
    return {
      ok: false,
      reason: "box-patch-id-uncomputable",
      detail: `git patch-id --stable did not return a 40-hex pid (got "${pid || "<empty>"}").`,
    };
  }

  const ws = sha256Hex(normalizeHunkHeaders(diffU0));
  const blobs = sha256Hex(diffRawZ);
  const patchId = BOX_PATCH_ID_PREFIX + sha256Hex(
    [repo, String(prNumber), headRepo, baseRef, String(labelEventDbId), `${pid}:${ws}:${blobs}`].join("\0"),
  );
  const tag = input.key ? createHmac("sha256", input.key).update(patchId).digest("hex") : undefined;

  return {
    ok: true,
    record: {
      patchId,
      tag,
      version: BOX_PATCH_ID_VERSION,
      headSha,
      baseRef,
      baseSha,
      labelEventDbId,
      refreshShas: [headSha],
      pathHashes: extractPathHashes(diffRawZ),
    },
  };
}

/** "tagged" when a record carries a verified/unverified tag, else the telemetry-only
 *  `BOX_PATCH_ID_UNKEYED_STATE` — for a log line or the mirrored comment, never for a
 *  refusal branch (see the constant's own doc comment). */
export function boxPatchIdKeyState(record: BoxPatchIdRecord): "tagged" | typeof BOX_PATCH_ID_UNKEYED_STATE {
  return record.tag ? "tagged" : BOX_PATCH_ID_UNKEYED_STATE;
}

// ───────────────────────────── reading back a check run ─────────────────────────────

/** The slice of the Checks API's check-run shape this file needs to read one back. */
export interface CheckRunLike {
  name: string;
  output?: { text?: string | null } | null;
}

function isBoxPatchIdRecordShape(value: unknown): value is BoxPatchIdRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.patchId === "string" &&
    v.patchId.startsWith(BOX_PATCH_ID_PREFIX) &&
    (v.tag === undefined || typeof v.tag === "string") &&
    typeof v.version === "number" &&
    typeof v.headSha === "string" &&
    typeof v.baseRef === "string" &&
    typeof v.baseSha === "string" &&
    typeof v.labelEventDbId === "number" &&
    Array.isArray(v.refreshShas) &&
    v.refreshShas.every((s) => typeof s === "string") &&
    typeof v.pathHashes === "object" &&
    v.pathHashes !== null
  );
}

/**
 * Reads back the `box-patch-id` check run(s) on a sha. Fail-closed per the ruling:
 * "Two valid records, a bad tag, or an unparseable one is `box-patch-id-unreadable`.
 * A check run present with the record missing is `box-patch-id-missing`, a refusal,
 * never a silent fall back to the position predicate." `key`, when given, additionally
 * verifies a tagged record's HMAC — a mismatch is `box-patch-id-unreadable` (never
 * trust an unverifiable tag over silently accepting it).
 */
export function readBoxPatchIdCheckRuns(checkRuns: readonly CheckRunLike[], key?: string): BoxPatchIdVerdict {
  const matches = checkRuns.filter((c) => c.name === BOX_PATCH_ID_CHECK_NAME);
  if (matches.length === 0) {
    return { ok: false, reason: "box-patch-id-missing", detail: `no "${BOX_PATCH_ID_CHECK_NAME}" check run exists on this sha.` };
  }

  // Phase 1 — structural parse only (JSON.parse + shape check). "box-patch-id-missing"
  // is reserved for a check run with GENUINELY no record (no output text at all) —
  // a check run present with a record that fails to parse, or doesn't match the
  // shape, is "box-patch-id-unreadable" per the ruling ("an unparseable one is
  // box-patch-id-unreadable"), tracked separately from the true-missing case below.
  const structurallyValid: BoxPatchIdRecord[] = [];
  const noRecordProblems: string[] = [];
  const malformedProblems: string[] = [];
  for (const run of matches) {
    const text = run.output?.text ?? null;
    if (!text) {
      noRecordProblems.push("a matching check run has no output text");
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      malformedProblems.push("a matching check run's output text is not parseable JSON");
      continue;
    }
    if (!isBoxPatchIdRecordShape(json)) {
      malformedProblems.push("a matching check run's JSON does not match the box-patch-id record shape");
      continue;
    }
    structurallyValid.push(json);
  }
  const structuralProblems = [...malformedProblems, ...noRecordProblems];

  if (structurallyValid.length === 0) {
    if (malformedProblems.length > 0) {
      return {
        ok: false,
        reason: "box-patch-id-unreadable",
        detail: `a "${BOX_PATCH_ID_CHECK_NAME}" check run is present but its record could not be read: ${structuralProblems.join("; ")}.`,
      };
    }
    return {
      ok: false,
      reason: "box-patch-id-missing",
      detail: `a "${BOX_PATCH_ID_CHECK_NAME}" check run is present but no record was found: ${structuralProblems.join("; ")}.`,
    };
  }

  // Phase 2 — at least one structurally-valid record exists. Anything short of
  // "exactly one match, exactly one structurally-valid record, and (if a key was
  // given) its tag verifies" is now "found something, can't trust which" —
  // box-patch-id-unreadable, never a silent pick-one. A tag that fails HMAC
  // verification lands here too: the record was found, its integrity check failed.
  // An UNTAGGED record with a key present is honored only when it predates the
  // current tag-enforcement version — Rule #381: tightening is forward-only, so a
  // record minted under BOX_PATCH_ID_VERSION (this build's policy: must be tagged
  // whenever the reader has a key) gets exactly one re-evaluation, and is pruned
  // (not silently grandfathered) when it fails that re-evaluation.
  const tagProblems: string[] = [];
  const verified: BoxPatchIdRecord[] = [];
  for (const record of structurallyValid) {
    if (key && record.tag !== undefined) {
      const expected = createHmac("sha256", key).update(record.patchId).digest("hex");
      if (record.tag !== expected) {
        tagProblems.push(`a record's tag does not verify against BOX_PATCH_ID_KEY (patchId ${record.patchId})`);
        continue;
      }
    } else if (key && record.tag === undefined && record.version >= BOX_PATCH_ID_VERSION) {
      tagProblems.push(
        `a record minted under the current tag-enforcement version (${record.version}) has no tag even though BOX_PATCH_ID_KEY is configured (patchId ${record.patchId}) — a live key does not honor an untagged record.`,
      );
      continue;
    }
    verified.push(record);
  }

  if (matches.length > 1 || structuralProblems.length > 0 || tagProblems.length > 0 || verified.length === 0) {
    return {
      ok: false,
      reason: "box-patch-id-unreadable",
      detail: `${matches.length} "${BOX_PATCH_ID_CHECK_NAME}" check run(s) found; ${verified.length} verified cleanly, ${structuralProblems.length} unparseable, ${tagProblems.length} failed tag verification — ambiguous or untrustworthy, refusing rather than guessing which record is authoritative.`,
    };
  }

  return { ok: true, record: verified[0]! };
}

// ───────────────────────────── explicitly out of scope this lap ─────────────────────────────

/**
 * The refresh leg (ruling §3 "Authority and refresh": recompute-on-`behind_by`,
 * `update-branch` polling, `refresh_shas` appending, `base-changed`/`base-moved`
 * detection, `BOX_PATCH_ID_MAX_BEHIND=2000`) is rollout step 4/5, not this PR's scope
 * (ops-pipeline#190 rollout step 3, observe-only). This export exists only so the
 * surface is visible to a future rung; nothing in this build calls it.
 */
export function refreshBoxPatchId(): never {
  throw new Error("refreshBoxPatchId is not implemented in ops-pipeline#190 rung 3 (observe-only) — see ruling §3, rollout step 4/5.");
}
