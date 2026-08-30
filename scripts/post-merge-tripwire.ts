/**
 * post-merge-tripwire.ts — post-merge 5xx regression tripwire for autonomously-merged
 * code-fix PRs (ops-pipeline#190 B2; design of record
 * docs/plans/2026-08-28-automerge-b-plus-a-v2.md §4.2).
 *
 * Fired by the reusable workflow on `pull_request: closed` + `merged == true` +
 * `automerge:code-fix` label. The LABEL is a cheap filter with ZERO authority — the verdict
 * that this PR was a qualifying code-fix is RE-DERIVED server-side here (same predicates the
 * gate used, imported from lib/automerge-classify.ts — Rule #283: one classification path,
 * never a fork), because a hand-applied label on an arbitrary merged PR must buy an attacker
 * nothing but a refusal receipt.
 *
 * Flow: re-derive class → attribute the Railway deployment (commitHash === squash sha AND
 * createdAt after PR close; bind by id on first match) → wait for SUCCESS → sleep out the
 * 10-min health window → ONE metrics read → verdict. On sustained 5xx: auto-OPEN a revert PR
 * (NEVER auto-merged — Rule #97; a human decides) + escalate. Every blind-instrument path
 * (metrics fetch failure, attribution timeout, deploy failure) ESCALATES as a GitHub issue in
 * the target repo (Rule #165 machinery lane) instead of silently passing (#322/#456).
 *
 * Exit contract: exit 0 = a verdict/receipt/escalation was rendered (the issue is the alarm,
 * not the job status). Throw → exit 1 ONLY for input-contract violations (bad argv, PR not
 * actually merged, workflow-supplied sha disagreeing with the server) — a red job there is
 * correct fail-loud for a malformed invocation.
 *
 * Stated residuals (§4.2, Rule #412 — what this alert may NOT claim to cover):
 * 2xx-wrong-content, 401/403/404 regressions, async-job breakage, and low-traffic windows
 * all PASS. This is a 5xx tripwire, not a health oracle.
 */

import { execFileSync } from "node:child_process";

import {
  classifyPrDiffClass,
  gateDecisionForClass,
  parseUnifiedDiff,
  reconcileFileClasses,
  requiredChecksSatisfied,
  type RollupItem,
} from "./lib/automerge-classify.js";
import { ensureLabel, gh, openIssue } from "./lib/github-issues.js";
import {
  fetchDeploymentsWithMeta,
  fetchHttpMetricsGroupedByStatus,
  type DeploymentWithMeta,
} from "./lib/railway-deployment-probes.js";
import { parseTripwireArgs, type TripwireArgs } from "./lib/tripwire-args.js";
import {
  attributeDeployment,
  classifyHealthWindow,
  detectWindowContamination,
  STEP_SECONDS,
  WINDOW_SECONDS,
} from "./lib/tripwire-health.js";

const TRIPWIRE_LABEL = "post-merge-tripwire";
const TRIPWIRE_LABEL_DESCRIPTION = "Post-merge 5xx tripwire escalations (ops-pipeline#190 B2)";
const TRIPWIRE_LABEL_COLOR = "d93f0b";

/** Attribution: poll every 30s for up to 15 min (§4.2 — then escalate, no revert). */
const ATTRIBUTION_POLL_MS = 30_000;
const ATTRIBUTION_TIMEOUT_MS = 15 * 60_000;

/** SUCCESS wait: poll every 30s for up to 30 min (build+deploy budget; then escalate). */
const SUCCESS_POLL_MS = 30_000;
const SUCCESS_TIMEOUT_MS = 30 * 60_000;

/** Post-window slack before the single metrics read, so the last buckets have landed. */
const METRICS_SETTLE_MS = 30_000;

/** GitHub's commits API caps `files[]` at 300 entries — at/over it the list may be truncated. */
const COMMIT_FILES_API_CAP = 300;

const BOT_NAME = "studiob-fleet-bot";
const BOT_EMAIL = "studiob-fleet-bot[bot]@users.noreply.github.com";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) {
    throw new Error(`required env var ${name} is not set`);
  }
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  console.log(`[tripwire] ${new Date().toISOString()} ${msg}`);
}

// ───────────────────────────── receipts + escalations ─────────────────────────────

