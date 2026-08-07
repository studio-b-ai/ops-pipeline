#!/usr/bin/env tsx
/**
 * squasher-health.ts — Project 2 (Squasher Health monitor).
 *
 * Watches ONE caller repo's auto-merge sweep and keeps the 2026-08-04 un-gating
 * from silently rotting: the gate spent a month structurally inert (#19 → #23 →
 * #29) with nothing red anywhere, because fail-closed defects read as "no
 * eligible PRs". This monitor makes that state LOUD.
 *
 * Architecture: runs IN each caller repo (scheduled caller → this script via the
 * reusable workflow), reading the repo's OWN workflow runs with its OWN
 * GITHUB_TOKEN — keyless by construction (#302's ladder: no PAT minted, no
 * cross-repo credential exists to leak). Machinery issues open in the CALLER
 * repo per the fleet issues law (#165 amendment: open issue = condition active,
 * auto-reconciled; ref lib/github-issues.ts).
 *
 * Conditions (each its own auto-reconciled issue; see lib/squasher-health-classify.ts):
 *   dead-sweep · runs-failing · crash-receipts (leg=other, crash-only post-#26)
 *
 * SLA honesty (#412/#448): sweeps run hourly; this check runs every 2h with a
 * 4h window, so a dead sweep surfaces within ~6h worst-case. The stated SLA is
 * ~6h, not "immediately". An inert gate fails SAFE (PRs wait for humans — the
 * pre-gate status quo), which is why hours-scale detection is proportionate.
 *
 * Planted-control seam (#471 — a fail-open detector is proven by a known-bad
 * that FIRES): the caller's workflow_dispatch accepts `sla_hours`; dispatching
 * with a sub-minute value makes dead-sweep fire against REAL data, opening a
 * real issue the next normal run auto-closes — both reconcile directions proven
 * live without breaking anything.
 */

import { execFileSync } from "node:child_process";
import { requireEnv } from "./lib/config.js";
import { classifyHealth, conditionTitle, parseReceipts, type HealthCondition, type RunJobEvidence, type SweepRun } from "./lib/squasher-health-classify.js";
import { reconcileCondition } from "./lib/gateway-token-reconcile.js";
import { ensureLabel, listIssuesByLabel, openIssue, closeIssue } from "./lib/github-issues.js";

const LABEL = "squasher-health";
const SWEEP_WORKFLOW = "squasher-automerge.yml";
const RUN_LOOKBACK = 12; // runs listed for SLA/conclusion checks
const LOG_LOOKBACK = 6; // completed runs whose logs are scanned for receipts (logs are the expensive read)
const ALL_KEYS: HealthCondition["key"][] = [
  "dead-sweep",
  "runs-failing",
  "crash-receipts",
  "sweep-infrastructure",
];

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function listSweepRuns(repo: string): SweepRun[] {
  const raw = gh([
    "run", "list", "--repo", repo, "--workflow", SWEEP_WORKFLOW,
    "--limit", String(RUN_LOOKBACK),
    "--json", "databaseId,status,conclusion,createdAt",
  ]);
  return JSON.parse(raw) as SweepRun[];
}

function fetchRunLog(repo: string, id: number): string {
  try {
    return gh(["run", "view", String(id), "--repo", repo, "--log"]);
  } catch {
    // Expired/evicted logs read as empty, never as evidence of health OR failure —
    // the receipts condition just sees fewer runs (#413: logs are a windowed
    // instrument; the run list above is the durable one for liveness).
    return "";
  }
}

/**
 * Job conclusions + failed-step count for one run. Returns undefined on any read
 * failure — absent evidence must degrade to "classify from the run conclusion alone"
 * (the pre-existing behaviour), never to a silent infrastructure verdict that would
 * suppress a real machinery failure.
 */
