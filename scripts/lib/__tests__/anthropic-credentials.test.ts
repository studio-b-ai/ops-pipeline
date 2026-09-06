import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicCredentialMode, requireAnthropicCredentials, FEDERATION_VARS } from "../anthropic-credentials.js";

function federationEnv(tokenFile: string): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
    ANTHROPIC_ORGANIZATION_ID: "00000000-0000-0000-0000-000000000000",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_test",
    ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile,
  };
}

describe("anthropicCredentialMode (WIF, 9/06)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wif-"));
  const tokenFile = join(dir, "jwt");
  writeFileSync(tokenFile, "header.payload.sig");

  it("a non-empty API key wins (SDK precedence)", () => {
    expect(anthropicCredentialMode({ ANTHROPIC_API_KEY: "sk-ant-test", ...federationEnv(tokenFile) })).toBe("api-key");
  });

  it("federation when the five variables are set and the token file exists", () => {
    expect(anthropicCredentialMode(federationEnv(tokenFile))).toBe("federation");
  });

  it("an EMPTY api key is deleted from the env so federation can win (the reusable-workflow caller that stopped passing the secret)", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "", ...federationEnv(tokenFile) };
    expect(anthropicCredentialMode(env)).toBe("federation");
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  it("federation vars without the token file on disk → none (the action did not run)", () => {
    expect(anthropicCredentialMode(federationEnv(join(dir, "missing")))).toBe("none");
  });

  it("nothing set → none; requireAnthropicCredentials names every federation variable", () => {
    expect(anthropicCredentialMode({})).toBe("none");
    expect(() => requireAnthropicCredentials({})).toThrow(/no Anthropic credentials/);
    for (const k of FEDERATION_VARS) expect(() => requireAnthropicCredentials({})).toThrow(new RegExp(k));
  });

  it("whitespace-only api key counts as empty", () => {
    expect(anthropicCredentialMode({ ANTHROPIC_API_KEY: "   " })).toBe("none");
  });
});
