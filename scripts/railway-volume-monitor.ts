#!/usr/bin/env tsx
/**
 * railway-volume-monitor.ts — CLAUDE.md Rule #302 family (fleet-wide infra monitoring).
 *
 * Origin (2026-07-27, Kevin-authorized): the aesthetik-production `Postgres` service's 500MB
 * Railway volume hit 100% and crash-looped ~10 hours, taking the whole Acumatica gateway down —
 * the volume sat ≥96% for 24h+ with ZERO alerting.
 *
 * v2 (2026-07-31, Kevin directive): **GitHub issues instead of Slack**, mirroring
 * gateway-token-watch.ts (ops-pipeline#9) — an open issue IS the alert state. One issue per
 * volume instance (label `volume-monitor`), title
 * `[volume-monitor] <project>/<environment>/<service>/<volume> [<instanceId>] — WARN|CRITICAL`
 * (codex review P1, fixed pre-merge: a bare `<project>/<service>/<volume>` key can collapse TWO
 * distinct volume instances into one issue whenever a project has multiple environments sharing
 * a service/volume name — `<environment>` + `[<instanceId>]` make the key match Railway's actual
 * identity, not just its display name); usage recovering below WARN auto-closes it with a
 * comment. A per-project fetch failure gets its own binary issue (`[volume-monitor] PROBE
 * FAILED — <project>`), auto-closed on the next successful fetch. If every project's fetch fails
 * this run, one `MONITOR BLIND` issue is opened in addition to the per-project ones (and the run
 * still exits 1 — a silently-dead monitor is worse than none, see below). A severity change on an
 * ALREADY-OPEN volume issue (WARN→CRITICAL, or CRITICAL cooling to WARN) does NOT open a second
 * issue — it comments + retitles in place (`lib/severity-issue-reconcile.ts`'s
 * `reconcileSeverity`), because the stale title would otherwise misstate current severity
 * (Rule #412). This replaces both the Slack posts AND the committed dedup-state file of v1 (an
 * open issue for an active condition is the dedup, Rules #292/#358 by construction).
 *
 * Every 6h (GH Actions cron): for every project visible to RAILWAY_API_TOKEN — the root
 * `projects()` query UNIONED with railway-projects.manifest.yaml (deduped by id; the manifest is
 * a safety net, not an either/or fallback, since a scoped token's discovery list may be a real but
 * incomplete subset — see lib/railway-volume-probes.ts file header) — for every volume instance
 * with `sizeMB > 0`:
 *   usage% = currentSizeMB / sizeMB
 *   OK (<75%) / WARN (≥75%) / CRITICAL (≥90%)
 *
 * `--dry-run` (or workflow_dispatch `dry_run: true`) still runs the REAL Railway query AND the
 * REAL `gh issue list` (this monitor's whole job is reading live usage numbers and reconciling
 * against live issue state — there's no meaningful secrets-free classify-only mode the way the
 * credential monitor has one) but performs ZERO issue mutations, so it's safe to run against
 * production for a spot-check.
 *
 * Fail-loud contract (Rule #302 family): RAILWAY_API_TOKEN missing → requireEnv throws → exit 1.
 * RAILWAY_API_TOKEN present but dead/expired/wrong-scoped → defined operationally as "every
 * project's volume fetch failed this run" (see lib/railway-volume-probes.ts file header for why
 * this monitor deliberately does NOT gate on a `me{}` liveness probe — a codex review caught that
 * `me` is account-token-only per Railway's docs, and would false-fail on a Workspace token, which
 * is Railway's OWN recommended type for "Team CI/CD, shared automation") → this script opens/keeps
 * the MONITOR BLIND issue AND exits 1 (workflow red) regardless of --dry-run (a fail-loud signal
 * is not a "would post" preview) — this is exactly the failure mode that let the volume run dark
 * for 24h+.
 *
 * SECURITY (Rule #259/#282/#363): RAILWAY_API_TOKEN is read into a variable and passed to fetch
 * calls; it is never logged, never put in issue text, never written anywhere durable by this
 * script (GitHub issues ARE the durable state now, by design — Rule #97: credential/token
 * remediation stays human work, but usage-threshold facts are fine to publish).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { requireEnv } from "./lib/config.js";
import { classifyUsage, type VolumeStatus } from "./lib/railway-volume-classify.js";
import { discoverProjectIds, fetchProjectVolumes, type VolumeRecord, type ProjectRef } from "./lib/railway-volume-probes.js";
import { reconcileCondition } from "./lib/gateway-token-reconcile.js";
import { reconcileSeverity, buildSeverityTitle, parseSeverityTitle } from "./lib/severity-issue-reconcile.js";
import { listIssuesByLabel, ensureLabel, openIssue, closeIssue, commentIssue, retitleIssue, type IssueRef } from "./lib/github-issues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(HERE, "railway-projects.manifest.yaml");

const REPO = "studio-b-ai/ops-pipeline";
const LABEL = "volume-monitor";
const LABEL_DESCRIPTION = "railway-volume-monitor alert state (open = usage at/above WARN, or a project probe failing)";

const BLIND_TITLE = "[volume-monitor] MONITOR BLIND — all projects failed to fetch";
const FIX_HINT = "Railway dashboard → service → volume → Live resize";

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

/** `[volume-monitor] PROBE FAILED — <project>` — a fixed (non-severity-tiered) per-project binary condition. */
function projectProbeFailedTitle(projectName: string): string {
  return `[volume-monitor] PROBE FAILED — ${projectName}`;
}

