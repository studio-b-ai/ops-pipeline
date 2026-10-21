import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_RULESET_NAME,
  detectNative,
  exclusionLogLine,
  reposForDoor,
  runCli,
  scanNative,
  targetsDefaultBranch,
  type NativeCache,
  type RulesetReader,
} from "../native-exclusion.js";
import { makeGhStub } from "./fixtures/gh-stub.js";

// Go-native Phase A, PR-A2 item 2 — detection half. Rule #223: every case calls the REAL detectNative / scanNative / runCli (and,
// for the process cases, the REAL CLI file under a fake `gh`). Rule #322/#471: known-good (a native repo is excluded) AND
// known-bad (every look-alike ruleset leaves the repo with the door) AND the fail-closed direction (a read error excludes).
//
// Fixture shapes are the REAL ones, probed read-only on studio-b-ai/chassis: the list endpoint returns summary rows with NO
// `conditions`/`rules`; the detail endpoint adds `conditions.ref_name.{include,exclude}`.

const row = (over: Record<string, unknown> = {}) => ({
  id: 111,
  name: NATIVE_RULESET_NAME,
  target: "branch",
  source_type: "Repository",
  source: "studio-b-ai/toto",
  enforcement: "active",
  node_id: "RRS_lACqUmVwb3NpdG9yec5J7LhBzgFmFDE",
  _links: { self: { href: "https://api.github.com/repos/studio-b-ai/toto/rulesets/111" } },
  created_at: "2026-01-15T08:00:00.000-04:00",
  updated_at: "2026-01-15T08:00:00.000-04:00",
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...row(),
  bypass_actors: [],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  current_user_can_bypass: "never",
  ...over,
});
/** the one live ruleset in the org when this was written (chassis) — a real known-bad: a ruleset that is NOT the native one */
const CHASSIS_ROW = row({ id: 23467057, name: "main — pull request required; automation bypass declared", source: "studio-b-ai/chassis" });

function api(map: Record<string, unknown>): { read: RulesetReader; calls: string[] } {
  const calls: string[] = [];
  const read: RulesetReader = (path) => {
    calls.push(path);
    if (!(path in map)) throw new Error(`HTTP 404 ${path}`);
    const v = map[path];
    if (v instanceof Error) throw v;
    return v;
  };
  return { read, calls };
}
const LIST = (repo: string) => `repos/${repo}/rulesets?per_page=100`;
const DETAIL = (repo: string, id: number) => `repos/${repo}/rulesets/${id}`;

describe("detectNative — known-good: an active native ruleset on the default branch", () => {
  it("native", () => {
    const { read, calls } = api({ [LIST("studio-b-ai/toto")]: [row()], [DETAIL("studio-b-ai/toto", 111)]: detail() });
    expect(detectNative("studio-b-ai/toto", read)).toBe("native");
    expect(calls).toEqual([LIST("studio-b-ai/toto"), DETAIL("studio-b-ai/toto", 111)]); // list, then the one matching row's detail
  });
  it("native when the default-branch condition is spelled ~ALL or refs/heads/main", () => {
    for (const include of [["~ALL"], ["refs/heads/main"]]) {
      const { read } = api({ [LIST("o/r")]: [row()], [DETAIL("o/r", 111)]: detail({ conditions: { ref_name: { include, exclude: [] } } }) });
      expect(detectNative("o/r", read)).toBe("native");
    }
  });
  it("native among other rulesets (the live chassis row beside it is ignored)", () => {
    const { read } = api({ [LIST("o/r")]: [CHASSIS_ROW, row({ id: 7 })], [DETAIL("o/r", 7)]: detail({ id: 7 }) });
    expect(detectNative("o/r", read)).toBe("native");
  });
});

describe("detectNative — known-bad: every look-alike leaves the repo with the door (not-native)", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
    ["no rulesets at all", {}],
    ["only the live chassis ruleset (a real, non-native name)", { name: CHASSIS_ROW.name }],
    ["name differs by case", { name: "Main - native merge v1" }],
    ["name has a trailing space", { name: `${NATIVE_RULESET_NAME} ` }],
    ["name is v2", { name: "main - native merge v2" }],
    ["enforcement disabled (break-glass)", { enforcement: "disabled" }],
    ["enforcement evaluate", { enforcement: "evaluate" }],
    ["target tag, not branch", { target: "tag" }],
    ["detail says disabled although the list row said active (race)", {}, { enforcement: "disabled" }],
    ["ruleset targets only release/*", {}, { conditions: { ref_name: { include: ["refs/heads/release/*"], exclude: [] } } }],
    ["ruleset includes the default branch but excludes it too", {}, { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["~DEFAULT_BRANCH"] } } }],
    ["detail has no conditions", {}, { conditions: undefined }],
  ];
  it.each(cases)("%s", (_n, rowOver, detailOver) => {
    const rows = _n === "no rulesets at all" ? [] : [row(rowOver)];
    const { read } = api({ [LIST("o/r")]: rows, [DETAIL("o/r", 111)]: detail(detailOver ?? {}) });
    expect(detectNative("o/r", read)).toBe("not-native");
  });
  it("a non-native repo costs exactly ONE GET (no detail read for a row that does not match the name)", () => {
    const { read, calls } = api({ [LIST("o/r")]: [CHASSIS_ROW] });
    expect(detectNative("o/r", read)).toBe("not-native");
    expect(calls).toEqual([LIST("o/r")]);
  });
});

