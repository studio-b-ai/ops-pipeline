#!/usr/bin/env tsx
/**
 * repo-hygiene-worker.ts — ops-pipeline#101 (design comment: CTO seat, 2026-08-14). Queue
 * head after Batch 7 (ops#61); its deferral condition ("after #21's classification")
 * resolved 8/14. Read scripts/lib/repo-hygiene-lib.ts's header FIRST — this file is thin
 * I/O glue around that pure lib; no diff/render/reconcile DECISION lives here.
 *
 * ══════════════════════════ FLAGS ONLY — READ BEFORE TOUCHING THIS FILE ══════════════════════════
 * The classifier mis-classed shuttle; Batch 7's instrument overrode the 8/12 sweep's
 * naming-derived classifications in BOTH directions (acusync "confirmed-live" →
 * instrument-dead; acuops-website "pushed today" → hourly bot loop). Classification
 * sweeps NOMINATE, instruments DECIDE, humans WORD. This worker:
 *   - NEVER mutates a repo (no archive, no visibility change, no delete, no transfer).
 *   - NEVER writes `scripts/repo-baseline.json` — baseline updates are human (Rules
 *     #379/#381: a worker that could silently accept its own drift as the new baseline
 *     would defeat the entire point of having one). The issue body it opens/updates
 *     carries the exact JSON line(s) a human would edit to accept current live state.
 *   - Opens/updates/closes exactly ONE aggregate issue — never one issue per repo.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Shape (v1 — GitHub-plane only, zero new credentials, per the issue):
 *   1. Load the committed baseline (`repo-baseline.json`, sibling to this file).
 *   2. Enumerate every live org repo via `gh repo list studio-b-ai` (name, isArchived,
 *      visibility, pushedAt) — requires the fleet App's org-wide read, which an ordinary
 *      repo-scoped ambient GITHUB_TOKEN structurally cannot provide (it can only see the
 *      one repo a workflow runs in). The calling workflow
 *      (.github/workflows/repo-hygiene.yml) mints a `studiob-fleet-bot` installation
 *      token (ops-pipeline#88's pattern, copied from needs-human-crossrepo.yml verbatim)
 *      and sets it as this process's `GH_TOKEN` for the whole run — every `gh` call below,
 *      enumeration AND issue ops, rides that one minted token.
 *   3. For repos pushed within BOT_CHURN_LOOKBACK_DAYS, fetch up to 20 recent commits'
 *      author info and classify bot-churn (informational finding class 5).
 *
 *      ⚠️ LIVE-VERIFIED GAP (2026-08-14, `gh api /orgs/studio-b-ai/installations`):
 *      `studiob-fleet-bot` (App 4595770) is installed with EXACTLY `issues:write` +
 *      `metadata:read` — no `contents:read`. GitHub's own permissions-required-for-apps
 *      docs list `GET /repos/{owner}/{repo}/commits` as requiring the **Contents**
 *      permission (read); `metadata:read` covers `GET /orgs/{org}/repos` (step 2) but not
 *      commit history. So TODAY, every commit fetch in step 3 will 403, and class 5 will
 *      read 0 findings every run — not a bug in this worker, a real permission gap in the
 *      App's org installation. Granting `contents:read` is an org-security-settings
 *      change (GitHub App installation permissions can only be widened via the org-owner
 *      UI, no API path — mirrors Rule #78's `workflows:` permission story) and is
 *      deliberately OUT OF SCOPE for this chip; flagged as a top-level follow-up in the PR
 *      body per Rule #6. Per Rule #464 ("a guard's first live firing is part of its ship,
 *      not its follow-up"), this worker does not let that sit silent: `attachBotChurn`
 *      below tracks attempted-vs-failed counts, and when EVERY attempt failed (as opposed
 *      to a few individually flaky repos) it prints a loud console warning AND threads
 *      `botChurnSystemicFailure` into the issue body (repo-hygiene-lib.ts's
 *      `renderDriftIssueBody`) naming the exact gap and remediation — so a human reading
 *      either the run log or the issue sees WHY class 5 is empty, not a silent 0 that
 *      looks identical to "no drift this week". Classes 1-4 are fully independent of this
 *      gap and function normally.
 *
 * `--dry-run`: real reads throughout (org enumeration, per-repo commit fetch, issue list)
 * — Rule #376, a dry run that reads nothing proves nothing — but ZERO issue mutations.
 *
 * Ship gate (issue #101, Rules #464/#471 — plant BOTH verdicts before calling this live):
 * (a) known-bad — a fake repo entry added to the baseline on a branch dispatch → must
 * flag `baseline-repo-gone` and open the issue; (b) known-good — revert the plant,
 * re-dispatch → issue must auto-close. Both receipts belong on issue #101, not this file;
 * this worker only needs to BEHAVE correctly for both, which its pure-lib tests already
 * cover deterministically (`planIssueAction`'s open/close branches) — the live plant is a
 * follow-up action against the merged worker, not part of this PR.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffFleet,
  planIssueAction,
  alertWorthyCount,
  renderDriftIssueBody,
  summarizeFindings,
  computeBotChurnSample,
  BOT_CHURN_LOOKBACK_DAYS,
  type BaselineFile,
  type LiveRepo,
  type CommitAuthorInfo,
} from "./lib/repo-hygiene-lib.js";
import { ensureLabel, listIssuesByLabel, openIssue, closeIssue, gh } from "./lib/github-issues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = join(HERE, "repo-baseline.json");

const ORG = "studio-b-ai";
const REPO = "studio-b-ai/ops-pipeline";
const LABEL = "repo-hygiene";
const LABEL_DESCRIPTION = "repo-hygiene fleet-drift-vs-baseline alert state (open = drift active)";
const LABEL_COLOR = "5319E7";
const TITLE = "[repo-hygiene] fleet drift vs baseline";

/** Safety bound, not a paging mechanism (Rule #331) — `--limit` requests up to this many; hitting it exactly is a loud signal the org may have grown past it, not silent truncation. */
const LIVE_ENUMERATION_LIMIT = 300;

