/**
 * Go-native Phase A, PR-A2 item 2 — the GATE-level backstop (pr-automerge-gate.ts main()).
 *
 * The sweeps skip a native repo at enumeration; main() makes "no PR read, no label write, no update-branch, no merge on a native
 * repo" structural for every other way the gate can be reached. Rule #223: this imports the REAL `main` and drives it against a
 * mocked `node:child_process` (every `gh` call — the gate's own AND native-exclusion's ruleset reads — funnels through
 * `execFileSync`); assertions are on the gh calls it CAPTURED. Both directions (#322/#471): native ⇒ only the two ruleset GETs and
 * not one PR read; non-native ⇒ the gate runs (positive control, same instrument); unreadable ruleset ⇒ excluded (fail closed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_RULESET_NAME } from "../native-exclusion.js";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const anthropicClientSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("the backstop suite never reaches the review leg — no Anthropic spend expected");
  }),
);
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: anthropicClientSpy }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { main } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/toto";
const PR = 5;
const nativeRow = { id: 321, name: NATIVE_RULESET_NAME, target: "branch", enforcement: "active", source_type: "Repository" };
const nativeDetail = { ...nativeRow, conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } };
const BLOCKED_PR = JSON.stringify({
  author: { login: "app/studiob-fleet-bot" },
  labels: [{ name: "fleet-internal" }],
  createdAt: "2026-01-15T08:00:00Z",
  state: "OPEN",
  isDraft: false,
  mergeStateStatus: "BLOCKED", // a deterministic early short-circuit: the gate reads the PR and stops at the ci-rollup leg
  additions: 3,
  deletions: 1,
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  // pg-enum-drift-exempt: GitHub statusCheckRollup `status` literal in a mocked `gh pr view` payload — not a Postgres enum
  statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
  files: [{ path: "docs/x.md" }],
  changedFiles: 1,
  headRepositoryOwner: { login: "studio-b-ai" },
  headRepository: { name: "toto" },
});

let ghCalls: string[];
let logLines: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

function gh(rulesets: "native" | "plain" | "unreadable") {
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    const a = args.join(" ");
    ghCalls.push(`${cmd} ${a}`);
    if (a === `api repos/${REPO}/rulesets?per_page=100`) {
      if (rulesets === "unreadable") throw new Error("HTTP 403: Resource not accessible by integration");
      return JSON.stringify(rulesets === "native" ? [nativeRow] : []);
    }
    if (a === `api repos/${REPO}/rulesets/321`) return JSON.stringify(nativeDetail);
    if (a.startsWith("pr view")) return BLOCKED_PR;
    throw new Error(`unexpected gh invocation in the backstop test: ${a}`);
  });
}

beforeEach(() => {
  ghCalls = [];
  logLines = [];
  execFileSyncMock.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logLines.push(a.join(" ")));
});
afterEach(() => logSpy.mockRestore());

const prReads = () => ghCalls.filter((c) => c.startsWith("gh pr "));

describe("pr-automerge-gate main() — native backstop", () => {
  it.each([
    ["squasher path", ["--repo", REPO, "--pr", String(PR)]],
    ["train path (--train-ready)", ["--repo", REPO, "--pr", String(PR), "--train-ready"]],
  ])("NATIVE repo, %s: logs `excluded: native <repo>`, makes ONLY the two ruleset reads — no PR read, no write, no merge", async (_n, argv) => {
    gh("native");
    await main(argv);
    expect(logLines).toEqual([`excluded: native ${REPO}`]);
    expect(ghCalls).toEqual([`gh api repos/${REPO}/rulesets?per_page=100`, `gh api repos/${REPO}/rulesets/321`]);
    expect(prReads()).toEqual([]);
    expect(anthropicClientSpy).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL (same instrument): a non-native repo is NOT excluded — the gate reads the PR and evaluates it", async () => {
    gh("plain");
    await main(["--repo", REPO, "--pr", String(PR)]);
    expect(logLines.some((l) => l.startsWith("excluded:"))).toBe(false);
    expect(prReads().some((c) => c.startsWith(`gh pr view ${PR} --repo ${REPO}`))).toBe(true);
    expect(logLines.some((l) => l.startsWith("[gate-receipt]") && l.includes("leg=ci-rollup"))).toBe(true); // it ran to its first leg
  });

  it("FAIL CLOSED: an unreadable ruleset list excludes the repo (and says so) — the gate does not read the PR", async () => {
    gh("unreadable");
    await main(["--repo", REPO, "--pr", String(PR)]);
    expect(logLines).toEqual([`excluded: native-check-failed ${REPO} (fail-closed: ruleset read failed)`]);
    expect(prReads()).toEqual([]);
  });
});