/**
 * Stable per-volume entity key for the severity-title convention. Codex review finding (P1,
 * fixed here): a bare `<project>/<service>/<volume>` key collapses DISTINCT VolumeRecords into
 * one issue whenever a project has multiple environments (e.g. production + staging) sharing a
 * service/volume name — the loop could then schedule a duplicate open, or close one
 * environment's issue because a DIFFERENT environment's same-named volume recovered. Including
 * `environmentName` + `volumeInstanceId` makes the key match Railway's actual identity for a
 * volume instance, not just its display name.
 */
function volumeEntityKey(v: VolumeRecord): string {
  return `${v.projectName}/${v.environmentName}/${v.serviceName ?? "(detached)"}/${v.volumeName} [${v.volumeInstanceId}]`;
}

// ───────────────────────────── formatting ─────────────────────────────

function fmtMB(n: number): string {
  return `${Math.round(n).toLocaleString()}MB`;
}

function formatLine(v: VolumeRecord, usagePct: number, status: VolumeStatus): string {
  const where = `${v.projectName}/${v.serviceName ?? "(detached)"}/${v.volumeName}`;
  return `  ${where.padEnd(50)} ${status.padEnd(9)} ${usagePct.toFixed(1).padStart(5)}%  ${fmtMB(v.currentSizeMB).padStart(10)} / ${fmtMB(v.sizeMB)}`;
}

// ───────────────────────────── issue bodies / comments ─────────────────────────────

function volumeIssueBody(v: VolumeRecord, usagePct: number, status: VolumeStatus): string {
  const where = `${v.projectName} → ${v.serviceName ?? `(detached volume, env ${v.environmentName})`} → ${v.volumeName}`;
  return [
    `**${status}** — Railway volume usage at **${usagePct.toFixed(1)}%** (${fmtMB(v.currentSizeMB)} / ${fmtMB(v.sizeMB)}).`,
    "",
    `Path: \`${where}\``,
    `Volume instance: \`${v.volumeInstanceId}\``,
    "",
    `**Fix:** ${FIX_HINT}.`,
    "",
    "This issue auto-closes (with a comment) when usage drops back below the WARN threshold (75%). A severity change while this stays open (WARN↔CRITICAL) updates the title + adds a comment here instead of opening a second issue.",
  ].join("\n");
}

function volumeRetitleComment(v: VolumeRecord, usagePct: number, fromStatus: string, toStatus: string): string {
  const rank: Record<string, number> = { OK: 0, WARN: 1, CRITICAL: 2 };
  const direction = (rank[toStatus] ?? 0) > (rank[fromStatus] ?? 0) ? "escalated" : "cooled";
  return `Severity ${direction}: ${fromStatus} → ${toStatus}. Usage now **${usagePct.toFixed(1)}%** (${fmtMB(v.currentSizeMB)} / ${fmtMB(v.sizeMB)}).`;
}

