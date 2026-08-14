/**
 * github-issues.ts — shared `gh` CLI helpers for the auto-reconciled-issue alerting pattern
 * (Kevin directive 2026-07-30, first shipped in gateway-token-watch.ts / ops-pipeline#9).
 *
 * The pattern: an open issue labeled per-monitor IS the alert/dedup state. A monitor opens an
 * issue when a condition becomes active and closes it (with a comment) when the condition
 * clears — the tracker never accumulates stale alerts, and "is there an open issue with this
 * title" is the entire dedup mechanism (Rules #292/#358 by construction). Extracted here so
 * every monitor (gateway-token-watch, railway-volume-monitor, credential-expiry-monitor,
 * cloudflare-token-rotation) shares ONE `execFileSync("gh", ...)` seam instead of N copies —
 * pure passthrough to the `gh` CLI, no monitor-specific policy lives in this file.
 *
 * Auth: every call is a real `gh issue ...` invocation — GH_TOKEN must be set in the
 * environment (workflows set `GH_TOKEN: ${{ github.token }}` with `permissions: issues:
 * write`; locally, `gh`'s own keyring auth, as used throughout this chip's manual verification).
 */

import { execFileSync } from "node:child_process";

export interface IssueRef {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
}

/** Thin `gh` CLI seam — every helper below goes through here so stdio handling stays in one place. */
export function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Issues carrying `label` in `repo` matching `state`. Rule #322: `--json` always returns valid
 * JSON (a real `[]` for none) — no jq-"null" style traps to guard against.
 *
 * `state` is REQUIRED (no default) so every call site states what it actually needs — codex
 * review finding (P2, fixed pre-merge): the previous always-`"all"` + `--limit 200` call mixed
 * open and closed issues into one page cap, so a long-lived label could push an older
 * STILL-OPEN issue off the page once enough newer closed issues accumulated, causing a caller
 * to open a duplicate. Callers that only need "is X currently open" (every monitor except
 * gateway-token-watch.ts's revocation-gate `everClosed` check) pass `"open"`, which both narrows
 * the result set to what can actually still miss AND — since `gh`'s `-L` triggers additional
 * paginated API requests under the hood — `limit: 1000` makes truncation implausible at any
 * realistic scale (hundreds of simultaneously open alert issues would itself be a five-alarm
 * operational signal, not a normal monitor page-cap risk).
 */
export function listIssuesByLabel(repo: string, label: string, state: "open" | "closed" | "all", limit = 1000): IssueRef[] {
  const out = gh([
    "issue", "list", "--repo", repo, "--label", label, "--state", state,
    "--limit", String(limit), "--json", "number,title,state",
  ]);
  const parsed = JSON.parse(out) as IssueRef[];
  return Array.isArray(parsed) ? parsed : [];
}

/** Idempotent (`--force` updates in place) — safe to call every run. Label ops ride the `issues: write` permission. */
export function ensureLabel(repo: string, label: string, description: string, color: string): void {
  gh(["label", "create", label, "--repo", repo, "--force", "--description", description, "--color", color]);
}

export function openIssue(repo: string, label: string, title: string, body: string): void {
  gh(["issue", "create", "--repo", repo, "--label", label, "--title", title, "--body", body]);
}

export function closeIssue(repo: string, num: number, comment: string): void {
  gh(["issue", "close", String(num), "--repo", repo, "--comment", comment]);
}

/**
 * Post a comment WITHOUT closing — used when a condition changes severity while its issue stays
 * open (e.g. WARN→CRITICAL) so the reader sees the change without a second issue being opened
 * (the open issue is still the dedup for "condition active", Rules #292/#358).
 */
export function commentIssue(repo: string, num: number, comment: string): void {
  gh(["issue", "comment", String(num), "--repo", repo, "--body", comment]);
}

/**
 * Retitle an existing issue in place — paired with `commentIssue` for in-place severity changes
 * so the title (which callers also use as part of the human-facing dedup key) reflects current
 * severity rather than lying about it (Rule #412: an alert's prose is a claim, not a guarantee).
 */
export function retitleIssue(repo: string, num: number, title: string): void {
  gh(["issue", "edit", String(num), "--repo", repo, "--title", title]);
}

/**
 * Remove a label from an issue — additive for ops-pipeline#66 (the needs-human router): a
 * same-repo auto-route REMOVES `needs-human` so the issue re-enters the owning lane's ordinary
 * (unlabeled-issue) re-entry folds. `gh issue edit --remove-label` is idempotent — removing an
 * absent label is a no-op, not an error — so callers never need to pre-check membership.
 */
export function removeLabel(repo: string, num: number, label: string): void {
  gh(["issue", "edit", String(num), "--repo", repo, "--remove-label", label]);
}

export interface IssueComment {
  /** Numeric REST id — NOT the GraphQL node id `gh issue view --json comments` returns; this is
   * the id `GET /repos/{repo}/issues/comments/{id}/reactions` requires. */
  id: number;
  body: string;
  login: string;
}

/**
 * All comments on an issue via the REST list endpoint (numeric `id`s, unlike `gh issue view
 * --json comments`'s GraphQL node ids) — additive for ops-pipeline#66, which needs the numeric
 * id to fetch per-comment reactions (see `getCommentReactions` below). `--paginate` follows
 * Link headers so a long thread's later comments are never silently dropped (Rule #331).
 */
export function listIssueComments(repo: string, issueNumber: number): IssueComment[] {
  const out = gh(["api", `repos/${repo}/issues/${issueNumber}/comments`, "--paginate", "--jq", ".[] | {id, body, login: .user.login}"]);
  // `--paginate` concatenates one JSON value per page on its own line, not a single array.
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as IssueComment);
}

