#!/usr/bin/env tsx
/**
 * railway-volume-monitor.ts — CLAUDE.md Rule #302 family (fleet-wide infra monitoring).
 *
 * Origin (2026-07-27, Kevin-authorized): the aesthetik-production `Postgres` service's 500MB
 * Railway volume hit 100% and crash-looped ~10 hours, taking the whole Acumatica gateway down —
 * the volume sat ≥96% for 24h+ with ZERO alerting. This mirrors the existing
 * credential-expiry-monitor.ts pattern (same repo, same alert channels, same dedup-via-state-file
 * idiom) for Railway VOLUME USAGE instead of credential expiry.
 *
 * Every 6h (GH Actions cron): for every project visible to RAILWAY_API_TOKEN (root `projects()`
 * query, falling back to railway-projects.manifest.yaml when that field errors — see
 * lib/railway-volume-probes.ts file header for why that fallback is real, not hypothetical), for
 * every volume instance with `sizeMB > 0`:
 *   usage% = currentSizeMB / sizeMB
 *   OK (<75%) / WARN (≥75%) / CRITICAL (≥90%)
 * Alerts to #agent-escalations ONLY on a STATE TRANSITION (ok→warn, warn→critical, and recovery
 * back down) — never per run (Rules #292/#358: a cron re-firing the same WARN forever trains the
 * reader to ignore the channel). Prior state lives in railway-volume-alert-state.json, committed
 * back with `[skip ci]` — same idiom as scripts/credential-alert-state.json.
 *
 * `--dry-run` (or workflow_dispatch `dry_run: true`) still runs the REAL Railway query (this
 * monitor's whole job is reading live usage numbers — there's no meaningful secrets-free
 * classify-only mode the way the credential monitor has one) but skips the Slack posts AND the
 * state-file commit, so it's safe to run against production for a spot-check.
 *
 * Fail-loud contract (Rule #302 family): RAILWAY_API_TOKEN missing → requireEnv throws → exit 1.
 * RAILWAY_API_TOKEN present but dead/expired/malformed → the dedicated `me` liveness probe in
 * lib/railway-volume-probes.ts catches it (Railway's GraphQL API returns HTTP 200 even on auth
 * failure — verified live 2026-07-27 — so this can't be detected from HTTP status alone) → this
 * script posts a best-effort escalation AND exits 1 (workflow red). A silently-dead monitor is
 * worse than none — this is exactly the failure mode that let the volume run dark for 24h+.
 *
 * SECURITY (Rule #259/#282/#363): RAILWAY_API_TOKEN is read into a variable and passed to fetch
 * calls; it is never logged, never put in alert text, never written to the state file.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { requireEnv } from "./lib/config.js";
import { classifyUsage, computeTransition, type VolumeStatus } from "./lib/railway-volume-classify.js";
import { probeTokenAlive, discoverProjectIds, fetchProjectVolumes, type VolumeRecord, type ProjectRef } from "./lib/railway-volume-probes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(HERE, "railway-projects.manifest.yaml");
const STATE_FILE = join(HERE, "railway-volume-alert-state.json");

const CH_ESCALATIONS = "C0ATMSL2CR2"; // #agent-escalations (studiob-ai workspace — Rule #32/#165)
const CH_NOTIFICATIONS = "C0B4B3F62H2"; // #agent-notifications (studiob-ai workspace)

// ───────────────────────────── manifest (fallback project list) ─────────────────────────────

function loadManifestProjects(): ProjectRef[] {
  if (!existsSync(MANIFEST_FILE)) return [];
  const doc = parseYaml(readFileSync(MANIFEST_FILE, "utf-8")) as { projects?: ProjectRef[] };
  return doc.projects ?? [];
}

// ───────────────────────────── alert state (dedup by transition) ─────────────────────────────

type AlertState = Record<string, VolumeStatus>;

/** Stable dedup key: survives a volume being renamed only if renamed AND re-attached; that's fine — worst case is one extra alert. */
function volumeKey(v: VolumeRecord): string {
  return `${v.projectName}/${v.serviceName ?? v.environmentName}/${v.volumeName}/${v.volumeInstanceId}`;
}

