/**
 * ai-review-verdict.ts — the verdict vocabulary of the central AI review check (go-native, native-plan §4).
 *
 * The check run is named exactly `studiob-ai-review`. Its `external_id` is the machine-readable verdict AND the cache:
 *
 *     v1:<verdict>:<categories>[:<mergebase>]   verdict ∈ pass | block | waived   categories = letters from CATEGORY_ORDER, in that order
 *
 * A MODEL verdict (a pass, a block of model categories S/I/K/D/U, or a waiver of I/K/D) rests on one specific diff: the diff from the
 * merge base to the head SHA. The head SHA alone does not pin it — the merge base moves when a PR is retargeted or when its parent lands —
 * so a model verdict ALWAYS carries the full 40-hex merge base it was computed against, and a cached model verdict is reused only for that
 * same merge base (`cachedModelOutcome`). A deterministic verdict (H F B C Z, or a waiver that recorded no model categories) rests on no diff
 * and carries none; the grammar forbids one. The merge base is a full SHA, never a truncated key.
 *
 * The external_id is built from parsed ENUMS only, never from model or diff text, so nothing a diff says can reshape it
 * (`encodeExternalId` throws on anything outside the grammar; `parseExternalId` is its exact inverse and returns null on a
 * non-canonical string). The free-text reasons live ONLY in the check run's `output.summary` on the private repo.
 *
 * Categories
 *   model rubric   S secret material (ALSO found by the deterministic scan in ai-review-secrets.ts, which runs before any waiver can produce
 *                  a success) · I injection aimed at the reviewer · K owner-reserved (Kevin-list) content in a neutral path ·
 *                  D destructive / test-weakening / disabled guard / obvious defect · U the model blocked without a recognized category
 *   deterministic  H held (hold / needs-human label) · F fork PR · B base branch is not the default branch · C CODEOWNERS errors (or missing,
 *                  in a live repo) · Z over the size cap
 *
 * Conclusion vs verdict. The VERDICT (pass | block | waived, and the categories) is what the sweep derived. The CONCLUSION is what the check
 * run says to GitHub, and it depends on the repository's mode in scripts/native/manifest.json:
 *   live     pass | waived → success      block → failure
 *   shadow   EVERY verdict → neutral      (the would-be verdict is in external_id and output.summary; nothing is enforced)
 * A shadow repo is still served by the old merge robot, which reads any failing check as "not clean" (automerge-classify.ts isRollupClean);
 * a neutral is clean there, so a shadow review can never hold a PR. The verdict is never read back from the conclusion: the cache reads the
 * external_id for the MODEL outcome only, and every other leg (gates, waiver, secret scan, conclusion) is re-derived each sweep — which is
 * why flipping a repo to live re-derives each verdict instead of reusing a neutral as a pass.
 *
 * Waiver (native-plan §4): a kbibelhausen APPROVED review whose commit_id equals the head SHA waives I, K, D and Z — and nothing else.
 * S is never waivable (rotate the secret instead); H lifts by removing the label; F and C are never waived; U is not waivable
 * because a block with no recognized category cannot be shown to fall inside the waivable set; B is not waivable because a waiver is not
 * bound to a base, and the way to clear B is to retarget the pull request to the default branch.
 */

export const CATEGORY_ORDER = ["S", "I", "K", "D", "H", "F", "B", "C", "Z", "U"] as const;
export type Category = (typeof CATEGORY_ORDER)[number];

/** Categories the MODEL can assign (U = "blocked, no recognized category"). */
export const MODEL_CATEGORIES: readonly Category[] = ["S", "I", "K", "D", "U"];
/** The only categories a Kevin approval on the head SHA waives. */
export const WAIVABLE: ReadonlySet<Category> = new Set<Category>(["I", "K", "D", "Z"]);

export type VerdictKind = "pass" | "block" | "waived";
export type Conclusion = "success" | "failure" | "neutral";
/** The manifest mode a verdict is posted under (a repo that is neither live nor shadow is never reviewed, so it has no mode here). */
export type ReviewMode = "live" | "shadow";
/** gate = a deterministic leg · scan = the deterministic secret scan · cached = an earlier model verdict reused · model = a fresh vote · waiver = Kevin's approval */
export type Source = "gate" | "scan" | "cached" | "model" | "waiver";

export interface Verdict {
  kind: VerdictKind;
  /** canonical order, unique */
  categories: Category[];
  /** full 40-hex merge base the verdict was computed against. Present exactly when `isModelVerdict(this)`; forbidden otherwise. */
  mergeBase?: string;
}

/** The model's own outcome, as cached in an earlier check run or freshly voted. */
export type ModelOutcome = { kind: "pass" } | { kind: "block"; categories: Category[] };

export function sortCategories(cats: Iterable<Category>): Category[] {
  const set = new Set(cats);
  return CATEGORY_ORDER.filter((c) => set.has(c));
}

