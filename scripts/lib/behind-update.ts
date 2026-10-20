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
 * lane's pre-checks (a BEHIND PR the gate would never merge is never touched). It:
 *   1. counts this gate's own update-branch markers on the PR (PR comments carrying
 *      BEHIND_MARKER, created inside the last 24h) — the persisted per-PR state; the
 *      gate holds none elsewhere (sweep fingerprints are an evictable cache);
 *   2. refuses at the cap (3 per PR per 24h) — "capped", zero calls made;
 *   3. records the attempt (the marker comment) BEFORE calling GitHub, so an attempt that
 *      fails still counts toward the cap and an unrecordable attempt is never made;
 *   4. PUT /pulls/{n}/update-branch pinned to `expected_head_sha` (a merge commit, never
 *      a force-push; 202 = requested).
 * Every error — unreadable count, unrecordable attempt, 422 conflict, a moved head,
 * anything — resolves to `refused` with the error text. Nothing here merges or labels.
 * The next sweep re-evaluates the new head once CI lands (the sweep fingerprint leads
 * with the head sha, so a new head is always "changed").
 */

export const BEHIND_UPDATE_CAP = 3;
export const BEHIND_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BEHIND_MARKER = "<!-- gate-update-branch";

export type BehindOutcome =
  | { kind: "requested"; used: number }
  | { kind: "capped"; used: number }
  | { kind: "refused"; reason: string };

/** Pure. An unparseable timestamp counts as recent — an undercount would fail open. */
export function countRecentRequests(createdAts: readonly string[], nowMs: number): number {
  return createdAts.filter((t) => {
    const age = nowMs - Date.parse(t);
    return Number.isNaN(age) || age < BEHIND_UPDATE_WINDOW_MS;
  }).length;
}

/** The useful part of an execFileSync error: gh's stderr (the HTTP error), not "Command failed: …". */
function errText(e: unknown): string {
  const stderr = (e as { stderr?: unknown })?.stderr;
  const raw = (typeof stderr === "string" || Buffer.isBuffer(stderr) ? String(stderr).trim() : "") || (e instanceof Error ? e.message : String(e));
  return raw.replace(/\s+/g, " ").slice(0, 300);
}

export function requestBehindUpdate(gh: (args: string[]) => string, repo: string, pr: number, headSha: string, nowMs: number = Date.now()): BehindOutcome {
  let used: number;
  try {
    const out = gh(["api", `repos/${repo}/issues/${pr}/comments?per_page=100`, "--paginate", "--jq", `.[] | select(.body | contains("${BEHIND_MARKER}")) | .created_at`]);
    used = countRecentRequests(out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0), nowMs);
  } catch (e) {
    return { kind: "refused", reason: `update-branch not requested — the attempt count is unreadable (fail-closed): ${errText(e)}` };
  }
  if (used >= BEHIND_UPDATE_CAP) return { kind: "capped", used };
  try {
    gh(["pr", "comment", String(pr), "--repo", repo, "--body",
      `${BEHIND_MARKER} ${headSha.slice(0, 12)} -->\n**door — bringing this PR current** (update-branch from base, attempt ${used + 1}/${BEHIND_UPDATE_CAP} in 24h, head \`${headSha.slice(0, 7)}\`). Re-evaluated when CI lands on the new head.`]);
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
