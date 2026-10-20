/**
 * behind-update.ts — bring an otherwise-eligible BEHIND PR current (row 928 redesign).
 *
 * Kevin 10/20 "protect main": branch protection with required checks + "require branches
 * to be up to date before merging" (strict) goes live on the fleet repos. GitHub then
 * enforces freshness itself and reports `mergeStateStatus=BEHIND` for any PR whose base
 * moved; the gate only merges CLEAN, so every eligible PR that fell behind would stall
 * forever. This is the whole fix: GitHub owns the freshness check, the gate only brings
 * an eligible PR current (ops-pipeline#580 built freshness in custom code and was
 * abandoned).
 *
 * `requestBehindUpdate` is called by pr-automerge-gate.ts ONLY after a PR has passed its
 * lane's pre-checks (a BEHIND PR the gate would never merge is never touched). The gate
 * holds no per-PR/per-repo state elsewhere (sweep fingerprints are an evictable cache),
 * so state is the gate's own comments, authored by GATE_AUTHORITY_LOGIN only (an outsider's
 * look-alike marker is ignored — F4): an UPDATE marker before every attempt, a MERGED
 * marker after every gate merge. One repo-wide read of them (`issues/comments?since=24h`)
 * decides, in order:
 *   1. CAP — 3 charged attempts per PR per 24h. An attempt is NOT charged if the gate
 *      merged another PR in this repo after it: the base moved because of the gate's own
 *      merges (a queue, not a treadmill). Past the cap: "capped", zero calls.
 *   2. LEASE — one gate update per repo at a time. Another open PR whose UPDATE marker is
 *      younger than LEASE_TTL (and not yet followed by that PR's MERGED marker) holds
 *      the repo's lease: "deferred", zero calls, nothing charged. Without this every
 *      sibling merge made every other eligible PR BEHIND and each re-updated (O(k²) CI
 *      runs and paid reviews, then the cap sent routine 'update by hand' asks to Kevin).
 *      First-come within a sweep; the sweep's run-number rotation keeps it fair across
 *      sweeps. Not atomic: two jobs landing within the same second can both take it,
 *      which costs one extra update, bounded by the cap.
 *   3. RECORD the attempt (UPDATE marker) BEFORE calling GitHub, so a failed attempt still
 *      counts and an unrecordable attempt is never made.
 *   4. PUT /pulls/{n}/update-branch pinned to `expected_head_sha` (a merge commit, never
 *      a force-push; 202 = requested).
 * Every error — unreadable marks, unreadable lease holder, unrecordable attempt, 422
 * conflict, a moved head — resolves to `refused` with the error text. Nothing here merges
 * or labels. A BEHIND PR's sweep fingerprint carries an hourly bucket
 * (fleet-sweep-changed.ts), so a deferred, refused or capped PR is looked at again.
 */

import { GATE_AUTHORITY_LOGIN } from "./label-authority.js";

export const BEHIND_UPDATE_CAP = 3;
export const BEHIND_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a gate update holds the repo's lease unless its PR merges (or closes) first. */
export const BEHIND_LEASE_TTL_MS = 75 * 60 * 1000;
export const BEHIND_MARKER = "<!-- gate-update-branch";
/** Prepended to the gate's merge receipts: lets the cap see that the base moved by the gate's own merge. */
export const MERGED_MARKER = "<!-- gate-merged";

export type BehindOutcome =
  | { kind: "requested"; used: number }
  | { kind: "capped"; used: number }
  | { kind: "deferred"; holder: number }
  | { kind: "refused"; reason: string };

export interface Mark {
  kind: "update" | "merged";
  pr: number;
  at: number; // epoch ms; NaN when unparseable
}

/** `jq` over the repo-wide comment list; one tab-separated line per marker comment. Login is filtered in JS (testable). */
const MARKS_JQ =
  `.[] | select(.body | (startswith("${BEHIND_MARKER}") or startswith("${MERGED_MARKER}"))) | ` +
  `"\\(.user.login)\\t\\(if (.body | startswith("${MERGED_MARKER}")) then "merged" else "update" end)\\t\\(.issue_url | split("/") | last)\\t\\(.created_at)"`;

