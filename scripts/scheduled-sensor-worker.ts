#!/usr/bin/env tsx
/**
 * scheduled-sensor-worker.ts — stint #693 (mechanic, 2026-09-18): the sensor stint #680's
 * end state named and its close never delivered. Two legs, one board:
 *
 *   Leg A (cron-fail) — for every non-archived, non-template org repo, every workflow file
 *     under .github/workflows/ whose YAML carries `on.schedule`: read the 3 newest COMPLETED
 *     scheduled runs (event=schedule). All 3 failing (failure / timed_out / startup_failure)
 *     → finding with the streak's first-failure timestamp. Fewer than 3 completed scheduled
 *     runs → no verdict possible, skip (conservative — Rule #425: this files rows humans
 *     act on). Streak breaks on ANY non-failing conclusion (cancelled/skipped are neutral).
 *
 *   Leg B (rename) — in the same workflow files, every job calling a reusable workflow
 *     (`jobs.<job>.uses`) with a `with.repo` input: resolve the declared owner/name through
 *     `gh api repos/{owner}/{name}`. 404 → finding ("does not resolve"). 200 whose
 *     full_name differs (case-insensitive) → finding ("renamed → <actual>"). This is the
 *     #680/#681 class: the Search API does not follow renames, so a caller naming a retired
 *     repo fails every run while the REST redirect hides it.
 *
 * Why this exists alongside dead-cron-worker.ts (weekly, GitHub issues, K derived from the
 * cron period ≈ dead-for-a-week): #680 burned 153 consecutive hourly failures over SIX DAYS
 * before a human noticed — a weekly tick with a week-scaled K structurally cannot catch an
 * hourly cron inside a day. This sensor runs every 3 hours (Rule #448: cadence beats the
 * SLA — 3 consecutive failures of an hourly cron = 3h of fire, detected within ~6h) with a
 * FIXED K=3 per Rule #358, and files BOARD ROWS (receipts/stints.jsonl on power-unit main)
 * instead of GitHub issues, because the garage board is where seats pick work up.
 *
 * Dedup / Rule #358 (escalate once, again only on recovery): every filed row carries a
 * `sensor_key` (`cron-fail:<repo>:<path>` / `rename:<repo>:<path>:<declared>`). A finding
 * whose key already has a NON-done/released row is not re-filed. The key's row closed and
 * the failure recurs → a fresh row files (that IS the re-escalation after recovery).
 * Flags-only: never edits/disables/re-runs a workflow, never mutates a repo — the only
 * write is the board-row append (Contents API on power-unit, sha-checked, one retry on
 * conflict).
 *
 * `--dry-run`: real reads throughout (Rule #376), zero board mutations, prints findings +
 *   would-be rows.
 * `--repo <name>`: scope to one org repo (testing / the Rule #464 plant ladder).
 * `--ref <ref>`: read workflow files at a non-default ref (the plant fires from a
 *   throwaway branch; Leg A scheduled runs are a default-branch concept and simply find
 *   no runs for a plant file — no special-casing).
 *
 * Auth: GH_TOKEN must be the MINTED studiob-fleet-bot installation token (org-wide reads +
 * contents:write on power-unit). Locally, a personally-authed `gh` works (how the #464
 * plant proof is produced).
 */

import { parse as parseYaml } from "yaml";
import { gh } from "./lib/github-issues.js";

const ORG = "studio-b-ai";
const BOARD_REPO = "studio-b-ai/power-unit";
const BOARD_PATH = "receipts/stints.jsonl";
const K = 3; // Rule #358: escalate at ~3 consecutive fails
const FAILING = new Set(["failure", "timed_out", "startup_failure"]);
const LIVE_ENUMERATION_LIMIT = 300; // safety bound, not paging (Rule #331)

/** repo → garage bay. v1: the Ästhetik surfaces rail to the asthetik bay; everything else studio-b. */
const BAY_BY_REPO: Record<string, string> = {
  "asthetik-website": "asthetik",
  "asthetik-platform": "asthetik",
  "client-asthetik": "asthetik",
};

