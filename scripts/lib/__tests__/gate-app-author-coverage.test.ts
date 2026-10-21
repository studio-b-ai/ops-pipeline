import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyPrDiffClass, gateDecisionForClass, isEligiblePrAuthor, type GateFile } from "../automerge-classify.js";

// Go-native Phase A, PR-A2 review finding (high): accepting the studiob-fleet-bot App as an eligible author (item 1) means a PR
// authored with ANY App token can reach the door's unattended `code-fix` merge — the App holds issues:write so it can label its own
// PR `bugsquasher`, and the gate's label leg checks presence only, never who applied it. Before this PR that path needed Kevin's
// identity. The registry's sensitive_path_patterns are what keep door machinery and credential code off that path, and they are
// tightened by PR-A1 (studio-b-ai/ops-pipeline#611: H2 credentials, H3 door machinery) — NOT by this PR. So this PR must not be able
// to merge while the registry still lets an App-authored PR change the door. This test is that tripwire, and it is deliberately RED
// against a registry without #611:
//
//   - it loads the REAL scripts/squasher-fleet.json and splits the lists exactly as squasher-automerge.yml does (comma, trimmed);
//   - it calls the REAL classifyPrDiffClass + gateDecisionForClass (Rule #223) — the production sensitive-path, safe-glob and
//     enabled-class legs — with the App as author, a green CI rollup and a CLEAN review, i.e. every leg a token holder can satisfy;
//   - the door's file list is DERIVED from source (the local-import closure of the scripts the door workflows execute), so a door
//     file added later is covered without anyone remembering to list it. That derivation is what caught scripts/lib/public-gate-log.ts
//     (added by this very PR) sitting outside #611's patterns; it now carries the protected `gate-` prefix (gate-log-enum.ts).
//   - Rule #322/#471 controls: the same instrument must say "admitted" for a row with blank patterns (what main's registry looks like
//     today) and for a plainly non-door script, or its "refused" verdicts mean nothing.

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = resolve(SCRIPTS, "..");
const APP = "app/studiob-fleet-bot";
const OPS = "studio-b-ai/ops-pipeline";
// Both labels a token holder can apply to its own PR; the worst case for every row.
const LABELS = ["bugsquasher", "fleet-internal"];

interface Row {
  repo: string;
  enabled_classes: string;
  sensitive_path_patterns?: string;
  safe_path_globs?: string;
}
const REGISTRY = (JSON.parse(readFileSync(resolve(SCRIPTS, "squasher-fleet.json"), "utf8")) as { repos: Row[] }).repos;
const rowFor = (repo: string): Row => {
  const row = REGISTRY.find((r) => r.repo === repo);
  if (!row) throw new Error(`registry has no row for ${repo}`);
  return row;
};
const splitList = (s?: string): string[] => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const blanked = (row: Row): Row => ({ ...row, sensitive_path_patterns: "" });

/** Would a PR authored by the App that changes only `path`, with a green rollup and a CLEAN review, merge with NO human key? */
function mergesUnattended(row: Row, path: string): boolean {
  const files: GateFile[] = [{ path, fileClass: "code" }];
  const cls = classifyPrDiffClass({
    files,
    totalChangedLines: 5,
    additions: 5,
    labels: LABELS,
    sensitivePathPatterns: splitList(row.sensitive_path_patterns),
    safePathGlobs: splitList(row.safe_path_globs),
  });
  if (cls.prClass === null || !splitList(row.enabled_classes).includes(cls.prClass)) return false;
  return gateDecisionForClass({ prClass: cls.prClass, author: APP, labels: LABELS, ciClean: true, reviewVerdict: "CLEAN" }).decision === "merge";
}
const offenders = (row: Row, paths: string[]): string[] => paths.filter((p) => mergesUnattended(row, p));

// Scripts the door workflows execute (squasher-automerge / restart-train / box-patch-id-labeled / post-merge-tripwire /
// squasher-fleet-sweep / automerge-sweep `run:` steps). Libraries they import are found by scanning, not listed.
const DOOR_ENTRYPOINTS = [
  "pr-automerge-gate.ts",
  "restart-train.ts",
  "box-patch-id-labeled.ts",
  "post-merge-tripwire.ts",
  "lib/native-exclusion.ts",
  "lib/fleet-sweep-changed.ts",
  "lib/fleet-sweep-order.ts",
].map((e) => resolve(SCRIPTS, e));

function localImportClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      queue.push(resolve(dirname(file), m[1]!).replace(/\.js$/, ".ts"));
    }
  }
  return [...seen].map((f) => relative(ROOT, f)).sort();
}
const DOOR_CODE = localImportClosure(DOOR_ENTRYPOINTS);