function volumeCloseComment(v: VolumeRecord, usagePct: number): string {
  return `Usage recovered to **${usagePct.toFixed(1)}%** (${fmtMB(v.currentSizeMB)} / ${fmtMB(v.sizeMB)}) — below the WARN threshold. Auto-closed by the volume monitor.`;
}

function projectProbeFailedBody(projectName: string, error: string): string {
  return `Project \`${projectName}\`'s volumes could not be fetched this run: ${error}. Its volumes are NOT being monitored until this clears. Auto-closes on the next successful fetch.`;
}

function projectProbeRecoveredComment(projectName: string): string {
  return `Project \`${projectName}\` is readable again (was failing to fetch) — auto-closed by the volume monitor.`;
}

function blindBody(msg: string): string {
  return `${msg} Check RAILWAY_API_TOKEN (Rule #302 family). Auto-closes once at least one project's volumes are readable again.`;
}

// ───────────────────────────── issue action plan ─────────────────────────────

type PlannedAction =
  | { kind: "open"; title: string; body: string }
  | { kind: "retitle"; num: number; newTitle: string; comment: string }
  | { kind: "close"; num: number; comment: string };

function describePlanned(p: PlannedAction): string {
  if (p.kind === "open") return `OPEN ${p.title}`;
  if (p.kind === "retitle") return `RETITLE #${p.num} → ${p.newTitle}`;
  return `CLOSE #${p.num}`;
}

