// scripts/lib/box-patch-id-observe.ts
//
// ops-pipeline#807 rollout step 4 — the box-patch-id-observe lap.
//
// This module computes the observe-only verdict by REUSING the existing exports of
// scripts/lib/box-patch-id.ts and scripts/lib/label-authority.ts — it adds no new patch-id math
// and no new authority predicate of its own (import, never re-implement).
//
// mode=mint-dry (plan section E, built by crew mechanic stint #865) dispatches
// mintBoxPatchId directly with a head_sha_override without reading any recorded check run —
// see scripts/box-patch-id-controls/control-5-nonexistent-ref.zsh for the consumer contract.
// Mode=observe reads the recorded box-patch-id check run and compares; mode=mint-dry mints
// the patch-id for a caller-supplied override sha directly.

import {
  BOX_PATCH_ID_CHECK_NAME,
  mintBoxPatchId,
  readBoxPatchIdCheckRuns,
  type BoxPatchIdRecord,
  type BoxPatchIdRefusalReason,
  type CheckRunLike,
  type GitCommandRunner,
} from "./box-patch-id.js";
import { evaluateLabelAuthority, resolveAuthorityLogins, type AuthorityTimelineItem } from "./label-authority.js";

/** The check run this build writes, on the PR's CURRENT head, every lap. Never conflated with
 *  BOX_PATCH_ID_CHECK_NAME ("box-patch-id"), which is the RECORDED check run this build only
 *  reads. */
export const BOX_PATCH_ID_OBSERVE_CHECK_NAME = "box-patch-id-observe";

export const SUPPORTED_OBSERVE_MODES = ["observe", "mint-dry"] as const;
export type SupportedObserveMode = (typeof SUPPORTED_OBSERVE_MODES)[number];

export type ObserveVerdict = "kept" | "stripped" | BoxPatchIdRefusalReason | "box-patch-id-observe-unsupported-mode";

export interface ShaWithCheckRuns {
  sha: string;
  checkRuns: readonly CheckRunLike[];
}

export interface ObserveBoxPatchIdInput {
  repo: string;
  prNumber: number;
  /** The control-kit's <n> (a control number, e.g. "3") or "n/a" outside the control kit. Passed
   *  through verbatim into the stdout line — this module assigns it no meaning of its own. */
  control: string;
  /** Raw mode string from the workflow_dispatch input. Anything other than "observe" fails closed
   *  (verdict box-patch-id-observe-unsupported-mode) rather than silently falling back to observe. */
  mode: string;
  /** GITHUB_RUN_ID, or a caller-supplied stand-in outside Actions. */
  runId: string;
  headSha: string;
  /** For mode=mint-dry only: the override SHA to mint against (a nonexistent ref, typically a blob
   *  oid produced by `git hash-object --stdin`). When present and mode is "mint-dry",
   *  mintBoxPatchId is called with this as headSha instead of the PR's real headRefOid. The PR's
   *  real headSha is still used for the check-run API call (GitHub rejects a nonexistent head_sha). */
  headShaOverride?: string;
  headRepo: string;
  baseRef: string;
  changedPaths: readonly string[];
  /** Every commit on the PR, OLDEST FIRST, each carrying whatever check runs GitHub has recorded
   *  for it. Used to (a) locate the sha that carries the recorded "box-patch-id" check run and
   *  (b) compute movedShas — every sha strictly after that one. */
  shasWithCheckRuns: readonly ShaWithCheckRuns[];
  key?: string;
  repoDir?: string;
  runner?: GitCommandRunner;
  /** Optional — when given, exercises label-authority.ts's EXISTING observe-only log branch
   *  (evaluateLabelAuthority logs which way the patch-id predicate leans; it never changes the
   *  verdict this function returns — that flip is gated behind boxPatchIdWins, which nothing sets
   *  true yet). Omit entirely in callers that have no timeline to hand it. */
  authorityTimeline?: readonly AuthorityTimelineItem[];
  currentLabels?: readonly string[];
  authorityLogins?: readonly string[];
  truncated?: boolean;
}