// The tests (and fixture) that pin the door's behavior and were added by PR-A2. #611's H3 protects door tests for the same reason it
// protects door code: an App-authored test-only PR must not be able to `it.skip` them.
const A2_DOOR_TESTS = [
  "gate-app-author-coverage.test.ts",
  "gate-eligible-pr-author.test.ts",
  "gate-native-exclusion.test.ts",
  "gate-native-backstop.test.ts",
  "gate-log-enum.test.ts",
  "gate-public-log.test.ts",
  "fleet-sweep-native-exclusion.test.ts",
  "automerge-sweep-native-exclusion.test.ts",
  "box-patch-id-labeled-workflow.test.ts",
  "fixtures/gate-gh-stub.ts",
].map((t) => `scripts/lib/__tests__/${t}`);

// Credential-bearing paths per repo, one inside each row's safe_path_globs. These are the rows #611's H2 hardens; radio already
// protects credential names on main, so it is a control that must be green both before and after #611.
const CREDENTIAL_PATHS: Array<[repo: string, path: string]> = [
  ["studio-b-ai/bolt-wms", "src/services/credential-store.ts"],
  ["studio-b-ai/studiob", "packages/api/src/lib/token-vault.ts"],
  ["studio-b-ai/radio", "src/lib/secret-loader.ts"],
  ["studio-b-ai/claude-hooks", "credential-guard.py"],
  ["studio-b-ai/toto", "src-tauri/capabilities/default.json"],
];

const BLOCKED_BY = "an App-authored PR could merge unattended into this — studio-b-ai/ops-pipeline#611 (PR-A1: H2 credentials, H3 door machinery) must be merged to main first";

describe("App author × door registry — the premise", () => {
  it("the App is an eligible PR author (if this fails the guard below is obsolete — delete it deliberately, do not skip it)", () => {
    expect(isEligiblePrAuthor(APP)).toBe(true);
  });

  it("the derived door file list has reach: it contains the gate, the classifier, the exclusion and the log wrapper, and every A2 door test exists", () => {
    for (const must of [
      "scripts/pr-automerge-gate.ts",
      "scripts/lib/automerge-classify.ts",
      "scripts/lib/native-exclusion.ts",
      "scripts/lib/gate-log-enum.ts",
      "scripts/lib/label-authority.ts",
      "scripts/restart-train.ts",
    ]) {
      expect(DOOR_CODE, `${must} missing from the derived door closure`).toContain(must);
    }
    expect(DOOR_CODE.length).toBeGreaterThan(15);
    for (const t of A2_DOOR_TESTS) expect(existsSync(resolve(ROOT, t)), `${t} does not exist`).toBe(true);
  });
});

describe("App author × door registry — the instrument can say yes (Rule #322/#471 controls)", () => {
  it("KNOWN-BAD: a registry row with no sensitive patterns (main's ops-pipeline row today lacks the door files) ADMITS an App-authored change to the gate itself", () => {
    expect(mergesUnattended(blanked(rowFor(OPS)), "scripts/pr-automerge-gate.ts")).toBe(true);
    expect(offenders(blanked(rowFor(OPS)), DOOR_CODE)).toContain("scripts/pr-automerge-gate.ts");
    expect(offenders(blanked(rowFor(OPS)), DOOR_CODE)).toContain("scripts/lib/gate-log-enum.ts");
  });

  it("KNOWN-BAD: a registry row with no credential patterns admits an App-authored change to credential code, in every row the guard checks", () => {
    for (const [repo, path] of CREDENTIAL_PATHS) {
      expect(mergesUnattended(blanked(rowFor(repo)), path), `${repo} ${path} is not inside the row's safe globs, so the guard below would prove nothing`).toBe(true);
    }
  });

  it("KNOWN-GOOD: a non-door script (drift-check) is NOT in the derived door closure and IS still admitted on the real ops-pipeline row", () => {
    expect(DOOR_CODE).not.toContain("scripts/drift-check.ts");
    expect(mergesUnattended(rowFor(OPS), "scripts/drift-check.ts")).toBe(true);
  });

  it("an author outside the eligible list never merges, whatever the registry says (the guard is about the App, not about everyone)", () => {
    const decision = gateDecisionForClass({ prClass: "code-fix", author: "app/some-other-app", labels: LABELS, ciClean: true, reviewVerdict: "CLEAN" });
    expect(decision.decision).toBe("wait");
  });
});

describe("App author × door registry — THE GUARD: the real registry refuses an App-authored PR on door machinery and credential code", () => {
  it("every file the door executes is refused on the real ops-pipeline row", () => {
    const bad = offenders(rowFor(OPS), DOOR_CODE);
    expect(bad, `${BLOCKED_BY}\n  admitted door files:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("every door test and fixture added by PR-A2 is refused on the real ops-pipeline row", () => {
    const bad = offenders(rowFor(OPS), A2_DOOR_TESTS);
    expect(bad, `${BLOCKED_BY}\n  admitted door tests:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it.each(CREDENTIAL_PATHS)("%s refuses credential-bearing path %s", (repo, path) => {
    expect(mergesUnattended(rowFor(repo), path), `${repo} ${path}: ${BLOCKED_BY}`).toBe(false);
  });
});