function fetchRunJobEvidence(repo: string, id: number): RunJobEvidence | undefined {
  try {
    const raw = gh(["run", "view", String(id), "--repo", repo, "--json", "jobs"]);
    const parsed = JSON.parse(raw) as {
      jobs?: { conclusion: string | null; steps?: { conclusion: string | null }[] }[];
    };
    const jobs = parsed.jobs ?? [];
    if (jobs.length === 0) return undefined;
    return {
      jobConclusions: jobs.map((j) => j.conclusion),
      failedStepCount: jobs.reduce(
        (n, j) => n + (j.steps ?? []).filter((s) => s.conclusion === "failure").length,
        0,
      ),
    };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const repo = requireEnv("HEALTH_REPO");
  const slaHours = Number(process.env.HEALTH_SLA_HOURS || "4");
  if (!Number.isFinite(slaHours) || slaHours <= 0) throw new Error(`HEALTH_SLA_HOURS invalid: ${process.env.HEALTH_SLA_HOURS}`);
  const dryRun = process.argv.includes("--dry-run");

  const runs = listSweepRuns(repo);
  const completed = runs.filter((r) => r.status === "completed").slice(0, LOG_LOOKBACK);
  const logText = completed.map((r) => fetchRunLog(repo, r.databaseId)).join("\n");
  const receipts = parseReceipts(logText);

  // Job-level evidence for the latest completed run, fetched ONLY when that run did
  // not succeed (one extra API call, and only on the unhappy path). The run-level
  // conclusion cannot distinguish "cancelled mid-flight" from "the gate errored" —
  // GitHub reports both as 'failure'. See isInfrastructureRun.
  const latestCompleted = runs.find((r) => r.status === "completed");
  let latestRunJobs: RunJobEvidence | undefined;
  if (latestCompleted && latestCompleted.conclusion !== "success") {
    latestRunJobs = fetchRunJobEvidence(repo, latestCompleted.databaseId);
  }

  const conditions = classifyHealth(runs, receipts, slaHours, new Date(), latestRunJobs);
  const activeKeys = new Set(conditions.map((c) => c.key));

  const open = listIssuesByLabel(repo, LABEL, "open");
  const openByTitle = new Map(open.map((i) => [i.title, i]));

  const planned: Array<{ action: "open" | "close"; title: string; num?: number; body?: string; comment?: string }> = [];
  for (const key of ALL_KEYS) {
    const title = conditionTitle(repo, key);
    const existing = openByTitle.get(title);
    const action = reconcileCondition(activeKeys.has(key), Boolean(existing));
    if (action === "open") {
      const cond = conditions.find((c) => c.key === key)!;
      planned.push({
        action, title,
        body: [
          cond.detail,
          "",
          `Sweep workflow: \`${SWEEP_WORKFLOW}\` · SLA window: ${slaHours}h · runs inspected: ${runs.length} (logs read: ${completed.length}).`,
          "",
          "Fire a sweep NOW to re-test (Rule #447): `gh workflow run squasher-automerge.yml --repo " + repo + "` — then re-run this health check the same way.",
          "",
          "This issue auto-closes when the condition clears (open = condition active).",
        ].join("\n"),
      });
    }
    if (action === "close" && existing) {
      planned.push({ action, title, num: existing.number, comment: `Condition \`${key}\` cleared on the latest health check — auto-closed. (Counts this run: ${runs.length} runs listed, ${receipts.length} receipts parsed, ${conditions.length} condition(s) active.)` });
    }
  }

  const summary = `Squasher health — ${repo}: ${runs.length} run(s) listed, ${receipts.length} receipt(s) parsed, active condition(s): ${conditions.map((c) => c.key).join(", ") || "none"}; issue action(s): ${planned.length}.`;
  if (dryRun) {
    console.log("=== squasher-health --dry-run (real reads, NO mutations) ===");
    for (const c of conditions) console.log(`  ACTIVE ${c.key}: ${c.detail.slice(0, 140)}`);
    for (const p of planned) console.log(`  would ${p.action.toUpperCase()}: ${p.title}`);
    console.log(summary);
    return;
  }

  if (planned.length > 0) ensureLabel(repo, LABEL, "squasher auto-merge gate health (open = condition active)", "B60205");
  for (const p of planned) {
    if (p.action === "open") openIssue(repo, LABEL, p.title, p.body ?? "");
    if (p.action === "close" && p.num !== undefined) closeIssue(repo, p.num, p.comment ?? "");
  }
  console.log(summary);
}

main().catch((e) => {
  console.error(`squasher-health FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