interface Finding {
  key: string;
  repo: string;
  path: string;
  kind: "cron-fail" | "rename";
  title: string;
  situation: string;
}

interface BoardRow {
  id: number;
  status?: string;
  sensor_key?: string;
  [k: string]: unknown;
}

// ───────────────────────────── args ─────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const repoIdx = argv.indexOf("--repo");
const ONLY_REPO = repoIdx >= 0 ? argv[repoIdx + 1] : null;
const refIdx = argv.indexOf("--ref");
const REF = refIdx >= 0 ? argv[refIdx + 1] : null;

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** gh api that returns null on HTTP 404 instead of throwing (rename leg's not-found probe). */
function ghApiOrNull(endpoint: string): string | null {
  try {
    return gh(["api", endpoint]);
  } catch (err) {
    const detail = err instanceof Error ? `${(err as { stderr?: string }).stderr ?? ""}\n${err.message}` : String(err);
    if (/HTTP 404/.test(detail)) return null;
    throw err;
  }
}

// ───────────────────────────── board read (dedup population) ─────────────────────────────
function readBoard(): { rows: BoardRow[]; openKeys: Set<string>; maxId: number } {
  const raw = gh(["api", `repos/${BOARD_REPO}/contents/${BOARD_PATH}`, "-H", "Accept: application/vnd.github.raw"]);
  const rows: BoardRow[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as BoardRow);
    } catch {
      /* a crew wrote a raw tab once — tolerate and move on (stint.py does the same) */
    }
  }
  const openKeys = new Set<string>();
  let maxId = 200;
  for (const r of rows) {
    if (typeof r.id === "number" && r.id > maxId) maxId = r.id;
    const st = (r.status ?? "").toLowerCase();
    if (r.sensor_key && st !== "done" && st !== "released" && st !== "closed") openKeys.add(r.sensor_key);
  }
  return { rows, openKeys, maxId };
}

// ───────────────────────────── board append (the only write) ─────────────────────────────
function appendRows(rows: BoardRow[]): void {
  for (const row of rows) {
    const line = JSON.stringify(row);
    for (let attempt = 0; attempt < 2; attempt++) {
      const meta = JSON.parse(gh(["api", `repos/${BOARD_REPO}/contents/${BOARD_PATH}`])) as { sha: string; content: string };
      const cur = Buffer.from(meta.content, "base64").toString("utf-8");
      const next = (cur.endsWith("\n") ? cur : cur + "\n") + line + "\n";
      try {
        gh([
          "api", "-X", "PUT", `repos/${BOARD_REPO}/contents/${BOARD_PATH}`,
          "-f", `message=sensor: stint #${row.id} add · ${String(row.title).slice(0, 60)}`,
          "-f", `content=${Buffer.from(next, "utf-8").toString("base64")}`,
          "-f", `sha=${meta.sha}`,
        ]);
        console.log(`[sensor] FILED board row #${row.id}: ${row.title}`);
        break;
      } catch (err) {
        const detail = err instanceof Error ? `${(err as { stderr?: string }).stderr ?? ""}\n${err.message}` : String(err);
        if (attempt === 0 && /HTTP 409/.test(detail)) continue; // another pen landed first — re-read sha, retry once
        throw err;
      }
    }
  }
}

// ───────────────────────────── enumeration ─────────────────────────────
function listRepos(): string[] {
  if (ONLY_REPO) return [ONLY_REPO];
  const raw = gh(["repo", "list", ORG, "--limit", String(LIVE_ENUMERATION_LIMIT), "--json", "name,isArchived,isTemplate"]);
  const all = JSON.parse(raw) as { name: string; isArchived: boolean; isTemplate: boolean }[];
  return all.filter((r) => !r.isArchived && !r.isTemplate).map((r) => r.name);
}

interface WorkflowFile { name: string; text: string }

