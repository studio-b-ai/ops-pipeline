import { describe, expect, it } from "vitest";

import { parseTripwireArgs } from "../tripwire-args.js";

const PROJECT_ID = "433dec0e-6963-4b66-bdd2-6049ba189b81";
const ENV_ID = "44268465-5f2c-4ec4-8b77-f29e5b16f0f8";
const SERVICE_ID = "09d9d0a2-a292-4b3d-8f3a-dc5dd4689573";
const SHA = "a".repeat(40);

function baseArgv(overrides: Record<string, string | null> = {}): string[] {
  const defaults: Record<string, string | null> = {
    "--repo": "studio-b-ai/webhook-router",
    "--pr": "123",
    "--merge-sha": SHA,
    "--closed-at": "2026-08-30T04:00:00Z",
    "--project-id": PROJECT_ID,
    "--environment-id": ENV_ID,
    "--service-id": SERVICE_ID,
    "--target-dir": "/tmp/target-checkout",
    ...overrides,
  };
  const argv: string[] = [];
  for (const [flag, value] of Object.entries(defaults)) {
    if (value === null) continue; // null = omit the flag entirely
    argv.push(flag, value);
  }
  return argv;
}

describe("parseTripwireArgs", () => {
  it("parses a fully-specified argv", () => {
    const args = parseTripwireArgs([
      ...baseArgv(),
      "--safe-path-glob",
      "src/**",
      "--safe-path-glob",
      "lib/**",
      "--sensitive-path",
      "**/auth*",
      "--required-check",
      "test",
      "--required-check",
      "typecheck",
    ]);
    expect(args.repo).toBe("studio-b-ai/webhook-router");
    expect(args.pr).toBe(123);
    expect(args.mergeSha).toBe(SHA);
    expect(args.closedAt).toBe("2026-08-30T04:00:00Z");
    expect(args.projectId).toBe(PROJECT_ID);
    expect(args.environmentId).toBe(ENV_ID);
    expect(args.serviceId).toBe(SERVICE_ID);
    expect(args.targetDir).toBe("/tmp/target-checkout");
    expect(args.safePathGlobs).toEqual(["src/**", "lib/**"]);
    expect(args.sensitivePaths).toEqual(["**/auth*"]);
    expect(args.requiredChecks).toEqual(["test", "typecheck"]);
  });

  it("defaults repeatable flags to empty arrays", () => {
    const args = parseTripwireArgs(baseArgv());
    expect(args.safePathGlobs).toEqual([]);
    expect(args.sensitivePaths).toEqual([]);
    expect(args.requiredChecks).toEqual([]);
  });

  it("trims repeatable values and drops whitespace-only entries", () => {
    const args = parseTripwireArgs([
      ...baseArgv(),
      "--safe-path-glob",
      "  src/** ",
      "--safe-path-glob",
      "   ",
      "--required-check",
      " test ",
    ]);
    expect(args.safePathGlobs).toEqual(["src/**"]);
    expect(args.requiredChecks).toEqual(["test"]);
  });

  it("lowercases the merge sha", () => {
    const args = parseTripwireArgs(baseArgv({ "--merge-sha": "A".repeat(40) }));
    expect(args.mergeSha).toBe("a".repeat(40));
  });

  // ── required-flag enforcement (each omission must throw) ──
  for (const flag of ["--repo", "--pr", "--merge-sha", "--closed-at", "--project-id", "--environment-id", "--service-id", "--target-dir"]) {
    it(`throws when ${flag} is missing`, () => {
      expect(() => parseTripwireArgs(baseArgv({ [flag]: null }))).toThrow(`${flag} is required`);
    });
  }

  // ── value validation ──
  it("rejects a non-owner/name repo", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--repo": "webhook-router" }))).toThrow("--repo must be owner/name");
  });

  it("rejects a non-integer PR number", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--pr": "12.5" }))).toThrow("--pr must be a positive integer");
  });

  it("rejects a zero PR number", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--pr": "0" }))).toThrow("--pr must be a positive integer");
  });

  it("rejects a short sha", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--merge-sha": "abc1234" }))).toThrow("--merge-sha must be a full 40-hex sha");
  });

  it("rejects a non-hex sha", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--merge-sha": "g".repeat(40) }))).toThrow("--merge-sha must be a full 40-hex sha");
  });

  it("rejects an unparseable closed-at timestamp", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--closed-at": "not-a-date" }))).toThrow("--closed-at must be an ISO-8601 timestamp");
  });

  // ── closed-at strictness (codex P1, 2026-08-30 pass 1): Date.parse alone accepts all
  // of these, and each silently moves the attribution floor — the regex must reject them ──
  it('rejects a bare-number closed-at ("123" parses as year 123 under Date.parse)', () => {
    expect(() => parseTripwireArgs(baseArgv({ "--closed-at": "123" }))).toThrow("--closed-at must be an ISO-8601 timestamp");
  });

  it("rejects a date-only closed-at (no time component)", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--closed-at": "2026-08-30" }))).toThrow("--closed-at must be an ISO-8601 timestamp");
  });

  it("rejects a zoneless closed-at (no Z or offset)", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--closed-at": "2026-08-30T04:00:00" }))).toThrow("--closed-at must be an ISO-8601 timestamp");
  });

  it("accepts a fractional-seconds Z-form closed-at (Railway shape)", () => {
    const args = parseTripwireArgs(baseArgv({ "--closed-at": "2026-08-30T04:00:00.123Z" }));
    expect(args.closedAt).toBe("2026-08-30T04:00:00.123Z");
  });

  it("accepts a numeric-offset closed-at", () => {
    const args = parseTripwireArgs(baseArgv({ "--closed-at": "2026-08-30T04:00:00+00:00" }));
    expect(args.closedAt).toBe("2026-08-30T04:00:00+00:00");
  });

  it("rejects a malformed project id", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--project-id": "not-a-uuid" }))).toThrow("--project-id must be a UUID");
  });

  it("rejects a malformed environment id", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--environment-id": "1234" }))).toThrow("--environment-id must be a UUID");
  });

  it("rejects a malformed service id", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--service-id": `${SERVICE_ID}x` }))).toThrow("--service-id must be a UUID");
  });

  it("rejects a whitespace-only target dir", () => {
    expect(() => parseTripwireArgs(baseArgv({ "--target-dir": "   " }))).toThrow("--target-dir must be a non-empty path");
  });

  it("throws on an unknown flag", () => {
    expect(() => parseTripwireArgs([...baseArgv(), "--bogus", "x"])).toThrow("unknown argument: --bogus");
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseTripwireArgs([...baseArgv(), "--safe-path-glob"])).toThrow("--safe-path-glob requires a value");
  });

  it("throws when a flag's value looks like another flag", () => {
    // --pr's "value" is the next flag — must be treated as missing, not consumed.
    expect(() => parseTripwireArgs(["--repo", "o/r", "--pr", "--merge-sha"])).toThrow("--pr requires a value");
  });
});
