#!/usr/bin/env tsx
/**
 * credential-expiry-monitor.ts — CLAUDE.md Rule #302.
 *
 * Daily (GH Actions cron): for each item in credentials.manifest.yaml, read its value via the
 * read-only "Studio B Infrastructure" 1Password Service Account (OP_SERVICE_ACCOUNT_INFRA), run
 * the type's ACTIVE probe (real expiry/aliveness — not the recorded date), classify, and route.
 *
 * v2 (2026-07-31, Kevin directive): **GitHub issues instead of Slack**, mirroring
 * gateway-token-watch.ts (ops-pipeline#9) and railway-volume-monitor.ts's v2. One issue per
 * credential (label `credential-monitor`), title `[credential-monitor] <name> — <status>` where
 * `<status>` mirrors the credential's alert class 1:1: `WARN-14`/`WARN-7`/`WARN-1` (the WARN
 * band, tightest-matching), `DEAD`, `NO_EXPIRY`, or `PROBE_FAILED`. The issue auto-closes (with a
 * comment) once the credential classifies back to OK. A status change on an ALREADY-OPEN issue
 * (e.g. a WARN band tightening from 14d to 7d, or DEAD easing to WARN after a rotation) comments +
 * retitles in place instead of opening a second issue (`lib/severity-issue-reconcile.ts`'s
 * `reconcileSeverity` — Rule #412: a stale title would misstate current severity). This replaces
 * both the Slack posts AND the committed dedup-state file of v1; unlike v1's DEAD status (which
 * posted to Slack on EVERY run, no dedup — the "urgent, never mute" theory), DEAD now behaves like
 * every other status: open once, stay open, auto-close on recovery. That's a deliberate
 * improvement, not an oversight — an open issue is a much stronger "don't ignore this" signal than
 * a message that scrolls off a channel, and this monitor's whole point is to stop re-alerting on
 * an unchanged condition (Rules #292/#358).
 *
 * `--dry-run` (or workflow_dispatch `dry_run: true`) classifies each item from its recorded
 * expiry date ONLY — NO secrets read, NO probe network calls (Rule #302's "pre-SA verification
 * path", unchanged from v1) — but DOES perform a real (read-only) `gh issue list` against this
 * repo, since that needs only the workflow's own ambient GITHUB_TOKEN, not a Kevin-gated secret,
 * so the issue-action preview reflects real state. Zero issue mutations either way.
 *
 * Probing logic (evaluate/runProbe/classify and every probeXxx function in
 * lib/credential-probes.ts) is UNCHANGED by this conversion — only how results become
 * alerts changed.
 *
 * SECURITY (Rule #259/#282): credential VALUES are read into variables and passed to probes; they
 * are NEVER logged, never put in issue text. Only NAME-level metadata + derived expiry DATES flow
 * out.
 *
 * Absent-entity orphan sweep (2026-08-14, ops-pipeline#74): the per-credential loop above
 * iterates `credentials.manifest.yaml` items ONLY — a credential REMOVED from the manifest
 * (rotated off, decommissioned, migrated to a keyless alternative) left its open issue orphaned
 * forever, the same gap already fixed for gateway-token-watch.ts (#37) and
 * railway-volume-monitor.ts (#71 Leg 1). This is the SIMPLEST instance of the class — see
 * `lib/credential-reconcile.ts`'s header for why it ports as the gateway-style name-in-set sweep
 * rather than the volume monitor's three-way one. Runs AFTER the per-credential loop, own
 * separate block, over the same `openIssuesList` already read above; close comments say "no
 * longer monitored", never "resolved" — this sweep never re-verifies a removed credential's
 * actual state. `--dry-run` previews sweep closes distinctly (`SWEEP-CLOSE #<num> <title> (no
 * longer monitored)`) since the real issue-list read already happens in dry-run (#376); zero
 * mutations either way.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { requireEnv } from "./lib/config.js";
import { classify, type Classification, type CredStatus, type ProbeResult } from "./lib/credential-classify.js";
import {
  probeGithubPat,
  probeNpmGranular,
  probeCloudflareToken,
  probeEntraSecret,
  probeEntraUserPassword,
  probe1PasswordSA,
  probeShipEngineApiKey,
  getCertExpiry,
  type EntraProbeCreds,
} from "./lib/credential-probes.js";
import { reconcileSeverity, buildSeverityTitle, parseSeverityTitle } from "./lib/severity-issue-reconcile.js";
import { listIssuesByLabel, ensureLabel, openIssue, closeIssue, commentIssue, retitleIssue, type IssueRef } from "./lib/github-issues.js";
import { sweepUnmonitoredCredentialIssues } from "./lib/credential-reconcile.js";
import { readCredentialValue } from "./lib/credential-value-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(HERE, "credentials.manifest.yaml");

const REPO = "studio-b-ai/ops-pipeline";
const LABEL = "credential-monitor";
const LABEL_DESCRIPTION = "credential-expiry-monitor alert state (open = a credential needs attention)";
/** Ladder rung labels (decision 2026-08-17) — kept next to the manifest field docs. */
const RUNG_LABELS: Record<0 | 1 | 2 | 3, string> = {
  0: "keyless",
  1: "self-rotating",
  2: "non-expiring + monitored + revoke-on-signal",
  3: "one Kevin sitting per year",
};