function commentOnPr(repo: string, pr: number, body: string): void {
  gh(["pr", "comment", String(pr), "--repo", repo, "--body", body]);
}

/**
 * Machinery-lane escalation (Rule #165): an open issue in the TARGET repo is the alarm.
 * These are point-event escalations (a trip / a blind window / a dead deploy) — humans
 * close them; there is no "condition cleared" auto-close for a completed window.
 */
function escalate(repo: string, title: string, body: string): void {
  ensureLabel(repo, TRIPWIRE_LABEL, TRIPWIRE_LABEL_DESCRIPTION, TRIPWIRE_LABEL_COLOR);
  openIssue(repo, TRIPWIRE_LABEL, title, body);
}

function receiptHeader(args: TripwireArgs): string {
  return `**post-merge tripwire** (ops-pipeline#190 B2) — PR #${args.pr}, squash \`${args.mergeSha.slice(0, 7)}\``;
}

// ───────────────────────────── PR + diff (re-derivation inputs) ─────────────────────────────

interface MergedPrJson {
  state: string;
  author: { login: string };
  labels: { name: string }[];
  mergeCommit: { oid: string } | null;
  statusCheckRollup: RollupItem[] | null;
}

function fetchMergedPr(repo: string, pr: number): MergedPrJson {
  const raw = gh([
    "pr",
    "view",
    String(pr),
    "--repo",
    repo,
    "--json",
    "state,author,labels,mergeCommit,statusCheckRollup",
  ]);
  return JSON.parse(raw) as MergedPrJson;
}

interface CommitFilesJson {
  files?: { filename: string; additions: number; deletions: number }[];
  stats?: { total: number };
}

interface SquashDiff {
  paths: string[];
  totalChangedLines: number;
  diffText: string;
}

/**
 * The squash COMMIT's own diff — never the gate's base...head compare, which is wrong
 * after merge (base has moved; the ABA problem the gate's fetchDiffBySha doc describes
 * applies doubly here). Two truncation guards fail CLOSED via throw (caller escalates):
 * the commits API caps files[] at 300, and a per-file additions+deletions sum that
 * disagrees with stats.total means the file list does not describe the whole commit.
 */
function fetchSquashCommitDiff(repo: string, sha: string): SquashDiff {
  const jsonRaw = gh(["api", `repos/${repo}/commits/${sha}`]);
  const json = JSON.parse(jsonRaw) as CommitFilesJson;
  const files = json.files ?? [];
  const statsTotal = json.stats?.total;

  if (files.length >= COMMIT_FILES_API_CAP) {
    throw new Error(`commit ${sha} reports ${files.length} files — at/over the API's 300-file cap, list may be truncated (fail-closed)`);
  }
  if (statsTotal === undefined) {
    throw new Error(`commit ${sha} response has no stats.total — cannot verify file-list completeness (fail-closed)`);
  }
  const sum = files.reduce((acc, f) => acc + f.additions + f.deletions, 0);
  if (sum !== statsTotal) {
    throw new Error(`commit ${sha} per-file additions+deletions sum ${sum} !== stats.total ${statsTotal} — file list incomplete (fail-closed)`);
  }

  const diffText = gh(["api", `repos/${repo}/commits/${sha}`, "-H", "Accept: application/vnd.github.diff"]);
  return { paths: files.map((f) => f.filename), totalChangedLines: statsTotal, diffText };
}

// ───────────────────────────── §4.1 re-derivation ─────────────────────────────

interface ReDerivation {
  ok: boolean;
  reasons: string[];
}

/**
 * Re-runs the gate's own qualification predicates against the MERGED artifact: diff class
 * must resolve to "code-fix" under the caller's safe-path globs + sensitive-path denylist,
 * the universal legs (author, `bugsquasher` label) must hold, and the caller's named
 * required checks must be SUCCESS on the final rollup.
 *
 * `ciClean: true` and `reviewVerdict: "CLEAN"` are constants — deliberately INHERITED,
 * not re-verified (codex P2, 2026-08-30 pass 1, resolution documented here): CI is
 * re-verified independently via requiredChecksSatisfied on the final rollup, but the
 * review leg has no durable machine receipt worth coupling to — the pre-merge gate's
 * receipt COMMENT would make a brittle oracle whose false refusal (format drift) silently
 * skips the whole health window, a worse failure than the residual it closes. Stated
 * consequence (#412): a human who hand-merges a squasher-authored PR with the label
 * applied gets a health window watched even if the pre-merge review had FLAGged — that
 * fail-open direction grants monitoring coverage, not merge authority, and every
 * remediation behind it stays human-gated (#97).
 */
