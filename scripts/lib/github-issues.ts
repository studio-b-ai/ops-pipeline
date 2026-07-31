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