function loadAlertState(): AlertState {
  if (!existsSync(STATE_FILE)) return {};
  try {
    const obj = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as unknown;
    return obj && typeof obj === "object" ? (obj as AlertState) : {};
  } catch {
    return {};
  }
}

function saveAlertState(state: AlertState): void {
  const sorted: AlertState = {};
  for (const k of Object.keys(state).sort()) sorted[k] = state[k];
  writeFileSync(STATE_FILE, JSON.stringify(sorted, null, 2) + "\n");
}

// ───────────────────────────── formatting ─────────────────────────────

function fmtMB(n: number): string {
  return `${Math.round(n).toLocaleString()}MB`;
}

const FIX_HINT = "Railway dashboard → service → volume → Live resize";

function alertText(v: VolumeRecord, usagePct: number, status: VolumeStatus, direction: "escalate" | "recover"): string {
  const where = `${v.projectName} → ${v.serviceName ?? `(detached volume, env ${v.environmentName})`} → ${v.volumeName}`;
  const pct = usagePct.toFixed(1);
  const sizes = `${fmtMB(v.currentSizeMB)} / ${fmtMB(v.sizeMB)}`;
  if (direction === "recover") {
    return `:large_green_circle: *Volume usage recovered* — \`${where}\` now *${status}* at ${pct}% (${sizes}).`;
  }
  if (status === "CRITICAL") {
    return `:red_circle: *Volume CRITICAL* — \`${where}\` at *${pct}%* (${sizes}). Fix: ${FIX_HINT}.`;
  }
  return `:warning: *Volume usage WARN* — \`${where}\` at *${pct}%* (${sizes}). Fix: ${FIX_HINT}.`;
}

function formatLine(v: VolumeRecord, usagePct: number, status: VolumeStatus): string {
  const where = `${v.projectName}/${v.serviceName ?? "(detached)"}/${v.volumeName}`;
  return `  ${where.padEnd(50)} ${status.padEnd(9)} ${usagePct.toFixed(1).padStart(5)}%  ${fmtMB(v.currentSizeMB).padStart(10)} / ${fmtMB(v.sizeMB)}`;
}

// ───────────────────────────── Slack ─────────────────────────────

async function postSlack(channel: string, text: string): Promise<void> {
  const token = requireEnv("STUDIOB_SLACK_BOT_TOKEN");
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await resp.json()) as { ok: boolean; error?: string };
  if (!json.ok) throw new Error(`Slack post to ${channel} failed: ${json.error}`);
}

