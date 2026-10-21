/**
 * ai-review-evaluate.ts — one PR → one verdict, for the central AI review check (go-native, native-plan §4).
 *
 * Idempotent reconcile, not "review once": every sweep re-derives the cheap, API-only legs (fork, label, CODEOWNERS, size, waiver) for every
 * open non-draft PR, and spends model calls ONLY on a head SHA that has no cached MODEL verdict. The cache is the external_id of the
 * reviewer App's own earlier check runs on that SHA (`v1:<verdict>:<categories>`). That is why a hold label that is removed, or a
 * waiver that is dismissed, flips the check on the next sweep with no new model spend — and why a verdict is only POSTED when it
 * differs from the newest one already there (no check run per PR per 10 minutes).
 *
 * Legs, cheapest first (everything is re-derived from the API, never from a dispatch payload — #398):
 *   1  fork PR (head repo ≠ base repo, or head repo gone)       → block F        never waived
 *   2  `hold` or `needs-human` label                            → block H        never waived; lifts with the label
 *   3  CODEOWNERS errors at the head (GET codeowners/errors)    → block C        never waived. No CODEOWNERS file at all is
 *                                                                                 not an error in a shadow repo (pre-bootstrap) and is
 *                                                                                 block C in a live one.
 *   4  size cap (lines/files from the PR, bytes from the diff)  → block Z        waivable
 *   5  model review (cached by external_id, else 3 votes)       → pass | block S/I/K/D/U
 *   6  waiver: kbibelhausen's LATEST review is APPROVED and its commit_id is the head SHA → waives I, K, D, Z.
 *      Deterministic: it needs no model, so it works when WIF or the model is down. S, H, F, C, U are never waived.
 *
 * Fail closed: an API or model error leaves NO verdict (`error`) — never a success. Two deliberate refinements:
 *   - when the model is unavailable and there is no cache, a Kevin approval on the head still resolves to `waived` (the deadlock the
 *     reviewer would otherwise create for its own fix);
 *   - a failed REVIEWS read is `error`, not "no waiver" — a transient API failure must never flip a posted waiver success back to failure.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  codeownersState,
  fetchDiffBySha,
  getPr,
  listReviewCheckRuns,
  listReviews,
  type CheckRunRecord,
  type GhApi,
  type PrFacts,
  type ReviewRecord,
} from "./ai-review-github.js";
import { reviewDiff, SIZE_CAP } from "./ai-review-rubric.js";
import {
  cachedModelOutcome,
  conclusionFor,
  encodeExternalId,
  parseExternalId,
  renderSummary,
  renderTitle,
  sortCategories,
  WAIVABLE,
  type Category,
  type Conclusion,
  type ModelOutcome,
  type Source,
  type Verdict,
} from "./ai-review-verdict.js";

export const WAIVER_LOGIN = "kbibelhausen";
export const HELD_LABELS: readonly string[] = ["hold", "needs-human"];

export interface EvalDeps {
  gh: GhApi;
  /** Lazy: built only when a model review is actually needed (so deterministic legs and the waiver run with federation down). */
  client: () => Anthropic;
  /** slug of the reviewer App — a pre-filter for the cache; the post job re-checks by numeric app id */
  reviewerSlug: string;
  sleep?: (ms: number) => Promise<void>;
}

export type ErrorLeg = "pr" | "checks" | "codeowners" | "diff" | "model" | "reviews" | "internal";

export type EvalResult =
  | { kind: "skip"; reason: "draft" | "closed" }
  /** No verdict this sweep (fail closed). `leg` names the failing step; there is deliberately no detail. */
  | { kind: "error"; leg: ErrorLeg }
  | { kind: "unchanged"; headSha: string; verdict: Verdict; source: Source }
  | {
      kind: "post";
      headSha: string;
      verdict: Verdict;
      source: Source;
      conclusion: Conclusion;
      externalId: string;
      title: string;
      summary: string;
    };

/** Pure. Kevin's LATEST decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED; a COMMENTED review changes nothing) must be an
 *  APPROVED whose commit_id is exactly the head SHA. An approval of an older SHA never waives a newer one. */
export function kevinWaives(reviews: ReviewRecord[], headSha: string): boolean {
  let latest: ReviewRecord | null = null;
  for (const r of reviews) {
    if (r.login.toLowerCase() !== WAIVER_LOGIN) continue;
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED" && r.state !== "DISMISSED") continue;
    if (latest === null || r.id > latest.id) latest = r;
  }
  return latest !== null && latest.state === "APPROVED" && latest.commitId === headSha;
}

/** Pure. */
export function isOversize(f: Pick<PrFacts, "additions" | "deletions" | "changedFiles">): boolean {
  return f.additions + f.deletions > SIZE_CAP.maxChangedLines || f.changedFiles > SIZE_CAP.maxFiles;
}

class LegError extends Error {
  constructor(public readonly leg: ErrorLeg) {
    super(`leg ${leg} failed`);
  }
}

type Waiver = "yes" | "no" | "unknown";

export async function evaluatePr(deps: EvalDeps, repo: string, mode: "live" | "shadow", prNumber: number): Promise<EvalResult> {
  try {
    return await evaluate(deps, repo, mode, prNumber);
  } catch (err) {
    return { kind: "error", leg: err instanceof LegError ? err.leg : "internal" };
  }
}

