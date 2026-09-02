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
 *
 * TWO PATHS (2026-09-02, ops#235 amendment): `loadSanctionedSkips` reads
 * `repos:` only (the squasher's unattended code-merge gate — unchanged).
 * `loadTrainSanctionedSkips` reads `repos:` UNION `train_repos:` for
 * restart-train's label-gated, human-authorized departures. See
 * `TrainSkipAllowlist` below for why the two must never share a caller.
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
const KNOWN_TOP_LEVEL_KEYS = new Set(["repos", "train_repos"]);

/** Shared strict validator for one top-level section (`repos` or `train_repos`) —
 *  same shape rules for both: missing ⇒ empty map; anything else must be a
 *  mapping of org/repo → a list whose entries are all non-empty strings (the
 *  list itself may be empty — that mirrors the pre-`train_repos` behavior). */
function parseRepoSection(section: unknown, sectionKey: string): SkipAllowlist {
  if (section === null || section === undefined) return new Map();
  if (typeof section !== "object" || Array.isArray(section)) {
    throw new Error(`automerge-skip-allowlist: \`${sectionKey}\` must be a mapping of org/repo → list of check names`);
  }
  const out = new Map<string, ReadonlySet<string>>();
  for (const [repo, value] of Object.entries(section as Record<string, unknown>)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      throw new Error(`automerge-skip-allowlist: repo key '${repo}' is not org/repo`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`automerge-skip-allowlist: ${sectionKey}['${repo}'] must be a list of check names`);
    }
    const names = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new Error(`automerge-skip-allowlist: ${sectionKey}['${repo}'] has a non-string or empty entry`);
      }
      names.add(entry);
    }
    out.set(repo, names);
  }
  return out;
}

/** Parses the top-level document, validating only the known-key set — shared by
 *  both `parseSkipAllowlist` (repos: only) and `parseFullSkipAllowlist` (both). */
function parseTopLevel(yamlText: string): Record<string, unknown> {
  const doc: unknown = parseYaml(yamlText);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("automerge-skip-allowlist: top level must be a mapping with a `repos` key");
  }
  const record = doc as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`automerge-skip-allowlist: unknown top-level key(s): ${unknown.join(", ")}`);
  }
  return record;
}

/**
 * Strict parse of the YAML text into repo → sanctioned check names — the
 * `repos:` section ONLY (the squasher path; byte-identical to pre-`train_repos`
 * behavior). Pure — the fs read stays in `loadSanctionedSkips` so tests
 * exercise every malformed shape without touching disk.
 */
export function parseSkipAllowlist(yamlText: string): SkipAllowlist {
  return parseRepoSection(parseTopLevel(yamlText).repos, "repos");
}

/**
 * Train-scoped resolution — Rule #459/ops#235 amendment, born of the
 * 2026-09-02 22:18Z restart-train first-firing incident: `train_repos:` is a
 * SECOND, additive sanction set consumed ONLY by the restart train (never the
 * squasher, never `loadSanctionedSkips`). Its merge authority is Kevin's
 * label + the window law (ops#265), not CI alone — so by-design PR-event
 * skips the squasher must never sanction can still count as clean for a
 * label-gated, human-authorized departure.
 */
export interface TrainSkipAllowlist {
  readonly repos: SkipAllowlist;
  readonly trainRepos: SkipAllowlist;
}

/** Strict parse of BOTH top-level sections — used by the train path only. */
export function parseFullSkipAllowlist(yamlText: string): TrainSkipAllowlist {
  const record = parseTopLevel(yamlText);
  return {
    repos: parseRepoSection(record.repos, "repos"),
    trainRepos: parseRepoSection(record.train_repos, "train_repos"),
  };
}

/** Missing repo ⇒ empty set (nothing sanctioned) — the fail-closed default. */
export function resolveSanctionedSkips(allowlist: SkipAllowlist, repo: string): ReadonlySet<string> {
  return allowlist.get(repo) ?? EMPTY_SET;
}

/** UNION of the repo's `repos:` set and its `train_repos:` set — TRAIN PATH ONLY. */
export function resolveTrainSanctionedSkips(allowlist: TrainSkipAllowlist, repo: string): ReadonlySet<string> {
  const base = resolveSanctionedSkips(allowlist.repos, repo);
  const train = resolveSanctionedSkips(allowlist.trainRepos, repo);
  if (train.size === 0) return base;
  return new Set([...base, ...train]);
}

let cached: SkipAllowlist | undefined;

/**
 * Runner entrypoint: read + parse the committed data file once per process,
 * resolve the repo's sanctioned set. Throws on a missing/malformed file — see
 * the module header for why that must stay loud. SQUASHER PATH — never
 * includes `train_repos:`.
 */
export function loadSanctionedSkips(repo: string): ReadonlySet<string> {
  if (cached === undefined) {
    cached = parseSkipAllowlist(readFileSync(DATA_FILE, "utf8"));
  }
  return resolveSanctionedSkips(cached, repo);
}

let trainCached: TrainSkipAllowlist | undefined;

/** Restart-train entrypoint ONLY — see `TrainSkipAllowlist` header. */
export function loadTrainSanctionedSkips(repo: string): ReadonlySet<string> {
  if (trainCached === undefined) {
    trainCached = parseFullSkipAllowlist(readFileSync(DATA_FILE, "utf8"));
  }
  return resolveTrainSanctionedSkips(trainCached, repo);
}
