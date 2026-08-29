import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseSkipAllowlist,
  resolveSanctionedSkips,
} from "../automerge-skip-allowlist.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** scripts/lib/__tests__/ → scripts/automerge-skip-allowlist.yaml */
const COMMITTED_FILE = join(HERE, "..", "..", "automerge-skip-allowlist.yaml");

describe("parseSkipAllowlist", () => {
  // ───── Negative controls first (Rule #322): every malformed shape THROWS ─────
  // A broken data file must be a loud failed run (Rule #464), never a silent
  // empty set that blocks every skip with a receipt misattributing the wait to CI.

  it("throws on a non-mapping top level (a bare list)", () => {
    expect(() => parseSkipAllowlist("- not-a-mapping\n")).toThrow(/top level/);
  });

  it("throws on an unknown top-level key", () => {
    expect(() => parseSkipAllowlist("repos: {}\nextra: true\n")).toThrow(/unknown top-level key/);
  });

  it("throws when `repos` is a list instead of a mapping", () => {
    expect(() => parseSkipAllowlist("repos:\n  - studio-b-ai/bolt-wms\n")).toThrow(/must be a mapping/);
  });

  it("throws on a repo key that is not org/repo", () => {
    expect(() => parseSkipAllowlist("repos:\n  bolt-wms:\n    - \"Slack Notification\"\n")).toThrow(/not org\/repo/);
  });

  it("throws when a repo's value is not a list", () => {
    expect(() => parseSkipAllowlist("repos:\n  studio-b-ai/bolt-wms: \"Slack Notification\"\n")).toThrow(/must be a list/);
  });

  it("throws on a non-string entry in a repo's list", () => {
    expect(() => parseSkipAllowlist("repos:\n  studio-b-ai/bolt-wms:\n    - 42\n")).toThrow(/non-string or empty/);
  });

  it("throws on an empty-string entry in a repo's list", () => {
    expect(() => parseSkipAllowlist('repos:\n  studio-b-ai/bolt-wms:\n    - ""\n')).toThrow(/non-string or empty/);
  });

  // ───── Positives ─────

  it("parses a well-formed document into repo → set of names", () => {
    const out = parseSkipAllowlist(
      'repos:\n  studio-b-ai/bolt-wms:\n    - "Slack Notification"\n    - "e2e / flake-detection"\n',
    );
    expect(out.get("studio-b-ai/bolt-wms")).toEqual(new Set(["Slack Notification", "e2e / flake-detection"]));
  });

  it("preserves template artifacts in names verbatim (the client-asthetik ${{ inputs.* }} shape, Rule #374)", () => {
    const name = "qualify / ui-tests-local ${{ inputs.ui_tests_local_path }} (advisory)";
    const out = parseSkipAllowlist(`repos:\n  studio-b-ai/client-asthetik:\n    - "${name}"\n`);
    expect(out.get("studio-b-ai/client-asthetik")?.has(name)).toBe(true);
  });

  it("returns an empty map for `repos: null` (an intentionally emptied file stays valid)", () => {
    expect(parseSkipAllowlist("repos:\n").size).toBe(0);
  });
});

describe("resolveSanctionedSkips", () => {
  it("resolves the EMPTY set for a repo with no row — nothing sanctioned by default (fail-closed)", () => {
    const allowlist = parseSkipAllowlist('repos:\n  studio-b-ai/bolt-wms:\n    - "Slack Notification"\n');
    expect(resolveSanctionedSkips(allowlist, "studio-b-ai/ops-pipeline").size).toBe(0);
  });

  it("resolves the repo's own set when a row exists", () => {
    const allowlist = parseSkipAllowlist('repos:\n  studio-b-ai/bolt-wms:\n    - "Slack Notification"\n');
    expect(resolveSanctionedSkips(allowlist, "studio-b-ai/bolt-wms").has("Slack Notification")).toBe(true);
  });
});

describe("committed data file", () => {
  // The deployment-shaped check: the YAML that actually ships must parse under the
  // same strict rules, so a malformed edit fails CI here before any runner throws.
  it("parses under the strict parser", () => {
    const out = parseSkipAllowlist(readFileSync(COMMITTED_FILE, "utf8"));
    expect(out.size).toBeGreaterThan(0);
    for (const repo of out.keys()) {
      expect(repo).toMatch(/^studio-b-ai\//);
    }
  });

  it("never sanctions a load-bearing deploy/qualification check (the Rule #320 class)", () => {
    const out = parseSkipAllowlist(readFileSync(COMMITTED_FILE, "utf8"));
    const forbidden = /^(deploy\b|deploy \/|build \/)/;
    for (const names of out.values()) {
      for (const name of names) {
        expect(name).not.toMatch(forbidden);
      }
    }
  });
});
