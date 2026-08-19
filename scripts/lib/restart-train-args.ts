/**
 * restart-train-args.ts — CLI argument parsing for the restart-train worker
 * (scripts/restart-train.ts), extracted to its own pure module so it gets real
 * unit tests — the worker calls `main().catch(...)` unconditionally at module
 * scope, so importing it from a test file would execute the whole scheduler
 * against `process.argv` (the same hazard automerge-args.ts documents for its
 * runner; same extraction shape, Rule #5).
 *
 * Carries the codex P2 guard (2026-08-19 pass 2): `--target` must NEVER be the
 * human calendar issue (client-asthetik#280). The worker PARSES #280 as a
 * read-only ledger source; a workflow_dispatch pointing --target at it would
 * make the train write dry-run/HELD lines into the very calendar it reads —
 * poisoning its own parser's input (findDanglingPlan / the #412 grammar). The
 * CI workflow always runs with --post, so dispatcher attention is not a guard;
 * this throw is (fail-closed, design §5).
 */

export interface Flags {
  dryRun: boolean;
  now: string;
  target: string;
  post: boolean;
}

/** The human restart calendar — a READ source for this worker, never a post target. */
export const CALENDAR_REPO = "studio-b-ai/client-asthetik";
export const CALENDAR_ISSUE = 280;
export const DEFAULT_TARGET = "studio-b-ai/ops-pipeline#172";

export function parseArgs(argv: string[]): Flags {
  if (argv.includes("--fire")) {
    throw new Error("rung 3 not built — this worker only ever runs --dry-run in rung 0 (ops-pipeline#172)");
  }
  const nowIdx = argv.indexOf("--now");
  if (nowIdx !== -1 && !argv[nowIdx + 1]) throw new Error("--now requires an ISO timestamp");
  const now = nowIdx !== -1 ? argv[nowIdx + 1] : new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error(`--now is not a parsable ISO timestamp: ${now}`);
  const targetIdx = argv.indexOf("--target");
  if (targetIdx !== -1 && !argv[targetIdx + 1]) throw new Error("--target requires <org/repo>#<n>");
  const target = targetIdx !== -1 ? argv[targetIdx + 1] : DEFAULT_TARGET;
  if (!/^[\w.-]+\/[\w.-]+#\d+$/.test(target)) throw new Error(`--target must look like org/repo#n, got: ${target}`);
  const parsed = parseTarget(target);
  if (parsed.repo === CALENDAR_REPO && parsed.number === CALENDAR_ISSUE) {
    throw new Error(
      `--target must never be ${CALENDAR_REPO}#${CALENDAR_ISSUE} — the human calendar is a READ-ONLY source for this worker; posting there would poison its own ledger parsing (codex P2, 2026-08-19)`
    );
  }
  const post = argv.includes("--post");
  return { dryRun: true, now, target, post };
}

export function parseTarget(target: string): { repo: string; number: number } {
  const m = target.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!m) throw new Error(`unparsable --target: ${target}`);
  return { repo: m[1], number: Number(m[2]) };
}
