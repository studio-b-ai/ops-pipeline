#!/usr/bin/env tsx
/**
 * sync-canvas.ts — Push designated repo files to a Slack canvas.
 *
 * Reads ops.yaml → slack.canvas_source[]. Concatenates each source file.
 * Calls Slack canvases.edit with action=replace + no section_id (full replace).
 *
 * Triggered by .github/workflows/sync-mirrors.yml on push to main.
 *
 * Env required:
 *   SLACK_BOT_TOKEN — xoxb-… with canvases:write + chat:write
 *
 * Exit codes:
 *   0 — canvas updated
 *   1 — config / source error
 *   2 — Slack API error
 */

import { loadOpsConfig, readSourceFile, requireEnv } from "./lib/config.js";

const cfg = loadOpsConfig();
const token = requireEnv("SLACK_BOT_TOKEN");

const canvasId = cfg.slack.canvas_id;
if (!canvasId) {
  console.error("ops.yaml: slack.canvas_id is empty — nothing to sync.");
  process.exit(0);
}

// Concatenate source files
const parts: string[] = [];
for (const src of cfg.slack.canvas_source) {
  console.log(`Reading ${src.path} (mode=${src.mode})...`);
  const content = readSourceFile(src.path);
  parts.push(content);
}

const canvasMarkdown = parts.join("\n\n---\n\n");

console.log(`Canvas content prepared: ${canvasMarkdown.length} chars`);

// Slack canvases.edit
// Note: the Anthropic-hosted MCP we used at session-time exposed slack_update_canvas
// with action=replace + content. The underlying Slack API is canvases.edit with
// changes=[{operation:'replace', document_content:{type:'markdown', markdown:'…'}}].
const resp = await fetch("https://slack.com/api/canvases.edit", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  },
  body: JSON.stringify({
    canvas_id: canvasId,
    changes: [
      {
        operation: "replace",
        document_content: { type: "markdown", markdown: canvasMarkdown },
      },
    ],
  }),
});

const json = (await resp.json()) as { ok: boolean; error?: string; warning?: string };
if (!json.ok) {
  console.error(`Slack canvases.edit failed: ${json.error}`);
  process.exit(2);
}

console.log(`✅ Canvas ${canvasId} updated successfully.`);
console.log(`   View: https://${cfg.slack.workspace}.slack.com/docs/${cfg.slack.team_id}/${canvasId}`);

// Optional success notification
if (cfg.notifications.on_sync_success) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: cfg.notifications.channel,
      text: `:arrows_counterclockwise: Canvas refreshed from main: <https://${cfg.slack.workspace}.slack.com/docs/${cfg.slack.team_id}/${canvasId}|${cfg.slack.canvas_title}>`,
    }),
  });
}
