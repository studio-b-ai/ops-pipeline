#!/usr/bin/env tsx
/**
 * squasher-fleet-canonical-check.ts — the CALLER that makes
 * `lib/squasher-fleet-canonical.ts` fire (Mechanic crew stint #380, 2026-09-15).
 * Read that lib's header FIRST — every DECISION lives there; this file is thin I/O
 * glue in the door-watch-coherence-check.ts shape: read the registry, probe each
 * entry's canonical identity, print, set an exit code.
 *
 * PROBE: `gh api repos/<entry> --jq .full_name` per registry entry, sequentially
 * (17 entries ≈ seconds; the sweep itself is far heavier). `gh` follows the rename
 * redirect and returns the CANONICAL full_name — that redirect-following is the
 * whole point: reachability is not identity. Auth comes from the environment's
 * GH_TOKEN (the repo-hygiene.yml leg rides the minted studiob-fleet-bot
 * installation token, whose org-wide `metadata:read` covers
 * `GET /repos/{owner}/{repo}` on every entry); locally, any `gh auth login` works.
 *
 * `--registry <path>`: probe a registry file OTHER than the committed one. Exists
 * for the planted negative control (Rule #322): run this against the PRE-FIX
 * registry and it MUST exit 1 naming studio-b-ai/roundhouse → lightsout; against
 * the fixed registry it MUST exit 0. Both receipts are on stint #380's PR.
 *
 * EXIT CODES (house convention, same as door-watch-coherence-check.ts):
 *   0 = every entry is its repo's canonical name.
 *   1 = drift (renamed/moved or unresolvable entries; full remediation printed).
 *   2 = could not run at all (registry unreadable/malformed, gh missing, or EVERY
 *       probe errored) — fail CLOSED and loud, never a silent pass (Rule #465).
 *
 * READ-ONLY LAW: this file never edits the registry, never renames a repo, never
 * touches a PR or issue. The fix is a human edit to scripts/squasher-fleet.json.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideCanonicalDrift,
  summarizeCanonicalScan,
  type CanonicalProbe,
} from "./lib/squasher-fleet-canonical.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = join(HERE, "squasher-fleet.json");

class CheckUnrunnable extends Error {}

function registryPathFromArgs(): string {
  const i = process.argv.indexOf("--registry");
  if (i === -1) return DEFAULT_REGISTRY;
  const p = process.argv[i + 1];
  if (!p) throw new CheckUnrunnable("--registry requires a path argument");
  return p;
}

function readRegistryEntries(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new CheckUnrunnable(`cannot read the door registry ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CheckUnrunnable(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const repos = (parsed as { repos?: unknown })?.repos;
  if (!Array.isArray(repos)) {
    throw new CheckUnrunnable(`${path} is malformed: "repos" is not an array`);
  }
  return repos.map((row, i) => {
    const r = row as { repo?: unknown };
    if (typeof r.repo !== "string" || r.repo.length === 0) {
      throw new CheckUnrunnable(`${path} is malformed: repos[${i}] has no string "repo"`);
    }
    return r.repo;
  });
}

function probeCanonical(entry: string): CanonicalProbe {
  try {
    // execFileSync with an argv array — no shell, so the entry string can never
    // be word-split or interpreted. gh exits non-zero on 404/410/auth failure;
    // its stderr is the probe's error text.
    const out = execFileSync("gh", ["api", `repos/${entry}`, "--jq", ".full_name"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!out) {
      return { entry, canonicalFullName: null, probeError: "gh api returned an empty full_name" };
    }
    return { entry, canonicalFullName: out, probeError: null };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string })?.stderr;
    const msg = (stderr ? String(stderr) : err instanceof Error ? err.message : String(err)).trim().split("\n")[0];
    return { entry, canonicalFullName: null, probeError: msg };
  }
}

function main(): void {
  let registryPath: string;
  let entries: string[];
  try {
    registryPath = registryPathFromArgs();
    entries = readRegistryEntries(registryPath);
  } catch (err) {
    if (err instanceof CheckUnrunnable) {
      console.error(`squasher-fleet-canonical-check COULD NOT RUN (failing closed, Rule #465): ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const probes = entries.map(probeCanonical);
  const result = decideCanonicalDrift(probes);

  // Population before verdict (Rule #465 — a clean zero is only readable against
  // what the probe could actually see).
  console.log("=== squasher-fleet canonical-name check (stint #380) ===");
  console.log(`Registry: ${registryPath}`);
  console.log(`Population: ${result.probedCount} registry entries probed via gh api repos/<entry> --jq .full_name`);
  console.log(summarizeCanonicalScan(result));

  if (result.systemicFailure) {
    for (const f of result.findings) console.error(`  probe error: ${f.entry}: ${f.detail}`);
    process.exit(2);
  }
  if (result.findings.length > 0) {
    console.log("");
    console.log("FAIL — every registry entry must be the repo's GitHub-canonical name:");
    for (const f of result.findings) {
      console.log("");
      console.log(`  • [${f.class}] ${f.entry}`);
      console.log(`    ${f.detail}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
