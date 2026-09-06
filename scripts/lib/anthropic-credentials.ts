/**
 * Anthropic credential resolution for the pipeline scripts (Kevin 9/06: Workload Identity
 * Federation for GitHub Actions — canon brain
 * library/decisions/2026-09-06-claude-models-in-opencode-through-the-door.md § Identity).
 *
 * Two modes, in the SDK's own precedence order:
 *   - "api-key"    — a NON-EMPTY `ANTHROPIC_API_KEY` (the legacy static key; wins when present).
 *   - "federation" — the five federation variables the `anthropic-federated-token` composite
 *                    action exports; `new Anthropic()` exchanges the identity token itself.
 *   - "none"       — neither. Callers decide whether that is fatal (the probe) or a graceful
 *                    skip (the shipped ledger).
 *
 * The one non-obvious rule: a reusable workflow whose caller stopped passing the secret sees
 * `ANTHROPIC_API_KEY=""` — set but EMPTY — and the SDK treats an empty string as a key and 401s.
 * `anthropicCredentialMode()` deletes an empty key from the environment so federation can win.
 */
import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";

export type AnthropicCredentialMode = "api-key" | "federation" | "none";

export const FEDERATION_VARS = [
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
] as const;

export function anthropicCredentialMode(env: NodeJS.ProcessEnv = process.env): AnthropicCredentialMode {
  if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY.trim() === "") {
    delete env.ANTHROPIC_API_KEY; // an empty key would shadow federation and 401
  }
  if (env.ANTHROPIC_API_KEY) return "api-key";
  const federated = FEDERATION_VARS.every((k) => Boolean(env[k] && env[k]!.trim()));
  if (federated && existsSync(env.ANTHROPIC_IDENTITY_TOKEN_FILE!)) return "federation";
  return "none";
}

/** Throw when no credential is present; log which mode won (never a value). */
export function requireAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): AnthropicCredentialMode {
  const mode = anthropicCredentialMode(env);
  if (mode === "none") {
    throw new Error(
      "no Anthropic credentials: set a non-empty ANTHROPIC_API_KEY or run the anthropic-federated-token action (permissions: id-token: write) so " +
        FEDERATION_VARS.join(", ") +
        " are present",
    );
  }
  console.log(`anthropic credentials: ${mode}${mode === "federation" ? ` (rule ${env.ANTHROPIC_FEDERATION_RULE_ID})` : ""}`);
  return mode;
}

/** A client in whichever mode is present; throws in "none". */
export function anthropicClient(env: NodeJS.ProcessEnv = process.env): Anthropic {
  requireAnthropicCredentials(env);
  return new Anthropic();
}