/** Up to 20 recent commits inspected per repo, per the issue's own spec. */
const COMMITS_PER_REPO = 20;

// ───────────────────────────── baseline (read-only — see file header) ─────────────────────────────

function loadBaseline(): BaselineFile {
  const raw = readFileSync(BASELINE_FILE, "utf-8");
  const parsed = JSON.parse(raw) as BaselineFile;
  if (!Array.isArray(parsed.repos)) throw new Error(`${BASELINE_FILE} is malformed: "repos" is not an array`);
  if (typeof parsed.rulesVersion !== "number") throw new Error(`${BASELINE_FILE} is malformed: "rulesVersion" is not a number`);
  return parsed;
}

// ───────────────────────────── live enumeration ─────────────────────────────

interface GhRepoListRow {
  name: string;
  isArchived: boolean;
  visibility: string;
  pushedAt: string;
}

function listLiveRepos(): { repos: LiveRepo[]; hitCap: boolean } {
  const raw = gh(["repo", "list", ORG, "--limit", String(LIVE_ENUMERATION_LIMIT), "--json", "name,isArchived,visibility,pushedAt"]);
  const rows = JSON.parse(raw) as GhRepoListRow[];
  const repos: LiveRepo[] = rows.map((r) => ({ name: r.name, isArchived: r.isArchived, visibility: r.visibility, pushedAt: r.pushedAt }));
  return { repos, hitCap: repos.length === LIVE_ENUMERATION_LIMIT };
}

// ───────────────────────────── bot-churn (informational leg) ─────────────────────────────

function isWithinFreshnessWindow(pushedAtIso: string, now: Date): boolean {
  const pushedAtMs = new Date(pushedAtIso).getTime();
  if (!Number.isFinite(pushedAtMs)) return false; // malformed date from the API — never treat as fresh
  const cutoffMs = now.getTime() - BOT_CHURN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return pushedAtMs >= cutoffMs;
}