/** Pure. Only the gate's own comments count; anything malformed is dropped (it cannot lower a count). */
export function parseMarks(out: string, login: string = GATE_AUTHORITY_LOGIN): Mark[] {
  const marks: Mark[] = [];
  for (const line of out.split("\n")) {
    const [who, kind, issue, created] = line.trim().split("\t");
    const pr = Number(issue);
    if (who !== login || (kind !== "update" && kind !== "merged") || !Number.isInteger(pr)) continue;
    marks.push({ kind, pr, at: Date.parse(created ?? "") });
  }
  return marks;
}

/** Pure. This PR's attempts inside the window, minus those overtaken by a gate merge of ANOTHER PR since. NaN stamps count (fail closed). */
export function chargedAttempts(marks: readonly Mark[], pr: number, nowMs: number): number {
  const lastGateMerge = Math.max(Number.NEGATIVE_INFINITY, ...marks.filter((m) => m.kind === "merged" && m.pr !== pr && !Number.isNaN(m.at)).map((m) => m.at));
  return marks.filter((m) => m.kind === "update" && m.pr === pr && (Number.isNaN(m.at) || (nowMs - m.at < BEHIND_UPDATE_WINDOW_MS && m.at > lastGateMerge))).length;
}

/** Pure. Other PRs whose update is still in flight: marker younger than the TTL and no later MERGED marker of their own. */
export function leaseCandidates(marks: readonly Mark[], pr: number, nowMs: number): number[] {
  const held = marks.filter((m) => m.kind === "update" && m.pr !== pr && (Number.isNaN(m.at) || nowMs - m.at < BEHIND_LEASE_TTL_MS));
  const merged = (n: number, at: number) => marks.some((m) => m.kind === "merged" && m.pr === n && m.at >= at);
  return [...new Set(held.filter((m) => !merged(m.pr, m.at)).map((m) => m.pr))];
}

/** The useful part of an execFileSync error: gh's stderr (the HTTP error), not "Command failed: …". */
function errText(e: unknown): string {
  const stderr = (e as { stderr?: unknown })?.stderr;
  const raw = (typeof stderr === "string" || Buffer.isBuffer(stderr) ? String(stderr).trim() : "") || (e instanceof Error ? e.message : String(e));
  return raw.replace(/\s+/g, " ").slice(0, 300);
}

export function requestBehindUpdate(gh: (args: string[]) => string, repo: string, pr: number, headSha: string, nowMs: number = Date.now()): BehindOutcome {
  const since = new Date(nowMs - BEHIND_UPDATE_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  let marks: Mark[];
  try {
    marks = parseMarks(gh(["api", `repos/${repo}/issues/comments?since=${since}&per_page=100`, "--paginate", "--jq", MARKS_JQ]));
  } catch (e) {
    return { kind: "refused", reason: `update-branch not requested — the attempt record is unreadable (fail-closed): ${errText(e)}` };
  }
  const used = chargedAttempts(marks, pr, nowMs);
  if (used >= BEHIND_UPDATE_CAP) return { kind: "capped", used };
  for (const holder of leaseCandidates(marks, pr, nowMs)) {
    let state: string;
    try {
      state = gh(["api", `repos/${repo}/pulls/${holder}`, "--jq", ".state"]).trim();
    } catch (e) {
      return { kind: "refused", reason: `update-branch not requested — the lease holder #${holder} is unreadable (fail-closed): ${errText(e)}` };
    }
    if (state === "open") return { kind: "deferred", holder };
  }
  try {
    gh(["pr", "comment", String(pr), "--repo", repo, "--body",
      `${BEHIND_MARKER} ${headSha.slice(0, 12)} -->\n**door — requesting update-branch from base** (attempt ${used + 1}/${BEHIND_UPDATE_CAP} in 24h, head \`${headSha.slice(0, 7)}\`). Re-evaluated on the next sweeps.`]);
  } catch (e) {
    return { kind: "refused", reason: `update-branch not requested — the attempt could not be recorded (fail-closed): ${errText(e)}` };
  }
  try {
    gh(["api", "-X", "PUT", `repos/${repo}/pulls/${pr}/update-branch`, "-f", `expected_head_sha=${headSha}`]);
  } catch (e) {
    return { kind: "refused", reason: `update-branch refused: ${errText(e)}` };
  }
  return { kind: "requested", used: used + 1 };
}
