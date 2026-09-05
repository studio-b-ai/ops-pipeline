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
  /**
   * Present when the caller passed `include: "labels"`; absent otherwise. ops-pipeline#320
   * (needs-human router hold-rail leg): the router needs `lane:<seat>` labels to rail each
   * named seat's inbox in addition to Dispatcher — the only current caller that needs this
   * shape. Existing callers destructuring `{number, title, state}` are unaffected
   * (structural typing; the optional field is simply ignored when absent).
   */
  labels?: { name: string }[];
}

/** Thin `gh` CLI seam — every helper below goes through here so stdio handling stays in one place. */
export function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Transient-failure predicate for `gh` invocations (ops-pipeline#158). Deliberately TIGHT
 * (Rule #425 — an over-broad transient predicate retries what it must not):
 *  - `HTTP 5\d\d` — gh surfaces the status line on stderr (`gh: … (HTTP 502)`); cannot match
 *    4xx, which MUST pass through untouched (isOrgMember's 404 semantics and closeIfOpen's
 *    check-failed semantics both depend on 4xx propagating on the first attempt).
 *  - "couldn't respond to your request in time" — GitHub's 50x error-page phrase, which gh
 *    relays verbatim when the API returns the HTML unicorn page (the 2026-08-17 incident's
 *    exact stderr shape).
 *  - ECONNRESET / ETIMEDOUT — socket-level transport failures.
 */
const TRANSIENT_GH_PATTERNS: RegExp[] = [
  /HTTP 5\d\d/,
  /couldn't respond to your request in time/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
];

export function isTransientGhFailure(err: unknown): boolean {
  const detail =
    err instanceof Error
      ? `${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}\n${err.message}`
      : String(err);
  return TRANSIENT_GH_PATTERNS.some((p) => p.test(detail));
}

/** Synchronous sleep — these are sync CLI scripts (execFileSync end to end), so a Promise-based
 * sleep has nothing to await it; `Atomics.wait` blocks the thread without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface GhRetryOptions {
  /** Total attempts including the first (default 3; clamped to [1, 3] — see withGhRetry). */
  attempts?: number;
  /** Injectable for tests — defaults to a real blocking sleep. */
  sleep?: (ms: number) => void;
  /** Short label for the retry log line (never interpolate full args — bodies may be long). */
  label?: string;
}

/**
 * Bounded retry for READ-ONLY `gh` calls (ops-pipeline#158): ≤3 attempts, retrying ONLY on
 * `isTransientGhFailure` shapes, with flat jittered backoff (1–5 s) between attempts. A
 * non-transient failure (4xx, auth, parse) is rethrown immediately on the first attempt —
 * byte-identical behavior to the unwrapped call.
 *
 * ⚠️ NEVER wrap MUTATING calls (issue create/close/comment/edit, label ops) in this: a 5xx can
 * arrive AFTER the server committed the write (timeout-after-commit), and a retry then mints a
 * duplicate issue/comment. Mutators stay fail-loud one-shot; the sweeps' own idempotency
 * (open-issue-as-dedup-state, closeIfOpen re-checks, marker-deduped receipts) self-heals them
 * on the next scheduled run instead.
 */
export function withGhRetry<T>(fn: () => T, opts: GhRetryOptions = {}): T {
  // "≤3 attempts" is the public contract, not a default (codex review pass 1 P2): clamp so
  // a future caller passing a big number can't quietly turn this into an unbounded hammer
  // against an already-degraded GitHub (and 0/negative can't skip the call entirely).
  const attempts = Math.max(1, Math.min(3, opts.attempts ?? 3));
  const sleep = opts.sleep ?? sleepSync;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientGhFailure(err) || attempt === attempts) throw err;
      const backoffMs = 1000 + Math.floor(Math.random() * 4000);
      console.error(
        `[gh-retry] transient failure on ${opts.label ?? "gh call"} (attempt ${attempt}/${attempts}) — retrying in ${backoffMs}ms`,
      );
      sleep(backoffMs);
    }
  }
  throw lastErr; // structurally unreachable (loop always returns or throws)
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
export function listIssuesByLabel(
  repo: string,
  label: string,
  state: "open" | "closed" | "all",
  limit = 1000,
  opts: { includeLabels?: boolean } = {},
): IssueRef[] {
  // ops-pipeline#320: opt-in labels field for the needs-human router hold-rail leg.
  // Default false so existing callers keep exactly the same wire (single opt-in, single
  // JSON field, no per-caller drift). `gh --json` accepts a comma list — adding `labels`
  // returns each issue with `labels: [{name, description, color, ...}]`.
  const fields = opts.includeLabels === true ? "number,title,state,labels" : "number,title,state";
  const out = withGhRetry(() => gh([
    "issue", "list", "--repo", repo, "--label", label, "--state", state,
    "--limit", String(limit), "--json", fields,
  ]), { label: `issue list ${repo}` });
  const parsed = JSON.parse(out) as IssueRef[];
  return Array.isArray(parsed) ? parsed : [];
}

