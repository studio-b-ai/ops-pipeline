#!/usr/bin/env tsx
/**
 * grants-drift-monitor.ts — GitHub org grant-surface drift guard (ops#178).
 *
 * Origin: `acuops-agent`'s installation flipped to `repository_selection: "all"` on 2026-08-21
 * (Kevin at the keyboard, unblocking a broken UI repo-picker) — a pragmatic, correct-for-Kevin
 * change that nonetheless silently widened one App's reach across the whole org with no guard
 * watching for it, or for any other org grant drifting the same way. This worker closes that gap
 * generally: org settings, org members, outside collaborators, teams (+ per-team members/repos),
 * direct (non-team) repo collaborator grants, and App installations (selection + permissions) are
 * all diffed against the expected state in `scripts/grants.manifest.yaml` every week.
 *
 * Mirrors railway-volume-monitor.ts + lib/severity-issue-reconcile.ts exactly (Rules #165/#292/
 * #358 by construction): an open issue labeled `grants-drift` IS the alert state. Per-entity
 * status is one of OK / DRIFT / PROBE FAILED (lib/grants-drift-classify.ts's STATUS_* constants);
 * title `[grants-drift] <entity> — <STATUS>` via `buildSeverityTitle`; a status change on an
 * already-open issue retitles + comments in place rather than opening a duplicate (Rule #412 — a
 * stale title would misstate current severity). A manifest edit IS the acknowledgment of a
 * deliberate grant change (see grants.manifest.yaml's own header) — the remediation line on every
 * DRIFT issue says so.
 *
 * MONITOR BLIND: a SEPARATE fixed-title binary condition (lib/gateway-token-reconcile.ts's
 * `reconcileCondition`, not the severity model — this title's " — " substring would otherwise be
 * mis-parsed by `parseSeverityTitle` as a bogus entity/status pair, so it lives in its own
 * exact-title map, mirroring railway-volume-monitor.ts's dual-map pattern). Fires when EVERY
 * top-level org probe (org settings, members, outside collaborators, team list, installations)
 * fails the same way — expected today (2026-08-21) until Kevin's one-click grant of
 * studiob-fleet-bot's org Administration:read + Members:read lands (ops#178 design comment): a
 * deployed-but-honest blind state, not a deployed-inert one (Rule #464). `direct-grants` needs
 * only repo Metadata:read (already granted) and is deliberately excluded from the blind check —
 * it keeps working, and keeps reconciling its own OK/DRIFT/PROBE FAILED issue, even while the
 * monitor is blind everywhere else. Per-entity PROBE FAILED issues (org-settings, org-members,
 * outside-collaborators, each team/<slug>, each installation/<app_slug>) open ALONGSIDE the
 * blanket MONITOR BLIND issue while the gap persists — this mirrors railway-volume-monitor.ts's
 * own all-projects-failed behavior exactly (its per-project PROBE FAILED issues open in the same
 * loop as the blanket MONITOR BLIND check, not instead of it): each issue names which specific
 * entity's state is unverified, and all of them auto-close together once the permission gap
 * closes and drift/no-drift becomes knowable again.
 *
 * `--dry-run` (or workflow_dispatch input `dry_run`) runs every real probe AND a real
 * `gh issue list` (there's no meaningful secrets-free classify-only mode — reading live grant
 * state and comparing it to already-open issues IS the job) but performs ZERO issue mutations, so
 * it's safe to run against the real org for a spot-check (Rule #376: a dry run that reads nothing
 * proves nothing).
 *
 * Fail-loud contract (Rule #302/#464 family): MONITOR BLIND sets `process.exitCode = 1`
 * regardless of `--dry-run` — a monitor that can't see the grant surface is as bad as one that
 * isn't running, and that must be loud in CI (workflow red), not just a quiet open issue.
 *
 * SECURITY (Rule #259/#282/#363): the minted GH_TOKEN is read only implicitly by the `gh` CLI
 * (via lib/grants-drift-probes.ts's and lib/github-issues.ts's `gh()` wrappers) — this file never
 * touches, logs, or persists it. GitHub issues ARE the durable state now, by design.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  probeAllDirectGrants,
  probeInstallations,
  probeMembers,
  probeOrgSettings,
  probeOutsideCollaborators,
  probeTeamDetail,
  probeTeamSlugs,
  type ProbeResult,
  type TeamDetail,
} from "./lib/grants-drift-probes.js";
import {
  classifyGrantSurface,
  isMonitorBlind,
  STATUS_DRIFT,
  STATUS_OK,
  STATUS_PROBE_FAILED,
  type EntityResult,
  type EntityStatus,
  type LiveSnapshot,
  type Manifest,
} from "./lib/grants-drift-classify.js";
import { reconcileSeverity, buildSeverityTitle, parseSeverityTitle } from "./lib/severity-issue-reconcile.js";
import { reconcileCondition } from "./lib/gateway-token-reconcile.js";
import { listIssuesByLabel, ensureLabel, openIssue, closeIssue, commentIssue, retitleIssue, type IssueRef } from "./lib/github-issues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(HERE, "grants.manifest.yaml");

const REPO = "studio-b-ai/ops-pipeline";
const LABEL = "grants-drift";
const LABEL_DESCRIPTION = "grants-drift-monitor alert state (open = live grant differs from manifest, or a probe failed)";
const BLIND_TITLE = "[grants-drift] MONITOR BLIND — fleet-bot lacks org read permissions (Kevin click pending, ops#178)";

// ───────────────────────────── manifest ─────────────────────────────

function loadManifest(): Manifest {
  return parseYaml(readFileSync(MANIFEST_FILE, "utf-8")) as Manifest;
}

// ───────────────────────────── formatting ─────────────────────────────

function formatLine(r: EntityResult): string {
  const base = `  ${r.entity.padEnd(32)} ${r.status}`;
  if (r.detail.length === 0) return base;
  return `${base}\n${r.detail.map((d) => `      - ${d}`).join("\n")}`;
}

// ───────────────────────────── issue bodies / comments ─────────────────────────────

const REMEDIATION_LINE =
  "**Fix:** update `scripts/grants.manifest.yaml` in the same PR that acknowledges the change, or revert the live grant.";

function entityIssueBody(entity: string, status: EntityStatus, detail: string[]): string {
  const detailBlock = detail.length > 0 ? detail.map((d) => `- ${d}`).join("\n") : "(no detail captured)";
  if (status === STATUS_PROBE_FAILED) {
    return [
      `**PROBE FAILED** for \`${entity}\` — live grant state for this entity could not be read this run:`,
      "",
      detailBlock,
      "",
      "This entity's manifest-vs-live state is UNKNOWN this run, not confirmed correct — treat it as unverified until this clears. Auto-closes once the probe succeeds again (a fresh DRIFT issue opens separately if live state turns out not to match the manifest).",
    ].join("\n");
  }
  return [
    `**DRIFT** on \`${entity}\` — live GitHub grant state no longer matches \`scripts/grants.manifest.yaml\`:`,
    "",
    detailBlock,
    "",
    REMEDIATION_LINE,
    "",
    "Auto-closes (with a comment) once live state matches the manifest again.",
  ].join("\n");
}

function retitleComment(entity: string, fromStatus: string, toStatus: string, detail: string[]): string {
  const detailBlock = detail.length > 0 ? detail.map((d) => `- ${d}`).join("\n") : "(no detail captured)";
  return [`Status changed on \`${entity}\`: ${fromStatus} → ${toStatus}.`, "", detailBlock].join("\n");
}

function closeComment(entity: string, fromStatus: string): string {
  return `Live state now matches \`scripts/grants.manifest.yaml\` for \`${entity}\` (was ${fromStatus}). Auto-closed by the grants drift monitor.`;
}

function orphanCloseComment(entity: string): string {
  return `\`${entity}\` is no longer tracked -- removed from both \`scripts/grants.manifest.yaml\` and live GitHub state (e.g. a team or App installation was deleted and the manifest entry deleted to acknowledge it). Auto-closed by the grants drift monitor.`;
}

function blindBody(): string {
  return [
    "**MONITOR BLIND** — every top-level org grant probe (org settings, members, outside collaborators, team list, App installations) failed this run, consistent with the studiob-fleet-bot App still lacking org **Administration: read** + **Members: read**.",
    "",
    "**Fix (Kevin-gated, one click):** studiob-fleet-bot App settings → Organization permissions → Administration = Read-only, Members = Read-only → Save → accept the permission request on the org installation. No new secrets, nothing to rotate (ops#178 design comment).",
    "",
    "The `direct-grants` entity (repo collaborators) is unaffected — it only needs repo Metadata: read, already granted — and its own OK/DRIFT/PROBE FAILED issue keeps reconciling normally while this is open. Per-entity PROBE FAILED issues for the org-level entities are open alongside this one; they all auto-close together once the gap closes.",
    "",
    "Auto-closes once at least one top-level org probe succeeds again.",
  ].join("\n");
}

function blindCloseComment(): string {
  return "At least one top-level org grant probe succeeded this run — the monitor is no longer blind. Auto-closed by the grants drift monitor.";
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

/** Apply the plan via the shared gh-issue helpers. Never called in dry-run (see main). */
function applyPlanned(planned: PlannedAction[]): void {
  if (planned.length > 0) ensureLabel(REPO, LABEL, LABEL_DESCRIPTION, "B60205");
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
  const dryRun = process.argv.includes("--dry-run") || process.env.GRANTS_DRIFT_MONITOR_DRY_RUN === "true";

  const manifest = loadManifest();
  const org = manifest.org;

  // 1. Probes. Every section is independent — one failing must not crash the run or hide the
  //    others (mirrors railway-volume-monitor.ts's per-project isolation, applied per
  //    grant-surface section here).
  const orgSettingsResult = probeOrgSettings(org);
  const membersResult = probeMembers(org);
  const outsideCollaboratorsResult = probeOutsideCollaborators(org);
  const teamSlugsResult = probeTeamSlugs(org);
  const directGrantsResult = probeAllDirectGrants(org);
  const installationsResult = probeInstallations(org);

  // Team detail union: every manifest-known slug, PLUS every live-discovered slug when the
  // top-level team list probe succeeded. When it fails, only manifest-known slugs are attempted —
  // each will independently come back PROBE FAILED (same permission gap), which is correct: we
  // simply can't discover a live-only team we have no other way to name.
  const manifestSlugs = manifest.teams.map((t) => t.slug);
  const liveSlugs = teamSlugsResult.ok ? teamSlugsResult.data.map((t) => t.slug) : [];
  const slugUnion = [...new Set([...manifestSlugs, ...liveSlugs])].sort();
  const teamDetails: Map<string, ProbeResult<TeamDetail | null>> = new Map();
  for (const slug of slugUnion) {
    teamDetails.set(slug, probeTeamDetail(org, slug));
  }

  const snapshot: LiveSnapshot = {
    orgSettings: orgSettingsResult,
    members: membersResult,
    outsideCollaborators: outsideCollaboratorsResult,
    teamDetails,
    directGrants: directGrantsResult,
    installations: installationsResult,
  };

  // 2. Real issue-list read regardless of --dry-run — this IS the alert/dedup state (mirrors
  //    railway-volume-monitor.ts / gateway-token-watch.ts). Two maps for the same open-issue set:
  //    by parsed entity (severity reconcile) and by exact title (the MONITOR BLIND fixed title,
  //    whose own " — " would otherwise mis-parse as a bogus entity/status pair — harmless if it
  //    does, since no real entity is ever named "MONITOR BLIND", but the exact-title map is the
  //    one actually load-bearing for the blind check).
  const issues = listIssuesByLabel(REPO, LABEL, "open");
  const openIssuesList = issues.filter((i) => i.state === "OPEN");
  const openByExactTitle = new Map(openIssuesList.map((i) => [i.title, i]));
  const openByEntity = new Map<string, { issue: IssueRef; status: string }>();
  for (const i of openIssuesList) {
    const parsed = parseSeverityTitle(LABEL, i.title);
    if (parsed) openByEntity.set(parsed.entity, { issue: i, status: parsed.status });
  }

  const planned: PlannedAction[] = [];

  // 3. Classify every entity + per-entity severity reconcile. Deliberately NOT gated behind the
  //    MONITOR BLIND check below — direct-grants (and any team reachable independently) must
  //    still reconcile even when every org-level probe is dark.
  const results = classifyGrantSurface(manifest, snapshot);
  for (const r of results) {
    const open = openByEntity.get(r.entity);
    const action = reconcileSeverity(r.status, open ? open.status : null);
    const title = buildSeverityTitle(LABEL, r.entity, r.status);
    if (action === "open") {
      planned.push({ kind: "open", title, body: entityIssueBody(r.entity, r.status, r.detail) });
    } else if (action === "retitle" && open) {
      planned.push({ kind: "retitle", num: open.issue.number, newTitle: title, comment: retitleComment(r.entity, open.status, r.status, r.detail) });
    } else if (action === "close" && open) {
      planned.push({ kind: "close", num: open.issue.number, comment: closeComment(r.entity, open.status) });
    }
  }

  // 3b. Orphan sweep (codex P1 pass, live-caught): an entity can vanish from `results` entirely
  //     when it's removed from BOTH the manifest and live state in the same run -- e.g. a team or
  //     App installation is deleted live and its manifest entry is deleted in the same PR to
  //     acknowledge that (the manifest's own header: "A manifest edit is an ACKNOWLEDGMENT of a
  //     deliberate grant change"). `classifyGrantSurface` never emits a vanished entity again, so
  //     the reconcile loop above (which only walks `results`) never revisits its previously-open
  //     issue -- an upsert-only reconcile over a narrowed entity set never reconciles removals
  //     (Rule #379). Close any open per-entity issue whose entity no longer appears in `results`
  //     at all. Excludes the MONITOR BLIND issue by exact title: its own " — " would otherwise
  //     parse into a bogus "MONITOR BLIND" pseudo-entity via `openByEntity`, and that issue is
  //     already reconciled separately in step 4 below via the exact-title map, not this one.
  const trackedEntities = new Set(results.map((r) => r.entity));
  for (const [entity, open] of openByEntity) {
    if (open.issue.title === BLIND_TITLE) continue;
    if (!trackedEntities.has(entity)) {
      planned.push({ kind: "close", num: open.issue.number, comment: orphanCloseComment(entity) });
    }
  }

  // 4. MONITOR BLIND — binary condition over the 5 top-level org probes (direct-grants
  //    deliberately excluded: repo Metadata: read only, already granted, works independently —
  //    ops#178 design comment: "the collaborator leg works day one").
  const orgLevelProbes = [orgSettingsResult, membersResult, outsideCollaboratorsResult, teamSlugsResult, installationsResult];
  const blind = isMonitorBlind(orgLevelProbes);
  const blindAction = reconcileCondition(blind, openByExactTitle.has(BLIND_TITLE));
  if (blindAction === "open") planned.push({ kind: "open", title: BLIND_TITLE, body: blindBody() });
  if (blindAction === "close") {
    const ref = openByExactTitle.get(BLIND_TITLE)!;
    planned.push({ kind: "close", num: ref.number, comment: blindCloseComment() });
  }

  // 5. Report + apply.
  const okCount = results.filter((r) => r.status === STATUS_OK).length;
  const driftCount = results.filter((r) => r.status === STATUS_DRIFT).length;
  const probeFailedCount = results.filter((r) => r.status === STATUS_PROBE_FAILED).length;
  const summary =
    `Grants drift monitor — ${results.length} entit${results.length === 1 ? "y" : "ies"} checked (org ${org}). ` +
    `${okCount} OK, ${driftCount} DRIFT, ${probeFailedCount} PROBE FAILED. MONITOR BLIND: ${blind ? "YES" : "no"}.`;

  if (dryRun) {
    console.log("=== grants-drift-monitor --dry-run (real reads, NO mutations) ===");
    for (const r of results) console.log(formatLine(r));
    console.log("");
    console.log(summary);
    console.log(`[would perform ${planned.length} issue action(s)]`);
    for (const p of planned) console.log(`  • ${describePlanned(p)}`);
  } else {
    applyPlanned(planned);
    console.log(`${summary} Issue actions: ${planned.length}.`);
  }

  // Fail-loud regardless of --dry-run — see file header. Checked LAST, after every entity
  // (including direct-grants) has already been classified and reconciled above.
  if (blind) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`grants-drift-monitor failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
