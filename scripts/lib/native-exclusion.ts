/**
 * native-exclusion.ts — the old door stays OUT of a repo that has gone native (go-native Phase A, PR-A2 item 2; Kevin 2026-10-21).
 *
 * Until a repo migrates, this repo's merge robot (the "door") still merges it. Once a repo carries an ACTIVE ruleset named exactly
 * `main - native merge v1` that targets its default branch, GitHub itself enforces the merge (PR required, code-owner review,
 * required checks, native auto-merge) and the door must neither merge, label, nor update-branch there. Detection is the live
 * ruleset — never a registry edit — so a migrated repo is excluded from the first sweep after the POST, and a break-glass
 * (`enforcement: disabled`) hands the repo straight back to the door.
 *
 *   GET repos/{o}/{r}/rulesets?per_page=100        → name + enforcement + target (the list endpoint carries NO conditions — probed live)
 *   GET repos/{o}/{r}/rulesets/{id}                → conditions.ref_name, only for a list row that already matches the name
 *
 * FAIL CLOSED: any read error, odd response shape, or invalid repo name counts as EXCLUDED and is logged (the door skips the repo).
 * A repo is only handled by the door when the ruleset list was read successfully AND carries no native ruleset. The cost of a
 * transient failure is one skipped sweep of that repo; the cost of the opposite error is the door merging into a native repo.
 *
 * Results are cached per run (one GET per repo per run): in-process via the `cache` Map, and across the sweep's several CLI
 * calls via `--cache <file>`.
 *
 * Legs wired to this module: squasher-fleet-sweep.yml (registry leg + org-wide box leg), automerge-sweep.yml, restart-train.ts
 * (heritage-restart-train.yml), and pr-automerge-gate.ts main() as the structural backstop (no label write / update-branch /
 * merge can happen on a native repo however the gate was reached).
 *
 * CLI:  tsx lib/native-exclusion.ts scan [--cache <file>] <owner/repo>...
 *   stdout: JSON array of the EXCLUDED repos        stderr: one line per freshly-evaluated excluded repo
 *   `excluded: native <repo>`                                   (a native ruleset was found)
 *   `excluded: native-check-failed <repo> (fail-closed: <why>)`  (the ruleset read failed or looked wrong)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const NATIVE_RULESET_NAME = "main - native merge v1";

export type NativeVerdict = "native" | "not-native" | "error";
/** GET an API path (e.g. `repos/o/r/rulesets?per_page=100`) → parsed JSON. Throws on ANY failure (non-2xx, network, bad JSON). */
export type RulesetReader = (apiPath: string) => unknown;
export type NativeCache = Map<string, NativeVerdict>;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** The list endpoint pages at 100 max; a Team repo holds at most 75 rulesets, so a full page can only mean "cannot prove complete" → error. */
const LIST_PAGE = 100;