function fetchCommitAuthors(repoName: string): CommitAuthorInfo[] {
  const raw = gh([
    "api",
    `repos/${ORG}/${repoName}/commits?per_page=${COMMITS_PER_REPO}`,
    "--jq",
    "[.[] | {login: (.author.login // null), type: (.author.type // null)}]",
  ]);
  return JSON.parse(raw) as CommitAuthorInfo[];
}

interface BotChurnFetchOutcome {
  attempted: number;
  failed: number;
  firstError: string | null;
}

/**
 * Mutates `repos` in place, attaching `botChurn` to every repo pushed within the
 * freshness window whose commit fetch succeeds. A per-repo failure (empty repo, 403,
 * transient API error) never aborts the run — it just means that repo is not considered
 * for the bot-churn-freshness class this run (`LiveRepo.botChurn` stays `undefined`,
 * `diffFleet`'s documented contract for "no sample"). Returns attempted/failed counts so
 * the caller can tell "systemic" (every attempt failed — almost certainly a permission
 * gap, see file header) from "a few flaky repos" (leave the per-repo warnings, no
 * aggregate alarm needed).
 */
function attachBotChurn(repos: LiveRepo[], now: Date): BotChurnFetchOutcome {
  const outcome: BotChurnFetchOutcome = { attempted: 0, failed: 0, firstError: null };
  for (const repo of repos) {
    if (!isWithinFreshnessWindow(repo.pushedAt, now)) continue;
    outcome.attempted += 1;
    try {
      const commits = fetchCommitAuthors(repo.name);
      repo.botChurn = computeBotChurnSample(commits);
    } catch (err) {
      outcome.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (outcome.firstError === null) outcome.firstError = msg;
      console.warn(`repo-hygiene: commit fetch failed for ${repo.name}, skipping bot-churn check for it this run: ${msg}`);
    }
  }
  return outcome;
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const now = new Date();

  const baselineFile = loadBaseline();
  const { repos: liveRepos, hitCap } = listLiveRepos();
  if (hitCap) {
    // codex review (2026-08-14, ops#101 PR pass 1, P2): a mere warning was insufficient —
    // continuing to diff a TRUNCATED live list would make every baseline repo past the cap
    // read as `baseline-repo-gone` (a false "deleted or transferred") purely because the
    // enumeration page never reached it, and the issue body would hand a human a wrong
    // "remove this line" instruction for a repo that still exists. Rule #331: the cap is a
    // safety bound, not a paging mechanism — a full final page means "stop and say so,"
    // never "silently proceed on a partial picture." Fail the whole run loud instead.
    throw new Error(
      `live enumeration returned exactly the ${LIVE_ENUMERATION_LIMIT}-repo cap — the org has grown to/past it, so this run cannot see the full fleet and refuses to diff a truncated list (a partial diff would falsely report real repos past the cap as baseline-repo-gone). Raise LIVE_ENUMERATION_LIMIT in repo-hygiene-worker.ts and re-run.`,
    );
  }

  const botChurnOutcome = attachBotChurn(liveRepos, now);
  // "Systemic" = every attempt failed (and at least one was attempted) — a strong signal
  // of a permission gap rather than N independent flaky repos; collapses N near-identical
  // per-repo warnings above into ONE loud, actionable line (see file header).
  const botChurnSystemic =
    botChurnOutcome.attempted > 0 && botChurnOutcome.failed === botChurnOutcome.attempted
      ? { attempted: botChurnOutcome.attempted, firstError: botChurnOutcome.firstError ?? "unknown error" }
      : undefined;
  if (botChurnSystemic) {
    console.warn(
      `repo-hygiene: bot-churn commit fetch failed for ALL ${botChurnSystemic.attempted} attempted repo(s) this run — reads as a permission gap (Contents:read missing on the fleet App), not per-repo flakiness. bot-churn-freshness will report 0 findings until fixed. First error: ${botChurnSystemic.firstError}`,
    );
  }

  const findings = diffFleet(baselineFile, liveRepos);
  const summary = summarizeFindings(findings);

  // "open" = OPEN only; a CLOSED issue from a prior clean run is not this run's concern —
  // planIssueAction's "open" branch handles "no currently-open issue" identically whether
  // one never existed or one closed long ago.
  const openIssues = listIssuesByLabel(REPO, LABEL, "open");
  const existing = openIssues.find((i) => i.title === TITLE && i.state === "OPEN");
  // codex review (2026-08-14, ops#101 PR pass 2, P2): `findings.length` alone would let a
  // fully-broken bot-churn leg (findings.length === 0 whenever no OTHER drift exists) plan
  // "none" and exit green forever, in production today — see alertWorthyCount's doc
  // comment. The issue stays open (carrying the degradation note) until Contents:read is
  // granted and bot-churn starts succeeding again, exactly like any other finding.
  const alertCount = alertWorthyCount(findings, Boolean(botChurnSystemic));
  const action = planIssueAction(alertCount, Boolean(existing));

  const body = renderDriftIssueBody(findings, {
    org: ORG,
    liveRepoCount: liveRepos.length,
    baselineRepoCount: baselineFile.repos.length,
    baselineRulesVersion: baselineFile.rulesVersion,
    baselineSeededAt: baselineFile.seededAt,
    generatedAt: now.toISOString(),
    botChurnSystemicFailure: botChurnSystemic,
  });

  console.log(`=== repo-hygiene-worker${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""} ===`);
  console.log(`Org: ${ORG} · Baseline: ${baselineFile.repos.length} repos (rulesVersion ${baselineFile.rulesVersion}, seeded ${baselineFile.seededAt}) · Live: ${liveRepos.length} repos${hitCap ? " (AT ENUMERATION CAP)" : ""}`);
  console.log(`bot-churn: attempted ${botChurnOutcome.attempted}, failed ${botChurnOutcome.failed}${botChurnSystemic ? " (SYSTEMIC — see warning above)" : ""}`);
  console.log(`Existing aggregate issue: ${existing ? `#${existing.number} OPEN` : "none open"}`);
  console.log(`Findings: ${findings.length} · alert-worthy count (incl. systemic bot-churn failure): ${alertCount}`);
  console.log(`Planned action: ${action.toUpperCase()}`);
  console.log(summary);

  if (dryRun) {
    console.log("\n--- would-be issue body ---");
    console.log(body);
    console.log("\n(dry run — no issue was opened, updated, or closed)");
    return;
  }

  if (action === "open") {
    ensureLabel(REPO, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
    openIssue(REPO, LABEL, TITLE, body);
  } else if (action === "update") {
    ensureLabel(REPO, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
    // No dedicated "edit body" helper exists in lib/github-issues.ts (every other monitor
    // in this repo either opens a fresh per-entity issue or retitles one — none refreshes
    // a body in place), so this uses that file's exported raw `gh` passthrough directly,
    // exactly as needs-human-crossrepo.ts and pr-automerge-gate.ts do for operations
    // without a named helper.
    gh(["issue", "edit", String(existing!.number), "--repo", REPO, "--body", body]);
  } else if (action === "close") {
    // Only reachable at alertCount === 0, which requires BOTH zero real findings AND no
    // systemic bot-churn failure this run (Rule #412 — the close comment says what was
    // actually verified, not just "no drift").
    closeIssue(
      REPO,
      existing!.number,
      `Fleet is clean vs the committed baseline — 0 findings this run, and bot-churn commit checks ran successfully (no systemic failure). Auto-closed by the repo-hygiene worker.\n\n${summary}.`,
    );
  }

  console.log(`repo-hygiene-worker done: ${action}.`);
}

main().catch((err) => {
  console.error(`repo-hygiene-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
