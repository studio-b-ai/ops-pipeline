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
  /** Rung 1 Leg B (ops-pipeline#172): default OFF. Without it, behavior is byte-identical to
   *  rung 0/Leg A — no CI-rollup check, no in-flight check, no `CLICK DUE` posting. Independent
   *  of `--post` (which still gates whether anything actually gets written, exactly as it does
   *  for every other posting path in this worker). */
  page: boolean;
  /** Rung 3 (ops-pipeline#172; Kevin GO "done;go", sitting 2026-08-28 §8.4): default OFF. With
   *  it, a green ready queue head is sha-pinned squash-MERGED instead of paged as CLICK DUE, and
   *  the observe state machine runs to END / END · FAILED. Three coherence guards, all throws:
   *  `--fire` refuses `--now` (live merges run on the REAL clock only — a simulated clock could
   *  fire outside the window law); `--fire` requires `--post` (a merge with no ledger receipts
   *  would be invisible, #4/#412) and `--page` (the fire path lives inside the paging gate
   *  ladder — fire without page is a no-op the operator would misread as armed, #376). */
  fire: boolean;
}

/** The human restart calendar — a READ source for this worker, never a post target. */
export const CALENDAR_REPO = "studio-b-ai/client-asthetik";
export const CALENDAR_ISSUE = 280;
export const DEFAULT_TARGET = "studio-b-ai/ops-pipeline#172";

export function parseArgs(argv: string[]): Flags {
  const fire = argv.includes("--fire");
  if (fire && argv.includes("--now")) {
    throw new Error(
      "--fire refuses --now — live merges must run on the real clock (the window law is meaningless under a simulated timestamp); drop --now or drop --fire",
    );
  }
  if (fire && (!argv.includes("--post") || !argv.includes("--page"))) {
    throw new Error(
      "--fire requires both --post and --page — a live merge without ledger receipts (--post) or outside the paging gate ladder (--page) is incoherent (rung 3, ops-pipeline#172)",
    );
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
  const page = argv.includes("--page");
  return { dryRun: !fire, now, target, post, page, fire };
}

export function parseTarget(target: string): { repo: string; number: number } {
  const m = target.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!m) throw new Error(`unparsable --target: ${target}`);
  return { repo: m[1], number: Number(m[2]) };
}
