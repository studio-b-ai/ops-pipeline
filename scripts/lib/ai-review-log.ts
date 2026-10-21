/**
 * ai-review-log.ts — the sweep's stdout is a PUBLIC log (ops-pipeline is a public repo; native-plan §4 "log hygiene").
 *
 * Same philosophy as lib/gate-log-enum.ts, applied to this module's own process: ONE choke point instead of every call site.
 *  - every line is BUILT from a closed event type by `formatLogEvent` (repo names are charset-validated, everything else is an enum, a
 *    number or a 40-hex SHA — there is no parameter that can carry free text);
 *  - `installAiReviewLog()` wraps console.{log,info,warn,error,debug} for the whole process so any line from any other source — the
 *    credential-mode line of anthropicClient(), an SDK warning, a stray debug print — passes the grammar below or is dropped.
 *    A new `console.log` with a juicy message therefore fails CLOSED: the text just never appears.
 *
 * What may reach the log (everything else is dropped):
 *   [ai-review] sweep repos=N prs=N post=N unchanged=N skipped=N errors=N
 *   [ai-review] R#N sha=<40-hex> verdict=<pass|block|waived> categories=<LETTERS|-> source=<gate|cached|model|waiver> action=<post|unchanged>
 *   [ai-review] R#N verdict=none leg=<enum>
 *   [ai-review] R#N skip=<draft|closed>
 *   [ai-review] R list-failed
 *   [ai-review] posted R#N sha=<40-hex> conclusion=<success|failure>
 *   [ai-review] post-skipped R#N reason=<unchanged|not-in-manifest>
 *   [ai-review] post-failed R#N
 *   [ai-review] post done posted=N skipped=N failed=N
 *   [ai-review] reviewer app not configured; nothing posted
 *   [ai-review] failed leg=<enum>
 * Reasons live in the check run on the private repo, and nowhere in a log.
 */
import { format } from "node:util";

const REPO = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
const ENUM = "[a-z][a-z0-9-]*";
const SHA = "[0-9a-f]{40}";

export type LogEvent =
  | { e: "sweep"; repos: number; prs: number; post: number; unchanged: number; skipped: number; errors: number }
  | { e: "verdict"; repo: string; pr: number; sha: string; verdict: "pass" | "block" | "waived"; categories: string; source: string; action: "post" | "unchanged" }
  | { e: "no-verdict"; repo: string; pr: number; leg: string }
  | { e: "skip"; repo: string; pr: number; reason: "draft" | "closed" }
  | { e: "list-failed"; repo: string }
  | { e: "posted"; repo: string; pr: number; sha: string; conclusion: "success" | "failure" }
  | { e: "post-skipped"; repo: string; pr: number; reason: "unchanged" | "not-in-manifest" }
  | { e: "post-failed"; repo: string; pr: number }
  | { e: "post-done"; posted: number; skipped: number; failed: number }
  | { e: "not-configured" }
  | { e: "failed"; leg: string };

const safeRepo = (r: string): string => (new RegExp(`^${REPO}$`).test(r) ? r : "<invalid-repo>");
const safeEnum = (s: string): string => (new RegExp(`^${ENUM}$`).test(s) ? s : "other");
const safeSha = (s: string): string => (new RegExp(`^${SHA}$`).test(s) ? s : "0".repeat(40));
const safeInt = (n: number): number => (Number.isInteger(n) && n >= 0 ? n : 0);
const safeCats = (c: string): string => (c === "" ? "-" : /^[A-Z]{1,9}$/.test(c) ? c : "-");

