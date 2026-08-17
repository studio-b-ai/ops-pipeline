#!/usr/bin/env tsx
/**
 * backlog-compliance-worker.ts — ops-pipeline#151 (CTO seat, LANES rule 17(g), Kevin word
 * 2026-08-17 ~02:20 ET via CoS: "make sure you're enforcing all sessions to be keeping
 * gittracked backlogs which are first ranked and prioritized by the lane, then the manager,
 * then the cos then kevin"). Thin I/O glue around scripts/lib/backlog-compliance-lib.ts — read
 * THAT file's header first; no parse/evaluate/render decision lives here. Full grammar + checks
 * table: `library/product/2026-08-17-backlog-compliance-leg-design.md` (brain repo).
 *
 * Distinct instrument from backlog-staleness-worker.ts (which classifies GitHub ISSUES against
 * per-manager staleness thresholds on the fleet's PRODUCT repos). This worker reads
 * `studio-b-ai/brain`'s LANES.md + every active lane's own git-tracked brief, and reconciles
 * findings as GitHub issues ON `studio-b-ai/brain` itself (`compliance.brain_repo` in
 * backlog-managers.yaml serves BOTH roles — the read source and the issue-mutation target).
 *
 * ── Read modes ──
 * `--brain-dir <path>` (LOCAL mode): reads LANES.md and every brief straight off disk under
 * that path — no `gh`/network calls for the CONTENT reads (issue mutations still go through
 * `gh`, always). Used for the ship-gate dry-run against the REAL vault
 * (`/Users/kevin/Documents/brain`) without a Contents-API round trip. This worker only ever
 * READS under `--brain-dir` — it never writes there, in any mode, ever.
 * Omitted (GitHub Contents-API mode): `gh api repos/<brain_repo>/contents/<path> --jq .content`
 * + base64-decode, mirroring `needs-human-probe.ts`'s `fetchFile` — the production/scheduled
 * mode, reading the pushed HEAD of `studio-b-ai/brain` rather than a local checkout.
 *
 * ── Failure posture: ALL-OR-NOTHING, stricter than backlog-staleness's per-manager tolerance ──
 * A LANES.md read failure (any error, in either mode) is fatal before anything else runs — no
 * rows, no findings, no mutations. A brief read that resolves to "genuinely absent" (ENOENT
 * locally; a confirmed `HTTP 404` from the Contents API) is NOT an error — it's exactly what a
 * P1 finding means, and evaluate() handles it. Any OTHER brief-read error (permission denied,
 * network failure, a non-404 API error, a truncated/ambiguous response) is collected across the
 * whole run; if ANY occurred, this run performs ZERO issue mutations — not partial, not
 * skip-that-one-lane — because a picture with an unknown-status lane in it is not a trustworthy
 * basis for reconciling ANY issue, rollup or per-lane (Rule #465). Every attempted read (or its
 * failure) is logged; the run still exits 1 so the GH Actions job goes red (Rule #8/#412).
 *
 * ── Rollup vs per-lane switching (design doc §2) ──
 * `now < compliance.per_lane_issues_from`: ONE fleet rollup issue (identified by
 * `ROLLUP_MARKER` as the first line of its body, never by title — title is cosmetic here,
 * unlike backlog-staleness's parsed-title severity convention) is opened once and its BODY
 * rewritten every run (Rule #355/#412 — a checklist that goes stale is worse than no
 * checklist). No comment-per-run: unlike backlog-staleness's discrete severity-transition
 * events, this is a continuously-refreshed census table, not a sequence of alert-worthy
 * moments — a daily near-duplicate comment would be noise, not history.
 * `now >= compliance.per_lane_issues_from`: the rollup issue, if still open, is CLOSED
 * (unconditionally — this is a date-driven cutover, not a findings-driven decision) and each
 * ACTIVE, non-skip row gets its OWN issue (identified by `laneMarker(name)`), opened/
 * retitled+re-bodied/closed via `planIssueAction` keyed on FAILED findings only (pending
 * findings never open or keep an issue open — design doc §2's ramp-up grace period).
 *
 * `config.skip` rows and inactive (ARCHIVED/TOMBSTONED) rows are never evaluated and never
 * mutated — including NOT auto-closing whatever issue state they happen to be in, since this
 * worker has no fresh evidence about them to reconcile on (Rule #465 applies to inaction too).
 *
 * `--lanes <csv>`: scope evaluation to a comma-separated subset of LANES.md row names (mirrors
 * backlog-staleness's `--repos`). Any name not matching a real row throws. In ROLLUP mode, a
 * scope that covers only SOME active/non-skip rows SKIPS the rollup mutation entirely (a
 * partial checklist overwriting the complete one would misrepresent state — the same concern
 * backlog-staleness's `managerScopeIncomplete` guards); the cutover CLOSE is exempt (it isn't
 * writing new checklist content). In PER-LANE mode each row's issue is independent, so `--lanes`
 * simply narrows which rows get touched this run, no aggregation risk.
 *
 * `--dry-run`: real reads throughout (LANES.md, every brief, the existing open compliance
 * issues on brain_repo — Rule #376), zero issue mutations. `--now <ISO>`: overrides the clock
 * (the #464/#471 plant ladder) — omit for the real time.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  parseLanesRows,
  resolveBriefPath,
  unmatchedBriefKeys,
  evaluate,
  isCompliant,
  renderRollupBody,
  renderLaneBody,
  summaryLine,
  laneMarker,
  ROLLUP_MARKER,
  LABEL,
  type ComplianceConfig,
  type LaneRow,
  type LaneComplianceResult,
} from "./lib/backlog-compliance-lib.js";
import { gh, ensureLabel, openIssue, closeIssue, commentIssue, retitleIssue, editIssueBody } from "./lib/github-issues.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "backlog-managers.yaml");
const LABEL_DESCRIPTION = "LANES rule 17(g): a lane's git-tracked ranked backlog is missing/stale/malformed (auto-reconciled)";
const LABEL_COLOR = "FBCA04"; // same family as backlog-staleness — both are LANES rule 17 instruments
const ROLLUP_TITLE = "[backlog-compliance] rollup";

/** Safety bound, not a paging mechanism (Rule #331) — a full final page is a loud warning, not a silent truncation. */
const ISSUE_LIST_LIMIT = 1000;