export interface CommentReaction {
  /** GitHub reaction content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes". */
  content: string;
  login: string;
}

/**
 * Per-user reactions on ONE issue comment (numeric comment id, not the GraphQL node id) —
 * additive for ops-pipeline#66's #398 authorization check: a reaction is origin-signed but WHO
 * reacted still needs checking against org membership before it can act as a brake. Called only
 * for the specific comments the router cares about (the probe comment, its own receipt) — not
 * fanned out over a whole thread. `--paginate` (codex review pass 1 P2, 2026-08-14): a comment
 * with more reactions than GitHub's default single-page size would otherwise silently drop a
 * later reactor's 👎 from the authorization check — mirrors `listIssueComments`'s own guard.
 */
export function getCommentReactions(repo: string, commentId: number): CommentReaction[] {
  const out = gh(["api", `repos/${repo}/issues/comments/${commentId}/reactions`, "--paginate", "--jq", ".[] | {content, login: .user.login}"]);
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CommentReaction);
}

/**
 * Whether `login` is a member of `org` — GitHub's membership-check endpoint returns 204 (member)
 * or 404 (genuinely not a member, or private membership the caller can't see). Rule #398: a 👎
 * is origin-signed but not authorized on its own — this is the WHO check, and it is the router's
 * ONE brake, so it must fail in the SAFE direction.
 *
 * codex review pass 1 P1 (2026-08-14): the original version caught ANY thrown error (network
 * blip, rate limit, a token missing `read:org`, a transient 5xx) and returned `false` — silently
 * indistinguishable from a confirmed 404. That direction is backwards: it would let a REAL
 * org-member's 👎 be treated as absent whenever the membership check merely couldn't complete,
 * so the router would route/close an issue a human actually tried to reject. Only a stderr
 * carrying the literal `HTTP 404` (verified live: `gh api orgs/<org>/members/<login>` on a
 * confirmed non-member prints exactly `gh: Not Found (HTTP 404)` to stderr, exit 1) is treated
 * as a real "not a member" answer; every other failure shape is unresolved and THROWN — the
 * caller's run fails loud rather than silently mis-authorizing.
 */
export function isOrgMember(org: string, login: string): boolean {
  try {
    gh(["api", `orgs/${org}/members/${login}`]);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? `${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}\n${err.message}` : String(err);
    if (detail.includes("HTTP 404")) return false; // confirmed: not a member
    throw new Error(`isOrgMember(${org}, ${login}): ambiguous failure, not a confirmed 404 — refusing to treat as "not a member": ${detail.trim()}`);
  }
}
