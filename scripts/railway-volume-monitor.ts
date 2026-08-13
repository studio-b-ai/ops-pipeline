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
import {
  sweepAbsentEntityIssues,
  resolveProjectByPrefix,
  VOLUME_MONITOR_BLIND_TITLE as BLIND_TITLE,
  PROBE_FAILED_PREFIX,
  type SweepContext,
} from "./lib/railway-volume-reconcile.js";
import {
  buildAcceptanceMap,
  evaluateAcceptance,
  effectiveStatus,
  findDanglingAcceptances,
  type ManifestProjectEntry,
  type AcceptedVolume,
  type AcceptanceDefect,
} from "./lib/railway-volume-accept.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(HERE, "railway-projects.manifest.yaml");

const REPO = "studio-b-ai/ops-pipeline";
const LABEL = "volume-monitor";
const LABEL_DESCRIPTION = "railway-volume-monitor alert state (open = usage at/above WARN, or a project probe failing)";

const FIX_HINT = "Railway dashboard → service → volume → Live resize";
/** `[volume-monitor] ACCEPTED-STATE INVALID — <id>` — ops#71 Leg 2's manifest-defect binary condition, mirroring PROBE FAILED's shape. */
const ACCEPTED_STATE_INVALID_PREFIX = "[volume-monitor] ACCEPTED-STATE INVALID — ";

// ───────────────────────────── manifest (safety-net project list) ─────────────────────────────

function loadManifestProjects(): ManifestProjectEntry[] {
  if (!existsSync(MANIFEST_FILE)) return [];
  const doc = parseYaml(readFileSync(MANIFEST_FILE, "utf-8")) as { projects?: ManifestProjectEntry[] };
  return doc.projects ?? [];
}

/** Union two project lists, deduped by id — the manifest entry loses on a name conflict (the live API name wins). */
function unionProjects(a: ProjectRef[], b: ProjectRef[]): ProjectRef[] {
  const byId = new Map<string, ProjectRef>();
  for (const p of b) byId.set(p.id, p); // manifest first
  for (const p of a) byId.set(p.id, p); // discovered overwrites on conflict
  return [...byId.values()];
}

/**
 * `[volume-monitor] PROBE FAILED — <project>` — a fixed (non-severity-tiered) per-project binary
 * condition. Built from the SAME `PROBE_FAILED_PREFIX` constant `lib/railway-volume-reconcile.ts`
 * uses to recognize this shape (ops#71) — the two must never drift apart, or the absent-entity
 * sweep silently stops recognizing this monitor's own titles.
 */
function projectProbeFailedTitle(projectName: string): string {
  return `${PROBE_FAILED_PREFIX}${projectName}`;
}

/** `<project>/<environment>/<service>/<volume>` — the entity's location, WITHOUT the instance-id suffix. Also what ops#71 Leg 2's manifest `path:` field is cross-checked against. */
function volumePath(v: VolumeRecord): string {
  return `${v.projectName}/${v.environmentName}/${v.serviceName ?? "(detached)"}/${v.volumeName}`;
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
  return `${volumePath(v)} [${v.volumeInstanceId}]`;
}

// ───────────────────────────── formatting ─────────────────────────────

function fmtMB(n: number): string {
  return `${Math.round(n).toLocaleString()}MB`;
}

/**
 * `rawStatus` + `acceptedOverride` are only used when this row is an ACCEPTED volume (`effStatus
 * === "OK"` but the volume actually computed WARN/CRITICAL) — ops#71 Leg 2's design review calls
 * for the display to carry `ACCEPTED (was WARN, 79.3% < 85%, review by 2026-11-30)`. The padded
 * status column stays a plain "ACCEPTED" (fits the existing column width); the parenthetical
 * detail trails the row so every OTHER row's alignment is untouched.
 */
