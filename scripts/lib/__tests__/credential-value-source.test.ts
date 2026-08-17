import { describe, it, expect, vi } from "vitest";
import { parseValueSource, readCredentialValue } from "../credential-value-source.js";

describe("parseValueSource", () => {
  it("parses op:// references as the op scheme (the existing path)", () => {
    expect(parseValueSource("op://Studio B Infrastructure/op-sa-acuops-hub/credential")).toEqual({
      scheme: "op",
      ref: "op://Studio B Infrastructure/op-sa-acuops-hub/credential",
    });
  });

  it("parses env:<NAME> as the self-probe scheme (decision 2026-08-17 D2)", () => {
    expect(parseValueSource("env:OP_SERVICE_ACCOUNT_INFRA")).toEqual({ scheme: "env", name: "OP_SERVICE_ACCOUNT_INFRA" });
    expect(parseValueSource("  env:FOO_1 ")).toEqual({ scheme: "env", name: "FOO_1" });
  });

  it("rejects malformed env names (a flagged gap, never a silent miss)", () => {
    expect(() => parseValueSource("env:")).toThrow(/invalid env: value source/);
    expect(() => parseValueSource("env:lower_case")).toThrow(/invalid env: value source/);
    expect(() => parseValueSource("env:HAS SPACE")).toThrow(/invalid env: value source/);
    expect(() => parseValueSource("env:$(whoami)")).toThrow(/invalid env: value source/);
  });

  it("rejects unknown schemes", () => {
    expect(() => parseValueSource("vault://x/y")).toThrow(/unrecognised value source/);
    expect(() => parseValueSource("op-sa-acuops-hub")).toThrow(/unrecognised value source/);
  });
});

describe("readCredentialValue — routes to exactly ONE reader (Rule #223: the real function, spy readers)", () => {
  it("op:// → readOp with the full ref, readEnv untouched", () => {
    const readOp = vi.fn(() => "opval");
    const readEnv = vi.fn(() => "envval");
    expect(readCredentialValue("op://V/I/f", { readOp, readEnv })).toBe("opval");
    expect(readOp).toHaveBeenCalledWith("op://V/I/f");
    expect(readEnv).not.toHaveBeenCalled();
  });

  it("env:NAME → readEnv with the NAME, readOp untouched", () => {
    const readOp = vi.fn(() => "opval");
    const readEnv = vi.fn(() => "envval");
    expect(readCredentialValue("env:OP_SERVICE_ACCOUNT_INFRA", { readOp, readEnv })).toBe("envval");
    expect(readEnv).toHaveBeenCalledWith("OP_SERVICE_ACCOUNT_INFRA");
    expect(readOp).not.toHaveBeenCalled();
  });

  it("propagates the env reader's throw when the var is unset (fail loud, PROBE_FAILED upstream)", () => {
    const readOp = vi.fn(() => "opval");
    const readEnv = vi.fn(() => {
      throw new Error("Missing required env var: OP_SERVICE_ACCOUNT_INFRA");
    });
    expect(() => readCredentialValue("env:OP_SERVICE_ACCOUNT_INFRA", { readOp, readEnv })).toThrow(/Missing required env var/);
    expect(readOp).not.toHaveBeenCalled();
  });
});