/** Apply the plan via the shared gh-issue helpers. No-op in dry-run (real query + real issue list already happened — nothing here mutates). */
function applyPlanned(planned: PlannedAction[], dryRun: boolean): void {
  if (dryRun) return;
  if (planned.length > 0) ensureLabel(REPO, LABEL, LABEL_DESCRIPTION, "D93F0B");
  for (const p of planned) {
    if (p.kind === "open") openIssue(REPO, LABEL, p.title, p.body);
    if (p.kind === "retitle") {
      retitleIssue(REPO, p.num, p.newTitle);
      commentIssue(REPO, p.num, p.comment);
    }
    if (p.kind === "close") closeIssue(REPO, p.num, p.comment);
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

  // 2. Real issue-list read regardless of --dry-run (this IS the alert/dedup state — mirrors
  //    gateway-token-watch.ts's "--dry-run does the real query + real issue list, zero mutations").
  //    "open" only — this monitor never needs closed-issue history (unlike gateway-token-watch's
  //    revocation gate); the extra state.filter below is defense-in-depth, not load-bearing.
  const issues = listIssuesByLabel(REPO, LABEL, "open");
  const openIssuesList = issues.filter((i) => i.state === "OPEN");
  const openByExactTitle = new Map(openIssuesList.map((i) => [i.title, i]));
  const openVolumeByEntity = new Map<string, { issue: IssueRef; status: string }>();
  for (const i of openIssuesList) {
    const parsed = parseSeverityTitle(LABEL, i.title);
    if (parsed) openVolumeByEntity.set(parsed.entity, { issue: i, status: parsed.status });
  }

  const planned: PlannedAction[] = [];

  // 3. Per-project volume fetch — one bad project must not crash the whole run. A fetch failure
  //    opens/keeps a per-project binary issue (mirrors credential-expiry-monitor.ts's
  //    PROBE_FAILED handling): a monitoring gap is itself alert-worthy, not just a console.warn.
  const allVolumes: VolumeRecord[] = [];
  const projectErrors: Array<{ name: string; error: string }> = [];
  let anyTruncated = false;

  for (const p of projects) {
    const failTitle = projectProbeFailedTitle(p.name);
    const wasOpen = openByExactTitle.has(failTitle);
    const result = await fetchProjectVolumes(token, p.id);

    if (!result.ok) {
      projectErrors.push({ name: p.name, error: result.error });
      console.warn(`railway-volume-monitor: failed to fetch volumes for project "${p.name}" (${p.id}): ${result.error}`);
      if (reconcileCondition(true, wasOpen) === "open") {
        planned.push({ kind: "open", title: failTitle, body: projectProbeFailedBody(p.name, result.error) });
      }
      continue;
    }

    if (reconcileCondition(false, wasOpen) === "close") {
      const openRef = openByExactTitle.get(failTitle)!;
      planned.push({ kind: "close", num: openRef.number, comment: projectProbeRecoveredComment(p.name) });
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
    // Every project failed — operationally indistinguishable from a dead/expired/wrong-scope
    // token (see file header: this replaces a `me{}` liveness gate, which a codex review found
    // would false-fail on a valid Workspace token). This monitor is as blind as if it weren't running.
    const msg = `ALL ${projects.length} project(s) failed to fetch volumes — the monitor is effectively blind this run.`;
    console.error(`railway-volume-monitor: ${msg}`);
    const blindOpen = openByExactTitle.get(BLIND_TITLE);
    if (reconcileCondition(true, Boolean(blindOpen)) === "open") {
      planned.push({ kind: "open", title: BLIND_TITLE, body: blindBody(msg) });
    }

    if (dryRun) {
      console.log(`=== railway-volume-monitor --dry-run (real query + real issue list, NO mutations; ${source}) ===`);
      console.log(`  all ${projects.length} project(s) failed: ${projectErrors.map((e) => `${e.name} (${e.error})`).join("; ")}`);
      console.log(`[would perform ${planned.length} issue action(s)]`);
      for (const p of planned) console.log(`  • ${describePlanned(p)}`);
    } else {
      applyPlanned(planned, dryRun);
      console.log(`Checked 0 volume instance(s) across ${projects.length} project(s) (all failed); issue actions: ${planned.length}.`);
    }
    process.exitCode = 1; // fail-loud regardless of --dry-run — see file header.
    return;
  }

  // At least one project succeeded this run — the blind issue (if any) recovers.
  const blindOpen = openByExactTitle.get(BLIND_TITLE);
  if (blindOpen && reconcileCondition(false, true) === "close") {
    planned.push({ kind: "close", num: blindOpen.number, comment: "At least one project's volumes are readable again this run — monitor no longer blind." });
  }

  // 4. Classify + per-volume issue reconcile.
  const rows: string[] = [];
  let warnCount = 0;
  let criticalCount = 0;

  for (const v of allVolumes) {
    const { usagePct, status } = classifyUsage(v.currentSizeMB, v.sizeMB);
    if (status === "WARN") warnCount++;
    if (status === "CRITICAL") criticalCount++;
    rows.push(formatLine(v, usagePct, status));

    const entity = volumeEntityKey(v);
    const open = openVolumeByEntity.get(entity);
    const action = reconcileSeverity(status, open?.status ?? null);
    const title = buildSeverityTitle(LABEL, entity, status);

    if (action === "open") planned.push({ kind: "open", title, body: volumeIssueBody(v, usagePct, status) });
    if (action === "retitle" && open) {
      planned.push({ kind: "retitle", num: open.issue.number, newTitle: title, comment: volumeRetitleComment(v, usagePct, open.status, status) });
    }
    if (action === "close" && open) {
      planned.push({ kind: "close", num: open.issue.number, comment: volumeCloseComment(v, usagePct) });
    }
  }

  const errSuffix =
    projectErrors.length > 0 ? ` ⚠️ ${projectErrors.length} project(s) failed to fetch (${projectErrors.map((e) => e.name).join(", ")}).` : "";
  const summary = `Railway volume monitor — ${allVolumes.length} volume instance(s) checked across ${projects.length} project(s) (${source}). ${criticalCount} CRITICAL, ${warnCount} WARN.${errSuffix}`;

  if (dryRun) {
    console.log(`=== railway-volume-monitor --dry-run (real query + real issue list, NO mutations; ${source}) ===`);
    console.log(`  ${"volume".padEnd(50)} ${"status".padEnd(9)} ${"usage".padStart(6)}  current / size`);
    for (const r of rows) console.log(r);
    console.log(`\n${summary}`);
    console.log(`[would perform ${planned.length} issue action(s)]`);
    for (const p of planned) console.log(`  • ${describePlanned(p)}`);
    return;
  }

  applyPlanned(planned, dryRun);
  console.log(`${summary} Issue actions: ${planned.length}.`);
}

main().catch((err) => {
  console.error(`railway-volume-monitor failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