export interface ObserveBoxPatchIdResult {
  verdict: ObserveVerdict;
  recordedPatchId: string | null;
  currentPatchId: string | null;
  recordedSha: string | null;
  movedShas: string[];
  unrefreshedShas: string[];
  record: BoxPatchIdRecord | null;
  /** For mint-dry, the override SHA used for the mint call (absent for observe mode). */
  headShaOverride: string | null;
  /** The EXACT required stdout line — callers print this verbatim, never reformat it. */
  line: string;
}

function findRecordedCheckRun(
  shasWithCheckRuns: readonly ShaWithCheckRuns[],
  key: string | undefined,
): { sha: string; index: number; verdict: ReturnType<typeof readBoxPatchIdCheckRuns> } | null {
  // Walk newest-to-oldest (input is oldest-first) so a re-recorded run on a later sha wins.
  for (let i = shasWithCheckRuns.length - 1; i >= 0; i--) {
    const entry = shasWithCheckRuns[i];
    const hasNamed = entry.checkRuns.some((cr) => cr.name === BOX_PATCH_ID_CHECK_NAME);
    if (!hasNamed) continue;
    return { sha: entry.sha, index: i, verdict: readBoxPatchIdCheckRuns(entry.checkRuns, key) };
  }
  return null;
}

function formatLine(input: ObserveBoxPatchIdInput, verdict: ObserveVerdict, recordedPatchId: string | null, currentPatchId: string | null, unrefreshedShas: readonly string[], movedShas: readonly string[]): string {
  const override = input.headShaOverride ? ` overridden=${input.headShaOverride}` : "";
  return (
    `[box-patch-id observe-only] control=${input.control} repo=${input.repo} pr=${input.prNumber} ` +
    `mode=${input.mode}${override} recorded=${recordedPatchId ?? "none"} current=${currentPatchId ?? "none"} ` +
    `verdict=${verdict} unrefreshed=[${unrefreshedShas.join(",")}] moved=[${movedShas.join(",")}] run=${input.runId}`
  );
}

/** Reads the recorded box-patch-id check run and the PR's current head, and computes the observe
 *  verdict entirely through box-patch-id.ts + label-authority.ts's existing exports. Never throws
 *  for well-typed input — every predicate short-circuit is returned as a typed verdict word. */
