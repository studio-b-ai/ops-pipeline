import { describe, expect, it } from "vitest";
import { NATIVE_RULESET_NAME } from "../native-exclusion.js";
import { type GhStubRule } from "./fixtures/gate-gh-stub.js";
import { prListCalls, runSweep, writeCalls } from "./fixtures/gate-fleet-sweep-harness.js";

// Go-native Phase A, PR-A2 item 2 — the WIRING half, on the real thing (#223): this test runs the `run:` script of the
// "List target (repo, PR, mode) entries" step straight out of .github/workflows/squasher-fleet-sweep.yml in bash, exactly as Actions does
// (`bash --noprofile --norc -e -o pipefail`), with the REAL native-exclusion CLI + fleet-sweep-changed + fleet-sweep-order under tsx,
// against a fake `gh` that answers GitHub (the harness: fixtures/gate-fleet-sweep-harness.ts). The only edit to the script is /tmp/ → a
// per-test dir.
// Both directions (#322/#471): a native repo is skipped with no PR read and no write; a non-native repo is NOT (same instrument,
// positive control); an unreadable ruleset list excludes (fail closed); the org-wide leg skips a native repo and keeps the rest.

const nativeRow = { id: 4242, name: NATIVE_RULESET_NAME, target: "branch", enforcement: "active", source_type: "Repository" };
const nativeDetail = { ...nativeRow, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } };
const rulesetsRule = (repo: string, out: string | null): GhStubRule => ({
  match: new RegExp(`^api repos/${repo}/rulesets\\?per_page=100$`),
  ...(out === null ? { fail: true } : { out }),
});
const NATIVE_RADIO: GhStubRule[] = [
  rulesetsRule("studio-b-ai/radio", JSON.stringify([nativeRow])),
  { match: /^api repos\/studio-b-ai\/radio\/rulesets\/4242$/, out: JSON.stringify(nativeDetail) },
];
const EVERY_OTHER_REPO_PLAIN: GhStubRule = { match: /^api repos\/[^/ ]+\/[^/ ]+\/rulesets\?per_page=100$/, out: "[]" };
const NO_LABELED_PRS: GhStubRule[] = [
  { match: /^pr list --repo /, out: "[]" },
  { match: /^api -X GET search\/issues/, out: "[]" },
];

describe("squasher-fleet-sweep.yml `list` step — native exclusion (registry leg), run for real", () => {
  it("dispatch ONLY_REPO=<native registered repo> logs exactly `excluded: native <repo>`, makes NO PR read and NO write, evaluates nothing", () => {
    const r = runSweep({ ONLY_REPO: "studio-b-ai/radio" }, [...NATIVE_RADIO, ...NO_LABELED_PRS]);
    expect(r.status).toBe(0);
    expect(r.log.split("\n")).toContain("excluded: native studio-b-ai/radio");
    expect(prListCalls(r.calls)).toEqual([]); // not one `gh pr list` against the native repo
    expect(writeCalls(r.calls)).toEqual([]);
    expect(r.log).not.toContain("studio-b-ai/radio: bugsquasher+fleet-internal="); // the normal count line is NOT printed
    expect(r.entries).toEqual([]);
  });

  it("POSITIVE CONTROL (same instrument): ONLY_REPO=<non-native registered repo> prints its normal count line and DOES read its PRs", () => {
    const r = runSweep({ ONLY_REPO: "studio-b-ai/radio" }, [EVERY_OTHER_REPO_PLAIN, ...NO_LABELED_PRS]);
    expect(r.status).toBe(0);
    expect(r.log).toContain("studio-b-ai/radio: bugsquasher+fleet-internal=0 box=0");
    expect(r.log).not.toContain("excluded:");
    expect(prListCalls(r.calls).length).toBeGreaterThanOrEqual(2);
  });

  it("FAIL CLOSED: an unreadable ruleset list excludes the repo and says so — it does NOT fall through to the door", () => {
    const r = runSweep({ ONLY_REPO: "studio-b-ai/radio" }, [rulesetsRule("studio-b-ai/radio", null), ...NO_LABELED_PRS]);
    expect(r.status).toBe(0);
    expect(r.log.split("\n")).toContain("excluded: native-check-failed studio-b-ai/radio (fail-closed: ruleset read failed)");
    expect(prListCalls(r.calls)).toEqual([]);
    expect(r.entries).toEqual([]);
  });

  it("an unregistered native repo with no labeled PR still logs the exclusion on dispatch (ONLY_REPO is always scanned)", () => {
    const r = runSweep({ ONLY_REPO: "studio-b-ai/brand-new" }, [
      rulesetsRule("studio-b-ai/brand-new", JSON.stringify([nativeRow])),
      { match: /^api repos\/studio-b-ai\/brand-new\/rulesets\/4242$/, out: JSON.stringify(nativeDetail) },
      ...NO_LABELED_PRS,
    ]);
    expect(r.status).toBe(0);
    expect(r.log.split("\n")).toContain("excluded: native studio-b-ai/brand-new");
  });

  it("scheduled shape (no ONLY_REPO): only the native repo is skipped; every other registry repo is still enumerated", () => {
    const r = runSweep({}, [...NATIVE_RADIO, EVERY_OTHER_REPO_PLAIN, ...NO_LABELED_PRS]);
    expect(r.status).toBe(0);
    expect(r.log.split("\n").filter((l) => l.startsWith("excluded:"))).toEqual(["excluded: native studio-b-ai/radio"]);
    expect(r.log).toContain("studio-b-ai/bolt-wms: bugsquasher+fleet-internal=0 box=0");
    expect(r.log).not.toContain("studio-b-ai/radio: bugsquasher+fleet-internal=");
    expect(prListCalls(r.calls).some((c) => c.includes("--repo studio-b-ai/radio "))).toBe(false);
    expect(prListCalls(r.calls).some((c) => c.includes("--repo studio-b-ai/bolt-wms "))).toBe(true);
  });

  it("the scan ITSELF breaking (the CLI cannot start) aborts the sweep non-zero — an empty answer never reads as 'nothing is native'", () => {
    // NODE_OPTIONS makes every `node`/`tsx` start fail before any code runs; jq/bash/gh are untouched
    const r = runSweep({ ONLY_REPO: "studio-b-ai/radio", NODE_OPTIONS: "--require=/nonexistent/boom.cjs" }, [EVERY_OTHER_REPO_PLAIN, ...NO_LABELED_PRS]);
    expect(r.status).not.toBe(0);
    expect(r.log).toContain("native-exclusion scan failed — refusing to sweep");
    expect(prListCalls(r.calls)).toEqual([]);
    expect(r.entries).toBeNull();
  });
});