type CredType =
  | "1password-sa"
  | "npm-granular"
  | "github-pat-finegrained"
  | "entra-client-secret"
  | "entra-user-password"
  | "cloudflare-api-token"
  | "shipengine-api-key"
  | "tls-cert";

interface ManifestItem {
  name: string;
  type: CredType;
  op_ref?: string;
  app_id?: string;
  app_secret_key_id?: string; // entra: pin the SPECIFIC monitored secret by its (non-secret) keyId
  user_id?: string; // entra-user-password: the monitored USER's Entra object id (non-secret)
  host?: string;
  recorded_expiry?: string | null;
  owner?: string;
  keyless_alternative?: string | null;
  /**
   * Credential-lifecycle ladder target (brain library/decisions/2026-08-17-credential-lifecycle-no-kevin-touch.md):
   * 0 keyless · 1 self-rotating · 2 non-expiring + monitored + revoke-on-signal · 3 one Kevin sitting/year.
   * Informational — surfaced in alert bodies so a WARN/DEAD issue names the migration it should trigger.
   */
  target_rung?: 0 | 1 | 2 | 3;
  /** When the credential must be AT its target rung (ISO date, or a milestone name). */
  rung_by?: string | null;
  /**
   * true = non-expiring BY DESIGN (rung 2). Alive + no expiry → OK instead of NO_EXPIRY; the daily
   * aliveness probe is the monitoring, revoke-on-signal the response. Must NOT be combined with a
   * `recorded_expiry` (classify fails loud on the contradiction).
   */
  non_expiring?: boolean;
}

interface ItemResult {
  item: ManifestItem;
  classification: Classification;
  probeError?: string;
  probeNonExpiring?: boolean;
  probeNote?: string;
}

/** Read a status value without the bare `status` keyword sitting next to a string literal. */
function statusOf(r: ItemResult): CredStatus {
  return r.classification.status;
}

// ───────────────────────────── value access (never logged) ─────────────────────────────

function opRead(opRef: string): string {
  return readCredentialValue(opRef, {
    readOp: (ref) => {
      const token = requireEnv("OP_SERVICE_ACCOUNT_INFRA");
      return execFileSync("op", ["read", ref], {
        env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
        encoding: "utf-8",
        timeout: 15_000,
      }).trim();
    },
    // env:<NAME> = the self-probe scheme (decision 2026-08-17 D2): the monitor's own SA token is
    // probed straight from its process env — it has no 1P item it could `op read` with itself.
    readEnv: (name) => requireEnv(name),
  });
}

function reqRef(item: ManifestItem): string {
  if (!item.op_ref) throw new Error(`manifest item ${item.name} is missing op_ref`);
  return item.op_ref;
}

function entraCredsOrNull(): EntraProbeCreds | null {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  if (tenantId && clientId && clientSecret) return { tenantId, clientId, clientSecret };
  return null;
}

// ───────────────────────────── probing (UNCHANGED by this conversion) ─────────────────────────────

