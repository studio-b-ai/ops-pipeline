/**
 * ai-review-secrets.ts — the deterministic secret scan behind category S of the central AI review check (go-native, native-plan §4).
 *
 * Why this exists. Category S (secret material) used to be decided by the model alone. Two paths post a SUCCESS without any model
 * verdict: the size-cap waiver (Kevin approves an oversized PR, Z → success) and the model-down waiver (no model verdict, Kevin approves
 * the head → success). Neither looked at the diff, so a Kevin approval given for size or availability reasons also let a committed
 * credential through. The rule is now: S is evaluated on EVERY head SHA whose verdict could be a success, by this scan, before any waiver
 * is consulted, and an S hit is an unwaivable failure (rotate the secret; a Kevin approval does not touch it).
 *
 * This is a FLOOR, not a ceiling: a conservative set of high-signal shapes (private-key blocks, GitHub tokens, AWS access key ids, `sk-`
 * API keys, Slack tokens). The model's own S category still runs on top wherever the model is available.
 *
 * What the repo already had. `sanitizeReasons` (ai-review-rubric.ts) holds token-shaped REDACTION patterns, and secret-scan.yml runs gitleaks
 * over the working tree — a CLI step in CI, not a function the sweep can call on a diff. The redaction patterns are deliberately broad
 * (an over-redacted reason costs nothing); a DETECTION pattern that is too broad is a false failure nobody can waive. So this module has its
 * own set with tighter floors, and a test pins the relationship: every shape detected here is also redacted from the reasons text.
 *
 * What is scanned: every ADDED line of the diff (a line starting with `+`). Removed and context lines are not scanned, or a PR that deletes
 * a leaked key could never pass. Lines that look like file headers (`+++ b/path`) are scanned too, never skipped: an added line whose
 * content begins `++ ` renders as `+++ ` in a diff, and skipping header-shaped lines would let anyone hide a secret behind that prefix.
 *
 * Placeholders. A match whose secret body has three or fewer distinct characters (`xxxxxxxx…`, `0000…`) is not a credential, and the AWS
 * documentation key id ending in `EXAMPLE` is not either; nobody can make a real credential look like either of those, so ignoring them
 * opens nothing.
 *
 * Output is ENUMS and sanitized file paths only. The matched text never leaves this function: a finding cannot carry the secret into a
 * check run, a log, or a handoff.
 *
 * Tightening later. A cached model verdict is reused without re-reading the diff, so broadening the patterns below does not reach verdicts
 * already posted. Bump VERDICT_ID_VERSION (ai-review-verdict.ts) in the same change: earlier external_ids stop parsing, are never a cache
 * hit, and each open PR is re-scanned once (#381).
 *
 * Cost. Every pattern is linear: the one look-ahead is bounded (120 characters), and no pattern nests an unbounded quantifier inside
 * another. A multi-megabyte diff is a few linear passes.
 */

export type SecretKind = "private-key" | "github-token" | "aws-access-key" | "api-key" | "slack-token";

export interface SecretFinding {
  kind: SecretKind;
  /** the file the hit is in, reduced to a safe charset and length; null when the diff gave no file header before it */
  path: string | null;
}

const KIND_TEXT: Record<SecretKind, string> = {
  "private-key": "a private key",
  "github-token": "a GitHub token",
  "aws-access-key": "an AWS access key id",
  "api-key": "an `sk-` API key",
  "slack-token": "a Slack token",
};

/** A body of three or fewer distinct characters is a placeholder, never a credential. */
function realBody(body: string): boolean {
  return new Set(body).size > 3;
}

interface TokenPattern {
  kind: SecretKind;
  re: RegExp;
  /** the secret body (the capture group); the pattern only counts when this returns true */
  ok: (body: string) => boolean;
}