// ───────────────────────────── config ─────────────────────────────

function loadComplianceConfig(): ComplianceConfig {
  const raw = parseYaml(readFileSync(CONFIG_FILE, "utf-8")) as { compliance?: Partial<ComplianceConfig> } | null;
  const c = raw?.compliance;
  if (!c) throw new Error(`${CONFIG_FILE} malformed: "compliance" block is missing`);

  const requiredStrings = ["brain_repo", "lanes_file", "per_lane_issues_from", "manager_stamp_enforced_from", "cos_stamp_enforced_from"] as const;
  for (const key of requiredStrings) {
    if (typeof c[key] !== "string" || c[key]!.length === 0) throw new Error(`${CONFIG_FILE} malformed: "compliance.${key}" must be a non-empty string`);
  }
  const requiredNumbers = ["lane_stamp_max_age_days", "manager_lag_max_hours", "cos_stamp_max_age_days"] as const;
  for (const key of requiredNumbers) {
    if (typeof c[key] !== "number") throw new Error(`${CONFIG_FILE} malformed: "compliance.${key}" must be a number`);
  }
  if (c.briefs !== undefined && (typeof c.briefs !== "object" || Array.isArray(c.briefs))) {
    throw new Error(`${CONFIG_FILE} malformed: "compliance.briefs" must be a map`);
  }
  if (c.skip !== undefined && !Array.isArray(c.skip)) throw new Error(`${CONFIG_FILE} malformed: "compliance.skip" must be an array`);

  return {
    brain_repo: c.brain_repo!,
    lanes_file: c.lanes_file!,
    per_lane_issues_from: c.per_lane_issues_from!,
    manager_stamp_enforced_from: c.manager_stamp_enforced_from!,
    cos_stamp_enforced_from: c.cos_stamp_enforced_from!,
    lane_stamp_max_age_days: c.lane_stamp_max_age_days!,
    manager_lag_max_hours: c.manager_lag_max_hours!,
    cos_stamp_max_age_days: c.cos_stamp_max_age_days!,
    briefs: c.briefs ?? {},
    skip: c.skip ?? [],
  };
}

// ───────────────────────────── content reads (LOCAL vs GitHub Contents API) ─────────────────────────────

interface BriefRead {
  exists: boolean;
  text: string;
}