async function runProbe(item: ManifestItem): Promise<ProbeResult> {
  const recorded = item.recorded_expiry ?? null;
  switch (item.type) {
    case "github-pat-finegrained":
      return probeGithubPat(opRead(reqRef(item)));
    case "cloudflare-api-token":
      return probeCloudflareToken(opRead(reqRef(item)), recorded);
    case "shipengine-api-key":
      return probeShipEngineApiKey(opRead(reqRef(item)));
    case "npm-granular":
      return probeNpmGranular(opRead(reqRef(item)), recorded);
    case "1password-sa":
      return probe1PasswordSA(opRead(reqRef(item)), recorded);
    case "entra-client-secret": {
      const creds = entraCredsOrNull();
      if (!creds || !item.app_id) {
        return { alive: true, expiry: null, source: "probe", error: "ENTRA_* probe creds (or app_id) not configured" };
      }
      return probeEntraSecret(item.app_id, creds, item.app_secret_key_id ?? null);
    }
    case "entra-user-password": {
      const creds = entraCredsOrNull();
      if (!creds || !item.user_id) {
        return { alive: true, expiry: null, source: "probe", error: "ENTRA_* probe creds (or user_id) not configured" };
      }
      return probeEntraUserPassword(item.user_id, creds);
    }
    case "tls-cert":
      if (!item.host) {
        return { alive: true, expiry: null, source: "probe", error: "tls-cert item missing host" };
      }
      return getCertExpiry(item.host);
    default:
      return { alive: true, expiry: null, source: "probe", error: `unknown credential type: ${(item as ManifestItem).type}` };
  }
}

async function evaluate(item: ManifestItem, dryRun: boolean): Promise<ItemResult> {
  const recorded = item.recorded_expiry ?? null;
  if (dryRun) {
    // No secrets, no network: classify from the recorded date alone.
    return { item, classification: classify({ recordedExpiry: recorded, probe: { alive: true, expiry: null, source: "recorded" }, declaredNonExpiring: item.non_expiring === true }) };
  }
  let probe: ProbeResult;
  try {
    probe = await runProbe(item);
  } catch (err) {
    probe = { alive: true, expiry: null, source: "probe", error: err instanceof Error ? err.message : String(err) };
  }
  return {
    item,
    classification: classify({ recordedExpiry: recorded, probe, declaredNonExpiring: item.non_expiring === true }),
    probeError: probe.error ?? (item.non_expiring === true && (probe.expiry || recorded)
      ? `manifest contradiction: non_expiring: true but an expiry is known (${probe.expiry ? "probe" : "recorded_expiry"}) — fix the manifest`
      : undefined),
    probeNonExpiring: probe.nonExpiring,
    probeNote: probe.note,
  };
}

// ───────────────────────────── status key (mirrors the old dedupKey's granularity) ─────────────────────────────

/**
 * The per-credential severity string used in the issue title. "OK" clears; a WARN status is
 * split into `WARN-<threshold>` so a band tightening (14d → 7d → 1d) retitles the open issue
 * instead of silently sitting under a stale "WARN-14" title while the real threshold is 1 —
 * mirrors v1's dedup granularity (`${name}:warn:${threshold}`), 1:1.
 */
function statusKey(r: ItemResult): string {
  const st = statusOf(r);
  if (st === "WARN") return `WARN-${r.classification.threshold}`;
  return st;
}

// ───────────────────────────── issue bodies / comments ─────────────────────────────

function credentialHeadline(r: ItemResult): string {
  const { item } = r;
  const c = r.classification;
  const st = statusOf(r);
  const expDate = c.expiry ? c.expiry.slice(0, 10) : "unknown";
  if (st === "DEAD") {
    return `**DEAD** — \`${item.name}\` (${item.type}) failed its aliveness probe — expired or revoked. Rotate now.`;
  }
  if (st === "WARN") {
    const d = c.daysToExpiry ?? 0;
    const when = d < 0 ? `**OVERDUE by ${Math.abs(d)}d**` : `expires in **${d}d**`;
    return `**WARN** — \`${item.name}\` (${item.type}) ${when} (${expDate}).`;
  }
  if (st === "NO_EXPIRY") {
    return r.probeNonExpiring
      ? `**Non-expiring credential** — \`${item.name}\` (${item.type}) does not expire (e.g. a classic PAT). Scope it down or migrate to keyless.`
      : `**No expiry recorded** — \`${item.name}\` (${item.type}) is alive but has no known expiry. Backfill \`recorded_expiry\` in the manifest (or let the active probe read it live).`;
  }
  if (st === "PROBE_FAILED") {
    return `**Probe failed** — \`${item.name}\` (${item.type}) could not be checked (monitoring gap): ${r.probeError ?? "unknown error"}.`;
  }
  return `\`${item.name}\` is OK.`; // not expected to be used — "open"/"retitle" only fire for alert-worthy statuses
}