export function formatLogEvent(ev: LogEvent): string {
  switch (ev.e) {
    case "sweep":
      return `[ai-review] sweep repos=${safeInt(ev.repos)} prs=${safeInt(ev.prs)} post=${safeInt(ev.post)} unchanged=${safeInt(ev.unchanged)} skipped=${safeInt(ev.skipped)} errors=${safeInt(ev.errors)}`;
    case "verdict":
      return `[ai-review] ${safeRepo(ev.repo)}#${safeInt(ev.pr)} sha=${safeSha(ev.sha)} verdict=${ev.verdict} categories=${safeCats(ev.categories)} source=${safeEnum(ev.source)} action=${ev.action}`;
    case "no-verdict":
      return `[ai-review] ${safeRepo(ev.repo)}#${safeInt(ev.pr)} verdict=none leg=${safeEnum(ev.leg)}`;
    case "skip":
      return `[ai-review] ${safeRepo(ev.repo)}#${safeInt(ev.pr)} skip=${ev.reason}`;
    case "list-failed":
      return `[ai-review] ${safeRepo(ev.repo)} list-failed`;
    case "posted":
      return `[ai-review] posted ${safeRepo(ev.repo)}#${safeInt(ev.pr)} sha=${safeSha(ev.sha)} conclusion=${ev.conclusion}`;
    case "post-skipped":
      return `[ai-review] post-skipped ${safeRepo(ev.repo)}#${safeInt(ev.pr)} reason=${ev.reason}`;
    case "post-failed":
      return `[ai-review] post-failed ${safeRepo(ev.repo)}#${safeInt(ev.pr)}`;
    case "post-done":
      return `[ai-review] post done posted=${safeInt(ev.posted)} skipped=${safeInt(ev.skipped)} failed=${safeInt(ev.failed)}`;
    case "not-configured":
      return "[ai-review] reviewer app not configured; nothing posted";
    case "failed":
      return `[ai-review] failed leg=${safeEnum(ev.leg)}`;
  }
}

const LINE_RES: RegExp[] = [
  /^\[ai-review\] sweep repos=\d+ prs=\d+ post=\d+ unchanged=\d+ skipped=\d+ errors=\d+$/,
  new RegExp(`^\\[ai-review\\] ${REPO}#\\d+ sha=${SHA} verdict=(pass|block|waived) categories=([A-Z]{1,9}|-) source=${ENUM} action=(post|unchanged)$`),
  new RegExp(`^\\[ai-review\\] ${REPO}#\\d+ verdict=none leg=${ENUM}$`),
  new RegExp(`^\\[ai-review\\] ${REPO}#\\d+ skip=(draft|closed)$`),
  new RegExp(`^\\[ai-review\\] ${REPO} list-failed$`),
  new RegExp(`^\\[ai-review\\] posted ${REPO}#\\d+ sha=${SHA} conclusion=(success|failure)$`),
  new RegExp(`^\\[ai-review\\] post-skipped ${REPO}#\\d+ reason=(unchanged|not-in-manifest)$`),
  new RegExp(`^\\[ai-review\\] post-failed ${REPO}#\\d+$`),
  /^\[ai-review\] post done posted=\d+ skipped=\d+ failed=\d+$/,
  /^\[ai-review\] reviewer app not configured; nothing posted$/,
  new RegExp(`^\\[ai-review\\] failed leg=${ENUM}$`),
];

/** Pure: one raw output line → the line that may be printed, or null (drop it). */
export function toPublicLine(line: string): string | null {
  return LINE_RES.some((re) => re.test(line)) ? line : null;
}

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];
const INSTALLED = Symbol.for("studiob.aiReviewLog");

/** Wrap the console for the rest of the process. Idempotent per method. Returns a restore function (tests; production never restores). */
export function installAiReviewLog(target: Pick<Console, ConsoleMethod> = console): () => void {
  const originals = new Map<ConsoleMethod, Console[ConsoleMethod]>();
  for (const m of METHODS) {
    const current = target[m] as Console[ConsoleMethod] & { [INSTALLED]?: boolean };
    if (current[INSTALLED]) continue;
    originals.set(m, current);
    const wrapped = ((...args: unknown[]) => {
      for (const raw of format(...args).split("\n")) {
        const safe = toPublicLine(raw);
        if (safe !== null) current.call(target, safe);
      }
    }) as Console[ConsoleMethod] & { [INSTALLED]?: boolean };
    wrapped[INSTALLED] = true;
    target[m] = wrapped;
  }
  return () => {
    for (const [m, orig] of originals) target[m] = orig;
  };
}

/** Print one event through console.log (and therefore through the installed choke point). */
export function logEvent(ev: LogEvent): void {
  console.log(formatLogEvent(ev));
}