const EXTERNAL_ID_RE = /^v1:(pass|block|waived):([SIKDHFBCZU]*)(?::([0-9a-f]{40}))?$/;
const SHA40 = /^[0-9a-f]{40}$/;
/** What a waiver can have overridden when it records MODEL categories (Z is waivable too, but it is a size gate, not a model verdict). */
const MODEL_WAIVED: ReadonlySet<Category> = new Set<Category>(["I", "K", "D"]);

/**
 * True when the verdict rests on a diff the model read, and so must be bound to the merge base of that diff:
 *   pass · block whose categories are all model categories · waiver whose categories are all I/K/D (non-empty).
 * False for every deterministic verdict (any H F B C Z, a waiver of Z, a waiver that recorded nothing).
 */
export function isModelVerdict(v: Pick<Verdict, "kind" | "categories">): boolean {
  if (v.kind === "pass") return true;
  if (v.categories.length === 0) return false;
  return v.kind === "block" ? v.categories.every((c) => MODEL_CATEGORIES.includes(c)) : v.categories.every((c) => MODEL_WAIVED.has(c));
}

export function encodeExternalId(v: Verdict): string {
  const canonical = sortCategories(v.categories);
  if (canonical.length !== v.categories.length || canonical.some((c, i) => c !== v.categories[i])) {
    throw new Error("external_id: categories must be unique and in canonical order");
  }
  if (v.kind === "pass" && canonical.length > 0) throw new Error("external_id: a pass carries no categories");
  if (v.kind === "block" && canonical.length === 0) throw new Error("external_id: a block carries at least one category");
  if (isModelVerdict(v)) {
    if (typeof v.mergeBase !== "string" || !SHA40.test(v.mergeBase)) throw new Error("external_id: a model verdict carries the full 40-hex merge base it was computed against");
    return `v1:${v.kind}:${canonical.join("")}:${v.mergeBase}`;
  }
  if (v.mergeBase !== undefined) throw new Error("external_id: a deterministic verdict carries no merge base");
  return `v1:${v.kind}:${canonical.join("")}`;
}

/** Exact inverse of encodeExternalId; null for anything that is not a canonical v1 verdict (including another version, a model verdict
 *  with no merge base, and a deterministic verdict with one). */
export function parseExternalId(id: string | null | undefined): Verdict | null {
  if (typeof id !== "string") return null;
  const m = EXTERNAL_ID_RE.exec(id);
  if (!m) return null;
  const kind = m[1] as VerdictKind;
  const categories = m[2].split("") as Category[];
  const canonical = sortCategories(categories);
  if (canonical.length !== categories.length || canonical.some((c, i) => c !== categories[i])) return null;
  if (kind === "pass" && categories.length > 0) return null;
  if (kind === "block" && categories.length === 0) return null;
  const mergeBase = m[3];
  if (isModelVerdict({ kind, categories }) !== (mergeBase !== undefined)) return null;
  return mergeBase === undefined ? { kind, categories } : { kind, categories, mergeBase };
}

/**
 * What the check run says. SHADOW IS ALWAYS NEUTRAL, whatever the verdict: a failure in a shadow repo would trip the old merge robot's
 * rollup (any failing latest-per-name check is "not clean"), and the reviewer must not block anything it does not yet own. Only a live
 * repo gets success / failure. `mode` has no default on purpose: every caller states which one it means.
 */
export function conclusionFor(kind: VerdictKind, mode: ReviewMode): Conclusion {
  if (mode === "shadow") return "neutral";
  return kind === "block" ? "failure" : "success";
}

/** True when `conclusion` is one a post could legitimately carry for this verdict: neutral (shadow, any verdict) or the live conclusion. */
export function conclusionAgrees(kind: VerdictKind, conclusion: string): boolean {
  return conclusion === "neutral" || conclusion === conclusionFor(kind, "live");
}

/**
 * The MODEL verdict an earlier check run encodes, for THIS merge base — or null. This is what makes the external_id a cache: a PR whose
 * hold label is removed, or whose waiver is dismissed, is re-derived from this value with no new model spend.
 *
 * The binding is the point: the head SHA does not pin the diff the model read (a retargeted PR, or one whose parent has landed, has a
 * different merge base under the SAME head), so an earlier verdict counts only when the merge base it recorded equals `currentMergeBase`.
 * A null `currentMergeBase` (the compare read failed) matches nothing.
 *   pass                                → pass
 *   block, all model categories         → block (those categories)
 *   waived, all of I/K/D (non-empty)    → the block the waiver overrode
 *   anything involving H F B C Z, or a waiver that recorded nothing, or another merge base → null
 */
export function cachedModelOutcome(v: Verdict | null, currentMergeBase: string | null): ModelOutcome | null {
  if (!v || currentMergeBase === null || !isModelVerdict(v) || v.mergeBase !== currentMergeBase) return null;
  return v.kind === "pass" ? { kind: "pass" } : { kind: "block", categories: v.categories };
}

