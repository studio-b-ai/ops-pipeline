#!/usr/bin/env tsx
/**
 * needs-human-probe.ts — ops-pipeline#20 (Project 3, Kevin word 2026-08-04:
 * "dispatch. we need to automate this process.")
 *
 * When the bug-squasher escalates an issue with the `needs-human` label, this probe
 * auto-dispatches: it gathers read-only context (the issue thread + files the thread
 * names) and posts ONE findings comment — culprit hypothesis, quoted evidence,
 * fix-layer recommendation, NEEDS-KEVIN flag — so the human arrives pre-briefed.
 * Humans enter at the FIX-LAYER decision, not the diagnosis. The manual prototype
 * was the 2026-08-04 bolt-wms#1417 probe.
 *
 * READ-ONLY BY CONSTRUCTION, not by prompt (Rule #373): the model gets NO tools —
 * one completion over deterministically-gathered context. The workflow token holds
 * `contents: read` + `issues: write` (comment) and nothing else. A hostile issue
 * body can at worst distort prose inside a comment that labels itself a hypothesis.
 *
 * Model: claude-sonnet-5 — probes are Sonnet-class (Rules #87/#469).
 *
 * Dispatch-ledger note (#461): dispatch here is a SYNCHRONOUS workflow run — the
 * run is its own receipt and a failure is a visibly red run. No detached sessions,
 * so no dispatched-but-no-receipt reconcile sweep is needed for v1.
 *
 * Failure posture: fail open-silent. Any error → red workflow run, no comment,
 * issue untouched. The human was already the fallback; a broken probe must never
 * block or spam the escalation surface.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { requireEnv } from "./lib/config.js";
import {
  alreadyProbed,
  buildSystemPrompt,
  buildUserPrompt,
  CAPS,
  extractFilePaths,
  PROBE_MARKER,
  renderComment,
  type ProbeContext,
} from "./lib/needs-human-probe-lib.js";

const PROBE_MODEL = "claude-sonnet-5";
const PROBE_MAX_TOKENS = 2500;

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

interface IssueView {
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  comments: Array<{ author: { login: string }; body: string }>;
}

function fetchIssue(repo: string, num: number): IssueView {
  return JSON.parse(gh(["issue", "view", String(num), "--repo", repo, "--json", "title,body,labels,comments"])) as IssueView;
}

/** Fetch a repo file's current content via the contents API; null when absent (paths in prose drift). */
function fetchFile(repo: string, path: string): string | null {
  try {
    const raw = gh(["api", `repos/${repo}/contents/${path}`, "--jq", ".content"]);
    return Buffer.from(raw.trim(), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  requireEnv("ANTHROPIC_API_KEY");
  const repo = requireEnv("PROBE_REPO");
  const issueNumber = Number(requireEnv("PROBE_ISSUE"));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`PROBE_ISSUE must be a positive integer, got: ${process.env.PROBE_ISSUE}`);
  }

  const issue = fetchIssue(repo, issueNumber);

  // Gate 1 — only escalated issues. The caller workflow filters on the label too,
  // but a manual workflow_dispatch can point anywhere; re-verify at evaluation time
  // (Rule #182) so the probe never comments on an unescalated issue.
  const labels = issue.labels.map((l) => l.name);
  if (!labels.includes("needs-human")) {
    console.log(`[probe] ${repo}#${issueNumber} has no needs-human label — not an escalation, skipping.`);
    return;
  }

  // Gate 2 — once per issue. The marker in a prior comment is the dedup state.
  const commentBodies = issue.comments.map((c) => c.body);
  if (alreadyProbed(commentBodies)) {
    console.log(`[probe] ${repo}#${issueNumber} already carries a probe comment — skipping (marker: ${PROBE_MARKER}).`);
    return;
  }

  // Context: thread text + the files it names (current heads, read-only).
  const threadText = [issue.title, issue.body, ...commentBodies].join("\n");
  const paths = extractFilePaths(threadText, CAPS.files);
  const files: ProbeContext["files"] = [];
  for (const p of paths) {
    const content = fetchFile(repo, p);
    if (content !== null) files.push({ path: p, content });
    else files.push({ path: p, content: "", note: "mentioned in thread but not found at repo HEAD" });
  }
  console.log(`[probe] ${repo}#${issueNumber}: ${issue.comments.length} comment(s), ${paths.length} path(s) referenced, ${files.filter((f) => f.content).length} fetched.`);

  const ctx: ProbeContext = {
    repo,
    issueNumber,
    title: issue.title,
    body: issue.body,
    labels,
    comments: issue.comments.map((c) => ({ author: c.author.login, body: c.body })),
    files,
  };

  const anthropic = new Anthropic();
  const resp = await anthropic.messages.create({
    model: PROBE_MODEL,
    max_tokens: PROBE_MAX_TOKENS,
    system: buildSystemPrompt(),
    // pg-enum-drift-exempt: Anthropic Messages API role field, not a Postgres column
    messages: [{ role: "user", content: buildUserPrompt(ctx) }],
  });
  const diagnosis = resp.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!diagnosis.trim()) throw new Error("model returned an empty diagnosis — not posting an empty comment");

  const comment = renderComment(diagnosis, PROBE_MODEL);
  gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", comment]);
  console.log(`[probe] posted findings comment on ${repo}#${issueNumber} (${diagnosis.length} chars).`);
}

main().catch((e) => {
  console.error(`[probe] FAILED (fail open-silent — no comment posted): ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