describe("detectNative — FAIL CLOSED: anything unprovable is excluded", () => {
  it("list read throws → error", () => {
    expect(detectNative("o/r", api({ [LIST("o/r")]: new Error("HTTP 403") }).read)).toBe("error");
  });
  it("list endpoint missing (unmapped) → error", () => {
    expect(detectNative("o/r", api({}).read)).toBe("error");
  });
  it("detail read throws on a matching row → error (never 'not-native' by default)", () => {
    expect(detectNative("o/r", api({ [LIST("o/r")]: [row()], [DETAIL("o/r", 111)]: new Error("HTTP 502") }).read)).toBe("error");
  });
  it.each([["an object", { message: "Not Found" }], ["null", null], ["a string", "oops"]])("list body is %s → error", (_n, body) => {
    expect(detectNative("o/r", api({ [LIST("o/r")]: body }).read)).toBe("error");
  });
  it("a full page (>=100 rows) cannot be proven complete → error", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row({ id: i + 1, name: `r${i}` }));
    expect(detectNative("o/r", api({ [LIST("o/r")]: rows }).read)).toBe("error");
  });
  it.each(["", "toto", "a/b/c", "o/r?x=1", "../orgs/x", "o/r\n::error::x", "o /r"])("invalid repo name %j → error, and NO GET is made", (repo) => {
    const { read, calls } = api({});
    expect(detectNative(repo, read)).toBe("error");
    expect(calls).toEqual([]);
  });
});

describe("targetsDefaultBranch — pure", () => {
  it.each([
    [{ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } }, true],
    [{ conditions: { ref_name: { include: ["refs/heads/dev", "~DEFAULT_BRANCH"] } } }, true],
    [{ conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } } }, false],
    [{ conditions: { ref_name: { include: "~DEFAULT_BRANCH" } } }, false],
    [{ conditions: {} }, false],
    [{}, false],
    [null, false],
    [undefined, false],
  ])("%j → %s", (d, want) => expect(targetsDefaultBranch(d)).toBe(want));
});

describe("scanNative — per-run cache, fixed log lines", () => {
  it("returns excluded repos in input order and logs exactly `excluded: native <repo>` once", () => {
    const { read } = api({
      [LIST("o/native")]: [row()],
      [DETAIL("o/native", 111)]: detail(),
      [LIST("o/plain")]: [],
      [LIST("o/broken")]: new Error("HTTP 500"),
    });
    const r = scanNative(["o/native", "o/plain", "o/broken", "o/native"], read);
    expect(r.excluded).toEqual(["o/native", "o/broken"]); // duplicate input collapsed; plain is NOT excluded
    expect(r.log).toEqual(["excluded: native o/native", "excluded: native-check-failed o/broken (fail-closed: ruleset read failed)"]);
  });
  it("cache: a second scan in the same run makes ZERO new GETs, still excludes, and does not log twice", () => {
    const { read, calls } = api({ [LIST("o/native")]: [row()], [DETAIL("o/native", 111)]: detail(), [LIST("o/plain")]: [] });
    const cache: NativeCache = new Map();
    scanNative(["o/native", "o/plain"], read, cache);
    const before = calls.length;
    const again = scanNative(["o/native", "o/plain"], read, cache);
    expect(calls.length).toBe(before);
    expect(again.excluded).toEqual(["o/native"]);
    expect(again.log).toEqual([]);
  });
  it("an invalid repo name is never echoed into the log (workflow-command injection guard)", () => {
    const evil = "o/r\n::set-output name=x::y";
    const r = scanNative([evil], api({}).read);
    expect(r.excluded).toEqual([evil]);
    expect(r.log).toEqual(["excluded: native-check-failed <invalid-repo-name> (fail-closed: ruleset read failed)"]);
    expect(r.log.join("\n")).not.toContain("::set-output");
  });
  it("exclusionLogLine: not-native has no line", () => expect(exclusionLogLine("o/r", "not-native")).toBeNull());
});