describe("squasher-fleet-sweep.yml `list` step — native exclusion (org-wide box leg), run for real", () => {
  const AMPLIFY_PR = JSON.stringify({ headRefOid: "a".repeat(40), statusCheckRollup: [], labels: [{ name: "box" }], mergeStateStatus: "CLEAN", isDraft: false });
  const ORG_SEARCH: GhStubRule = {
    match: /^api -X GET search\/issues -f q=org:studio-b-ai is:pr is:open label:box/,
    out: JSON.stringify([
      { repo: "studio-b-ai/amplify", n: 5 },
      { repo: "studio-b-ai/native-thing", n: 9 },
    ]),
  };
  const NATIVE_THING: GhStubRule[] = [
    rulesetsRule("studio-b-ai/native-thing", JSON.stringify([nativeRow])),
    { match: /^api repos\/studio-b-ai\/native-thing\/rulesets\/4242$/, out: JSON.stringify(nativeDetail) },
  ];

  it("a native repo outside the registry is dropped from the org-wide leg; a non-native one is kept (and evaluated)", () => {
    const r = runSweep({}, [
      ...NATIVE_THING,
      EVERY_OTHER_REPO_PLAIN,
      ORG_SEARCH,
      { match: /^pr view 5 --repo studio-b-ai\/amplify /, out: AMPLIFY_PR },
      ...NO_LABELED_PRS,
    ]);
    expect(r.status).toBe(0);
    expect(r.log.split("\n")).toContain("excluded: native studio-b-ai/native-thing");
    expect(r.log).toContain("org-wide box (repos outside the registry): 1 — studio-b-ai/amplify#5");
    expect(r.log).not.toContain("native-thing#9");
    expect(r.entries?.map((e) => `${e.repo}#${e.pr_number}`)).toEqual(["studio-b-ai/amplify#5"]);
    expect(r.calls.some((c) => c.includes("--repo studio-b-ai/native-thing"))).toBe(false); // never even fingerprinted
  });

  it("each repo is read ONCE per run: a repo already scanned on the registry leg costs no second ruleset GET", () => {
    const r = runSweep({}, [EVERY_OTHER_REPO_PLAIN, ORG_SEARCH, { match: /^pr view /, out: AMPLIFY_PR }, ...NO_LABELED_PRS]);
    expect(r.status).toBe(0);
    const rulesetGets = r.calls.filter((c) => /^api repos\/[^/ ]+\/[^/ ]+\/rulesets\?per_page=100$/.test(c));
    expect(new Set(rulesetGets).size).toBe(rulesetGets.length); // no duplicates
    expect(rulesetGets).toContain("api repos/studio-b-ai/amplify/rulesets?per_page=100");
  });
});
