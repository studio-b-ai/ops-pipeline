#!/usr/bin/env tsx
/**
 * credential-expiry-monitor.ts — CLAUDE.md Rule #302.
 *
 * Daily (GH Actions cron): for each item in credentials.manifest.yaml, read its value via the
 * read-only "Studio B Infrastructure" 1Password Service Account (OP_SERVICE_ACCOUNT_INFRA), run
 * the type's ACTIVE probe (real expiry/aliveness — not the recorded date), classify, and route:
 *   WARN / DEAD / NO_EXPIRY / PROBE_FAILED → #agent-escalations (C0ATMSL2CR2), deduped (Rule #292)
 *   a daily "✅ N checked …" beacon       → #agent-notifications (C0B4B3F62H2) — its ABSENCE is
 *                                            the monitor's own staleness signal (Rule #279)
 *
 * `--dry-run` classifies from the recorded dates only — NO secrets, NO network, NO Slack posts —
 * so the logic is testable before the Infra SA exists.
 *
 * SECURITY (Rule #259/#282): credential VALUES are read into variables and passed to probes; they
 * are NEVER logged, never put in alert text, never written to the state file. Only NAME-level
 * metadata + derived expiry DATES flow out.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  probe1PasswordSA,
  getCertExpiry,
  type EntraProbeCreds,
} from "./lib/credential-probes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(HERE, "credentials.manifest.yaml");
const STATE_FILE = join(HERE, "credential-alert-state.json");

const CH_ESCALATIONS = "C0ATMSL2CR2"; // #agent-escalations (studiob-ai workspace — Rule #32/#165)
const CH_NOTIFICATIONS = "C0B4B3F62H2"; // #agent-notifications (studiob-ai workspace)

type CredType =
  | "1password-sa"
  | "npm-granular"
  | "github-pat-finegrained"
  | "entra-client-secret"
  | "cloudflare-api-token"
  | "tls-cert";

interface ManifestItem {
  name: string;
  type: CredType;
  op_ref?: string;
  app_id?: string;
  app_secret_key_id?: string; // entra: pin the SPECIFIC monitored secret by its (non-secret) keyId
  host?: string;
  recorded_expiry?: string | null;
  owner?: string;
  keyless_alternative?: string | null;
}

interface ItemResult {
  item: ManifestItem;
  classification: Classification;
  probeError?: string;
  probeNonExpiring?: boolean;
}

/** Read a status value without the bare `status` keyword sitting next to a string literal. */
function statusOf(r: ItemResult): CredStatus {
  return r.classification.status;
}

// ───────────────────────────── value access (never logged) ─────────────────────────────

