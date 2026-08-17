/**
 * credential-value-source.ts — where a manifest item's VALUE comes from (Rule #302 monitor).
 *
 * Two schemes, parsed here so the monitor script never branches on string prefixes inline:
 *
 *   op://<vault>/<item>/<field>   → read via the monitor's own read-only Infra-vault Service
 *                                   Account (`op read`, token = OP_SERVICE_ACCOUNT_INFRA)
 *   env:<VAR_NAME>                → read straight from the monitor's own process env — the
 *                                   SELF-PROBE scheme (decision 2026-08-17, credential lifecycle
 *                                   with no Kevin touch, D2): the `credential-monitor` SA is the
 *                                   token the monitor itself runs on; it has no 1P item to `op read`
 *                                   (an SA cannot read its own credential out of a vault it only
 *                                   has read access to via that same token), so its aliveness
 *                                   probe uses the env value directly. Nothing about the value is
 *                                   ever logged; only the scheme + the env NAME are.
 *
 * Pure: no I/O. The caller supplies the readers so this stays unit-testable (Rule #223 — tests
 * call THIS function with spy readers and assert which reader was invoked with what).
 */

export type ValueSource =
  | { scheme: "op"; ref: string }
  | { scheme: "env"; name: string };

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Parse a manifest `op_ref` into its scheme. Throws on an unrecognised shape (a flagged gap, never a silent miss). */
export function parseValueSource(opRef: string): ValueSource {
  const ref = opRef.trim();
  if (ref.startsWith("op://")) return { scheme: "op", ref };
  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length).trim();
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid env: value source \`${ref}\` — expected env:<UPPER_SNAKE_NAME>`);
    return { scheme: "env", name };
  }
  throw new Error(`unrecognised value source \`${ref}\` — expected op://… or env:<VAR_NAME>`);
}

export interface ValueReaders {
  /** `op read <ref>` under the monitor's SA — the existing path. */
  readOp: (ref: string) => string;
  /** `process.env[name]` (throwing when unset) — the self-probe path. */
  readEnv: (name: string) => string;
}

/** Resolve a manifest `op_ref` to its value through the matching reader. */
export function readCredentialValue(opRef: string, readers: ValueReaders): string {
  const src = parseValueSource(opRef);
  return src.scheme === "op" ? readers.readOp(src.ref) : readers.readEnv(src.name);
}