function reDeriveCodeFix(args: TripwireArgs, pr: MergedPrJson, diff: SquashDiff): ReDerivation {
  const parsed = parseUnifiedDiff(diff.diffText);
  const files = reconcileFileClasses(diff.paths, parsed);

  const cls = classifyPrDiffClass({
    files,
    totalChangedLines: diff.totalChangedLines,
    safePathGlobs: args.safePathGlobs,
    sensitivePathPatterns: args.sensitivePaths,
  });
  if (cls.prClass !== "code-fix") {
    return {
      ok: false,
      reasons: [`diff class re-derivation: ${cls.prClass ?? "null"} (${cls.reasons.join("; ") || "no reasons"})`],
    };
  }

  const gate = gateDecisionForClass({
    prClass: "code-fix",
    author: pr.author.login,
    labels: pr.labels.map((l) => l.name),
    ciClean: true,
    reviewVerdict: "CLEAN",
  });
  if (gate.decision !== "merge") {
    return { ok: false, reasons: gate.reasons };
  }

  const checks = requiredChecksSatisfied(pr.statusCheckRollup ?? [], args.requiredChecks);
  if (!checks.ok) {
    return { ok: false, reasons: checks.reasons };
  }

  return { ok: true, reasons: [] };
}

// ───────────────────────────── revert PR ─────────────────────────────

