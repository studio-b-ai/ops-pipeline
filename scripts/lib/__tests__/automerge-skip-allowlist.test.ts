import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseSkipAllowlist,
  resolveSanctionedSkips,
  parseFullSkipAllowlist,
  resolveTrainSanctionedSkips,
  loadSanctionedSkips,
  loadTrainSanctionedSkips,
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

  it("accepts `train_repos` as a known top-level key (does not throw) but does not include it in the returned map — squasher path stays repos:-only", () => {
    const out = parseSkipAllowlist(
      'repos:\n  studio-b-ai/bolt-wms:\n    - "Slack Notification"\ntrain_repos:\n  studio-b-ai/client-asthetik:\n    - "deploy"\n',
    );
    expect(out.get("studio-b-ai/bolt-wms")).toEqual(new Set(["Slack Notification"]));
    expect(out.get("studio-b-ai/client-asthetik")).toBeUndefined();
  });
});

describe("parseFullSkipAllowlist / resolveTrainSanctionedSkips (train path)", () => {
  // Same negative-control discipline as parseSkipAllowlist, applied to train_repos:.

  it("throws when `train_repos` is a list instead of a mapping", () => {
    expect(() => parseFullSkipAllowlist("repos: {}\ntrain_repos:\n  - studio-b-ai/client-asthetik\n")).toThrow(
      /must be a mapping/,
    );
  });

  it("throws on a non-string entry in a train_repos list", () => {
    expect(() =>
      parseFullSkipAllowlist("repos: {}\ntrain_repos:\n  studio-b-ai/client-asthetik:\n    - 42\n"),
    ).toThrow(/non-string or empty/);
  });

  it("resolves the UNION of repos: and train_repos: for a repo present in both", () => {
    const allowlist = parseFullSkipAllowlist(
      'repos:\n  studio-b-ai/client-asthetik:\n    - "Auto-qualifier (shadow)"\ntrain_repos:\n  studio-b-ai/client-asthetik:\n    - "deploy"\n    - "build / build-bin"\n',
    );
    const resolved = resolveTrainSanctionedSkips(allowlist, "studio-b-ai/client-asthetik");
    expect(resolved).toEqual(new Set(["Auto-qualifier (shadow)", "deploy", "build / build-bin"]));
  });

  it("a repo absent from train_repos: resolves to exactly its repos: set (train_repos is additive, never required)", () => {
    const allowlist = parseFullSkipAllowlist(
      'repos:\n  studio-b-ai/bolt-wms:\n    - "Slack Notification"\ntrain_repos:\n  studio-b-ai/client-asthetik:\n    - "deploy"\n',
    );
    expect(resolveTrainSanctionedSkips(allowlist, "studio-b-ai/bolt-wms")).toEqual(
      resolveSanctionedSkips(allowlist.repos, "studio-b-ai/bolt-wms"),
    );
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
  it("parses under the strict parser (repos:)", () => {
    const out = parseSkipAllowlist(readFileSync(COMMITTED_FILE, "utf8"));
    expect(out.size).toBeGreaterThan(0);
    for (const repo of out.keys()) {
      expect(repo).toMatch(/^studio-b-ai\//);
    }
  });

  it("also parses under the strict train-path parser (repos: + train_repos:)", () => {
    const allowlist = parseFullSkipAllowlist(readFileSync(COMMITTED_FILE, "utf8"));
    expect(allowlist.trainRepos.size).toBeGreaterThan(0);
    for (const repo of allowlist.trainRepos.keys()) {
      expect(repo).toMatch(/^studio-b-ai\//);
    }
  });

  it("never sanctions a load-bearing deploy/qualification check under repos: (the Rule #320 class — squasher scope only)", () => {
    const out = parseSkipAllowlist(readFileSync(COMMITTED_FILE, "utf8"));
    const forbidden = /^(deploy\b|deploy \/|build \/)/;
    for (const names of out.values()) {
      for (const name of names) {
        expect(name).not.toMatch(forbidden);
      }
    }
  });

  it("DOES allow the deploy/build-prefixed names under train_repos: for client-asthetik (the train-only exemption)", () => {
    const allowlist = parseFullSkipAllowlist(readFileSync(COMMITTED_FILE, "utf8"));
    const trainSkips = allowlist.trainRepos.get("studio-b-ai/client-asthetik") ?? new Set<string>();
    expect(trainSkips.has("deploy")).toBe(true);
    expect(trainSkips.has("build / build-bin")).toBe(true);
  });

  it("loadTrainSanctionedSkips returns the UNION for client-asthetik, including deploy and build / build-bin", () => {
    const resolved = loadTrainSanctionedSkips("studio-b-ai/client-asthetik");
    expect(resolved.has("deploy")).toBe(true);
    expect(resolved.has("build / build-bin")).toBe(true);
    // union half: still carries at least one repos:-only name
    expect(resolved.has("Auto-qualifier (shadow)")).toBe(true);
  });

  it("NEGATIVE CONTROL: loadSanctionedSkips (squasher path) still excludes deploy and every build / name for client-asthetik", () => {
    const resolved = loadSanctionedSkips("studio-b-ai/client-asthetik");
    expect(resolved.has("deploy")).toBe(false);
    for (const name of resolved) {
      expect(name).not.toMatch(/^build \//);
    }
  });

  // ───── studio-b#112, 2026-09-13: radio's three by-design PR-event skips ─────
  // Born from a live defect, not a hypothetical: the 19:17Z sweep refused
  // radio#1008 at leg=ci-rollup with ciClean=false while GitHub's own
  // mergeStateStatus said CLEAN. Cause: ops#405 flipped radio onto the release
  // leg without giving it a sanction set, so these three notification jobs —
  // structurally unable to run on a pull_request event (radio origin/main
  // ci.yml `if:` conditions pin them to refs/heads/main push) — made radio's
  // CI leg permanently inert. Guards the regression in BOTH directions per
  // Rule #322.
  it("sanctions radio's three by-design PR-event notification skips (studio-b#112)", () => {
    const resolved = loadSanctionedSkips("studio-b-ai/radio");
    expect(resolved.has("Post-Deploy Smoke")).toBe(true);
    expect(resolved.has("Slack Alert on Failure")).toBe(true);
    expect(resolved.has("Slack Recovery Notice")).toBe(true);
  });

  it("NEGATIVE CONTROL: radio's sanction set never grows past those three — no real gate is sanctioned", () => {
    const resolved = loadSanctionedSkips("studio-b-ai/radio");
    expect([...resolved].sort()).toEqual([
      "Post-Deploy Smoke",
      "Slack Alert on Failure",
      "Slack Recovery Notice",
    ]);
    // radio's real gates stay required — naming them explicitly so a future
    // widening of this entry fails loudly here rather than in a live sweep.
    for (const gate of [
      "Build & Check",
      "Cross-System QA / API Tests (Vitest)",
      "gitleaks / Secret scan (gitleaks, Rule 363)",
      "boundary-check",
    ]) {
      expect(resolved.has(gate)).toBe(false);
    }
  });

  it("radio's entry carries the three sanctioned skips (Post-Deploy Smoke, Slack Alert on Failure, Slack Recovery Notice)", () => {
    const radio = [...loadSanctionedSkips("studio-b-ai/radio")].sort();
    expect(radio).toEqual(["Post-Deploy Smoke", "Slack Alert on Failure", "Slack Recovery Notice"]);
  });

  // ───── crew stint #861, 2026-09-23: amplify's one by-design PR-event skip ─────
  // Born from a live defect, not a hypothetical: the 2026-09-22 23:24Z sweep
  // (run 35796899573) refused amplify#69 — Kevin's `box`, mergeStateStatus
  // CLEAN — at the ci-rollup floor with ciClean=false because amplify had no
  // sanction row while its rollup carries "Slack Notification" (SKIPPED) on
  // every PR. Structurally unable to run on a pull_request event: amplify
  // origin/main ci.yml's notify-failure job is `if: failure() &&
  // github.ref == 'refs/heads/main'` (Rule #466). Guards the regression in
  // BOTH directions per Rule #322.
  it("sanctions amplify's by-design PR-event notification skip (stint #861)", () => {
    const resolved = loadSanctionedSkips("studio-b-ai/amplify");
    expect(resolved.has("Slack Notification")).toBe(true);
  });

  it("NEGATIVE CONTROL: amplify's sanction set never grows past the one notify job — no real gate is sanctioned", () => {
    const resolved = loadSanctionedSkips("studio-b-ai/amplify");
    expect([...resolved]).toEqual(["Slack Notification"]);
    // amplify's real gates stay unsanctioned — naming them explicitly so a
    // future widening of this entry fails loudly here rather than in a live sweep.
    for (const gate of [
      "Build + Test (amplify-engine)",
      "Build + Test (amplify-workers)",
      "Deprecated-API lint",
      "Cross-workspace dep build coverage",
      "Lint script unit tests",
      "gitleaks / Secret scan (gitleaks, Rule 363)",
    ]) {
      expect(resolved.has(gate)).toBe(false);
    }
  });

  it("NEGATIVE CONTROL: lightsout stays unsanctioned — a repo with zero CI must keep failing closed", () => {
    // ops#405 flipped lightsout on too, but its refusal is CORRECT and is NOT
    // this change's business: it has no .github/workflows at all (GitHub API
    // 404 at 19:5xZ), so isRollupClean's empty-rollup guard refuses it. Adding
    // skips could never help a repo with no checks, and sanctioning anything
    // here would be vacuous-pass territory.
    expect([...loadSanctionedSkips("studio-b-ai/lightsout")]).toEqual([]);
  });
});