function credentialIssueBody(r: ItemResult): string {
  const { item } = r;
  const owner = item.owner ?? "?";
  const keyless = item.keyless_alternative ? `\n\nConsider moving to: ${item.keyless_alternative}` : "";
  const rung = item.target_rung !== undefined
    ? `\n\nLifecycle target: rung ${item.target_rung} (${RUNG_LABELS[item.target_rung]})${item.rung_by ? ` by ${item.rung_by}` : ""} — decision 2026-08-17 (credential lifecycle with no Kevin touch); this alert is the signal to run that migration, not to mint a fresh copy.`
    : "";
  return [credentialHeadline(r), "", `Owner: ${owner}${keyless}${rung}`, "", "This issue auto-closes (with a comment) when this credential's status returns to OK."].join("\n");
}

function credentialStatusChangeComment(r: ItemResult, fromStatus: string, toStatus: string): string {
  return `Status changed: ${fromStatus} → ${toStatus}.\n\n${credentialHeadline(r)}`;
}

function credentialCloseComment(r: ItemResult): string {
  return `\`${r.item.name}\` is back to OK — auto-closed by the credential monitor.`;
}

/**
 * ops-pipeline#74 — the absent-entity sweep's close comment. Per the design comment, NEVER a
 * bare "resolved"/"back to OK" CLAIM — this sweep closes because the credential left the
 * manifest, not because its actual state was re-verified (it wasn't). Mirrors
 * railway-volume-reconcile.ts's sweepCloseComment (#71 Leg 1) in intent; distinct in wording
 * (this monitor has one disposition, not three).
 */
function credentialSweepCloseComment(entity: string): string {
  return `\`${entity}\` is no longer in credentials.manifest.yaml — no longer monitored. This says nothing about the credential's actual state (it was NOT verified as rotated or resolved); if it still exists and matters, re-add it to the manifest. Auto-closed by the credential monitor's absent-entity sweep (ops-pipeline#74).`;
}

// ───────────────────────────── issue action plan ─────────────────────────────

type PlannedAction =
  | { kind: "open"; title: string; body: string }
  | { kind: "retitle"; num: number; newTitle: string; comment: string }
  | { kind: "close"; num: number; comment: string; sweepTitle?: string };

/**
 * `sweepTitle` is set only by the #74 absent-entity sweep — same underlying `close` action as an
 * ordinary OK-recovery close, but the two mean different things (Rule #412), so the dry-run
 * preview text distinguishes them instead of collapsing both to a bare `CLOSE #<num>`.
 */
function describePlanned(p: PlannedAction): string {
  if (p.kind === "open") return `OPEN ${p.title}`;
  if (p.kind === "retitle") return `RETITLE #${p.num} → ${p.newTitle}`;
  if (p.kind === "close" && p.sweepTitle) return `SWEEP-CLOSE #${p.num} ${p.sweepTitle} (no longer monitored)`;
  return `CLOSE #${p.num}`;
}

/** Apply the plan via the shared gh-issue helpers. No-op in dry-run (the issue LIST read already happened; nothing here mutates). */
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

