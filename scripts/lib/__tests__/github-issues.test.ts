import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_LABEL_DESCRIPTION_MAX, assertLabelDescription } from "../github-issues.js";

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("assertLabelDescription (GitHub 100-char label description cap)", () => {
  it("accepts exactly the maximum", () => {
    const d = "x".repeat(GITHUB_LABEL_DESCRIPTION_MAX);
    expect(assertLabelDescription(d)).toBe(d);
  });
  it("rejects one over the maximum, naming the length", () => {
    const d = "x".repeat(GITHUB_LABEL_DESCRIPTION_MAX + 1);
    expect(() => assertLabelDescription(d)).toThrow(/101 chars; GitHub's maximum is 100/);
  });
});

/**
 * Source-level guard for the class ops-pipeline#136's first live firing exposed (2026-08-16):
 * label descriptions only reach `gh label create` on a worker's MUTATING path, so a too-long
 * literal passes every dry run and every unit test and 422s on the first real run. Scan every
 * worker's `LABEL_DESCRIPTION = "…"` constant and every inline `ensureLabel(…, "…", …)` literal.
 */
describe("worker label-description literals stay under GitHub's cap", () => {
  const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".ts"));
  const literals: Array<{ file: string; text: string }> = [];
  for (const f of files) {
    const src = readFileSync(join(SCRIPTS_DIR, f), "utf8");
    for (const m of src.matchAll(/LABEL_DESCRIPTION\s*=\s*"([^"]*)"/g)) literals.push({ file: f, text: m[1] });
    for (const m of src.matchAll(/ensureLabel\([^,\n]+,[^,\n]+,\s*"([^"]*)"/g)) literals.push({ file: f, text: m[1] });
  }
  it("finds the known literals (positive control — the scan is not blind)", () => {
    expect(literals.length).toBeGreaterThanOrEqual(5);
    expect(literals.some((l) => l.file === "backlog-staleness-worker.ts")).toBe(true);
  });
  it.each(literals.map((l) => [l.file, l.text] as const))("%s: %s", (_file, text) => {
    expect(text.length).toBeLessThanOrEqual(GITHUB_LABEL_DESCRIPTION_MAX);
  });
});

/**
 * Regression guard (ops-pipeline#146, 2026-08-16): an in-place UPDATE that only retitles +
 * comments leaves the issue BODY at its first-run table forever — a stale scope claim that reads
 * as current (Rule #355/#412). Every worker that retitles an open aggregate in place must also
 * rewrite its body in the same branch.
 */
describe("in-place issue updates rewrite the body, not just the title", () => {
  it("backlog-staleness-worker's update branch calls editIssueBody alongside retitleIssue", () => {
    const src = readFileSync(join(SCRIPTS_DIR, "backlog-staleness-worker.ts"), "utf8");
    const retitleAt = src.indexOf("retitleIssue(SELF_REPO, existingNum!, title)");
    expect(retitleAt).toBeGreaterThan(-1);
    const window = src.slice(retitleAt, retitleAt + 400);
    expect(window).toMatch(/editIssueBody\(SELF_REPO, existingNum!, body\)/);
    expect(window).toMatch(/commentIssue\(SELF_REPO, existingNum!, body\)/);
  });
});
