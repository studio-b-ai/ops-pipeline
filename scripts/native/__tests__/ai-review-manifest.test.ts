/**
 * go-native P1 — the pilot manifest is read exactly or not at all.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHADOW_PR_CAP, activeRepoNames, loadManifest, modeFor, parseManifest } from "../../lib/ai-review-manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ok = { repo: "studio-b-ai/toto", live: false, shadow: true };

describe("manifest.json", () => {
  it("the committed file is exactly the pilot: toto, shadow, not live", () => {
    expect(JSON.parse(readFileSync(join(HERE, "..", "manifest.json"), "utf-8"))).toEqual({ repos: [{ repo: "studio-b-ai/toto", live: false, shadow: true }] });
    expect(loadManifest(join(HERE, "..", "manifest.json")).repos).toHaveLength(1);
  });
  it("parses a valid manifest", () => {
    expect(parseManifest({ repos: [ok] })).toEqual({ repos: [ok] });
    expect(parseManifest({ repos: [] })).toEqual({ repos: [] });
  });
});

describe("a manifest that cannot be read exactly throws (known-bad controls)", () => {
  const bad: Array<[string, unknown]> = [
    ["not an object", []],
    ["null", null],
    ["extra top-level key", { repos: [ok], review_hold: [1] }],
    ["repos not an array", { repos: "studio-b-ai/toto" }],
    ["entry not an object", { repos: ["studio-b-ai/toto"] }],
    ["entry with an extra key", { repos: [{ ...ok, extra: 1 }] }],
    ["entry missing a key", { repos: [{ repo: ok.repo, live: false }] }],
    ["repo outside the org", { repos: [{ ...ok, repo: "someone/toto" }] }],
    ["repo with no name", { repos: [{ ...ok, repo: "studio-b-ai/" }] }],
    ["repo with a path escape", { repos: [{ ...ok, repo: "studio-b-ai/../x" }] }],
    ["repo with a space", { repos: [{ ...ok, repo: "studio-b-ai/to to" }] }],
    ["live as a string", { repos: [{ ...ok, live: "true" }] }],
    ["shadow as a number", { repos: [{ ...ok, shadow: 1 }] }],
    ["duplicate (case-insensitive)", { repos: [ok, { ...ok, repo: "studio-b-ai/TOTO" }] }],
  ];
  for (const [name, input] of bad) {
    it(name, () => expect(() => parseManifest(input)).toThrow(/^manifest invalid/));
  }
  it("error text names an entry index only, never entry content (ops-pipeline logs are public)", () => {
    expect(() => parseManifest({ repos: [{ ...ok, repo: "studio-b-ai/SECRET-CANARY name" }] })).toThrow(/entry 0/);
    try {
      parseManifest({ repos: [{ ...ok, repo: "studio-b-ai/SECRET-CANARY name" }] });
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET-CANARY");
    }
  });
});

describe("modes", () => {
  it("live → live; shadow → shadow; neither → off; live wins over shadow (a live repo is never capped)", () => {
    expect(modeFor({ repo: "studio-b-ai/a", live: true, shadow: false })).toBe("live");
    expect(modeFor({ repo: "studio-b-ai/a", live: false, shadow: true })).toBe("shadow");
    expect(modeFor({ repo: "studio-b-ai/a", live: false, shadow: false })).toBe("off");
    expect(modeFor({ repo: "studio-b-ai/a", live: true, shadow: true })).toBe("live");
  });
  it("the shadow cap is 3", () => expect(SHADOW_PR_CAP).toBe(3));
  it("activeRepoNames: bare names of the reviewed repos only (the workflow's `repositories:` scope)", () => {
    const m = parseManifest({ repos: [ok, { repo: "studio-b-ai/live-one", live: true, shadow: false }, { repo: "studio-b-ai/off-one", live: false, shadow: false }] });
    expect(activeRepoNames(m)).toEqual(["toto", "live-one"]);
  });
});