export function defaultGhReader(apiPath: string): unknown {
  const out = execFileSync("gh", ["api", apiPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(out);
}

type RefNameCondition = { include?: unknown; exclude?: unknown };
/** Every repo this fleet governs defaults to `main` (PRs open --base main); the plan's ruleset uses `~DEFAULT_BRANCH`. */
const DEFAULT_BRANCH_REFS = ["~DEFAULT_BRANCH", "~ALL", "refs/heads/main"];

/** Pure: does this ruleset DETAIL (GET .../rulesets/{id}) apply to the default branch? */
export function targetsDefaultBranch(detail: unknown): boolean {
  const ref = (detail as { conditions?: { ref_name?: RefNameCondition } } | null)?.conditions?.ref_name;
  if (!ref || !Array.isArray(ref.include)) return false;
  const exclude = Array.isArray(ref.exclude) ? ref.exclude : [];
  return ref.include.some((r) => DEFAULT_BRANCH_REFS.includes(r as string)) && !exclude.some((r) => DEFAULT_BRANCH_REFS.includes(r as string));
}

export function detectNative(repo: string, read: RulesetReader, cache: NativeCache = new Map()): NativeVerdict {
  const hit = cache.get(repo);
  if (hit) return hit;
  let verdict: NativeVerdict;
  try {
    if (!REPO_RE.test(repo)) throw new Error("invalid repo name");
    const list = read(`repos/${repo}/rulesets?per_page=${LIST_PAGE}`);
    if (!Array.isArray(list)) throw new Error("rulesets list is not an array");
    if (list.length >= LIST_PAGE) throw new Error("rulesets list page is full");
    const matches = list.filter(
      (r) => r?.name === NATIVE_RULESET_NAME && r?.enforcement === "active" && r?.target === "branch" && Number.isInteger(r?.id),
    );
    verdict = "not-native";
    for (const m of matches) {
      const detail = read(`repos/${repo}/rulesets/${m.id}`) as { enforcement?: unknown };
      if (detail?.enforcement === "active" && targetsDefaultBranch(detail)) {
        verdict = "native";
        break;
      }
    }
  } catch {
    verdict = "error";
  }
  cache.set(repo, verdict);
  return verdict;
}

/** The ONLY log lines this module emits — fixed shapes (repo names are charset-validated; an invalid name is never echoed). */
export function exclusionLogLine(repo: string, verdict: NativeVerdict): string | null {
  if (verdict === "not-native") return null;
  if (verdict === "native") return `excluded: native ${repo}`;
  return `excluded: native-check-failed ${REPO_RE.test(repo) ? repo : "<invalid-repo-name>"} (fail-closed: ruleset read failed)`;
}

export interface NativeScan {
  /** repos the door must skip (native, or the check failed) — in input order, de-duplicated */
  excluded: string[];
  /** one line per repo evaluated FRESH this call (cache hits are silent, so a repo is logged once per run) */
  log: string[];
}

export function scanNative(repos: readonly string[], read: RulesetReader, cache: NativeCache = new Map()): NativeScan {
  const excluded: string[] = [];
  const log: string[] = [];
  for (const repo of new Set(repos)) {
    const fresh = !cache.has(repo);
    const verdict = detectNative(repo, read, cache);
    if (verdict === "not-native") continue;
    excluded.push(repo);
    const line = fresh ? exclusionLogLine(repo, verdict) : null;
    if (line) log.push(line);
  }
  return { excluded, log };
}

/** The repos the door may act on: the input minus every excluded repo (native, or the check failed), plus the fixed log lines. */
export function reposForDoor<T extends string>(
  repos: readonly T[],
  read: RulesetReader = defaultGhReader,
  cache: NativeCache = new Map(),
): { active: T[]; log: string[] } {
  const { excluded, log } = scanNative(repos, read, cache);
  return { active: repos.filter((r) => !excluded.includes(r)), log };
}

// ───────────────────────────── CLI (the sweep's `scan` step) ─────────────────────────────

function loadCacheFile(path: string): NativeCache {
  const cache: NativeCache = new Map();
  try {
    if (!existsSync(path)) return cache;
    for (const [repo, v] of Object.entries(JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>)) {
      if (v === "native" || v === "not-native" || v === "error") cache.set(repo, v);
    }
  } catch {
    /* a corrupt cache file is an empty cache — every repo is simply re-read */
  }
  return cache;
}

export function runCli(argv: string[], read: RulesetReader = defaultGhReader): { stdout: string; stderr: string[]; code: number } {
  const [cmd, ...rest] = argv;
  if (cmd !== "scan") return { stdout: "", stderr: ["usage: native-exclusion.ts scan [--cache <file>] <owner/repo>..."], code: 2 };
  let cachePath: string | undefined;
  const repos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--cache") cachePath = rest[++i];
    else repos.push(rest[i]);
  }
  const cache = cachePath ? loadCacheFile(cachePath) : new Map<string, NativeVerdict>();
  const { excluded, log } = scanNative(repos, read, cache);
  if (cachePath) writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)) + "\n");
  return { stdout: JSON.stringify(excluded), stderr: log, code: 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runCli(process.argv.slice(2));
  for (const l of r.stderr) process.stderr.write(l + "\n");
  process.stdout.write(r.stdout);
  process.exitCode = r.code;
}