function formatLine(v: VolumeRecord, usagePct: number, effStatus: VolumeStatus, rawStatus?: VolumeStatus, acceptedOverride?: AcceptedVolume): string {
  const where = `${v.projectName}/${v.serviceName ?? "(detached)"}/${v.volumeName}`;
  const accepted = acceptedOverride !== undefined && rawStatus !== undefined && effStatus === "OK" && rawStatus !== "OK";
  const statusLabel = accepted ? "ACCEPTED" : effStatus;
  const base = `  ${where.padEnd(50)} ${statusLabel.padEnd(9)} ${usagePct.toFixed(1).padStart(5)}%  ${fmtMB(v.currentSizeMB).padStart(10)} / ${fmtMB(v.sizeMB)}`;
  if (accepted && acceptedOverride && rawStatus) {
    return `${base}  (was ${rawStatus}, ${usagePct.toFixed(1)}% < ${acceptedOverride.acceptedBelowPct}%, review by ${acceptedOverride.reviewBy})`;
  }
  return base;
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

/** ops#71 Leg 2 — closes an already-open volume issue because an acceptance override now applies, NOT because usage actually recovered (Rule #412: the comment must say which). */
function volumeAcceptedCloseComment(v: VolumeRecord, usagePct: number, rawStatus: VolumeStatus, override: AcceptedVolume): string {
  return [
    `**ACCEPTED** (was ${rawStatus}, ${usagePct.toFixed(1)}% < ${override.acceptedBelowPct}%, review by ${override.reviewBy}) — usage did NOT drop; a manifest acceptance override now applies instead.`,
    "",
    `Reason: ${override.reason}`,
    "",
    `Auto-closed by the volume monitor. Re-fires automatically if usage reaches ${override.acceptedBelowPct}%, the review date (${override.reviewBy}) passes, or the manifest \`path\` no longer matches this volume's live location.`,
  ].join("\n");
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

/** ops#71 Leg 1 — the absent-entity sweep's close comment. Per the design review, NEVER the word "resolved" (that implies usage recovered, which is not what happened here). */
function sweepCloseComment(disposition: "close-absent" | "close-unprobed", projectSetSize: number, source: string): string {
  const headline =
    disposition === "close-unprobed"
      ? "No longer probed — removed from Railway/manifest."
      : "No longer present in the monitored set (deleted, detached, or no longer reporting a configured size).";
  return `${headline}\n\nProject set this run: **${projectSetSize}** project(s) (${source}).\n\nAuto-closed by the volume monitor's absent-entity sweep.`;
}

/** ops#71 Leg 2 — `[volume-monitor] ACCEPTED-STATE INVALID — <id>` title. `id` is `volume_instance_id`, or the literal `"unspecified"` when that field itself is the thing missing (nothing else to key the flag issue on). */
function acceptedStateInvalidTitle(id: string): string {
  return `${ACCEPTED_STATE_INVALID_PREFIX}${id}`;
}

function acceptedStateInvalidBody(defects: AcceptanceDefect[]): string {
  return [
    "**Acceptance override ignored** — one or more `accepted_volumes` entries in `railway-projects.manifest.yaml` are invalid and are NOT being applied:",
    "",
    defects.map((d) => `- ${d.reason}`).join("\n"),
    "",
    "The underlying volume's own WARN/CRITICAL alerting continues unaffected — only the ACCEPTANCE is ignored, not the volume itself.",
    "",
    "Fix (or remove) the manifest entry and this issue auto-closes on the next run where it no longer recurs.",
  ].join("\n");
}

function acceptedStateInvalidRecoveredComment(id: string): string {
  return `Acceptance override \`${id}\` no longer has an open defect this run (fixed, removed, or the volume it referenced is gone) — auto-closed by the volume monitor.`;
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

  // 1b. ops#71 Leg 2 — build the acceptance map DIRECTLY from `manifestProjects` (the raw parse),
  //     never from `projects` (the union above) — see lib/railway-volume-accept.ts's
  //     `buildAcceptanceMap` doc comment for why. Structural defects (bad manifest entries) start
  //     the run's defect list; dangling + path-mismatch defects append later, once live data exists.
  const { map: acceptanceMap, defects: acceptanceStructuralDefects } = buildAcceptanceMap(manifestProjects);
  const acceptanceDefects: AcceptanceDefect[] = [...acceptanceStructuralDefects];
  const todayIso = new Date().toISOString().slice(0, 10);

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
  /**
   * ops#71 — names of projects whose fetch succeeded but hit a pagination cap this run. codex
   * review finding (P1, fixed here): the old bare `anyTruncated` boolean gave the absent-entity
   * sweep no way to know WHICH project's seenEntities was incomplete, so it would falsely
   * close-absent a still-active volume sitting past the fetched page. Per-project granularity is
   * required to scope that trust decision correctly.
   */
  const truncatedProjectNames = new Set<string>();

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
    if (result.truncated) {
      anyTruncated = true;
      truncatedProjectNames.add(p.name);
    }
  }

  if (anyTruncated) {
    // Rule #331 — a fetch-all paginator silently truncating the tail is worse than an error.
    console.warn(
      "railway-volume-monitor: at least one project hit its 100-item page cap (services/environments/volumeInstances) — results may be INCOMPLETE. Raise the `first:` argument in lib/railway-volume-probes.ts or add pagination.",
    );
  }

  // ops#71 Leg 1 + Leg 2 — derived sets shared by the absent-entity sweep (below, after the
  // per-volume reconcile loop) and the dangling-acceptance scoping check. Pure derivations from
  // data that's already complete at this point; harmless to compute even on the all-failed path.
  const failedProjectNames = new Set(projectErrors.map((e) => e.name));
  const probedOkProjectNames = new Set(projects.filter((p) => !failedProjectNames.has(p.name)).map((p) => p.name));
  const seenEntities = new Set(allVolumes.map(volumeEntityKey));

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

    // ops#71 Leg 2 (codex review finding, P2, fixed here): STRUCTURAL manifest defects
    // (buildAcceptanceMap's output at step 1b) do NOT depend on live volume data at all — they're
    // fully known before the per-project fetch loop even runs. Without this, a malformed
    // accepted_volumes entry would stay completely unflagged for the ENTIRE duration of a Railway
    // outage/bad-token period (this branch returns before the full dangling+ACCEPTED-STATE
    // INVALID reconcile further down, which correctly DOES need live data and correctly stays
    // gated to the normal path). OPEN-only, deliberately: unlike opening (safe on certain
    // information), CLOSING here would risk a false-close — this branch has no visibility into
    // dangling/path-mismatch defects (those genuinely need this run's live data), so closing
    // based on the structural-only view could incorrectly close an issue that's still open for a
    // reason this branch can't see.
    const structuralDefectsById = new Map<string, AcceptanceDefect[]>();
    for (const d of acceptanceStructuralDefects) {
      const id = d.volumeInstanceId ?? "unspecified";
      const list = structuralDefectsById.get(id) ?? [];
      list.push(d);
      structuralDefectsById.set(id, list);
    }
    for (const [id, ds] of structuralDefectsById) {
      const title = acceptedStateInvalidTitle(id);
      if (reconcileCondition(true, openByExactTitle.has(title)) === "open") {
        planned.push({ kind: "open", title, body: acceptedStateInvalidBody(ds) });
      }
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

  // 4. Classify + per-volume issue reconcile. ops#71 Leg 2: each volume's acceptance override
  //    (if any) is evaluated BEFORE the reconcile — an accepted volume feeds `reconcileSeverity`
  //    the literal "OK" (`effStatus`), closing its already-open issue rather than merely
  //    suppressing future opens. `status` (the raw computed severity) is kept separately for
  //    display/comment text, which must say what ACTUALLY happened (Rule #412).
  const rows: string[] = [];
  let warnCount = 0;
  let criticalCount = 0;
  let acceptedCount = 0;

  for (const v of allVolumes) {
    const { usagePct, status } = classifyUsage(v.currentSizeMB, v.sizeMB);
    const override = acceptanceMap.get(v.volumeInstanceId);
    const liveEntityPath = volumePath(v);
    const acceptance = evaluateAcceptance({ override, liveEntityPath, usagePct, todayIso });
    if (acceptance.rejectReason === "path-mismatch" && override) {
      acceptanceDefects.push({
        volumeInstanceId: v.volumeInstanceId,
        reason: `path mismatch: manifest declares path "${override.path}" but this volume's live path this run is "${liveEntityPath}" — acceptance NOT applied.`,
      });
    }
    const effStatus = effectiveStatus(acceptance.accepted, status);
    if (acceptance.accepted) acceptedCount++;
    if (effStatus === "WARN") warnCount++;
    if (effStatus === "CRITICAL") criticalCount++;
    rows.push(formatLine(v, usagePct, effStatus, status, acceptance.accepted ? override : undefined));

    const entity = volumeEntityKey(v);
    const open = openVolumeByEntity.get(entity);
    const action = reconcileSeverity(effStatus, open?.status ?? null);
    const title = buildSeverityTitle(LABEL, entity, effStatus);

    if (action === "open") planned.push({ kind: "open", title, body: volumeIssueBody(v, usagePct, effStatus) });
    if (action === "retitle" && open) {
      planned.push({ kind: "retitle", num: open.issue.number, newTitle: title, comment: volumeRetitleComment(v, usagePct, open.status, effStatus) });
    }
    if (action === "close" && open) {
      const comment = acceptance.accepted && override ? volumeAcceptedCloseComment(v, usagePct, status, override) : volumeCloseComment(v, usagePct);
      planned.push({ kind: "close", num: open.issue.number, comment });
    }
  }

  // ops#71 Leg 2 (continued) — dangling acceptances: an override whose volume_instance_id matches
  // no live volume THIS run is flagged, UNLESS its owning project is a KNOWN project that failed
  // to fetch or was truncated this run (mirrors Leg 1's "never act on absence-evidence from a
  // blind project" — an override whose project merely failed to fetch is not dangling, it's just
  // unprobed). Deriving "owning project" from `path`'s first segment is a scoping heuristic only.
  //
  // codex review finding (P2, fixed here): the ORIGINAL filter was an ALLOWLIST
  // (`probedOkProjectNames.has(...)`), which silently excluded from the dangling check ANY
  // override whose path's project segment didn't match a probed-ok project name for ANY reason —
  // including a typo'd/stale project-name segment that never matched a REAL project at all. Since
  // such an override's volume_instance_id also never matches a live volume (nothing points at
  // it), it would NEVER be flagged by ANY path: not structurally invalid (path is just a string),
  // never evaluated in the per-volume loop above (its id matches no live v.volumeInstanceId), and
  // now excluded here too — a garbage entry sits in the manifest forever with zero visibility.
  // The fix inverts to a DENYLIST: exclude ONLY entries whose owning project is one we can
  // POSITIVELY confirm is blind/truncated this run; anything else (including a bogus name
  // matching no known project) proceeds to the dangling check and gets flagged if unmatched.
  //
  // codex review finding (P2, fixed here): deriving "owning project" via a naive
  // `path.split("/")[0]` first-segment split is the SAME class of bug `resolveProjectByPrefix`
  // (Leg 1) exists to avoid — a project whose name is itself a prefix segment of another
  // project's name (e.g. "a" and "a/b") would misattribute "a/b/..." to blind project "a" via a
  // bare first-segment split, exempting a genuinely dangling "a/b" acceptance from ever being
  // flagged. Reusing Leg 1's own longest-prefix resolver against THIS run's full `projects` set
  // fixes it the same way it's already fixed for the sweep.
  const liveVolumeInstanceIds = new Set(allVolumes.map((v) => v.volumeInstanceId));
  const blindOrTruncatedProjectNames = new Set([...failedProjectNames, ...truncatedProjectNames]);
  const scopedAcceptanceMap = new Map(
    [...acceptanceMap].filter(([, av]) => {
      const owningProject = resolveProjectByPrefix(av.path, projects);
      return !owningProject || !blindOrTruncatedProjectNames.has(owningProject.name);
    }),
  );
  acceptanceDefects.push(...findDanglingAcceptances(scopedAcceptanceMap, liveVolumeInstanceIds));

  // Reconcile `[volume-monitor] ACCEPTED-STATE INVALID — <id>` issues BOTH directions — grouped
  // by id first so two structurally-invalid entries that both lack `volume_instance_id` (both
  // falling back to the shared "unspecified" id) open exactly ONE issue, not two.
  const defectsById = new Map<string, AcceptanceDefect[]>();
  for (const d of acceptanceDefects) {
    const id = d.volumeInstanceId ?? "unspecified";
    const list = defectsById.get(id) ?? [];
    list.push(d);
    defectsById.set(id, list);
  }
  for (const [id, ds] of defectsById) {
    const title = acceptedStateInvalidTitle(id);
    if (reconcileCondition(true, openByExactTitle.has(title)) === "open") {
      planned.push({ kind: "open", title, body: acceptedStateInvalidBody(ds) });
    }
  }
  for (const issue of openIssuesList) {
    if (!issue.title.startsWith(ACCEPTED_STATE_INVALID_PREFIX)) continue;
    const id = issue.title.slice(ACCEPTED_STATE_INVALID_PREFIX.length);
    if (!defectsById.has(id)) {
      planned.push({ kind: "close", num: issue.number, comment: acceptedStateInvalidRecoveredComment(id) });
    }
  }

  // ops#71 Leg 1 — absent-entity sweep: runs AFTER the project loop AND the per-volume reconcile
  // loop above (design review Q4). Structurally disjoint from that loop's issue targets — the
  // sweep only ever selects an entity NOT in `seenEntities` (or unresolvable to any current
  // project), while the loop above only ever acts on entities THAT ARE in `seenEntities` (it
  // iterates exactly `allVolumes`, which is what populates `seenEntities`) — so there is no
  // ordering hazard despite both pushing into the same `planned` list (proven in
  // railway-volume-reconcile.test.ts's disjoint-targeting invariant test).
  const sweepCtx: SweepContext = {
    probedOkProjects: probedOkProjectNames,
    failedProjects: failedProjectNames,
    truncatedProjects: truncatedProjectNames,
    seenEntities,
    projectSet: projects,
  };
  const sweep = sweepAbsentEntityIssues(openIssuesList, sweepCtx);
  for (const w of sweep.warnings) console.warn(`railway-volume-monitor: ${w}`);
  for (const action of sweep.actions) {
    planned.push({ kind: "close", num: action.number, comment: sweepCloseComment(action.disposition, projects.length, source) });
  }

  const errSuffix =
    projectErrors.length > 0 ? ` ⚠️ ${projectErrors.length} project(s) failed to fetch (${projectErrors.map((e) => e.name).join(", ")}).` : "";
  const summary =
    `Railway volume monitor — ${allVolumes.length} volume instance(s) checked across ${projects.length} project(s) (${source}). ` +
    `${criticalCount} CRITICAL, ${warnCount} WARN, ${acceptedCount} ACCEPTED.${errSuffix} ` +
    `Absent-entity sweep: ${sweep.actions.length} orphan(s) closed, ${sweep.keptBlindCount} kept (project probe failed).`;

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
