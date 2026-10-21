/**
 * public-gate-log.ts — the gate's stdout is a PUBLIC log (go-native Phase A, PR-A2 item 5).
 *
 * ops-pipeline is a public repo, so its Actions logs are public — and the gate used to print private-repo review content there:
 * the refusal reasons (`finalCheck.reasons`, the review's own detail text), the PR classification verdict text, free-text
 * diagnostics, and (via the step's `env:` echo) the safe-path globs. Run 39524054966 (2026-10-21) logged bolt-wms#3936's verdict
 * text verbatim. The plan (native-plan §6 PR-A2 item 5): "gate logs carry only repo, PR, SHA and verdict enum".
 *
 * ONE choke point instead of ~60 call sites: `installPublicGateLog()` wraps console.{log,info,warn,error,debug} for the whole
 * gate process, so every line any module prints — pr-automerge-gate.ts, gate-enroll.ts, label-authority.ts, anything added
 * later — passes the grammar below or is dropped. A new `console.log` with a juicy message therefore fails CLOSED (the text just
 * doesn't appear), never open.
 *
 * What may reach the log (everything else is dropped):
 *   [gate-receipt] repo=R pr=N class=C verdict=V [leg=L]         rebuilt from validated fields; `reasons="…"` is stripped
 *   [train-gate-receipt] repo=R pr=N outcome=O                   rebuilt; `detail="…"` is stripped
 *   [tag] [pr-automerge-gate ]R#N [leg=L] [sha=<40-hex>]        a tagged line is reduced to its tag, repo#pr, an enum leg, a SHA
 *   [tag]                                                        a tagged line with no repo#pr right after the tag
 *   excluded: native R / excluded: native-check-failed R (…)     the native-exclusion lines (lib/native-exclusion.ts), verbatim shape
 *   pr-automerge-gate failed (detail withheld from the public log)   the crash line (the stack is dropped; the receipt carries leg=other)
 * where R is a charset-validated owner/repo, N digits, tag/leg/class/verdict/outcome lowercase enums, SHA a 40-hex string.
 *
 * Where the reasons live instead: the PR itself, in the PRIVATE repo — the blue flag card / authority receipt / merge receipt the
 * gate already posts as PR comments, and Kevin's decision line (gate-enroll). Reproduce a gate run locally for the full text.
 */
import { format } from "node:util";

const REPO = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
const ENUM = "[a-z][a-z0-9-]*";
const SHA_RE = /\b[0-9a-f]{40}\b/;

const GATE_RECEIPT_RE = new RegExp(`^\\[gate-receipt\\] repo=(${REPO}) pr=(\\d+) class=(${ENUM}) verdict=(qualified|missed|candidate)(?: leg=(${ENUM}))?(?:\\s|$)`);
const TRAIN_RECEIPT_RE = new RegExp(`^\\[train-gate-receipt\\] repo=(${REPO}) pr=(\\d+) outcome=(merged|stale-label-removed|refused|merge-attempt-failed)(?:\\s|$)`);
const EXCLUDED_RE = new RegExp(`^excluded: (?:native ${REPO}|native-check-failed (?:${REPO}|<invalid-repo-name>) \\(fail-closed: ruleset read failed\\))$`);
const TAGGED_RE = new RegExp(`^\\[(${ENUM})\\](?: (pr-automerge-gate )?(${REPO})#(\\d+)(?: leg=(${ENUM}))?)?`);
const CRASH_RE = /^pr-automerge-gate failed:/;

/** Pure: one raw output line → the line that may be printed, or null (drop it). */
export function toPublicGateLine(line: string): string | null {
  const receipt = GATE_RECEIPT_RE.exec(line);
  if (receipt) {
    const [, repo, pr, cls, verdict, leg] = receipt;
    return `[gate-receipt] repo=${repo} pr=${pr} class=${cls} verdict=${verdict}${leg ? ` leg=${leg}` : ""}`;
  }
  const train = TRAIN_RECEIPT_RE.exec(line);
  if (train) return `[train-gate-receipt] repo=${train[1]} pr=${train[2]} outcome=${train[3]}`;
  if (EXCLUDED_RE.test(line)) return line;
  if (CRASH_RE.test(line)) return "pr-automerge-gate failed (detail withheld from the public log)";
  const tagged = TAGGED_RE.exec(line);
  if (tagged) {
    const [, tag, gatePrefix, repo, pr, leg] = tagged;
    const sha = SHA_RE.exec(line)?.[0];
    return [`[${tag}]`, repo ? `${gatePrefix ?? ""}${repo}#${pr}` : "", leg ? `leg=${leg}` : "", sha ? `sha=${sha}` : ""].filter(Boolean).join(" ");
  }
  return null;
}

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];
const INSTALLED = Symbol.for("studiob.publicGateLog");

/**
 * Wrap the console for the rest of the process. Idempotent per method. Returns a restore function (tests; production never
 * restores — the process exits). A multi-line message is sanitized line by line.
 */
export function installPublicGateLog(target: Pick<Console, ConsoleMethod> = console): () => void {
  const originals = new Map<ConsoleMethod, Console[ConsoleMethod]>();
  for (const m of METHODS) {
    const current = target[m] as Console[ConsoleMethod] & { [INSTALLED]?: boolean };
    if (current[INSTALLED]) continue;
    originals.set(m, current);
    const wrapped = ((...args: unknown[]) => {
      for (const raw of format(...args).split("\n")) {
        const safe = toPublicGateLine(raw);
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
