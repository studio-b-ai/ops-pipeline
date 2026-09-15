#!/usr/bin/env tsx
/**
 * door-watch-coherence-check.ts — the CALLER that makes `lib/door-watch-coherence.ts`
 * fire (studio-b#112 leg 1, Mechanic crew stint 2026-09-13, second pass).
 *
 * WHY THIS FILE EXISTS — it closes a Rule #464 defect in this stint's OWN prior pass.
 * The earlier pass shipped the invariant as a pure lib plus the four reconciling watch
 * rows, and verified the function in both directions with a throwaway probe. But
 * `git grep -n door-watch-coherence origin/main -- scripts .github` returned ZERO
 * non-test hits: nothing in the repo ever invoked it. A guard with no caller is
 * "fail-closed + CI-green + zero observed firings = presumed INERT, not working"
 * (Rule #464) — it would have sat there passing forever while the next registry
 * widening drifted straight past it. The rows fixed the population; this file is what
 * keeps it fixed.
 *
 * ── WHY A `pull_request` CHECK AND NOT A WEEKLY WORKER ────────────────────────────
 * Every sibling detector in this repo (repo-hygiene-worker, dead-cron-worker,
 * required-checks-drift-worker) is a scheduled worker that opens an aggregate issue,
 * because each one probes LIVE GITHUB STATE it cannot see from a checkout — branch
 * protection, cron schedules, commit authorship — and therefore needs a minted fleet-App
 * token and degrades honestly when a permission is missing (all three carry
 * `systemicFailure` plumbing for exactly that reason).
 *
 * This invariant is categorically different: BOTH of its inputs are committed files in
 * THIS repo — `scripts/squasher-fleet.json` (the door registry) and
 * `scripts/backlog-managers.yaml` (the watch registry). There is no API call, no token,
 * no permission gap, and nothing to degrade. The drift is introduced by a PR editing one
 * registry without the other, and it is fully decidable from the diff's own checkout. So
 * the correct instrument is the one that runs ON that PR and BLOCKS it — Rule #29:
 * automate deterministic-pass CI gates. A weekly issue-opener would instead let the
 * incoherent merge land and then mention it up to seven days later, which is precisely
 * the window the four already-drifted repos sat unwatched in.
 *
 * ── WHY A STEP IN THE EXISTING JOB, NOT A NEW WORKFLOW ───────────────────────────
 * `"Scripts — typecheck + tests"` in `.github/workflows/ci.yml` is ALREADY a required
 * status check on `main` with `enforce_admins: true` (that file's own header, live-read
 * this session). Adding a step to it inherits required-ness and admin-enforcement with
 * zero branch-protection edits. A NEW workflow would need a new required context added
 * to branch protection to actually block anything — and a required context that has
 * never reported blocks every PR in the repo forever (Rules #198/#280, the ordering trap
 * ci.yml's header documents). Same reason this file adds no `paths:` filter anywhere:
 * ci.yml deliberately has none, because a filtered required check is silently absent on
 * the PRs it skips.
 *
 * ── LAW: READ-ONLY, AND IT DECIDES NOTHING ITSELF ────────────────────────────────
 * This is thin I/O glue, exactly like its sibling workers are to their libs: it reads two
 * files, hands already-parsed contents to `findDoorWatchIncoherence`, prints, and sets an
 * exit code. It NEVER edits either registry, opens a door, enrols a repo, or touches a PR
 * or issue. Auto-repair would be the wrong shape twice over: picking a `manager:` for a
 * newly-doored repo is a named-owner claim a human must make (Rule #294 — the lib
 * deliberately reports `suggestedManager: null` rather than inventing one), and a gate
 * that silently repairs its own inputs cannot detect that they were broken (ci.yml's own
 * `npm ci` note).
 *
 * EXIT CODES: 0 = coherent. 1 = drift found (prints every finding's full remediation
 * text). 2 = the check could not run at all (missing/malformed registry) — fail CLOSED
 * and loud, never a silent pass, since an unreadable registry is indistinguishable from
 * an empty one to a naive reader and "malformed = fatal" is the same call the lib's own
 * header makes (Rule #465: a predicate that cannot see its population must not report a
 * clean zero).
 *
 * `--json` prints the findings array for machine consumption; the human-readable block
 * always goes to stdout so a CI log reader sees the remediation without extra tooling.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  findDoorWatchIncoherence,
  summarizeDoorWatchCoherence,
  type DoorRegistryRow,
  type DoorWatchCoherenceFinding,
} from "./lib/door-watch-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOOR_REGISTRY = join(HERE, "squasher-fleet.json");
const WATCH_REGISTRY = join(HERE, "backlog-managers.yaml");

/**
 * Lane-manager map used ONLY to enrich a finding's text with a suggested owner. Grounded
 * in `kits/studio-b.yaml`'s `radio: {technical: mechanic}` routing — every studio-b
 * fleet-internal repo routes its technical lane to the Mechanic seat. A repo absent here
 * yields `suggestedManager: null` and a finding that says the owner must be set by a
 * human, which is the deliberate Rule #294 behaviour: name the gap, never fill it with a
 * guess. This is presentation only — it can never suppress or create a finding.
 */