function isNotFoundError(err: unknown): boolean {
  const detail = err instanceof Error ? `${(err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ""}\n${err.message}` : String(err);
  return detail.includes("HTTP 404") || detail.includes("Not Found");
}

function apiContentsRaw(repo: string, path: string): string {
  // Throws on ANY failure, 404 included — callers decide how to interpret (mirrors the
  // isNotFoundError-detection convention already established in github-issues.ts's
  // isOrgMember, same `gh` CLI, same stderr shape).
  const raw = gh(["api", `repos/${repo}/contents/${path}`, "--jq", ".content"]);
  return Buffer.from(raw.trim(), "base64").toString("utf-8");
}

/** Builds the two read functions this run uses, closed over the mode (local disk vs Contents API). */
function buildReader(config: ComplianceConfig, brainDir: string | undefined): { readLanes: () => string; readBrief: (path: string) => BriefRead } {
  if (brainDir) {
    return {
      readLanes: () => readFileSync(join(brainDir, config.lanes_file), "utf-8"), // throws naturally (ENOENT etc.) — always hard, LANES.md must exist
      readBrief: (path: string): BriefRead => {
        try {
          return { exists: true, text: readFileSync(join(brainDir, path), "utf-8") };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, text: "" };
          throw err; // permission denied / not-a-file / etc. — a hard failure, not "absent"
        }
      },
    };
  }
  return {
    readLanes: () => apiContentsRaw(config.brain_repo, config.lanes_file), // throws naturally, 404 included — always hard
    readBrief: (path: string): BriefRead => {
      try {
        return { exists: true, text: apiContentsRaw(config.brain_repo, path) };
      } catch (err) {
        if (isNotFoundError(err)) return { exists: false, text: "" };
        throw err;
      }
    },
  };
}

// ───────────────────────────── compliance-issue reads (own gh call — body is needed, listIssuesByLabel doesn't carry it) ─────────────────────────────

interface ComplianceIssueRow {
  number: number;
  title: string;
  body: string;
}

function listOpenComplianceIssues(repo: string): ComplianceIssueRow[] {
  const raw = gh(["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--limit", String(ISSUE_LIST_LIMIT), "--json", "number,title,body"]);
  const rows = JSON.parse(raw) as ComplianceIssueRow[];
  if (rows.length === ISSUE_LIST_LIMIT) {
    throw new Error(`${repo} returned exactly the ${ISSUE_LIST_LIMIT}-issue cap for label "${LABEL}" — this run may be scanning a truncated list (Rule #331); refusing to reconcile against a possibly-incomplete picture.`);
  }
  return rows;
}

// ───────────────────────────── args ─────────────────────────────