export function observeBoxPatchId(input: ObserveBoxPatchIdInput): ObserveBoxPatchIdResult {
  const emit = (
    verdict: ObserveVerdict,
    extra: Partial<{
      recordedPatchId: string | null;
      currentPatchId: string | null;
      recordedSha: string | null;
      movedShas: string[];
      unrefreshedShas: string[];
      record: BoxPatchIdRecord | null;
    }> = {},
  ): ObserveBoxPatchIdResult => {
    const recordedPatchId = extra.recordedPatchId ?? null;
    const currentPatchId = extra.currentPatchId ?? null;
    const movedShas = extra.movedShas ?? [];
    const unrefreshedShas = extra.unrefreshedShas ?? [];
    return {
      verdict,
      recordedPatchId,
      currentPatchId,
      recordedSha: extra.recordedSha ?? null,
      movedShas,
      unrefreshedShas,
      record: extra.record ?? null,
      headShaOverride: input.headShaOverride ?? null,
      line: formatLine(input, verdict, recordedPatchId, currentPatchId, unrefreshedShas, movedShas),
    };
  };

  if (input.mode === "mint-dry") {
    const mintHeadSha = input.headShaOverride;
    if (!mintHeadSha) {
      return emit("box-patch-id-observe-unsupported-mode");
    }

    const mintVerdict = mintBoxPatchId({
      repo: input.repo,
      prNumber: input.prNumber,
      headRepo: input.headRepo,
      headSha: mintHeadSha,
      baseRef: input.baseRef,
      labelEventDbId: 0, // no label event — this PR was never boxed
      changedPaths: input.changedPaths,
      repoDir: input.repoDir,
      runner: input.runner,
      key: input.key,
    });

    if (!mintVerdict.ok) {
      return emit(mintVerdict.reason, {
        recordedPatchId: null,
        currentPatchId: null,
        movedShas: [],
        unrefreshedShas: [],
      });
    }

    return emit("kept", {
      recordedPatchId: null,
      currentPatchId: mintVerdict.record.patchId,
      movedShas: [],
      unrefreshedShas: [],
      record: mintVerdict.record,
    });
  }

  if (input.mode !== "observe") {
    return emit("box-patch-id-observe-unsupported-mode");
  }

  const found = findRecordedCheckRun(input.shasWithCheckRuns, input.key);
  if (!found || !found.verdict.ok) {
    const reason: BoxPatchIdRefusalReason = found && !found.verdict.ok ? found.verdict.reason : "box-patch-id-missing";
    return emit(reason);
  }

  const record = found.verdict.record;
  const movedShas = input.shasWithCheckRuns.slice(found.index + 1).map((e) => e.sha);

  // Recompute the CURRENT patch-id via the SAME recipe, holding the recorded labelEventDbId fixed
  // (asking "same label event, does the diff still match" — never a fresh label event's id).
  const currentVerdict = mintBoxPatchId({
    repo: input.repo,
    prNumber: input.prNumber,
    headRepo: input.headRepo,
    headSha: input.headSha,
    baseRef: input.baseRef,
    labelEventDbId: record.labelEventDbId,
    changedPaths: input.changedPaths,
    repoDir: input.repoDir,
    runner: input.runner,
    key: input.key,
  });

  if (!currentVerdict.ok) {
    return emit(currentVerdict.reason, { recordedPatchId: record.patchId, recordedSha: found.sha, movedShas, record });
  }

  const currentPatchId = currentVerdict.record.patchId;
  // Rule #223 target scenario (control 6, finding 4.0.1): patch-id equality ALONE is not
  // sufficient — a moved sha absent from the recorded record's refreshShas means the refresh-shas
  // leg was skipped, even when the net diff is byte-identical.
  const unrefreshedShas = movedShas.filter((sha) => !record.refreshShas.includes(sha));
  const patchIdAgrees = currentPatchId === record.patchId;
  const refreshLegClean = movedShas.length === 0 || unrefreshedShas.length === 0;
  const verdict: ObserveVerdict = patchIdAgrees && refreshLegClean ? "kept" : "stripped";

  if (input.authorityTimeline) {
    // Exercise (never re-implement) label-authority's existing observe-only log branch. It only
    // logs which way the patch-id predicate leans; boxPatchIdWins is intentionally omitted here —
    // nothing sets it true yet, so this call can never change the verdict returned above.
    evaluateLabelAuthority({
      currentLabels: [...(input.currentLabels ?? [])],
      timeline: [...input.authorityTimeline],
      authorityLogins: [...(input.authorityLogins ?? resolveAuthorityLogins())],
      truncated: input.truncated ?? false,
      boxPatchId: { recordedPatchId: record.patchId, currentPatchId },
    });
  }

  return emit(verdict, {
    recordedPatchId: record.patchId,
    currentPatchId,
    recordedSha: found.sha,
    movedShas,
    unrefreshedShas,
    record,
  });
}

export type CheckRunApiAction =
  | { kind: "post"; args: string[] }
  | { kind: "patch"; id: number; args: string[] };

/** Pure — decides PATCH vs POST for the box-patch-id-observe check run on the CURRENT head, and
 *  builds the exact `gh api` argument array either way. Pass `existingId` when a
 *  box-patch-id-observe check run already exists on that head; omit it to POST exactly one. */
export function buildCheckRunApiArgs(params: {
  repo: string;
  headSha: string;
  conclusion: "neutral";
  title: string;
  text: string;
  existingId?: number;
}): CheckRunApiAction {
  const fields = [
    "-f",
    `name=${BOX_PATCH_ID_OBSERVE_CHECK_NAME}`,
    "-f",
    "status=completed",
    "-f",
    `conclusion=${params.conclusion}`,
    "-f",
    `output[title]=${params.title}`,
    "-f",
    `output[summary]=${params.title}`,
    "-f",
    `output[text]=${params.text}`,
  ];
  if (params.existingId != null) {
    return {
      kind: "patch",
      id: params.existingId,
      args: ["api", `repos/${params.repo}/check-runs/${params.existingId}`, "-X", "PATCH", ...fields],
    };
  }
  return {
    kind: "post",
    args: ["api", `repos/${params.repo}/check-runs`, "-X", "POST", "-f", `head_sha=${params.headSha}`, ...fields],
  };
}
