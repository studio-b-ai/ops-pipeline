/**
 * Sanctioned skip-by-design check names — Rule #459 amendment (Friday sitting
 * 2026-08-28 §3 item 3: "durable allowlist = Mechanic's build").
 *
 * `isRollupClean` (automerge-classify.ts) treats a SKIPPED conclusion as clean
 * ONLY when the check's name is in the sanctioned set this module resolves for
 * the repo under evaluation. The committed data lives in
 * scripts/automerge-skip-allowlist.yaml — one file, read by every runner from
 * the ops-pipeline checkout the reusable workflows already make, so callers
 * inherit edits on their next sweep with no vendored-copy drift.
 *
 * FAIL-CLOSED SHAPES, deliberately:
 *   - A repo with no row resolves to the EMPTY set (nothing sanctioned).
 *   - A missing or malformed data file THROWS — that is a broken deployment,
 *     not a policy state; the runner's failed job is the loud receipt
 *     (Rule #464: an inert guard must not look healthy). It must never
 *     degrade to "empty file ⇒ every skip blocks silently with a receipt
 *     that misattributes the wait to CI".
 *   - parse is strict: unknown top-level keys, non-list repo values, and
 *     non-string entries all throw rather than being skipped over.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
/** scripts/lib/ → scripts/automerge-skip-allowlist.yaml */
const DATA_FILE = join(HERE, "..", "automerge-skip-allowlist.yaml");

export type SkipAllowlist = ReadonlyMap<string, ReadonlySet<string>>;

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Strict parse of the YAML text into repo → sanctioned check names. Pure —
 * the fs read stays in `loadSanctionedSkips` so tests exercise every malformed
 * shape without touching disk.
 */
export function parseSkipAllowlist(yamlText: string): SkipAllowlist {
  const doc: unknown = parseYaml(yamlText);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("automerge-skip-allowlist: top level must be a mapping with a `repos` key");
  }
  const keys = Object.keys(doc as Record<string, unknown>);
  const unknown = keys.filter((k) => k !== "repos");
  if (unknown.length > 0) {
    throw new Error(`automerge-skip-allowlist: unknown top-level key(s): ${unknown.join(", ")}`);
  }
  const repos = (doc as Record<string, unknown>).repos;
  if (repos === null || repos === undefined) return new Map();
  if (typeof repos !== "object" || Array.isArray(repos)) {
    throw new Error("automerge-skip-allowlist: `repos` must be a mapping of org/repo → list of check names");
  }
  const out = new Map<string, ReadonlySet<string>>();
  for (const [repo, value] of Object.entries(repos as Record<string, unknown>)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      throw new Error(`automerge-skip-allowlist: repo key '${repo}' is not org/repo`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`automerge-skip-allowlist: repos['${repo}'] must be a list of check names`);
    }
    const names = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error(`automerge-skip-allowlist: repos['${repo}'] has a non-string or empty entry`);
      }
      names.add(entry);
    }
    out.set(repo, names);
  }
  return out;
}

/** Missing repo ⇒ empty set (nothing sanctioned) — the fail-closed default. */
export function resolveSanctionedSkips(allowlist: SkipAllowlist, repo: string): ReadonlySet<string> {
  return allowlist.get(repo) ?? EMPTY_SET;
}

let cached: SkipAllowlist | undefined;

/**
 * Runner entrypoint: read + parse the committed data file once per process,
 * resolve the repo's sanctioned set. Throws on a missing/malformed file — see
 * the module header for why that must stay loud.
 */
export function loadSanctionedSkips(repo: string): ReadonlySet<string> {
  if (cached === undefined) {
    cached = parseSkipAllowlist(readFileSync(DATA_FILE, "utf8"));
  }
  return resolveSanctionedSkips(cached, repo);
}
