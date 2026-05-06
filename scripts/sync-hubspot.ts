#!/usr/bin/env tsx
/**
 * sync-hubspot.ts — Reconcile live HubSpot portal against infra/hubspot.yaml.
 *
 * Reads infra/hubspot.yaml as canonical state. Probes live HubSpot via API.
 * Reports any drift. If ops.yaml hubspot.auto_fix=true, PATCHes live to match repo.
 *
 * MVP scope (this commit):
 *   - Pipeline stage labels + display_order + probability + is_closed
 *   - Custom property labels + types
 *   - Workflow names + enabled state + descriptions (read-only — internal action
 *     sequences are not codified; would require an unstable Workflow Definition API)
 *
 * Env required:
 *   HUBSPOT_ACCESS_TOKEN — pat-na1-… with crm.objects.deals.read,
 *     crm.schemas.deals.read, crm.schemas.contacts.read, automation
 *
 * Exit codes:
 *   0 — clean (or auto-fix succeeded)
 *   1 — drift detected and auto_fix=false (report-only mode)
 *   2 — auto-fix attempted and failed
 *   3 — config / probe error
 */

import { loadOpsConfig, loadHubspotState, requireEnv, type HubspotState } from "./lib/config.js";

const cfg = loadOpsConfig();
const state = loadHubspotState(cfg.hubspot.state_file);
const token = requireEnv("HUBSPOT_ACCESS_TOKEN");

const HS = "https://api.hubapi.com";

interface DriftItem {
  surface: "pipeline" | "property" | "workflow";
  resource_id: string;
  field: string;
  expected: unknown;
  actual: unknown;
  fixable: boolean;
}

const drift: DriftItem[] = [];

// ─── Pipelines ───────────────────────────────────────────────────────
console.log("Reconciling pipelines...");
for (const expected of state.pipelines.deals) {
  const r = await fetch(`${HS}/crm/v3/pipelines/deals/${expected.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    console.error(`Pipeline ${expected.id} probe failed: ${r.status}`);
    process.exit(3);
  }
  const live = (await r.json()) as { id: string; label: string; stages: Array<{ id: string; label: string; displayOrder: number; metadata: { probability: string; isClosed: string } }> };

  if (live.label !== expected.label) {
    drift.push({ surface: "pipeline", resource_id: expected.id, field: "label", expected: expected.label, actual: live.label, fixable: false });
  }

  for (const expStage of expected.stages) {
    const liveStage = live.stages.find((s) => String(s.id) === String(expStage.id));
    if (!liveStage) {
      drift.push({ surface: "pipeline", resource_id: `${expected.id}/${expStage.id}`, field: "exists", expected: true, actual: false, fixable: false });
      continue;
    }
    if (liveStage.label !== expStage.label) {
      drift.push({ surface: "pipeline", resource_id: `${expected.id}/${expStage.id}`, field: "label", expected: expStage.label, actual: liveStage.label, fixable: true });
    }
    if (liveStage.displayOrder !== expStage.display_order) {
      drift.push({ surface: "pipeline", resource_id: `${expected.id}/${expStage.id}`, field: "display_order", expected: expStage.display_order, actual: liveStage.displayOrder, fixable: true });
    }
    if (parseFloat(liveStage.metadata.probability) !== expStage.probability) {
      drift.push({ surface: "pipeline", resource_id: `${expected.id}/${expStage.id}`, field: "probability", expected: expStage.probability, actual: liveStage.metadata.probability, fixable: true });
    }
    if ((liveStage.metadata.isClosed === "true") !== expStage.is_closed) {
      drift.push({ surface: "pipeline", resource_id: `${expected.id}/${expStage.id}`, field: "is_closed", expected: expStage.is_closed, actual: liveStage.metadata.isClosed, fixable: false });
    }
  }
}

// ─── Properties ──────────────────────────────────────────────────────
console.log("Reconciling properties...");
async function probeProperty(objType: string, name: string) {
  const r = await fetch(`${HS}/crm/v3/properties/${objType}/${name}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json() as Promise<{ name: string; label: string; type: string; fieldType: string; description?: string }>;
}

for (const [objType, props] of [["contacts", state.properties.contacts], ["deals", state.properties.deals]] as const) {
  for (const expected of props) {
    if (expected.managed === false) continue; // not managed by this repo
    const live = await probeProperty(objType, expected.name);
    if (!live) {
      drift.push({ surface: "property", resource_id: `${objType}/${expected.name}`, field: "exists", expected: true, actual: false, fixable: false });
      continue;
    }
    if (live.label !== expected.label) {
      drift.push({ surface: "property", resource_id: `${objType}/${expected.name}`, field: "label", expected: expected.label, actual: live.label, fixable: true });
    }
    if (live.type !== expected.type) {
      drift.push({ surface: "property", resource_id: `${objType}/${expected.name}`, field: "type", expected: expected.type, actual: live.type, fixable: false });
    }
  }
}

// ─── Workflows ───────────────────────────────────────────────────────
// Note: HubSpot's Workflows API is in legacy mode for v3 read; uses /automation/v3/workflows
console.log("Reconciling workflows (read-only)...");
for (const expected of state.workflows) {
  const r = await fetch(`${HS}/automation/v3/workflows/${expected.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    console.warn(`Workflow ${expected.id} probe returned ${r.status} — skipping (expected for some workflow types)`);
    continue;
  }
  const live = (await r.json()) as { id: number; name: string; enabled: boolean; description?: string };
  if (live.name !== expected.name) {
    drift.push({ surface: "workflow", resource_id: String(expected.id), field: "name", expected: expected.name, actual: live.name, fixable: false });
  }
  if (live.enabled !== expected.enabled) {
    drift.push({ surface: "workflow", resource_id: String(expected.id), field: "enabled", expected: expected.enabled, actual: live.enabled, fixable: false });
  }
}

// ─── Report ──────────────────────────────────────────────────────────
if (drift.length === 0) {
  console.log("✅ HubSpot live state matches repo. No drift.");
  process.exit(0);
}

console.log(`⚠️  Detected ${drift.length} drift item(s):`);
for (const d of drift) {
  console.log(`   [${d.surface}] ${d.resource_id} :: ${d.field}: expected ${JSON.stringify(d.expected)}, actual ${JSON.stringify(d.actual)} (fixable=${d.fixable})`);
}

if (cfg.hubspot.auto_fix) {
  console.error("auto_fix=true is not yet implemented in MVP. Manual reconciliation required.");
  process.exit(2);
}

// MVP: report-only — exit non-zero so CI surfaces drift
if (cfg.notifications.on_drift_detected) {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (slackToken) {
    const summary = drift.slice(0, 10).map((d) => `• [${d.surface}] \`${d.resource_id}\` ${d.field}: \`${JSON.stringify(d.actual)}\` ≠ \`${JSON.stringify(d.expected)}\``).join("\n");
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: cfg.hubspot.drift_report_channel,
        text: `:warning: *HubSpot drift detected — ${drift.length} item(s)*\n\n${summary}${drift.length > 10 ? `\n…and ${drift.length - 10} more.` : ""}\n\nPR a fix to \`infra/hubspot.yaml\` or revert the live change in HubSpot UI.`,
      }),
    });
  }
}

process.exit(1);