function formatLine(r: ItemResult): string {
  const c = r.classification;
  const days = c.daysToExpiry == null ? "" : ` ${c.daysToExpiry}d`;
  const exp = c.expiry ? ` exp=${c.expiry.slice(0, 10)}` : "";
  const err = r.probeError ? ` err="${r.probeError}"` : "";
  const noteStr = r.probeNote ? ` ${r.probeNote}` : "";
  return `  ${r.item.name.padEnd(22)} ${statusOf(r).padEnd(13)}${exp}${days}${noteStr}${err}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const manifest = parseYaml(readFileSync(MANIFEST_FILE, "utf-8")) as { credentials?: ManifestItem[] };
  const items = manifest.credentials ?? [];
  if (items.length === 0) throw new Error("manifest has no credentials");
  // ops-pipeline#74 — the full monitored-name set, unconditional of probe outcome (a
  // PROBE_FAILED credential is still IN the manifest, so its name belongs here too — see
  // lib/credential-reconcile.ts's header for why the sweep must never see an empty set here).
  const manifestNames = new Set(items.map((i) => i.name));

  const results: ItemResult[] = [];
  for (const item of items) {
    results.push(await evaluate(item, dryRun));
  }

  // Real issue-list read regardless of --dry-run (needs only the workflow's ambient GITHUB_TOKEN,
  // not a Kevin-gated secret — see file header) so the preview reflects real open-issue state.
  // "open" only — this monitor never needs closed-issue history.
  const issues = listIssuesByLabel(REPO, LABEL, "open");
  const openIssuesList = issues.filter((i) => i.state === "OPEN");
  const openByEntity = new Map<string, { issue: IssueRef; status: string }>();
  for (const i of openIssuesList) {
    const parsed = parseSeverityTitle(LABEL, i.title);
    if (parsed) openByEntity.set(parsed.entity, { issue: i, status: parsed.status });
  }

  const planned: PlannedAction[] = [];
  for (const r of results) {
    const entity = r.item.name;
    const key = statusOf(r) === "OK" ? "OK" : statusKey(r);
    const open = openByEntity.get(entity);
    const action = reconcileSeverity(key, open?.status ?? null);
    const title = buildSeverityTitle(LABEL, entity, key);

    if (action === "open") planned.push({ kind: "open", title, body: credentialIssueBody(r) });
    if (action === "retitle" && open) {
      planned.push({ kind: "retitle", num: open.issue.number, newTitle: title, comment: credentialStatusChangeComment(r, open.status, key) });
    }
    if (action === "close" && open) {
      planned.push({ kind: "close", num: open.issue.number, comment: credentialCloseComment(r) });
    }
  }

  // ops-pipeline#74 — absent-entity sweep, run AFTER the per-credential loop above (own
  // separate block, mirrors railway-volume-monitor.ts's sweep call-site convention): closes any
  // OPEN credential-monitor issue whose entity has left credentials.manifest.yaml. Structurally
  // disjoint from the loop above by construction — that loop only ever acts on entities IN
  // `manifestNames` (it iterates `results`, itself built from `items`); the sweep only ever acts
  // on entities NOT in `manifestNames` (lib/credential-reconcile.ts's own guard).
  const sweep = sweepUnmonitoredCredentialIssues(openIssuesList, manifestNames);
  for (const action of sweep.actions) {
    planned.push({ kind: "close", num: action.number, comment: credentialSweepCloseComment(action.entity), sweepTitle: action.title });
  }

  const okCount = results.filter((r) => statusOf(r) === "OK").length;
  const attentionCount = results.length - okCount;
  const summary =
    `Credential monitor — ${results.length} checked, ${okCount} OK, ${attentionCount} need attention. Issue actions: ${planned.length}. ` +
    `Absent-entity sweep: ${sweep.actions.length} orphan(s) closed.`;

  if (dryRun) {
    console.log("=== credential-expiry-monitor --dry-run (no secrets, no probe network calls; REAL gh issue list, NO issue mutations) ===");
    for (const r of results) console.log(formatLine(r));
    console.log(`\n${summary}`);
    for (const p of planned) console.log(`  • ${describePlanned(p)}`);
    return;
  }

  applyPlanned(planned, dryRun);
  // Per-row lines on real runs too (ops#194 receipt contract): probed detail —
  // status, expiry, and the probe `note` (e.g. pw-changed=<date>) — is only
  // populated on real runs, so the daily log is where it must render. Dry-run
  // skips probes and can never show it. Name-level metadata only, never values.
  for (const r of results) console.log(formatLine(r));
  console.log(summary);
}

main().catch((err) => {
  console.error(`credential-expiry-monitor failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
