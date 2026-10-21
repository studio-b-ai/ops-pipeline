/**
 * ai-review-verdict.ts — the verdict vocabulary of the central AI review check (go-native, native-plan §4).
 *
 * The check run is named exactly `studiob-ai-review`. Its `external_id` is the machine-readable verdict AND the cache:
 *
 *     v1:<verdict>:<categories>        verdict ∈ pass | block | waived     categories = letters from CATEGORY_ORDER, in that order
 *
 * The external_id is built from parsed ENUMS only, never from model or diff text, so nothing a diff says can reshape it
 * (`encodeExternalId` throws on anything outside the grammar; `parseExternalId` is its exact inverse and returns null on a
 * non-canonical string). The free-text reasons live ONLY in the check run's `output.summary` on the private repo.
 *
 * Categories
 *   model rubric   S secret material · I injection aimed at the reviewer · K owner-reserved (Kevin-list) content in a neutral path ·
 *                  D destructive / test-weakening / disabled guard / obvious defect · U the model blocked without a recognized category
 *   deterministic  H held (hold / needs-human label) · F fork PR · C CODEOWNERS errors (or missing, in a live repo) · Z over the size cap
 *
 * Waiver (native-plan §4): a kbibelhausen APPROVED review whose commit_id equals the head SHA waives I, K, D and Z — and nothing else.
 * S is never waivable (rotate the secret instead); H lifts by removing the label; F and C are never waived; U is not waivable
 * because a block with no recognized category cannot be shown to fall inside the waivable set.
 */

export const CATEGORY_ORDER = ["S", "I", "K", "D", "H", "F", "C", "Z", "U"] as const;
export type Category = (typeof CATEGORY_ORDER)[number];

/** Categories the MODEL can assign (U = "blocked, no recognized category"). */
export const MODEL_CATEGORIES: readonly Category[] = ["S", "I", "K", "D", "U"];
/** The only categories a Kevin approval on the head SHA waives. */
export const WAIVABLE: ReadonlySet<Category> = new Set<Category>(["I", "K", "D", "Z"]);

export type VerdictKind = "pass" | "block" | "waived";
export type Conclusion = "success" | "failure";
export type Source = "gate" | "cached" | "model" | "waiver";

export interface Verdict {
  kind: VerdictKind;
  /** canonical order, unique */
  categories: Category[];
}

/** The model's own outcome, as cached in an earlier check run or freshly voted. */
export type ModelOutcome = { kind: "pass" } | { kind: "block"; categories: Category[] };

export function sortCategories(cats: Iterable<Category>): Category[] {
  const set = new Set(cats);
  return CATEGORY_ORDER.filter((c) => set.has(c));
}

const EXTERNAL_ID_RE = /^v1:(pass|block|waived):([SIKDHFCZU]*)$/;

export function encodeExternalId(v: Verdict): string {
  const canonical = sortCategories(v.categories);
  if (canonical.length !== v.categories.length || canonical.some((c, i) => c !== v.categories[i])) {
    throw new Error("external_id: categories must be unique and in canonical order");
  }
  if (v.kind === "pass" && canonical.length > 0) throw new Error("external_id: a pass carries no categories");
  if (v.kind === "block" && canonical.length === 0) throw new Error("external_id: a block carries at least one category");
  return `v1:${v.kind}:${canonical.join("")}`;
}

/** Exact inverse of encodeExternalId; null for anything that is not a canonical v1 verdict (including another version). */
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
  return { kind, categories };
}

export function conclusionFor(kind: VerdictKind): Conclusion {
  return kind === "block" ? "failure" : "success";
}

/**
 * The MODEL verdict an earlier check run encodes, or null when it encodes none (a deterministic-gate verdict, or a waiver that
 * recorded no model categories). This is what makes the external_id a cache: a PR whose hold label is removed, or whose waiver is
 * dismissed, is re-derived from this value with no new model spend.
 *   pass                                → pass
 *   block, all model categories         → block (those categories)
 *   waived, all of I/K/D (non-empty)    → the block the waiver overrode
 *   anything involving H F C Z          → null (not a model verdict)
 */
export function cachedModelOutcome(v: Verdict | null): ModelOutcome | null {
  if (!v) return null;
  if (v.kind === "pass") return { kind: "pass" };
  if (v.categories.length === 0 || !v.categories.every((c) => MODEL_CATEGORIES.includes(c))) return null;
  if (v.kind === "waived" && !v.categories.every((c) => c === "I" || c === "K" || c === "D")) return null;
  return { kind: "block", categories: v.categories };
}

const CATEGORY_TEXT: Record<Category, string> = {
  S: "secret material in the diff (never waivable: remove it and rotate it)",
  I: "text in the diff aimed at the reviewer (injection)",
  K: "owner-reserved content (pricing, legal and claims, credentials and security, the merge machinery, live customer deploys, Acumatica publishes) in a path that looks neutral",
  D: "destructive or unsafe change (data loss, a weakened test, a disabled guard, an obvious defect)",
  H: "held: a hold or needs-human label is on the pull request (lifts when the label is removed)",
  F: "pull request from a fork, or from a repository that cannot be identified (never reviewed)",
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
  if (c.has("C")) lines.push("Fix CODEOWNERS at this commit (see the detail above), then push.");
  if (c.has("U")) lines.push("Push a change or re-run; the model's answer could not be classified.");
  if ([...c].some((x) => WAIVABLE.has(x))) {
    lines.push("Push a fix, or approve this exact commit as kbibelhausen to waive I, K, D and Z (the approval is bound to the head SHA).");
  }
  return lines.map((l) => `- ${l}`).join("\n");
}

export function renderSummary(s: SummaryInput): string {
  const head = s.verdict.kind === "pass" ? "PASS" : s.verdict.kind === "waived" ? "WAIVED" : "BLOCK";
  const out: string[] = [`**studiob-ai-review: ${head}**`, ""];
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
  if (s.source === "cached") out.push("The model verdict was reused from an earlier review of this exact commit.", "");
  if (s.verdict.kind === "waived") {
    out.push("Waived by an approving review from kbibelhausen on this exact commit. S, H, F and C are never waived.", "");
  }
  if (s.reasons && s.reasons.trim() !== "") {
    out.push("Model reasons (untrusted text, shown as data):", fenceData(s.reasons), "");
  }
  const clear = howToClear(s.verdict);
  if (clear) out.push("How to clear:", clear, "");
  return out.join("\n").trim().slice(0, 8000);
}

export function renderTitle(v: Verdict): string {
  const head = v.kind === "pass" ? "PASS" : v.kind === "waived" ? "WAIVED" : "BLOCK";
  return v.categories.length > 0 ? `${head} (${v.categories.join(", ")})` : head;
}