/** Best-effort Slack post that never throws — used on the fail-loud paths where the caller is about to exit 1 regardless. */
async function tryPostSlack(channel: string, text: string): Promise<void> {
  try {
    await postSlack(channel, text);
  } catch (err) {
    console.error(`railway-volume-monitor: escalation Slack post also failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || process.env.RAILWAY_VOLUME_MONITOR_DRY_RUN === "true";

  const token = requireEnv("RAILWAY_API_TOKEN");

  // 1. Liveness probe FIRST — the only place an API error means "the token itself is dead"
  //    (root `projects()` erroring does NOT mean this — see step 2).
  const liveness = await probeTokenAlive(token);
  if (!liveness.ok) {
    const msg = `RAILWAY_API_TOKEN failed its liveness probe (me query): ${liveness.error}`;
    console.error(`railway-volume-monitor: ${msg}`);
    if (!dryRun) {
      await tryPostSlack(
        CH_ESCALATIONS,
        `:red_circle: *Railway volume monitor DOWN* — ${msg}. Rotate RAILWAY_API_TOKEN (Rule #302 family).`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // 2. Discover projects: root query first (fleet-wide, zero maintenance), manifest fallback
  //    second (verified-real degradation path — see lib/railway-volume-probes.ts header).
  const discovered = await discoverProjectIds(token);
  let projects: ProjectRef[];
  let source: string;
  if (discovered && discovered.length > 0) {
    projects = discovered;
    source = "graphql-projects-root";
  } else {
    projects = loadManifestProjects();
    source = "manifest-fallback";
    console.log(
      `railway-volume-monitor: projects() root query unavailable for this token — using railway-projects.manifest.yaml fallback (${projects.length} project(s)).`,
    );
  }
  if (projects.length === 0) {
    throw new Error("no projects to check: projects() root query failed/empty AND the manifest fallback is empty");
  }

  // 3. Per-project volume fetch — one bad project must not crash the whole run.
  const allVolumes: VolumeRecord[] = [];
  const projectErrors: Array<{ name: string; error: string }> = [];
  let anyTruncated = false;
  for (const p of projects) {
    const result = await fetchProjectVolumes(token, p.id);
    if (!result.ok) {
      projectErrors.push({ name: p.name, error: result.error });
      console.warn(`railway-volume-monitor: failed to fetch volumes for project "${p.name}" (${p.id}): ${result.error}`);
      continue;
    }
    allVolumes.push(...result.volumes);
    if (result.truncated) anyTruncated = true;
  }

  if (anyTruncated) {
    // Rule #331 — a fetch-all paginator silently truncating the tail is worse than an error.
    console.warn(
      "railway-volume-monitor: at least one project hit its 100-item page cap (services/environments/volumeInstances) — results may be INCOMPLETE. Raise the `first:` argument in lib/railway-volume-probes.ts or add pagination.",
    );
  }

  if (allVolumes.length === 0 && projectErrors.length === projects.length) {
    // Every project failed — this monitor is as blind as if the token were dead.
    const msg = `ALL ${projects.length} project(s) failed to fetch volumes — the monitor is effectively blind this run.`;
    console.error(`railway-volume-monitor: ${msg}`);
    if (!dryRun) {
      await tryPostSlack(CH_ESCALATIONS, `:red_circle: *Railway volume monitor DOWN* — ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  // 4. Classify + transition-dedup.
  const prevState = dryRun ? {} : loadAlertState();
  const nextState: AlertState = { ...prevState }; // carry forward unseen keys (e.g. a project that
  // failed to fetch THIS run) so a transient gap doesn't reset tracking and double-fire on recovery.
  const toPost: string[] = [];
  const rows: string[] = [];
  let warnCount = 0;
  let criticalCount = 0;

  for (const v of allVolumes) {
    const { usagePct, status } = classifyUsage(v.currentSizeMB, v.sizeMB);
    if (status === "WARN") warnCount++;
    if (status === "CRITICAL") criticalCount++;
    rows.push(formatLine(v, usagePct, status));

    const key = volumeKey(v);
    const prevStatus = prevState[key] ?? "OK"; // unseen volume = assume OK baseline (documented in computeTransition's doc comment)
    nextState[key] = status;

    const transition = computeTransition(prevStatus, status);
    if (transition.changed) {
      toPost.push(alertText(v, usagePct, status, transition.direction));
    }
  }

  const errSuffix = projectErrors.length > 0 ? ` ⚠️ ${projectErrors.length} project(s) failed to fetch (${projectErrors.map((e) => e.name).join(", ")}).` : "";
  const beacon = `:floppy_disk: Railway volume monitor — ${allVolumes.length} volume instance(s) checked across ${projects.length} project(s) (source=${source}). ${criticalCount} CRITICAL, ${warnCount} WARN.${errSuffix}`;

  if (dryRun) {
    console.log(`=== railway-volume-monitor --dry-run (real query, NO Slack post, NO state commit; source=${source}) ===`);
    console.log(`  ${"volume".padEnd(50)} ${"status".padEnd(9)} ${"usage".padStart(6)}  current / size`);
    for (const r of rows) console.log(r);
    console.log(`\n[beacon → #agent-notifications] ${beacon}`);
    console.log(`[would post ${toPost.length} alert(s) → #agent-escalations]`);
    for (const t of toPost) console.log(`  • ${t}`);
    return;
  }

  for (const text of toPost) await postSlack(CH_ESCALATIONS, text);
  await postSlack(CH_NOTIFICATIONS, beacon);
  saveAlertState(nextState);
  console.log(`Checked ${allVolumes.length} volume instance(s) across ${projects.length} project(s); posted ${toPost.length} alert(s) + 1 beacon.`);
}

main().catch((err) => {
  console.error(`railway-volume-monitor failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
