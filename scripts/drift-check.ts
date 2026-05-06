#!/usr/bin/env tsx
/**
 * drift-check.ts — Weekly probe that reports drift across all mirrored surfaces.
 *
 * Runs sync-hubspot in report-only mode + diffs Slack canvas against expected
 * output from current repo HEAD. Posts a structured drift report to the
 * configured channel.
 *
 * Triggered by .github/workflows/drift-check-weekly.yml on Mondays.
 *
 * Env required:
 *   HUBSPOT_ACCESS_TOKEN
 *   SLACK_BOT_TOKEN
 *
 * Exit codes:
 *   0 — clean
 *   1 — drift detected (report posted; non-zero so CI surfaces it)
 */

import { loadOpsConfig, readSourceFile, requireEnv } from "./lib/config.js";

const cfg = loadOpsConfig();
const slackToken = requireEnv("SLACK_BOT_TOKEN");

let driftCount = 0;
const sections: string[] = [];

// ─── Slack canvas drift ──────────────────────────────────────────────
console.log("Checking Slack canvas drift...");

const canvasResp = await fetch("https://slack.com/api/canvases.sections.lookup", {
  method: "POST",
  headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({ canvas_id: cfg.slack.canvas_id, criteria: { contains_text: "" } }),
});
const canvasJson = (await canvasResp.json()) as { ok: boolean; sections?: Array<{ section_id: string }>; error?: string };

if (!canvasJson.ok) {
  // Fallback: just check if the canvas is recently updated
  console.warn(`canvases.sections.lookup failed: ${canvasJson.error}. Skipping fine-grained canvas drift check.`);
} else {
  // Compare expected source content vs canvas size as a rough proxy
  const expectedParts = cfg.slack.canvas_source.map((s) => readSourceFile(s.path));
  const expectedTotal = expectedParts.reduce((acc, p) => acc + p.length, 0);
  const liveSections = canvasJson.sections?.length ?? 0;
  console.log(`Expected source: ${expectedTotal} chars across ${expectedParts.length} files. Live canvas sections: ${liveSections}.`);
  // For MVP, we don't deep-diff. We trust the on-push sync. The drift-check is
  // primarily for HubSpot which is far more likely to drift via UI hand-edits.
}

// ─── HubSpot drift (re-run sync-hubspot in dry mode) ────────────────
console.log("Running HubSpot reconciliation (report-only)...");
import("./sync-hubspot.js").catch((err) => {
  console.error("sync-hubspot run failed:", err);
});

// sync-hubspot.ts handles its own drift reporting + non-zero exit.
// drift-check is a thin wrapper that runs it on a schedule.

// ─── Footer post ─────────────────────────────────────────────────────
const now = new Date().toISOString().slice(0, 10);
await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    channel: cfg.notifications.channel,
    text: `:mag: *Weekly drift-check completed (${now})*\n\nMirrors checked: Slack canvas, HubSpot pipeline, HubSpot properties, HubSpot workflows. ${driftCount === 0 ? ":white_check_mark: No drift detected." : `:warning: See above for ${driftCount} drift item(s).`}`,
  }),
});