function parseArgs(argv: string[]): { dryRun: boolean; now: string; lanesFilter: string[] | undefined; brainDir: string | undefined } {
  const dryRun = argv.includes("--dry-run");
  const nowIdx = argv.indexOf("--now");
  if (nowIdx !== -1 && !argv[nowIdx + 1]) throw new Error("--now requires an ISO timestamp");
  const now = nowIdx !== -1 ? argv[nowIdx + 1] : new Date().toISOString();
  const lanesIdx = argv.indexOf("--lanes");
  if (lanesIdx !== -1 && !argv[lanesIdx + 1]) throw new Error("--lanes requires a comma-separated lane-name list");
  const lanesFilter = lanesIdx !== -1 ? argv[lanesIdx + 1].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const brainDirIdx = argv.indexOf("--brain-dir");
  if (brainDirIdx !== -1 && !argv[brainDirIdx + 1]) throw new Error("--brain-dir requires a path");
  const brainDir = brainDirIdx !== -1 ? argv[brainDirIdx + 1] : undefined;
  return { dryRun, now, lanesFilter, brainDir };
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const { dryRun, now, lanesFilter, brainDir } = parseArgs(process.argv.slice(2));
  console.log(
    `=== backlog-compliance-worker${dryRun ? " --dry-run (real reads, NO issue mutations)" : ""} now=${now}${lanesFilter ? ` --lanes ${lanesFilter.join(",")}` : ""}${brainDir ? ` --brain-dir ${brainDir}` : " (GitHub Contents API mode)"} ===`,
  );

  const config = loadComplianceConfig();
  const reader = buildReader(config, brainDir);

  // LANES.md read failure is fatal before anything else — no rows, no findings, no mutations.
  let lanesText: string;
  try {
    lanesText = reader.readLanes();
  } catch (err) {
    console.error(`backlog-compliance: FATAL — could not read ${config.lanes_file} from ${brainDir ?? config.brain_repo}: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("LANES.md read failed — aborting before any evaluation or issue mutation (Rule #465).");
  }

  const allRows = parseLanesRows(lanesText);
  console.log(`[backlog-compliance] parsed ${allRows.length} row(s) from ${config.lanes_file}.`);

  for (const key of unmatchedBriefKeys(allRows, config)) {
    console.warn(`[backlog-compliance] warn: briefs key "${key}" matches no LANES row`);
  }

  if (lanesFilter) {
    const rowNames = new Set(allRows.map((r) => r.name));
    const unknown = lanesFilter.filter((n) => !rowNames.has(n));
    if (unknown.length > 0) {
      throw new Error(`--lanes names row(s) not present in ${config.lanes_file}: ${unknown.join(", ")}.`);
    }
  }

  const activeNonSkip = allRows.filter((r) => r.active && !config.skip.includes(r.name));
  const scoped = lanesFilter ? activeNonSkip.filter((r) => lanesFilter.includes(r.name)) : activeNonSkip;
  const rollupScopeIncomplete = lanesFilter !== undefined && scoped.length < activeNonSkip.length;

  for (const row of allRows) {
    if (row.active && config.skip.includes(row.name)) console.log(`${row.name} [${row.class}]: SKIPPED (config.skip)`);
    else if (!row.active) console.log(`${row.name} [${row.class}]: not evaluated (inactive)`);
  }

  // Attempt every scoped row's brief read BEFORE deciding anything — collect hard failures
  // across the whole set rather than aborting on the first (Rule #401: a complete picture of
  // what's broken beats a whack-a-mole one-error-at-a-time run).
  const results: LaneComplianceResult[] = [];
  const hardFailures: string[] = [];
  for (const row of scoped) {
    const briefPath = resolveBriefPath(row, config);
    let brief: BriefRead;
    try {
      brief = reader.readBrief(briefPath);
    } catch (err) {
      const msg = `${row.name}: brief read FAILED (not a confirmed absence) at ${briefPath}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`backlog-compliance: ${msg}`);
      hardFailures.push(msg);
      continue;
    }
    const findings = evaluate(row, brief, config, now);
    const result: LaneComplianceResult = { row, briefPath, findings };
    results.push(result);
    const failedCount = findings.filter((f) => f.status === "failed").length;
    const verdict = isCompliant(result)
      ? "COMPLIANT"
      : `${failedCount} finding(s): ${findings.filter((f) => f.status === "failed").map((f) => f.check).join(",")}`;
    const pendingNote = findings.some((f) => f.status === "pending") ? ` (+${findings.filter((f) => f.status === "pending").length} pending)` : "";
    console.log(`${row.name} [${row.class}] brief=${briefPath} -> ${verdict}${pendingNote}`);
  }

  const hasHardFailures = hardFailures.length > 0;
  if (hasHardFailures) {
    console.error(
      `backlog-compliance: ${hardFailures.length} brief read failure(s) this run — see errors above. ZERO issue mutations will be attempted (Rule #465): a run with an unknown-status lane is not a trustworthy basis for reconciling ANY issue, rollup or per-lane.`,
    );
  }

  // Real read regardless of --dry-run (Rule #376) — a preview should reflect real open-issue
  // state, not a guess. Skipped entirely when a hard failure already voids this run's mutation
  // authority, since nothing below would be allowed to act on it anyway.
  const openIssues = hasHardFailures ? [] : listOpenComplianceIssues(config.brain_repo);
  const rollupIssue = openIssues.find((i) => i.body.startsWith(ROLLUP_MARKER));

  const perLaneMode = now >= config.per_lane_issues_from;
  let opened = 0;
  let updated = 0;
  let closed = 0;

  const canMutate = !dryRun && !hasHardFailures;

  if (!perLaneMode) {
    // ── ROLLUP MODE ──
    if (rollupScopeIncomplete) {
      console.warn(
        `backlog-compliance: --lanes scoped this run to ${scoped.length}/${activeNonSkip.length} active row(s) — SKIPPING the rollup mutation (a partial checklist must never overwrite the complete one). Re-run without --lanes to update the rollup.`,
      );
    } else if (dryRun) {
      console.log(`\n--- [dry-run] rollup: ${results.length} row(s) evaluated — would ${rollupIssue ? "UPDATE" : "OPEN"} ---`);
      if (!hasHardFailures) console.log(renderRollupBody(results, now));
    } else if (hasHardFailures) {
      console.log(`--- rollup: SKIPPED this run (hard read failure(s) above) ---`);
    } else {
      const body = renderRollupBody(results, now);
      if (!rollupIssue) {
        ensureLabel(config.brain_repo, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
        openIssue(config.brain_repo, LABEL, ROLLUP_TITLE, body);
        opened += 1;
        console.log(`OPENED the backlog-compliance rollup issue (${results.length} row(s)).`);
      } else {
        editIssueBody(config.brain_repo, rollupIssue.number, body); // body only — no per-run comment (see header: this is a refreshed census, not a discrete alert event)
        updated += 1;
        console.log(`UPDATED (body) backlog-compliance rollup issue #${rollupIssue.number} (${results.length} row(s)).`);
      }
    }
  } else {
    // ── PER-LANE MODE ── — cutover-close the rollup first (unconditional on date, not on scope/findings).
    if (rollupIssue) {
      if (dryRun) {
        console.log(`--- [dry-run] rollup: would CLOSE #${rollupIssue.number} (per_lane_issues_from cutover reached) ---`);
      } else if (hasHardFailures) {
        console.log(`--- rollup: close SKIPPED this run (hard read failure(s) above) ---`);
      } else {
        closeIssue(
          config.brain_repo,
          rollupIssue.number,
          `per_lane_issues_from (${config.per_lane_issues_from}) reached — findings now open as one issue per non-compliant lane. Auto-closed by the backlog-compliance worker.`,
        );
        closed += 1;
        console.log(`CLOSED backlog-compliance rollup issue #${rollupIssue.number} (per-lane cutover).`);
      }
    }

    for (const result of results) {
      const failedCount = result.findings.filter((f) => f.status === "failed").length;
      const existing = openIssues.find((i) => i.body.startsWith(laneMarker(result.row.name)));
      const action: "open" | "update" | "close" | "none" = failedCount > 0 ? (existing ? "update" : "open") : existing ? "close" : "none";
      const title = `[backlog-compliance] ${result.row.name} — ${failedCount} finding(s)`;

      if (dryRun) {
        if (action !== "none") console.log(`--- [dry-run] ${result.row.name}: would ${action.toUpperCase()} ${existing ? `#${existing.number}` : ""} ---`);
        continue;
      }
      if (hasHardFailures) continue; // logged once, above, at the run level

      if (action === "open") {
        ensureLabel(config.brain_repo, LABEL, LABEL_DESCRIPTION, LABEL_COLOR);
        openIssue(config.brain_repo, LABEL, title, renderLaneBody(result, now));
        opened += 1;
        console.log(`OPENED backlog-compliance issue for ${result.row.name} (${failedCount} finding(s)).`);
      } else if (action === "update") {
        retitleIssue(config.brain_repo, existing!.number, title);
        editIssueBody(config.brain_repo, existing!.number, renderLaneBody(result, now));
        updated += 1;
        console.log(`UPDATED (retitle+body) backlog-compliance issue #${existing!.number} for ${result.row.name} (${failedCount} finding(s)).`);
      } else if (action === "close") {
        closeIssue(config.brain_repo, existing!.number, `0 failed findings for ${result.row.name} this run — compliant. Auto-closed by the backlog-compliance worker.`);
        closed += 1;
        console.log(`CLOSED backlog-compliance issue #${existing!.number} for ${result.row.name} (compliant).`);
      }
    }
  }

  console.log(`[backlog-compliance] mode=${perLaneMode ? "per-lane" : "rollup"} opened=${opened} updated=${updated} closed=${closed} dry_run=${dryRun} can_mutate=${canMutate}`);
  console.log(summaryLine(allRows, results));

  if (hasHardFailures) {
    throw new Error(
      `${hardFailures.length} brief read failure(s) this run (see errors above) — ZERO issue mutations were attempted. The next scheduled run retries.`,
    );
  }
}

main().catch((err) => {
  console.error(`backlog-compliance-worker FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
