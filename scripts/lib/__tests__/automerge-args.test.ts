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

  it("parses repo and numeric pr correctly alongside other flags", () => {
    const args = parseArgs(["--enabled-classes", "test-only", "--repo", "studio-b-ai/bolt-wms", "--pr", "123"]);
    expect(args.repo).toBe("studio-b-ai/bolt-wms");
    expect(args.pr).toBe(123);
  });
});