const CATEGORY_TEXT: Record<Category, string> = {
  S: "secret material in the diff, found by the deterministic scan or by the model (never waivable: remove it and rotate it)",
  I: "text in the diff aimed at the reviewer (injection)",
  K: "owner-reserved content (pricing, legal and claims, credentials and security, the merge machinery, live customer deploys, Acumatica publishes) in a path that looks neutral",
  D: "destructive or unsafe change (data loss, a weakened test, a disabled guard, an obvious defect)",
  H: "held: a hold or needs-human label is on the pull request (lifts when the label is removed)",
  F: "pull request from a fork, or from a repository that cannot be identified (never reviewed)",
  B: "the pull request does not target the repository's default branch (it is reviewed only once it does)",
  C: "the CODEOWNERS file has errors, or is missing in a live repo, at this commit",
  Z: "the diff is over the review size cap",
  U: "the model blocked without naming a recognized category",
};

export function describeCategory(c: Category): string {
  return CATEGORY_TEXT[c];
}

/** Model text rendered as DATA: fenced so no markdown (images, links) in it can render, and no fence of its own can close ours. */
function fenceData(text: string): string {
  const safe = text.replace(/`/g, "'");
  return "```text\n" + safe + "\n```";
}

export interface SummaryInput {
  verdict: Verdict;
  source: Source;
  /** the repository's mode: a shadow summary says it is neutral and what the same verdict would be live */
  mode: ReviewMode;
  /** deterministic detail lines (labels, CODEOWNERS errors, sizes) — never model text */
  detail?: string[];
  /** model reasons, already sanitized by sanitizeReasons — rendered as fenced data */
  reasons?: string;
  /** per-vote enums only: pass | block | error */
  votes?: string[];
}

function howToClear(v: Verdict): string {
  if (v.kind !== "block") return "";
  const c = new Set(v.categories);
  const lines: string[] = [];
  if (c.has("S")) lines.push("Remove the secret from the diff and rotate it. S cannot be waived.");
  if (c.has("H")) lines.push("Remove the hold / needs-human label; the next sweep re-derives this check without a new model review.");
  if (c.has("F")) lines.push("Fork pull requests are never reviewed. Re-open the change from a branch in this repository.");
  if (c.has("B")) lines.push("Retarget the pull request to the default branch; the next sweep reviews it against that branch. B cannot be waived.");
  if (c.has("C")) lines.push("Fix CODEOWNERS at this commit (see the detail above), then push.");
  if (c.has("U")) lines.push("Push a change or re-run; the model's answer could not be classified.");
  // a waiver clears a verdict only when EVERY category in it is waivable; one S, H, F, B, C or U in the mix keeps it a failure
  if ([...c].every((x) => WAIVABLE.has(x))) {
    lines.push("Push a fix, or approve this exact commit as kbibelhausen to waive I, K, D and Z (the approval is bound to the head SHA).");
  }
  return lines.map((l) => `- ${l}`).join("\n");
}

export function renderSummary(s: SummaryInput): string {
  const head = s.verdict.kind === "pass" ? "PASS" : s.verdict.kind === "waived" ? "WAIVED" : "BLOCK";
  const out: string[] =
    s.mode === "shadow"
      ? [
          `**studiob-ai-review (shadow): would be ${head}**`,
          "",
          `Shadow mode: this check run is NEUTRAL and blocks nothing. In a live repository the same verdict posts ${conclusionFor(s.verdict.kind, "live")}.`,
          "",
        ]
      : [`**studiob-ai-review: ${head}**`, ""];
  if (s.verdict.categories.length > 0) {
    out.push(s.verdict.kind === "waived" ? "Waived categories:" : "Categories:");
    for (const c of s.verdict.categories) out.push(`- ${c}: ${describeCategory(c)}`);
    out.push("");
  }
  if (s.detail && s.detail.length > 0) {
    out.push("Detail:");
    for (const d of s.detail) out.push(`- ${d.replace(/[\r\n]+/g, " ").slice(0, 300)}`);
    out.push("");
  }
  if (s.votes && s.votes.length > 0) {
    out.push(`Model votes: ${s.votes.join(", ")} (PASS needs 2 of 3 exact first-line PASS).`, "");
  }
  if (s.verdict.mergeBase) out.push(`Reviewed diff: merge base ${s.verdict.mergeBase} to the head commit.`, "");
  if (s.source === "cached") out.push("This verdict was reused from an earlier review of this exact commit against this exact merge base.", "");
  if (s.verdict.kind === "waived") {
    out.push("Waived by an approving review from kbibelhausen on this exact commit. S, H, F, B and C are never waived.", "");
  }
  if (s.reasons && s.reasons.trim() !== "") {
    out.push("Model reasons (untrusted text, shown as data):", fenceData(s.reasons), "");
  }
  const clear = howToClear(s.verdict);
  if (clear) out.push("How to clear:", clear, "");
  return out.join("\n").trim().slice(0, 8000);
}

export function renderTitle(v: Verdict, mode: ReviewMode): string {
  const head = v.kind === "pass" ? "PASS" : v.kind === "waived" ? "WAIVED" : "BLOCK";
  const base = v.categories.length > 0 ? `${head} (${v.categories.join(", ")})` : head;
  return mode === "shadow" ? `SHADOW, would be ${base}` : base;
}
