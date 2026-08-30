/**
 * tripwire-args.ts — CLI argument parsing for the post-merge 5xx tripwire runner
 * (post-merge-tripwire.ts; ops-pipeline#190 B2, design §4.2).
 *
 * Extracted to a lib for the same reason automerge-args.ts is one: the runner executes
 * `main().catch(...)` at module scope, so importing it from tests would fire the runner —
 * the parser lives here where it can be imported and tested pure.
 *
 * Every flag is validated fail-loud at parse time. The three Railway ids gate the metrics
 * read: a wrong id doesn't error downstream, it returns EMPTY metrics that read as
 * "no traffic — pass" (a blind instrument, Rules #322/#456), so the parser is the one
 * place a malformed id can be caught before it becomes a false verdict.
 */

export interface TripwireArgs {
  /** Target repo as owner/name (e.g. "studio-b-ai/webhook-router"). */
  repo: string;
  /** Merged PR number in the target repo. */
  pr: number;
  /** Full 40-hex squash merge commit sha (event.pull_request.merge_commit_sha). */
  mergeSha: string;
  /** PR closed timestamp, ISO-8601 (event.pull_request.closed_at) — the attribution floor. */
  closedAt: string;
  /** Railway project id (UUID). */
  projectId: string;
  /** Railway environment id (UUID). */
  environmentId: string;
  /** Railway service id (UUID) — the service whose deploy + HTTP metrics are read. */
  serviceId: string;
  /**
   * Path to the CALLER repo's checkout (the workflow checks it out at a separate path
   * with App-token credentials) — where a trip's `git revert` runs. Required up front,
   * not at trip time: a tripwire that discovers mid-incident it cannot revert is worse
   * than a job that fails loud at parse.
   */
  targetDir: string;
  /**
   * Safe-path globs for the §4.1 re-derivation (same semantics as the gate's
   * --safe-path-glob). Empty = no code-fix candidate can qualify (classifyPrDiffClass
   * only proposes codeFix when globs are non-empty), so the runner will refuse with
   * "not code-fix class" — fail-closed by construction.
   */
  safePathGlobs: string[];
  /** Sensitive-path deny patterns for the re-derivation (fail-closed on match). */
  sensitivePaths: string[];
  /** Named required checks the merged PR's final rollup must satisfy. */
  requiredChecks: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Full date + time + explicit zone, nothing less (codex P1, 2026-08-30 pass 1):
// Date.parse alone accepts "123" (year 123!) and date-only/zoneless strings — any of
// which silently moves the attribution floor and can bind a pre-existing same-sha
// deployment. GitHub's closed_at is always this shape.
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return v;
}

/**
 * Parses the runner's argv (process.argv.slice(2)). Throws on any unknown flag, missing
 * required flag, or malformed value — the workflow surfaces the throw as a failed job,
 * which is the correct fail-closed shape for a tripwire that must never render a verdict
 * from inputs it cannot trust.
 *
 * Repeatable flags (--safe-path-glob / --sensitive-path / --required-check) trim each
 * value and drop whitespace-only entries — defense-in-depth behind the workflow's own
 * comma-split + trim (mirrors the automerge-args convention).
 */
export function parseTripwireArgs(argv: string[]): TripwireArgs {
  let repo: string | undefined;
  let pr: number | undefined;
  let mergeSha: string | undefined;
  let closedAt: string | undefined;
  let projectId: string | undefined;
  let environmentId: string | undefined;
  let serviceId: string | undefined;
  let targetDir: string | undefined;
  const safePathGlobs: string[] = [];
  const sensitivePaths: string[] = [];
  const requiredChecks: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--repo": {
        const v = requireValue(argv, i, arg).trim();
        if (!REPO_RE.test(v)) throw new Error(`--repo must be owner/name, got: ${v}`);
        repo = v;
        i++;
        break;
      }
      case "--pr": {
        const v = requireValue(argv, i, arg).trim();
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--pr must be a positive integer, got: ${v}`);
        pr = n;
        i++;
        break;
      }
      case "--merge-sha": {
        const v = requireValue(argv, i, arg).trim();
        if (!SHA_RE.test(v)) throw new Error(`--merge-sha must be a full 40-hex sha, got: ${v}`);
        mergeSha = v.toLowerCase();
        i++;
        break;
      }
      case "--closed-at": {
        const v = requireValue(argv, i, arg).trim();
        if (!ISO_8601_RE.test(v) || Number.isNaN(Date.parse(v))) throw new Error(`--closed-at must be an ISO-8601 timestamp, got: ${v}`);
        closedAt = v;
        i++;
        break;
      }
      case "--project-id": {
        const v = requireValue(argv, i, arg).trim();
        if (!UUID_RE.test(v)) throw new Error(`--project-id must be a UUID, got: ${v}`);
        projectId = v;
        i++;
        break;
      }
      case "--environment-id": {
        const v = requireValue(argv, i, arg).trim();
        if (!UUID_RE.test(v)) throw new Error(`--environment-id must be a UUID, got: ${v}`);
        environmentId = v;
        i++;
        break;
      }
      case "--service-id": {
        const v = requireValue(argv, i, arg).trim();
        if (!UUID_RE.test(v)) throw new Error(`--service-id must be a UUID, got: ${v}`);
        serviceId = v;
        i++;
        break;
      }
      case "--target-dir": {
        const v = requireValue(argv, i, arg).trim();
        if (v.length === 0) throw new Error("--target-dir must be a non-empty path");
        targetDir = v;
        i++;
        break;
      }
      case "--safe-path-glob": {
        const v = requireValue(argv, i, arg).trim();
        if (v.length > 0) safePathGlobs.push(v);
        i++;
        break;
      }
      case "--sensitive-path": {
        const v = requireValue(argv, i, arg).trim();
        if (v.length > 0) sensitivePaths.push(v);
        i++;
        break;
      }
      case "--required-check": {
        const v = requireValue(argv, i, arg).trim();
        if (v.length > 0) requiredChecks.push(v);
        i++;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (repo === undefined) throw new Error("--repo is required");
  if (pr === undefined) throw new Error("--pr is required");
  if (mergeSha === undefined) throw new Error("--merge-sha is required");
  if (closedAt === undefined) throw new Error("--closed-at is required");
  if (projectId === undefined) throw new Error("--project-id is required");
  if (environmentId === undefined) throw new Error("--environment-id is required");
  if (serviceId === undefined) throw new Error("--service-id is required");
  if (targetDir === undefined) throw new Error("--target-dir is required");

  return { repo, pr, mergeSha, closedAt, projectId, environmentId, serviceId, targetDir, safePathGlobs, sensitivePaths, requiredChecks };
}