const LANE_MANAGERS: Readonly<Record<string, string>> = {
  "studio-b-ai/claude-config-plane": "Mechanic",
  "studio-b-ai/ops-pipeline": "Mechanic",
  "studio-b-ai/radio": "Mechanic",
  "studio-b-ai/lightsout": "Mechanic",
  "studio-b-ai/power-unit": "Dispatcher",
  "studio-b-ai/toto": "Mechanic",
  "studio-b-ai/client-asthetik": "Mechanic",
};

class CheckUnrunnable extends Error {}

function readDoorRows(): DoorRegistryRow[] {
  let raw: string;
  try {
    raw = readFileSync(DOOR_REGISTRY, "utf-8");
  } catch (err) {
    throw new CheckUnrunnable(`cannot read the door registry ${DOOR_REGISTRY}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CheckUnrunnable(`${DOOR_REGISTRY} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const repos = (parsed as { repos?: unknown })?.repos;
  if (!Array.isArray(repos)) {
    throw new CheckUnrunnable(`${DOOR_REGISTRY} is malformed: "repos" is not an array`);
  }
  return repos.map((row, i) => {
    const r = row as { repo?: unknown; train?: unknown };
    if (typeof r.repo !== "string" || r.repo.length === 0) {
      throw new CheckUnrunnable(`${DOOR_REGISTRY} is malformed: repos[${i}] has no string "repo"`);
    }
    // `train` is optional in the registry and absent means false (the lib's documented
    // fallback). Any NON-boolean present value is fatal rather than coerced: a string
    // "false" would be truthy to a naive check, and this gate's entire job is to not be
    // naive about that field (Rule #197's string-vs-typed family).
    if (r.train !== undefined && typeof r.train !== "boolean") {
      throw new CheckUnrunnable(`${DOOR_REGISTRY} is malformed: repos[${i}] ("${r.repo}") has a non-boolean "train" (${JSON.stringify(r.train)})`);
    }
    return { repo: r.repo, train: r.train };
  });
}

function readWatchedRepos(): string[] {
  let raw: string;
  try {
    raw = readFileSync(WATCH_REGISTRY, "utf-8");
  } catch (err) {
    throw new CheckUnrunnable(`cannot read the watch registry ${WATCH_REGISTRY}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    // Parsed as real YAML (the `yaml` dep this package already carries), never regex-
    // scraped: a regex over the file would also match the four-paragraph comment block
    // above the rows, which names all six door repos in prose — it would silently report
    // the fleet as fully watched no matter what the actual rows said.
    parsed = parseYaml(raw);
  } catch (err) {
    throw new CheckUnrunnable(`${WATCH_REGISTRY} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const repos = (parsed as { repos?: unknown })?.repos;
  if (!Array.isArray(repos)) {
    throw new CheckUnrunnable(`${WATCH_REGISTRY} is malformed: "repos" is not an array`);
  }
  return repos.map((row, i) => {
    const r = row as { repo?: unknown };
    if (typeof r.repo !== "string" || r.repo.length === 0) {
      throw new CheckUnrunnable(`${WATCH_REGISTRY} is malformed: repos[${i}] has no string "repo"`);
    }
    return r.repo;
  });
}

function render(findings: DoorWatchCoherenceFinding[], doorCount: number, watchCount: number): string {
  const lines: string[] = [];
  lines.push("=== door/watch coherence check (studio-b#112 leg 1) ===");
  // The POPULATION is printed before the verdict so a clean zero can be read against what
  // the check could actually see (Rule #465 — a predicate is part of the receipt; an
  // all-clear over an empty population is a blind instrument, not a healthy one).
  lines.push(`Door registry: ${DOOR_REGISTRY}`);
  lines.push(`Watch registry: ${WATCH_REGISTRY}`);
  lines.push(`Population: ${doorCount} repo(s) with an OPEN release leg (train: true) vs ${watchCount} repo(s) carrying a backlog-watch row.`);
  lines.push(summarizeDoorWatchCoherence(findings));
  if (findings.length > 0) {
    lines.push("");
    lines.push("FAIL — a repo may not have an autonomous merge door with no backlog watch:");
    for (const f of findings) {
      lines.push("");
      lines.push(`  • ${f.repo} (suggested manager: ${f.suggestedManager ?? "UNKNOWN — a human must set it"})`);
      lines.push(`    ${f.detail}`);
    }
  }
  return lines.join("\n");
}

function main(): void {
  const asJson = process.argv.includes("--json");

  let doorRows: DoorRegistryRow[];
  let watchedRepos: string[];
  try {
    doorRows = readDoorRows();
    watchedRepos = readWatchedRepos();
  } catch (err) {
    if (err instanceof CheckUnrunnable) {
      console.error(`door-watch-coherence-check COULD NOT RUN (failing closed, Rule #465): ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const findings = findDoorWatchIncoherence({ doorRows, watchedRepos, laneManagers: LANE_MANAGERS });
  const openDoorCount = doorRows.filter((r) => r.train === true).length;

  console.log(render(findings, openDoorCount, watchedRepos.length));
  if (asJson) console.log(JSON.stringify(findings, null, 2));

  process.exit(findings.length === 0 ? 0 : 1);
}

main();
