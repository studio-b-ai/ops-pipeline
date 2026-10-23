import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "..", "base-must-be-main.ts");

function run(env: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", WORKER], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 30000,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? "").trim(),
    };
  }
}

function parseJsonLine(output: string): Record<string, unknown> {
  const lines = output.split("\n").filter((l) => l.trim().startsWith("{"));
  if (lines.length === 0) throw new Error(`no JSON line found in output:\n${output}`);
  return JSON.parse(lines[0]);
}

describe("base-must-be-main.ts", () => {
  it("PASS (exit 0): base IS the default branch, non-draft", () => {
    const r = run({ PR_BASE_REF: "main", PR_DRAFT: "false", DEFAULT_BRANCH: "main" });
    expect(r.exitCode).toBe(0);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("PASS");
    expect(j.draft).toBe(false);
    expect(j.base).toBe("main");
  });

  it("PASS (exit 0): base IS the default branch, draft", () => {
    const r = run({ PR_BASE_REF: "main", PR_DRAFT: "true", DEFAULT_BRANCH: "main" });
    expect(r.exitCode).toBe(0);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("PASS");
    expect(j.draft).toBe(true);
  });

  it("PASS (exit 0): base is NOT default, but PR is a draft (stacked-PR workflow)", () => {
    const r = run({
      PR_BASE_REF: "feature/parent-abc",
      PR_DRAFT: "true",
      DEFAULT_BRANCH: "main",
    });
    expect(r.exitCode).toBe(0);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("PASS");
    expect(j.base).toBe("feature/parent-abc");
  });

  it("PASS (exit 0): base is NOT default, but is allowlisted", () => {
    const r = run({
      PR_BASE_REF: "gh-pages",
      PR_DRAFT: "false",
      DEFAULT_BRANCH: "main",
      ALLOW_LIST: "gh-pages,release/v2",
    });
    expect(r.exitCode).toBe(0);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("PASS");
    expect(j.allowlisted).toBe(true);
  });

  it("PASS (exit 0): base is NOT default, but is one entry in a multi-entry allowlist", () => {
    const r = run({
      PR_BASE_REF: "release/v2",
      PR_DRAFT: "false",
      DEFAULT_BRANCH: "main",
      ALLOW_LIST: "gh-pages,release/v2,staging",
    });
    expect(r.exitCode).toBe(0);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("PASS");
    expect(j.allowlisted).toBe(true);
  });

  it("FAIL (exit 1): base is NOT default, non-draft, not allowlisted — the #3945 class", () => {
    const r = run({
      PR_BASE_REF: "fix/3823-wms-onhand-shippable-sites",
      PR_DRAFT: "false",
      DEFAULT_BRANCH: "main",
    });
    expect(r.exitCode).toBe(1);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("FAIL");
    expect(j.draft).toBe(false);
    expect(j.base).toBe("fix/3823-wms-onhand-shippable-sites");
    expect(j.defaultBranch).toBe("main");
    expect(r.stdout).toContain("::error::");
  });

  it("FAIL (exit 1): base is develop, non-draft, no allowlist match", () => {
    const r = run({
      PR_BASE_REF: "develop",
      PR_DRAFT: "false",
      DEFAULT_BRANCH: "main",
      ALLOW_LIST: "gh-pages",
    });
    expect(r.exitCode).toBe(1);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("FAIL");
    expect(j.base).toBe("develop");
  });

  it("PASS (exit 0): fail-open when PR_BASE_REF is missing", () => {
    const r = run({ PR_BASE_REF: "", PR_DRAFT: "false", DEFAULT_BRANCH: "main" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("FAIL-OPEN");
  });

  it("PASS (exit 0): fail-open when DEFAULT_BRANCH is missing", () => {
    const r = run({ PR_BASE_REF: "main", PR_DRAFT: "false", DEFAULT_BRANCH: "" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("FAIL-OPEN");
  });

  it("PASS (exit 0): default branch named something other than main (e.g. master)", () => {
    const r = run({ PR_BASE_REF: "master", PR_DRAFT: "false", DEFAULT_BRANCH: "master" });
    expect(r.exitCode).toBe(0);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("PASS");
    expect(j.defaultBranch).toBe("master");
  });

  it("FAIL (exit 1): repo with non-main default branch, PR targeting main (which is not the default)", () => {
    const r = run({ PR_BASE_REF: "main", PR_DRAFT: "false", DEFAULT_BRANCH: "master" });
    expect(r.exitCode).toBe(1);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("FAIL");
    expect(j.base).toBe("main");
    expect(j.defaultBranch).toBe("master");
  });

  it("draft='anything-but-true' is treated as not-draft", () => {
    const r = run({
      PR_BASE_REF: "feature/x",
      PR_DRAFT: "False",
      DEFAULT_BRANCH: "main",
    });
    expect(r.exitCode).toBe(1);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("FAIL");
  });

  it("empty allowlist with a non-main base and non-draft → FAIL", () => {
    const r = run({
      PR_BASE_REF: "feature/y",
      PR_DRAFT: "false",
      DEFAULT_BRANCH: "main",
      ALLOW_LIST: "",
    });
    expect(r.exitCode).toBe(1);
    const j = parseJsonLine(r.stdout);
    expect(j.verdict).toBe("FAIL");
  });
});