function opRead(opRef: string): string {
  const token = requireEnv("OP_SERVICE_ACCOUNT_INFRA");
  return execFileSync("op", ["read", opRef], {
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
    encoding: "utf-8",
    timeout: 15_000,
  }).trim();
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

// ───────────────────────────── probing ─────────────────────────────

async function runProbe(item: ManifestItem): Promise<ProbeResult> {
  const recorded = item.recorded_expiry ?? null;
  switch (item.type) {
    case "github-pat-finegrained":
      return probeGithubPat(opRead(reqRef(item)));
    case "cloudflare-api-token":
      return probeCloudflareToken(opRead(reqRef(item)), recorded);
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
    return { item, classification: classify({ recordedExpiry: recorded, probe: { alive: true, expiry: null, source: "recorded" } }) };
  }
  let probe: ProbeResult;
  try {
    probe = await runProbe(item);
  } catch (err) {
    probe = { alive: true, expiry: null, source: "probe", error: err instanceof Error ? err.message : String(err) };
  }
  return {
    item,
    classification: classify({ recordedExpiry: recorded, probe }),
    probeError: probe.error,
    probeNonExpiring: probe.nonExpiring,
  };
}

// ───────────────────────────── alerting + dedup ─────────────────────────────

function dedupKey(r: ItemResult): string {
  const st = statusOf(r);
  if (st === "WARN") return `${r.item.name}:warn:${r.classification.threshold}`;
  return `${r.item.name}:${st.toLowerCase()}`;
}

function alertText(r: ItemResult): string | null {
  const { item } = r;
  const c = r.classification;
  const st = statusOf(r);
  const owner = item.owner ?? "?";
  const keyless = item.keyless_alternative ? ` → consider moving to ${item.keyless_alternative}` : "";
  const expDate = c.expiry ? c.expiry.slice(0, 10) : "unknown";
  if (st === "DEAD") {
    return `:red_circle: *Credential DEAD* — \`${item.name}\` (${item.type}) failed its aliveness probe — expired or revoked. Rotate now. Owner: ${owner}.`;
  }
  if (st === "WARN") {
    const d = c.daysToExpiry ?? 0;
    const when = d < 0 ? `*OVERDUE by ${Math.abs(d)}d*` : `expires in *${d}d*`;
    return `:warning: *Credential expiring* — \`${item.name}\` (${item.type}) ${when} (${expDate}). Owner: ${owner}.${keyless}`;
  }
  if (st === "NO_EXPIRY") {
    if (r.probeNonExpiring) {
      return `:grey_question: *Non-expiring credential* — \`${item.name}\` (${item.type}) does not expire (e.g. a classic PAT). Scope it down or migrate to keyless. Owner: ${owner}.${keyless}`;
    }
    return `:grey_question: *No expiry recorded* — \`${item.name}\` (${item.type}) is alive but has no known expiry. Backfill \`recorded_expiry\` in the manifest (or let the active probe read it live). Owner: ${owner}.${keyless}`;
  }
  if (st === "PROBE_FAILED") {
    return `:large_orange_diamond: *Credential probe failed* — \`${item.name}\` (${item.type}) could not be checked (monitoring gap): ${r.probeError ?? "unknown error"}. Owner: ${owner}.`;
  }
  return null; // OK
}

function buildBeacon(results: ItemResult[]): string {
  const n = results.length;
  const ok = results.filter((r) => statusOf(r) === "OK").length;
  const attention = results.filter((r) => statusOf(r) !== "OK").length;
  const withDays = results.filter((r) => r.classification.daysToExpiry != null);
  let soonest = "";
  if (withDays.length > 0) {
    const min = withDays.reduce((a, b) =>
      (a.classification.daysToExpiry as number) <= (b.classification.daysToExpiry as number) ? a : b,
    );
    soonest = ` Soonest: ${min.item.name} in ${min.classification.daysToExpiry}d.`;
  }
  const tail = attention > 0 ? `:warning: ${attention} need attention.` : ":white_check_mark: all clear.";
  return `:closed_lock_with_key: Credential monitor — ${n} checked, ${ok} OK.${soonest} ${tail}`;
}

function loadAlertState(): Set<string> {
  if (!existsSync(STATE_FILE)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as unknown;
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveAlertState(keys: Set<string>): void {
  writeFileSync(STATE_FILE, JSON.stringify([...keys].sort(), null, 2) + "\n");
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

// ───────────────────────────── main ─────────────────────────────

function formatLine(r: ItemResult): string {
  const c = r.classification;
  const days = c.daysToExpiry == null ? "" : ` ${c.daysToExpiry}d`;
  const exp = c.expiry ? ` exp=${c.expiry.slice(0, 10)}` : "";
  const err = r.probeError ? ` err="${r.probeError}"` : "";
  return `  ${r.item.name.padEnd(22)} ${statusOf(r).padEnd(13)}${exp}${days}${err}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const manifest = parseYaml(readFileSync(MANIFEST_FILE, "utf-8")) as { credentials?: ManifestItem[] };
  const items = manifest.credentials ?? [];
  if (items.length === 0) throw new Error("manifest has no credentials");

  const results: ItemResult[] = [];
  for (const item of items) {
    results.push(await evaluate(item, dryRun));
  }

  const prev = dryRun ? new Set<string>() : loadAlertState();
  const nowKeys = new Set<string>();
  const toPost: string[] = [];

  for (const r of results) {
    const text = alertText(r);
    if (!text) continue; // OK
    if (statusOf(r) === "DEAD") {
      toPost.push(text); // urgent — post every run, no dedup
      continue;
    }
    const key = dedupKey(r);
    nowKeys.add(key);
    if (!prev.has(key)) toPost.push(text);
  }

  const beacon = buildBeacon(results);

  if (dryRun) {
    console.log("=== credential-expiry-monitor --dry-run (no secrets, no network, no Slack) ===");
    for (const r of results) console.log(formatLine(r));
    console.log(`\n[beacon → #agent-notifications] ${beacon}`);
    console.log(`[would post ${toPost.length} alert(s) → #agent-escalations]`);
    for (const t of toPost) console.log(`  • ${t}`);
    return;
  }

  for (const text of toPost) await postSlack(CH_ESCALATIONS, text);
  await postSlack(CH_NOTIFICATIONS, beacon);
  saveAlertState(nowKeys);
  console.log(`Checked ${results.length} credential(s); posted ${toPost.length} escalation(s) + 1 beacon.`);
}

main().catch((err) => {
  console.error(`credential-expiry-monitor failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