function listWorkflowFiles(repo: string): WorkflowFile[] {
  const refQ = REF ? `?ref=${encodeURIComponent(REF)}` : "";
  const listing = ghApiOrNull(`repos/${ORG}/${repo}/contents/.github/workflows${refQ}`);
  if (!listing) return [];
  const entries = JSON.parse(listing) as { name: string; type: string }[];
  const out: WorkflowFile[] = [];
  for (const e of entries) {
    if (e.type !== "file" || !/\.(ya?ml)$/.test(e.name)) continue;
    const file = ghApiOrNull(`repos/${ORG}/${repo}/contents/.github/workflows/${e.name}${refQ}`);
    if (!file) continue;
    const meta = JSON.parse(file) as { content?: string };
    if (!meta.content) continue;
    out.push({ name: e.name, text: Buffer.from(meta.content, "base64").toString("utf-8") });
  }
  return out;
}

// ───────────────────────────── leg A: cron-fail ─────────────────────────────
interface RunRow { id?: number; status: string; conclusion: string | null; created_at: string; html_url: string }

function legA(repo: string, wf: WorkflowFile): Finding | null {
  if (!/cron\s*:/.test(wf.text)) return null; // no schedule in the file — not this leg's business
  // Transient-read guard (dead-cron's ui-test-suite#44 lesson — a one-shot runs page came
  // back with entries missing and the classifier trusted it): read the window TWICE with
  // different query shapes and classify on the UNION by run id. A run missing from one
  // response is caught if the other has it — an absence claim needs a second instrument
  // (#322/#465). Residual: a backend dropping the same runs from BOTH shapes still fools
  // it; the 3-hourly re-evaluation + the open-row dedup is the self-heal.
  const plain = ghApiOrNull(`repos/${ORG}/${repo}/actions/workflows/${encodeURIComponent(wf.name)}/runs?event=schedule&per_page=${K}`);
  const windowed = ghApiOrNull(`repos/${ORG}/${repo}/actions/workflows/${encodeURIComponent(wf.name)}/runs?event=schedule&per_page=${K}&created=%3E%3D2000-01-01`);
  const byId = new Map<number, RunRow>();
  let anon = -1;
  for (const raw of [plain, windowed]) {
    if (!raw) continue;
    for (const r of (JSON.parse(raw).workflow_runs ?? []) as RunRow[]) byId.set(r.id ?? anon--, r);
  }
  const runs = [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)); // never trust input order
  const completed = runs.filter((r) => r.status === "completed").slice(0, K);
  if (completed.length < K) return null; // <K completed scheduled runs — no verdict (Rule #425)
  if (!completed.every((r) => r.conclusion && FAILING.has(r.conclusion))) return null;
  const newest = completed[0];
  const oldest = completed[completed.length - 1];
  return {
    key: `cron-fail:${repo}:${wf.name}`,
    repo, path: wf.name, kind: "cron-fail",
    title: `[sensor] cron-fail: ${repo} ${wf.name} — ${K} consecutive scheduled failures`,
    situation:
      `${ORG}/${repo} ${wf.name} has failed its last ${K} completed scheduled runs ` +
      `(newest ${newest.created_at} ${newest.html_url}, first-of-streak ${oldest.created_at}). ` +
      `This is the #680 silence class: a scheduled workflow failing identically every run with nobody watching. ` +
      `Sensor: scheduled-sensor.yml (stint #693), fixed K=${K} per Rule #358.`,
  };
}