/** Idempotent (`--force` updates in place) — safe to call every run. Label ops ride the `issues: write` permission. */
/**
 * GitHub rejects label descriptions over 100 characters with HTTP 422 ("description is too
 * long") — and because every worker only reaches ensureLabel on its MUTATING path, a too-long
 * description passes every dry run and every unit test and fails only on the first live
 * firing (ops-pipeline#136's first real run, 2026-08-16: 53 real findings read fine, then the
 * label create 422'd and the run exited 1 with nothing opened — Rule #464's exact class).
 * Guarded here at the shared choke point (Rule #159) so the failure is a typecheck-time /
 * test-time constant check, never a live 422.
 */
export const GITHUB_LABEL_DESCRIPTION_MAX = 100;

export function assertLabelDescription(description: string): string {
  if (description.length > GITHUB_LABEL_DESCRIPTION_MAX) {
    throw new Error(
      `label description is ${description.length} chars; GitHub's maximum is ${GITHUB_LABEL_DESCRIPTION_MAX} ` +
        `(would 422 at \`gh label create\`): ${JSON.stringify(description.slice(0, 60))}…`,
    );
  }
  return description;
}

export function ensureLabel(repo: string, label: string, description: string, color: string): void {
  assertLabelDescription(description);
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
 * Rewrite an open issue's BODY in place — the third leg of an in-place update alongside
 * `retitleIssue` + `commentIssue`. Without it a reconciled aggregate keeps its FIRST-run body
 * forever while the title moves ("CTO — 1 findings" over a body still listing 8) — a
 * write-time scope claim that reads as current state (Rule #355/#412; seen live on
 * ops-pipeline#146, 2026-08-16). The comment stream still keeps every prior table as history.
 */
export function editIssueBody(repo: string, num: number, body: string): void {
  gh(["issue", "edit", String(num), "--repo", repo, "--body", body]);
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

/**
 * Add a label to an issue — additive for ops-pipeline#317 (default-to-WORK ruling, 2026-09-05):
 * a same-repo route with an unparseable probe trailer ALSO surfaces the format bug via a
 * `probe-trailer-unparsed` label so it stays visible in the lane backlog. `gh issue edit
 * --add-label` is idempotent (a repeat is a no-op) but does REQUIRE the label to already exist —
 * pair with `ensureLabel(...)` first if the label may be absent, mirroring the alert-issue
 * monitors' own pattern.
 */
export function addLabel(repo: string, num: number, label: string): void {
  gh(["issue", "edit", String(num), "--repo", repo, "--add-label", label]);
}

export interface IssueComment {
  /** Numeric REST id — NOT the GraphQL node id `gh issue view --json comments` returns; this is
   * the id `GET /repos/{repo}/issues/comments/{id}/reactions` requires. */
  id: number;
  body: string;
  login: string;
  /** ISO instant the comment was posted — additive for ops-pipeline#172 (restart-train rung 0),
   * which needs chronological ordering across a comment thread. Existing callers destructuring
   * `{id, body, login}` are unaffected (structural typing; the field is simply ignored). */
  createdAt: string;
}

/**
 * All comments on an issue via the REST list endpoint (numeric `id`s, unlike `gh issue view
 * --json comments`'s GraphQL node ids) — additive for ops-pipeline#66, which needs the numeric
 * id to fetch per-comment reactions (see `getCommentReactions` below). `--paginate` follows
 * Link headers so a long thread's later comments are never silently dropped (Rule #331).
 */
export function listIssueComments(repo: string, issueNumber: number): IssueComment[] {
  const out = withGhRetry(() => gh([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "--paginate",
    "--jq",
    ".[] | {id, body, login: .user.login, createdAt: .created_at}",
  ]), { label: `comments ${repo}#${issueNumber}` });
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
  const out = withGhRetry(
    () => gh(["api", `repos/${repo}/issues/comments/${commentId}/reactions`, "--paginate", "--jq", ".[] | {content, login: .user.login}"]),
    { label: `reactions ${repo} comment ${commentId}` },
  );
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
 *
 * ⚠️ FLAGGED, NOT RESOLVED (codex review pass 3, 2026-08-14 — Rule #50/#218, needs LIVE
 * verification, not more guessing): GitHub's docs for this exact endpoint note that a 404 can
 * ALSO mean "the requester lacks visibility into this membership" (e.g. a private membership),
 * not only "genuinely not a member" — those two cases are NOT distinguishable from the response
 * alone. All live testing so far (this file's own verification script, this session) ran under
 * a real authenticated `gh` CLI session (an actual org owner), which reliably tells the two
 * apart. In PRODUCTION this function runs via each caller repo's own ambient `GITHUB_TOKEN` — a
 * repo-scoped installation token, NOT a human's personal token — and `GITHUB_TOKEN`'s available
 * `permissions:` categories (contents, issues, etc.) do not include an org-membership scope at
 * all, so whether it can see PRIVATE org membership for an arbitrary login is genuinely
 * uncertain without firing the real deployed workflow. If it cannot, a real member's 👎 could
 * still 404 and be (correctly, per the logic above) read as "not a member" — the brake would
 * fail silently in exactly the direction this fix was trying to close, just one layer up, at
 * the API-visibility layer instead of the error-handling layer. This is EXPLICITLY a live-fire
 * question for the plant ladder the design comment calls out (issue #66, "Plant ladder in
 * bolt-wms after both merge... second planted issue with org-member 👎 → close-as-rejected"):
 * that planted-👎 test is the first real signal on whether GITHUB_TOKEN's org-membership
 * visibility holds in a real caller repo. If it fails there, the fix is NOT more client-side
 * logic (there is no way to disambiguate the two 404 causes from this endpoint's response) — it
 * is switching the requester identity, e.g. a Kevin-gated fine-grained PAT with `read:org`
 * passed as a secret to the reusable workflow.
 */
export function isOrgMember(org: string, login: string): boolean {
  try {
    // withGhRetry preserves the 404 contract exactly: a 404 fails `isTransientGhFailure`, so it
    // is rethrown on the FIRST attempt and lands in this catch unchanged — only genuine 5xx /
    // transport blips are retried before reaching the ambiguous-failure throw below.
    withGhRetry(() => gh(["api", `orgs/${org}/members/${login}`]), { label: `org-membership ${org}/${login}` });
    return true;
  } catch (err) {
    const detail = err instanceof Error ? `${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}\n${err.message}` : String(err);
    if (detail.includes("HTTP 404")) return false; // confirmed: not a member
    throw new Error(`isOrgMember(${org}, ${login}): ambiguous failure, not a confirmed 404 — refusing to treat as "not a member": ${detail.trim()}`);
  }
}