// All start at a word boundary, so `risk-…`, `task-…`, `disk-…` can never match the `sk-` shape.
const TOKEN_PATTERNS: readonly TokenPattern[] = [
  { kind: "github-token", re: /\bgh[pousr]_([A-Za-z0-9]{30,})/g, ok: realBody },
  { kind: "github-token", re: /\bgithub_pat_([A-Za-z0-9_]{30,})/g, ok: realBody },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)([0-9A-Z]{16})\b/g, ok: (b) => !b.endsWith("EXAMPLE") && realBody(b) },
  // 32+ characters and a digit inside the first 120: real keys (`sk-…`, `sk-proj-…`, `sk-ant-…`) have both; a CSS class like `sk-fading-circle` has neither
  { kind: "api-key", re: /\bsk-(?=[A-Za-z0-9_-]{0,120}\d)([A-Za-z0-9_-]{32,})/g, ok: realBody },
  { kind: "slack-token", re: /\bxox[abprs]-([A-Za-z0-9-]{20,})/g, ok: realBody },
];

const KEY_HEADER = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/** What may sit between a key header and its body on the same line: whitespace, quotes, commas, `+` (string concatenation), or an escaped `\n`/`\r`/`\t`. */
const AFTER_HEADER = /^(?:\\[nrt]|[\s"',+])+/;
/** Key material: 16+ base64 characters (PEM lines are 64–76 wide; this also catches a key re-wrapped narrower) containing a digit, `+` or `/`. */
const BODY_START = /^[A-Za-z0-9+/]{16,}/;
const BODY_WRAPPERS = /^[\s"'#*>+]+/;
/** How many added lines after a header may hold the first line of the body (RFC 1421 headers such as `Proc-Type:` and a blank line sit in between). */
const BODY_WINDOW = 4;

function looksLikeKeyBody(text: string): boolean {
  const m = BODY_START.exec(text);
  return m !== null && /[0-9+/]/.test(m[0]);
}

function safePath(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._/@+-]/g, "?").slice(0, 120);
}

/** `+++ b/path` → path; `+++ /dev/null` → null. Only used to LABEL a finding; a forged header can only mislabel it, never hide it. */
function pathFromHeader(line: string): string | null {
  const rest = line.slice(4).split("\t")[0];
  if (rest === "/dev/null") return null;
  return safePath(rest.startsWith("b/") ? rest.slice(2) : rest);
}

const MAX_FINDINGS = 10;

/**
 * The secret-shaped additions in a unified diff: at most MAX_FINDINGS distinct (kind, file) pairs. Empty means none found. Never throws on
 * any string.
 */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: SecretKind, path: string | null): void => {
    const key = `${kind}\u0000${path ?? ""}`;
    if (seen.has(key) || findings.length >= MAX_FINDINGS) return;
    seen.add(key);
    findings.push({ kind, path });
  };

  const lines = diff.split("\n");
  let path: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("+")) continue;
    if (line.startsWith("+++ ") && i > 0 && lines[i - 1].startsWith("--- ")) path = pathFromHeader(line);
    const text = line.slice(1);

    for (const p of TOKEN_PATTERNS) {
      for (const m of text.matchAll(p.re)) {
        if (p.ok(m[1])) {
          add(p.kind, path);
          break;
        }
      }
    }

    const header = KEY_HEADER.exec(text);
    if (header) {
      // the body on the same line (a JSON string with escaped newlines), or on one of the next added lines (a PEM block)
      const sameLine = text.slice(header.index + header[0].length).replace(AFTER_HEADER, "");
      let body = looksLikeKeyBody(sameLine);
      for (let j = i + 1; !body && j <= i + BODY_WINDOW && j < lines.length && lines[j].startsWith("+"); j++) {
        body = looksLikeKeyBody(lines[j].slice(1).replace(BODY_WRAPPERS, ""));
      }
      if (body) add("private-key", path);
    }
  }
  return findings;
}

/** One detail line for a check run summary: kind enum text and a sanitized path, never any matched text. */
export function describeFinding(f: SecretFinding): string {
  return `secret scan: ${KIND_TEXT[f.kind]} in ${f.path ?? "an unnamed file"}`;
}