async function evaluate(deps: EvalDeps, repo: string, mode: "live" | "shadow", prNumber: number): Promise<EvalResult> {
  const { gh } = deps;
  const step = async <T>(leg: ErrorLeg, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      throw new LegError(leg);
    }
  };

  const facts = await step("pr", () => getPr(gh, repo, prNumber));
  if (facts.state !== "open") return { kind: "skip", reason: "closed" };
  if (facts.draft) return { kind: "skip", reason: "draft" };
  const head = facts.headSha;

  const runs = await step("checks", () => listReviewCheckRuns(gh, repo, head));
  const completed: CheckRunRecord[] = runs.filter((r) => r.status === "completed" && r.appSlug === deps.reviewerSlug).sort((a, b) => b.id - a.id);
  const latest = completed[0] ?? null;
  const cachedModel: ModelOutcome | null = (() => {
    for (const r of completed) {
      const m = cachedModelOutcome(parseExternalId(r.externalId));
      if (m) return m;
    }
    return null;
  })();

  let waiverMemo: Promise<Waiver> | null = null;
  const waiver = (): Promise<Waiver> =>
    (waiverMemo ??= listReviews(gh, repo, prNumber).then(
      (rows): Waiver => (kevinWaives(rows, head) ? "yes" : "no"),
      (): Waiver => "unknown",
    ));

  // ── the decision, once derived, is compared with what is already posted ──
  const conclude = (verdict: Verdict, source: Source, extra: { detail?: string[]; reasons?: string; votes?: string[] } = {}): EvalResult => {
    const externalId = encodeExternalId(verdict);
    const conclusion = conclusionFor(verdict.kind);
    if (latest && latest.externalId === externalId && latest.conclusion === conclusion) return { kind: "unchanged", headSha: head, verdict, source };
    return {
      kind: "post",
      headSha: head,
      verdict,
      source,
      conclusion,
      externalId,
      title: renderTitle(verdict),
      summary: renderSummary({ verdict, source, ...extra }),
    };
  };
  const block = (cats: Category[]): Verdict => ({ kind: "block", categories: sortCategories(cats) });

  // 1 + 2: free legs, from the facts just read
  const gateCats: Category[] = [];
  const gateDetail: string[] = [];
  if (facts.headRepo === null || facts.headRepo.toLowerCase() !== facts.baseRepo.toLowerCase()) {
    gateCats.push("F");
    gateDetail.push("the head repository is not this repository (a fork, or a deleted fork)");
  }
  const held = facts.labels.filter((l) => HELD_LABELS.includes(l.toLowerCase()));
  if (held.length > 0) {
    gateCats.push("H");
    gateDetail.push(`held by label: ${held.join(", ")}`);
  }
  if (gateCats.length > 0) return conclude(block(gateCats), "gate", { detail: gateDetail });

  // 3: CODEOWNERS
  const co = await step("codeowners", () => codeownersState(gh, repo, head));
  if (co.kind === "errors") return conclude(block(["C"]), "gate", { detail: co.items });
  if (co.kind === "absent" && mode === "live") return conclude(block(["C"]), "gate", { detail: ["no CODEOWNERS file exists at this commit"] });

  // 4: size, then 5/6
  const oversize = async (sizes: string): Promise<EvalResult> => {
    const w = await waiver();
    if (w === "unknown") throw new LegError("reviews");
    if (w === "yes") return conclude({ kind: "waived", categories: ["Z"] }, "waiver", { detail: [sizes] });
    return conclude(block(["Z"]), "gate", { detail: [sizes] });
  };
  if (isOversize(facts)) {
    return oversize(`${facts.additions + facts.deletions} changed lines in ${facts.changedFiles} files (cap ${SIZE_CAP.maxChangedLines} lines, ${SIZE_CAP.maxFiles} files)`);
  }

  let model: ModelOutcome | null = cachedModel;
  let source: Source = "cached";
  let reasons = "";
  let votes: string[] | undefined;
  let modelLeg: ErrorLeg = "model";
  if (model === null) {
    source = "model";
    let diff: string | null = null;
    try {
      diff = await fetchDiffBySha(gh, repo, facts.baseRef, head);
    } catch {
      modelLeg = "diff";
    }
    if (diff !== null) {
      if (Buffer.byteLength(diff, "utf-8") > SIZE_CAP.maxDiffBytes) {
        return oversize(`the diff is ${Buffer.byteLength(diff, "utf-8")} bytes (cap ${SIZE_CAP.maxDiffBytes})`);
      }
      try {
        const t = await reviewDiff(deps.client(), diff, { sleep: deps.sleep });
        votes = t.votes;
        if (t.outcome === "pass") model = { kind: "pass" };
        else if (t.outcome === "block") {
          model = { kind: "block", categories: t.categories };
          reasons = t.reasons;
        }
      } catch {
        /* the client could not be built or the review crashed: no model verdict, same as an inconclusive vote */
      }
    }
  }

  if (model === null) {
    // the model is down (or inconclusive) and nothing is cached: only a Kevin approval on the head can still resolve this PR
    const w = await waiver();
    if (w === "yes") return conclude({ kind: "waived", categories: [] }, "waiver", { votes });
    throw new LegError(w === "unknown" ? "reviews" : modelLeg);
  }
  if (model.kind === "pass") return conclude({ kind: "pass", categories: [] }, source, { votes });

  const cats = model.categories;
  if (cats.every((c) => WAIVABLE.has(c))) {
    const w = await waiver();
    if (w === "unknown") throw new LegError("reviews");
    if (w === "yes") return conclude({ kind: "waived", categories: cats }, "waiver", { reasons, votes });
  }
  return conclude(block(cats), source, { reasons, votes });
}