describe("reposForDoor — what the restart train iterates", () => {
  it("drops the native repo (and a repo whose check failed), keeps the plain one, and says why", () => {
    const { read } = api({
      [LIST("o/native")]: [row()],
      [DETAIL("o/native", 111)]: detail(),
      [LIST("o/plain")]: [],
      [LIST("o/broken")]: new Error("HTTP 500"),
    });
    const r = reposForDoor(["o/native", "o/plain", "o/broken"] as const, read);
    expect(r.active).toEqual(["o/plain"]);
    expect(r.log).toEqual(["excluded: native o/native", "excluded: native-check-failed o/broken (fail-closed: ruleset read failed)"]);
  });
  it("control: with no native repo the door keeps every repo and logs nothing", () => {
    const { read } = api({ [LIST("o/a")]: [], [LIST("o/b")]: [CHASSIS_ROW] });
    expect(reposForDoor(["o/a", "o/b"], read)).toEqual({ active: ["o/a", "o/b"], log: [] });
  });
  it("restart-train.ts builds its tickets ONLY from the door's active repos (the stale-label strip, the merge and the in-flight label all hang off them)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "restart-train.ts"), "utf-8");
    const start = src.indexOf("async function fetchTickets(");
    const end = src.indexOf("\nasync function postLines(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain("reposForDoor(TICKET_REPOS");
    expect(body).toContain("for (const repo of door.active)");
    expect(body).not.toMatch(/of TICKET_REPOS\)/); // a raw iteration over TICKET_REPOS here would bypass the exclusion
  });
});

describe("runCli — argument handling + cache file", () => {
  it("scan prints the excluded JSON on stdout and the fixed lines on stderr", () => {
    const { read } = api({ [LIST("o/native")]: [row()], [DETAIL("o/native", 111)]: detail(), [LIST("o/plain")]: [] });
    const r = runCli(["scan", "o/native", "o/plain"], read);
    expect(r).toEqual({ stdout: '["o/native"]', stderr: ["excluded: native o/native"], code: 0 });
  });
  it("an unknown subcommand is a usage error (non-zero), never a silent empty result", () => {
    expect(runCli(["frobnicate"], api({}).read).code).toBe(2);
    expect(runCli([], api({}).read).code).toBe(2);
  });
  it("--cache persists verdicts across two invocations: the second makes no GET for a cached repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "native-excl-"));
    const cacheFile = join(dir, "cache.json");
    const spy = vi.fn();
    const { read } = api({ [LIST("o/native")]: [row()], [DETAIL("o/native", 111)]: detail(), [LIST("o/plain")]: [] });
    const counted: RulesetReader = (p) => (spy(p), read(p));
    runCli(["scan", "--cache", cacheFile, "o/native", "o/plain"], counted);
    const n = spy.mock.calls.length;
    const second = runCli(["scan", "--cache", cacheFile, "o/native", "o/plain"], counted);
    expect(spy.mock.calls.length).toBe(n);
    expect(second.stdout).toBe('["o/native"]');
    expect(second.stderr).toEqual([]); // already logged by the first call in this run
    expect(JSON.parse(readFileSync(cacheFile, "utf-8"))).toEqual({ "o/native": "native", "o/plain": "not-native" });
  });
  it("a corrupt cache file is an empty cache (re-read), not a crash and not a stale verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "native-excl-"));
    const cacheFile = join(dir, "cache.json");
    writeFileSync(cacheFile, "{not json");
    const { read } = api({ [LIST("o/native")]: [row()], [DETAIL("o/native", 111)]: detail() });
    expect(runCli(["scan", "--cache", cacheFile, "o/native"], read).stdout).toBe('["o/native"]');
  });
});

describe("the REAL CLI file under a fake gh (process-level; defaultGhReader → execFileSync gh)", () => {
  const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const TSX = join(SCRIPTS, "node_modules", ".bin", "tsx");
  function run(repos: string[], rules: Parameters<typeof makeGhStub>[1]) {
    const dir = mkdtempSync(join(tmpdir(), "native-excl-proc-"));
    const stub = makeGhStub(dir, rules);
    const out = execFileSync(TSX, [join(SCRIPTS, "lib", "native-exclusion.ts"), "scan", ...repos], {
      cwd: SCRIPTS,
      env: { ...process.env, PATH: stub.path, GH_STUB_LOG: stub.logPath },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, calls: readFileSync(stub.logPath, "utf-8").trim().split("\n").filter(Boolean) };
  }
  it("known-good + known-bad + fail-closed through the real gh call path", () => {
    const { out, calls } = run(["studio-b-ai/toto", "studio-b-ai/radio", "studio-b-ai/down"], [
      { match: /^api repos\/studio-b-ai\/toto\/rulesets\?per_page=100$/, out: JSON.stringify([row()]) },
      { match: /^api repos\/studio-b-ai\/toto\/rulesets\/111$/, out: JSON.stringify(detail()) },
      { match: /^api repos\/studio-b-ai\/radio\/rulesets\?per_page=100$/, out: "[]" },
      { match: /^api repos\/studio-b-ai\/down\/rulesets\?per_page=100$/, fail: true },
    ]);
    expect(JSON.parse(out)).toEqual(["studio-b-ai/toto", "studio-b-ai/down"]);
    expect(calls).toEqual([
      "api repos/studio-b-ai/toto/rulesets?per_page=100",
      "api repos/studio-b-ai/toto/rulesets/111",
      "api repos/studio-b-ai/radio/rulesets?per_page=100",
      "api repos/studio-b-ai/down/rulesets?per_page=100",
    ]);
  });
});
