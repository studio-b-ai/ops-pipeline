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
 * Every 6h (GH Actions cron): for every project visible to RAILWAY_API_TOKEN — the root
 * `projects()` query UNIONED with railway-projects.manifest.yaml (deduped by id; the manifest is
 * a safety net, not an either/or fallback, since a scoped token's discovery list may be a real but
 * incomplete subset — see lib/railway-volume-probes.ts file header) — for every volume instance
 * with `sizeMB > 0`:
 *   usage% = currentSizeMB / sizeMB
 *   OK (<75%) / WARN (≥75%) / CRITICAL (≥90%)
 * Alerts to #agent-escalations ONLY on a STATE TRANSITION (ok→warn, warn→critical, and recovery
 * back down) — never per run (Rules #292/#358: a cron re-firing the same WARN forever trains the
 * reader to ignore the channel). A per-PROJECT fetch failure gets the same transition-deduped
 * treatment via a synthetic `PROBE_FAILED` status (mirrors credential-expiry-monitor.ts's
 * PROBE_FAILED — a monitoring gap is itself alert-worthy, not just a console.warn). Prior state
 * lives in railway-volume-alert-state.json, committed back with `[skip ci]` — same idiom as
 * scripts/credential-alert-state.json.
 *
 * `--dry-run` (or workflow_dispatch `dry_run: true`) still runs the REAL Railway query (this
 * monitor's whole job is reading live usage numbers — there's no meaningful secrets-free
 * classify-only mode the way the credential monitor has one) but skips the Slack posts AND the
 * state-file commit, so it's safe to run against production for a spot-check.
 *
 * Fail-loud contract (Rule #302 family): RAILWAY_API_TOKEN missing → requireEnv throws → exit 1.
 * RAILWAY_API_TOKEN present but dead/expired/wrong-scoped → defined operationally as "every
 * project's volume fetch failed this run" (see lib/railway-volume-probes.ts file header for why
 * this monitor deliberately does NOT gate on a `me{}` liveness probe — a codex review caught that
 * `me` is account-token-only per Railway's docs, and would false-fail on a Workspace token, which
 * is Railway's OWN recommended type for "Team CI/CD, shared automation") → this script posts a
 * best-effort escalation AND exits 1 (workflow red). A silently-dead monitor is worse than none —
 * this is exactly the failure mode that let the volume run dark for 24h+.
 *
 * SECURITY (Rule #259/#282/#363): RAILWAY_API_TOKEN is read into a variable and passed to fetch
 * calls; it is never logged, never put in alert text, never written to the state file.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { requireEnv } from "./lib/config.js";
import { classifyUsage, computeTransition, type MonitorStatus } from "./lib/railway-volume-classify.js";
import { discoverProjectIds, fetchProjectVolumes, type VolumeRecord, type ProjectRef } from "./lib/railway-volume-probes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(HERE, "railway-projects.manifest.yaml");
const STATE_FILE = join(HERE, "railway-volume-alert-state.json");

const CH_ESCALATIONS = "C0ATMSL2CR2"; // #agent-escalations (studiob-ai workspace — Rule #32/#165)
const CH_NOTIFICATIONS = "C0B4B3F62H2"; // #agent-notifications (studiob-ai workspace)

// ───────────────────────────── manifest (safety-net project list) ─────────────────────────────

function loadManifestProjects(): ProjectRef[] {
  if (!existsSync(MANIFEST_FILE)) return [];
  const doc = parseYaml(readFileSync(MANIFEST_FILE, "utf-8")) as { projects?: ProjectRef[] };
  return doc.projects ?? [];
}

/** Union two project lists, deduped by id — the manifest entry loses on a name conflict (the live API name wins). */
function unionProjects(a: ProjectRef[], b: ProjectRef[]): ProjectRef[] {
  const byId = new Map<string, ProjectRef>();
  for (const p of b) byId.set(p.id, p); // manifest first
  for (const p of a) byId.set(p.id, p); // discovered overwrites on conflict
  return [...byId.values()];
}

/** project-probe state-key prefix, namespaced away from volume keys so the two families of MonitorStatus dedup never collide. */
function projectProbeKey(projectName: string): string {
  return `project-probe:${projectName}`;
}

// ───────────────────────────── alert state (dedup by transition) ─────────────────────────────

type AlertState = Record<string, MonitorStatus>;

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

function volumeAlertText(v: VolumeRecord, usagePct: number, status: MonitorStatus, direction: "escalate" | "recover"): string {
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

function projectProbeAlertText(projectName: string, direction: "escalate" | "recover", error?: string): string {
  if (direction === "recover") {
    return `:large_green_circle: *Railway volume monitor* — project \`${projectName}\` is readable again (was failing to fetch).`;
  }
  return `:large_orange_diamond: *Railway volume monitor gap* — project \`${projectName}\` could not be checked this run: ${error ?? "unknown error"}. Its volumes are NOT being monitored until this clears.`;
}

function formatLine(v: VolumeRecord, usagePct: number, status: MonitorStatus): string {
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

/** Best-effort Slack post that never throws — used once state is ALREADY saved, so a Slack outage never blocks dedup durability. */
async function tryPostSlack(channel: string, text: string): Promise<void> {
  try {
    await postSlack(channel, text);
  } catch (err) {
    console.error(`railway-volume-monitor: a Slack post failed (state was already saved, so this won't re-fire next run): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || process.env.RAILWAY_VOLUME_MONITOR_DRY_RUN === "true";

  const token = requireEnv("RAILWAY_API_TOKEN");

  // 1. Discover projects: root query (fleet-wide, zero maintenance) UNIONED with the manifest
  //    safety net (see lib/railway-volume-probes.ts header — a scoped token's discovery list may
  //    be a real-but-incomplete subset, not just an all-or-nothing failure).
  const discovered = await discoverProjectIds(token);
  const manifestProjects = loadManifestProjects();
  const projects = discovered ? unionProjects(discovered, manifestProjects) : manifestProjects;
  const source = discovered
    ? `graphql-projects-root(${discovered.length}) ∪ manifest(${manifestProjects.length}) = ${projects.length}`
    : `manifest-only(${manifestProjects.length}) — projects() root query unavailable for this token`;
  if (!discovered) {
    console.log(`railway-volume-monitor: ${source}.`);
  }
  if (projects.length === 0) {
    throw new Error("no projects to check: projects() root query failed/empty AND the manifest is empty");
  }

  // 2. Per-project volume fetch — one bad project must not crash the whole run. A fetch failure
  //    is tracked as a first-class MonitorStatus ("PROBE_FAILED") through the SAME transition-dedup
  //    state file as volume usage, so a monitoring gap alerts once (not every run) and clears once
  //    resolved — mirrors credential-expiry-monitor.ts's PROBE_FAILED handling.
  const prevState = dryRun ? {} : loadAlertState();
  const nextState: AlertState = { ...prevState }; // carry forward anything this run didn't touch.

  const allVolumes: VolumeRecord[] = [];
  const projectErrors: Array<{ name: string; error: string }> = [];
  const probeTransitionAlerts: string[] = [];
  let anyTruncated = false;

  for (const p of projects) {
    const key = projectProbeKey(p.name);
    const prevProbeStatus = prevState[key] ?? "OK";
    const result = await fetchProjectVolumes(token, p.id);

    if (!result.ok) {
      projectErrors.push({ name: p.name, error: result.error });
      console.warn(`railway-volume-monitor: failed to fetch volumes for project "${p.name}" (${p.id}): ${result.error}`);
      nextState[key] = "PROBE_FAILED";
      const t = computeTransition(prevProbeStatus, "PROBE_FAILED");
      if (t.changed) probeTransitionAlerts.push(projectProbeAlertText(p.name, "escalate", result.error));
      continue;
    }

    nextState[key] = "OK";
    const t = computeTransition(prevProbeStatus, "OK");
    if (t.changed) probeTransitionAlerts.push(projectProbeAlertText(p.name, "recover"));

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
    // Every project failed — operationally indistinguishable from a dead/expired/wrong-scope
    // token (see file header: this replaces a `me{}` liveness gate, which a codex review found
    // would false-fail on a valid Workspace token). This monitor is as blind as if it weren't running.
    const msg = `ALL ${projects.length} project(s) failed to fetch volumes — the monitor is effectively blind this run.`;
    console.error(`railway-volume-monitor: ${msg}`);
    if (!dryRun) {
      saveAlertState(nextState); // durable BEFORE the Slack attempt (see step 4 rationale below).
      await tryPostSlack(CH_ESCALATIONS, `:red_circle: *Railway volume monitor DOWN* — ${msg} Check RAILWAY_API_TOKEN (Rule #302 family).`);
    }
    process.exitCode = 1;
    return;
  }

  // 3. Classify + transition-dedup for volume usage.
  const toPost: string[] = [...probeTransitionAlerts];
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
      toPost.push(volumeAlertText(v, usagePct, status, transition.direction === "escalate" ? "escalate" : "recover"));
    }
  }

  const errSuffix =
    projectErrors.length > 0 ? ` ⚠️ ${projectErrors.length} project(s) failed to fetch (${projectErrors.map((e) => e.name).join(", ")}).` : "";
  const beacon = `:floppy_disk: Railway volume monitor — ${allVolumes.length} volume instance(s) checked across ${projects.length} project(s) (${source}). ${criticalCount} CRITICAL, ${warnCount} WARN.${errSuffix}`;

  if (dryRun) {
    console.log(`=== railway-volume-monitor --dry-run (real query, NO Slack post, NO state commit; ${source}) ===`);
    console.log(`  ${"volume".padEnd(50)} ${"status".padEnd(9)} ${"usage".padStart(6)}  current / size`);
    for (const r of rows) console.log(r);
    console.log(`\n[beacon → #agent-notifications] ${beacon}`);
    console.log(`[would post ${toPost.length} alert(s) → #agent-escalations]`);
    for (const t of toPost) console.log(`  • ${t}`);
    return;
  }

  // 4. Save state BEFORE posting to Slack (codex review finding): the durable dedup record only
  //    needs to be correct, not to have been announced — if a Slack post throws (network blip,
  //    rate limit), the transition is still recorded, so the NEXT run won't re-discover the same
  //    transition and double-post. Losing a single notification to a Slack outage is the lesser
  //    failure mode vs. spamming duplicate alerts once Slack recovers.
  saveAlertState(nextState);
  for (const text of toPost) await tryPostSlack(CH_ESCALATIONS, text);
  await tryPostSlack(CH_NOTIFICATIONS, beacon);
  console.log(`Checked ${allVolumes.length} volume instance(s) across ${projects.length} project(s); posted ${toPost.length} alert(s) + 1 beacon.`);
}

main().catch((err) => {
  console.error(`railway-volume-monitor failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
