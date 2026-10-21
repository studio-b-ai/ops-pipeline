/**
 * A hermetic fake `gh` for tests that run REAL scripts (a workflow `run:` block, a CLI) as child processes.
 *
 * `makeGhStub(dir, rules)` writes an executable `gh` into `dir` and returns the PATH-prefix + the call log path. Every call is
 * appended to the log (one line, the joined argv) so a test can assert which GitHub calls were — and were NOT — made. Rules are
 * matched in order against the joined argv (`"api repos/o/r/rulesets?per_page=100"`); the first match wins:
 *   { match: /regex/, out: "<stdout>" }                 → prints `out`, exit 0
 *   { match: /regex/, fail: true }                      → stderr noise, exit 1 (an API error)
 * An UNMAPPED call exits 97 — a test never silently talks to a default.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GhStubRule {
  match: RegExp;
  out?: string;
  fail?: boolean;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function makeGhStub(dir: string, rules: GhStubRule[]): { binDir: string; logPath: string; path: string } {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = join(dir, "gh-calls.log");
  writeFileSync(logPath, "");
  const lines = ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$GH_STUB_LOG"'];
  rules.forEach((r, i) => {
    const outFile = join(dir, `gh-out-${i}`);
    writeFileSync(outFile, r.out ?? "");
    lines.push(`if printf '%s' "$*" | grep -qE -e ${sq(r.match.source)}; then`);
    lines.push(r.fail ? `  echo "gh: stub API failure (HTTP 500)" >&2; exit 1` : `  cat ${sq(outFile)}; exit 0`);
    lines.push("fi");
  });
  lines.push('echo "gh stub: unmapped call: $*" >&2', "exit 97");
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, lines.join("\n") + "\n");
  chmodSync(ghPath, 0o755);
  return { binDir, logPath, path: `${binDir}:${process.env.PATH ?? ""}` };
}
