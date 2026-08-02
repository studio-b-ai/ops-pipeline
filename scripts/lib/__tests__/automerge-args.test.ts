import { describe, expect, it } from "vitest";
import { parseArgs } from "../automerge-args.js";

describe("parseArgs", () => {
  // ───── Negative controls first (Rule #322) ─────

  it("throws when --repo is missing", () => {
    expect(() => parseArgs(["--pr", "1"])).toThrow(/--repo/);
  });

  it("throws when --pr is missing", () => {
    expect(() => parseArgs(["--repo", "studio-b-ai/bolt-wms"])).toThrow(/--pr/);
  });

  it("throws when --pr is not a positive number", () => {
    expect(() => parseArgs(["--repo", "studio-b-ai/bolt-wms", "--pr", "0"])).toThrow(/--pr/);
    expect(() => parseArgs(["--repo", "studio-b-ai/bolt-wms", "--pr", "abc"])).toThrow(/--pr/);
    expect(() => parseArgs(["--repo", "studio-b-ai/bolt-wms", "--pr", "-3"])).toThrow(/--pr/);
  });

  it("throws on an unknown class name in --enabled-classes", () => {
    expect(() =>
      parseArgs(["--repo", "studio-b-ai/bolt-wms", "--pr", "1", "--enabled-classes", "docs-comment,bogus-class"]),
    ).toThrow(/unknown class/);
  });

  it("throws when --enabled-classes is present but resolves to zero valid classes (all-comma/whitespace)", () => {
    expect(() => parseArgs(["--repo", "studio-b-ai/bolt-wms", "--pr", "1", "--enabled-classes", ",  ,"])).toThrow(
      /no valid class names/,
    );
  });

  // ───── Positives ─────

  it("defaults enabledClasses to ['docs-comment'] ONLY when --enabled-classes is omitted (studiob's caller shape — the original #279 gate's scope, unchanged)", () => {
    const args = parseArgs(["--repo", "studio-b-ai/studiob", "--pr", "42"]);
    expect(args.enabledClasses).toEqual(["docs-comment"]);
    expect(args.sensitivePathPatterns).toEqual([]);
  });

  it("defaults enabledClasses to ['docs-comment'] when --enabled-classes is passed empty (defends the same default against a blank workflow input)", () => {
    const args = parseArgs(["--repo", "studio-b-ai/studiob", "--pr", "42", "--enabled-classes", ""]);
    expect(args.enabledClasses).toEqual(["docs-comment"]);
  });

  it("parses a full three-class --enabled-classes list (the bolt-wms canary caller shape)", () => {
    const args = parseArgs(["--repo", "studio-b-ai/bolt-wms", "--pr", "7", "--enabled-classes", "docs-comment,ci-infra,test-only"]);
    expect(args.enabledClasses).toEqual(["docs-comment", "ci-infra", "test-only"]);
  });

  it("trims whitespace around comma-separated class names", () => {
    const args = parseArgs(["--repo", "studio-b-ai/bolt-wms", "--pr", "7", "--enabled-classes", " docs-comment , ci-infra "]);
    expect(args.enabledClasses).toEqual(["docs-comment", "ci-infra"]);
  });

  it("collects multiple --sensitive-path flags into an array, in order", () => {
    const args = parseArgs([
      "--repo",
      "studio-b-ai/bolt-wms",
      "--pr",
      "7",
      "--sensitive-path",
      "^\\.github/actions/",
      "--sensitive-path",
      "\\.sql$",
    ]);
    expect(args.sensitivePathPatterns).toEqual(["^\\.github/actions/", "\\.sql$"]);
  });

  it("trims whitespace off each --sensitive-path value (codex P2 fix, 2026-08-02 pass 2) — an untrimmed leading-space regex source would never match a real path, silently making the exclusion inert", () => {
    // Reproduces the exact shape the reusable workflow's un-trimmed bash comma-split
    // would have produced for a caller-friendly "a, b" input: the SECOND arg arrives
    // here with a leading space.
    const args = parseArgs([
      "--repo",
      "studio-b-ai/bolt-wms",
      "--pr",
      "7",
      "--sensitive-path",
      "^\\.github/workflows/",
      "--sensitive-path",
      " ^scripts/deploy",
    ]);
    expect(args.sensitivePathPatterns).toEqual(["^\\.github/workflows/", "^scripts/deploy"]);
  });

  it("drops a whitespace-only --sensitive-path entry entirely rather than compiling an empty-string regex (which would match every path)", () => {
    const args = parseArgs(["--repo", "studio-b-ai/bolt-wms", "--pr", "7", "--sensitive-path", "   "]);
    expect(args.sensitivePathPatterns).toEqual([]);
  });

  it("parses repo and numeric pr correctly alongside other flags", () => {
    const args = parseArgs(["--enabled-classes", "test-only", "--repo", "studio-b-ai/bolt-wms", "--pr", "123"]);
    expect(args.repo).toBe("studio-b-ai/bolt-wms");
    expect(args.pr).toBe(123);
  });
});