// ───────────────────────────── leg B: rename ─────────────────────────────
function legB(repo: string, wf: WorkflowFile): Finding[] {
  let doc: unknown;
  try {
    doc = parseYaml(wf.text);
  } catch {
    return []; // unparseable YAML is required-checks-drift's finding class, not this leg's
  }
  const jobs = (doc as { jobs?: Record<string, { uses?: string; with?: Record<string, unknown> }> })?.jobs;
  if (!jobs || typeof jobs !== "object") return [];
  const findings: Finding[] = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object" || !job.uses) continue; // only reusable-workflow callers
    const declared = job.with?.repo;
    if (typeof declared !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(declared)) continue;
    const res = ghApiOrNull(`repos/${declared}`);
    if (res === null) {
      findings.push({
        key: `rename:${repo}:${wf.name}:${declared}`,
        repo, path: wf.name, kind: "rename",
        title: `[sensor] rename: ${repo} ${wf.name} job ${jobName} names ${declared} — does not resolve`,
        situation:
          `${ORG}/${repo} ${wf.name} job "${jobName}" calls ${job.uses} with repo: ${declared}, which ` +
          `gh api repos/${declared} returns 404 for. The Search API does not follow renames — a caller naming a ` +
          `retired repo fails every run while REST redirects hide it (#680/#681). Declared value must be corrected ` +
          `or the call removed. Sensor: scheduled-sensor.yml (stint #693).`,
      });
      continue;
    }
    const actual = (JSON.parse(res) as { full_name?: string }).full_name;
    if (actual && actual.toLowerCase() !== declared.toLowerCase()) {
      findings.push({
        key: `rename:${repo}:${wf.name}:${declared}`,
        repo, path: wf.name, kind: "rename",
        title: `[sensor] rename: ${repo} ${wf.name} job ${jobName} names ${declared} → now ${actual}`,
        situation:
          `${ORG}/${repo} ${wf.name} job "${jobName}" calls ${job.uses} with repo: ${declared}; the REST API ` +
          `redirects to ${actual}, but the Search API does not follow renames — every search leg against the ` +
          `retired name fails (#680 radio#1204, #681 asthetik-website#611). Fix: repo: ${actual}. ` +
          `Sensor: scheduled-sensor.yml (stint #693).`,
      });
    }
  }
  return findings;
}

// ───────────────────────────── main ─────────────────────────────
function main(): void {
  const { openKeys, maxId } = readBoard();
  console.log(`[sensor] board read: ${openKeys.size} open sensor key(s), max id ${maxId}${DRY_RUN ? " (dry-run)" : ""}`);
  const findings: Finding[] = [];
  for (const repo of listRepos()) {
    for (const wf of listWorkflowFiles(repo)) {
      try {
        const a = legA(repo, wf);
        if (a) findings.push(a);
        findings.push(...legB(repo, wf));
      } catch (err) {
        // one repo/workflow's read failure must not blind the fleet sweep — say so loudly and continue
        console.log(`[sensor] READ-FAIL ${repo}/${wf.name}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      }
    }
  }
  console.log(`[sensor] ${findings.length} finding(s) before dedup`);
  const fresh = findings.filter((f) => !openKeys.has(f.key));
  const dupes = findings.length - fresh.length;
  if (dupes) console.log(`[sensor] dedup: ${dupes} finding(s) already have an open board row (Rule #358 — escalate once)`);
  if (!fresh.length) {
    console.log("[sensor] nothing to file");
    return;
  }
  const now = utcNow();
  const rows: BoardRow[] = fresh.map((f, i) => ({
    id: maxId + 1 + i,
    bay: BAY_BY_REPO[f.repo] ?? "studio-b",
    title: f.title,
    seat: "mechanic",
    priority: "P2",
    status: "open",
    tags: ["sensor", f.kind, f.repo],
    race: null,
    blocked: false,
    created: now,
    updated: now,
    born: "telemetry",
    class: "fire",
    budget_min: 25,
    shape: "push",
    situation: f.situation,
    purpose: "A rename must never again break a workflow for days before a human notices; a scheduled workflow failing N consecutive runs is a signal, not noise.",
    end_state: "Root cause named in a receipt; the workflow's next scheduled run green, or the caller corrected and its next run green; this row closed by the fixing seat.",
    sensor_key: f.key,
  }));
  for (const r of rows) console.log(`[sensor] ${DRY_RUN ? "would file" : "filing"} #${r.id}: ${r.title}\n           key=${r.sensor_key}`);
  if (DRY_RUN) return;
  appendRows(rows);
}

main();