function git(targetDir: string, gitArgs: string[]): string {
  return execFileSync("git", ["-C", targetDir, ...gitArgs], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

type RevertResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Opens (never merges — Rule #97) a revert PR for the squash commit, from the caller-repo
 * checkout the workflow prepared with App-token credentials. A conflict aborts cleanly and
 * comes back as {ok:false} for the caller to escalate as "manual revert needed".
 */
function openRevertPr(args: TripwireArgs, detail: string): RevertResult {
  const shortSha = args.mergeSha.slice(0, 7);
  const branch = `revert/tripwire-${args.pr}-${shortSha}`;
  try {
    // Backstop: make sure the squash sha object exists locally even on a shallow checkout.
    git(args.targetDir, ["fetch", "--depth=2", "origin", args.mergeSha]);
    git(args.targetDir, ["checkout", "-B", branch]);
    try {
      git(args.targetDir, [
        "-c",
        `user.name=${BOT_NAME}`,
        "-c",
        `user.email=${BOT_EMAIL}`,
        "revert",
        "--no-edit",
        args.mergeSha,
      ]);
    } catch (revertErr) {
      try {
        git(args.targetDir, ["revert", "--abort"]);
      } catch {
        // abort is best-effort — the checkout is a throwaway workflow workspace
      }
      const message = revertErr instanceof Error ? revertErr.message : String(revertErr);
      return { ok: false, error: `git revert conflicted or failed: ${message}` };
    }
    git(args.targetDir, ["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);

    const title = `Revert tripwire: PR #${args.pr} — sustained 5xx after deploy`;
    const body = [
      `Auto-opened by the post-merge 5xx tripwire (ops-pipeline#190 B2). **This PR is NEVER auto-merged** — a human decides (Rule #97).`,
      ``,
      `Reverts squash commit \`${args.mergeSha}\` from #${args.pr}.`,
      ``,
      detail,
      ``,
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
    ].join("\n");
    const url = gh([
      "pr",
      "create",
      "--repo",
      args.repo,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]).trim();
    return { ok: true, url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A re-run can hit "a pull request already exists" — surface the existing PR as success.
    if (/already exists/i.test(message)) {
      try {
        const listRaw = gh(["pr", "list", "--repo", args.repo, "--head", branch, "--json", "url", "--limit", "1"]);
        const list = JSON.parse(listRaw) as { url: string }[];
        if (list.length > 0) return { ok: true, url: list[0].url };
      } catch {
        // fall through to the error return
      }
    }
    return { ok: false, error: message };
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const args = parseTripwireArgs(process.argv.slice(2));
  const railwayToken = requireEnv("RAILWAY_API_TOKEN");
  const header = receiptHeader(args);

  log(`start: ${args.repo}#${args.pr} squash ${args.mergeSha} service ${args.serviceId}`);

  // ── input integrity (throw = red job; a malformed invocation is not a verdict) ──
  const pr = fetchMergedPr(args.repo, args.pr);
  if (pr.state !== "MERGED") {
    throw new Error(`PR #${args.pr} state is ${pr.state}, not MERGED — tripwire only runs on merged PRs`);
  }
  const serverSha = pr.mergeCommit?.oid?.toLowerCase();
  if (serverSha !== args.mergeSha) {
    throw new Error(`workflow-supplied merge sha ${args.mergeSha} !== server mergeCommit.oid ${serverSha ?? "null"} — input integrity failure`);
  }

  // ── §4.1 re-derivation (the label bought entry to THIS check, nothing more) ──
  let diff: SquashDiff;
  try {
    diff = fetchSquashCommitDiff(args.repo, args.mergeSha);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`re-derivation blind: ${message}`);
    escalate(
      args.repo,
      `tripwire could not re-derive PR #${args.pr} — diff unreadable`,
      `${header}\n\nThe tripwire could not fetch a complete squash-commit diff, so it cannot verify the merged PR was a qualifying code-fix and cannot honestly watch the window (fail-closed, no revert):\n\n\`\`\`\n${message}\n\`\`\`\n\nManual check of the deploy's health is needed.`,
    );
    commentOnPr(args.repo, args.pr, `${header}\n\n⚠️ Could not re-derive the diff class (${message}) — escalated as an issue; no health verdict was rendered.`);
    return;
  }

  const derivation = reDeriveCodeFix(args, pr, diff);
  if (!derivation.ok) {
    log(`refusal: not code-fix class — ${derivation.reasons.join("; ")}`);
    commentOnPr(
      args.repo,
      args.pr,
      `${header}\n\n**Refused: not code-fix class.** The \`automerge:code-fix\` label is a filter, not authority — re-derivation against the squash commit did not qualify this PR, so the tripwire took no action:\n${derivation.reasons.map((r) => `- ${r}`).join("\n")}`,
    );
    return;
  }
  log(`re-derivation: code-fix confirmed — class+author+label+checks re-verified, review leg inherited from the pre-merge gate (${diff.paths.length} files, ${diff.totalChangedLines} lines)`);

  // ── attribution: bind exactly one deployment by squash sha + createdAt after close ──
  const attributionDeadline = Date.now() + ATTRIBUTION_TIMEOUT_MS;
  let bound: DeploymentWithMeta | null = null;
  let lastFetchError: string | null = null;
  while (Date.now() < attributionDeadline) {
    const res = await fetchDeploymentsWithMeta(railwayToken, args.projectId, args.environmentId, args.serviceId);
    if (!res.ok) {
      lastFetchError = res.error;
      log(`attribution poll: fetch failed (${res.error}) — retrying`);
    } else {
      lastFetchError = null;
      bound = attributeDeployment(res.deployments, args.mergeSha, args.closedAt);
      if (bound !== null) break;
      log(`attribution poll: no qualifying deployment yet (${res.deployments.length} recent examined)`);
    }
    await sleep(ATTRIBUTION_POLL_MS);
  }
  if (bound === null) {
    const why = lastFetchError !== null ? `Railway deployments API unreadable (last error: ${lastFetchError})` : `no deployment with commitHash ${args.mergeSha} created after ${args.closedAt} appeared within ${ATTRIBUTION_TIMEOUT_MS / 60_000} min`;
    log(`attribution timeout: ${why}`);
    escalate(
      args.repo,
      `tripwire: deploy never attributed for PR #${args.pr}`,
      `${header}\n\n${why}.\n\nNo revert (a missing deploy is a deploy-pipeline question, not a health verdict) — but the merged code-fix is now UNWATCHED. Manual check needed.\n\n- Railway service: \`${args.serviceId}\` (env \`${args.environmentId}\`)`,
    );
    commentOnPr(args.repo, args.pr, `${header}\n\n⚠️ No Railway deployment could be attributed to this merge within ${ATTRIBUTION_TIMEOUT_MS / 60_000} min — escalated as an issue; the health window was NOT watched.`);
    return;
  }
  log(`bound deployment ${bound.id} (created ${bound.createdAt}, status ${bound.status})`);

  // ── wait for the bound deployment (by id — later redeploys neither re-arm nor re-trip) ──
  const successDeadline = Date.now() + SUCCESS_TIMEOUT_MS;
  let successAtEpochSec: number | null = null;
  let terminalFailure: string | null = null;
  while (Date.now() < successDeadline) {
    const res = await fetchDeploymentsWithMeta(railwayToken, args.projectId, args.environmentId, args.serviceId);
    if (!res.ok) {
      log(`success poll: fetch failed (${res.error}) — retrying`);
    } else {
      const current = res.deployments.find((d) => d.id === bound.id);
      if (current === undefined) {
        log(`success poll: bound deployment ${bound.id} not in the recent page — retrying`);
      } else if (current.status === "SUCCESS") {
        const parsed = Date.parse(current.updatedAt);
        successAtEpochSec = Math.floor((Number.isNaN(parsed) ? Date.now() : parsed) / 1000);
        break;
      } else if (current.status === "FAILED" || current.status === "CRASHED") {
        terminalFailure = current.status;
        break;
      } else if (current.status === "REMOVED" || current.status === "SKIPPED") {
        terminalFailure = `${current.status} (superseded before reaching SUCCESS)`;
        break;
      } else {
        log(`success poll: deployment ${bound.id} status ${current.status}`);
      }
    }
    await sleep(SUCCESS_POLL_MS);
  }
  if (terminalFailure !== null) {
    log(`bound deployment terminal failure: ${terminalFailure}`);
    escalate(
      args.repo,
      `tripwire: deploy for PR #${args.pr} ended ${terminalFailure}`,
      `${header}\n\nThe deployment bound to this merge (\`${bound.id}\`) ended **${terminalFailure}** — the merged code never (cleanly) reached production, so no health window was watched and no revert was opened. This is a deploy failure escalation, not a health verdict.`,
    );
    commentOnPr(args.repo, args.pr, `${header}\n\n⚠️ Bound deployment \`${bound.id}\` ended **${terminalFailure}** — escalated as an issue; no health window was watched.`);
    return;
  }
  if (successAtEpochSec === null) {
    log(`success timeout: deployment ${bound.id} never reached SUCCESS within ${SUCCESS_TIMEOUT_MS / 60_000} min`);
    escalate(
      args.repo,
      `tripwire: deploy for PR #${args.pr} never reached SUCCESS`,
      `${header}\n\nDeployment \`${bound.id}\` did not reach SUCCESS within ${SUCCESS_TIMEOUT_MS / 60_000} min — the tripwire gave up WITHOUT a health verdict (no revert). Manual check needed.`,
    );
    commentOnPr(args.repo, args.pr, `${header}\n\n⚠️ Bound deployment \`${bound.id}\` never reached SUCCESS within ${SUCCESS_TIMEOUT_MS / 60_000} min — escalated as an issue.`);
    return;
  }
  log(`deployment ${bound.id} SUCCESS at ${new Date(successAtEpochSec * 1000).toISOString()} — watching ${WINDOW_SECONDS}s window`);

  // ── sleep out the window, then ONE metrics read (§4.2 — no mid-window peeking in v1) ──
  const windowCloseMs = (successAtEpochSec + WINDOW_SECONDS) * 1000 + METRICS_SETTLE_MS;
  const waitMs = windowCloseMs - Date.now();
  if (waitMs > 0) await sleep(waitMs);

  const startIso = new Date(successAtEpochSec * 1000).toISOString();
  const endIso = new Date((successAtEpochSec + WINDOW_SECONDS) * 1000).toISOString();

  // ── window purity: Railway metrics are SERVICE-scoped, so the verdict is only
  // attributable to the bound deployment if it stayed the serving deployment for the
  // whole window (codex P1, 2026-08-30 pass 1). A contaminated window gets NO verdict —
  // 5xx in it belongs to an unknown mix of deploys, and reverting OUR PR over another
  // deploy's errors is the #295 false-revert generator.
  const purity = await fetchDeploymentsWithMeta(railwayToken, args.projectId, args.environmentId, args.serviceId);
  if (!purity.ok) {
    log(`purity refetch failed: ${purity.error}`);
    escalate(
      args.repo,
      `tripwire blind: cannot verify window purity for PR #${args.pr}`,
      `${header}\n\nThe post-window deployments refetch failed, so the tripwire cannot verify that deployment \`${bound.id}\` was still the serving deployment for the whole window — the purity check is part of the instrument, and a blind instrument never passes (Rules #322/#456). NO verdict was rendered (no revert either).\n\n\`\`\`\n${purity.error}\n\`\`\`\n\n- Window: ${startIso} → ${endIso}\n- Manual check of the service's deploy timeline + 5xx rate for that window is needed.`,
    );
    commentOnPr(args.repo, args.pr, `${header}\n\n⚠️ Could not verify window purity (deployments refetch failed) — escalated as an issue; NO verdict was rendered.`);
    return;
  }
  const contamination = detectWindowContamination(purity.deployments, bound);
  if (contamination.contaminated) {
    log(`window contaminated: ${contamination.reason}`);
    escalate(
      args.repo,
      `tripwire: health window contaminated for PR #${args.pr}`,
      `${header}\n\nThe health window was CONTAMINATED by deploy activity after the bound deployment — service-level 5xx metrics for it cannot be attributed to this PR, so the tripwire rendered NO verdict (never pass, never trip; Rule #295 — a revert here could punish this PR for another deploy's errors).\n\n- ${contamination.reason}\n- Window: ${startIso} → ${endIso}\n- Manual check: the service's deploy timeline + 5xx rate for that window.`,
    );
    commentOnPr(args.repo, args.pr, `${header}\n\n⚠️ **Health window contaminated** by subsequent deploy activity — NO verdict was rendered (escalated as an issue): ${contamination.reason}`);
    return;
  }

  const metrics = await fetchHttpMetricsGroupedByStatus(
    railwayToken,
    args.environmentId,
    args.serviceId,
    startIso,
    endIso,
    STEP_SECONDS,
  );
  if (!metrics.ok) {
    log(`metrics fetch failed: ${metrics.error}`);
    escalate(
      args.repo,
      `tripwire blind: metrics unreadable for PR #${args.pr}'s window`,
      `${header}\n\nThe single end-of-window metrics read failed — the tripwire is a BLIND instrument for this window and refuses to render a pass (Rules #322/#456). No revert (no evidence of regression either).\n\n\`\`\`\n${metrics.error}\n\`\`\`\n\n- Deployment: \`${bound.id}\`, window ${startIso} → ${endIso}\n- Manual check of the service's 5xx rate for that window is needed.`,
    );
    commentOnPr(args.repo, args.pr, `${header}\n\n⚠️ Metrics read failed for the health window — escalated as an issue; NO verdict was rendered (a blind instrument never passes).`);
    return;
  }

  const verdict = classifyHealthWindow(metrics.groups, { successAtEpochSec });
  const windowLine = `Deployment \`${bound.id}\` · window ${startIso} → ${endIso} · ${verdict.detail}`;

  if (verdict.verdict === "pass") {
    log(`PASS: ${verdict.detail}`);
    commentOnPr(args.repo, args.pr, `${header}\n\n✅ **Health window clean.** ${windowLine}`);
    return;
  }

  // ── trip: open the revert PR (human-gated) + escalate ──
  log(`TRIP: ${verdict.detail}`);
  const revert = openRevertPr(args, windowLine);
  const revertLine = revert.ok
    ? `Revert PR opened (human decision — never auto-merged, Rule #97): ${revert.url}`
    : `⚠️ Revert PR could NOT be opened (${revert.error}) — **manual revert of \`${args.mergeSha}\` needed.**`;
  escalate(
    args.repo,
    `tripwire TRIPPED: sustained 5xx after PR #${args.pr}'s deploy`,
    `${header}\n\n🔴 **Sustained 5xx in the post-deploy health window.**\n\n${windowLine}\n\n${revertLine}\n\nResiduals reminder (§4.2): this gate watched 5xx only — 2xx-wrong-content and auth/404 regressions were not in scope.`,
  );
  commentOnPr(args.repo, args.pr, `${header}\n\n🔴 **TRIPPED — sustained 5xx after deploy.** ${windowLine}\n\n${revertLine}`);
}

main().catch((err) => {
  console.error(`[tripwire] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
