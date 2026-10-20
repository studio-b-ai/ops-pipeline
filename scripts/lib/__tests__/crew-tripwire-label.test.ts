/**
 * Stint #928 (post-#580 review) — every UNATTENDED crew merge must carry the label the
 * post-merge 5xx tripwire watches.
 *
 * The tripwire (`.github/workflows/post-merge-tripwire.yml`) is a reusable workflow; the
 * trigger FILTER lives in each CALLER repo's workflow as
 * `contains(github.event.pull_request.labels.*.name, 'automerge:code-fix')` (today the one
 * caller is studio-b-ai/radio's post-merge-tripwire-caller.yml; the header of the reusable
 * workflow documents the wiring). The standard code-fix route writes that label itself before
 * its direct merge. The CREW route merges later, through the gate's own bot `box`, so before
 * this change those merges were invisible to the canary.
 *
 * Choice (a), the least invasive: write the EXISTING `automerge:code-fix` label — no new
 * label, no cross-repo change to the caller's filter. These tests import and call the REAL
 * `evaluate` / `evaluateTrainReady` (Rule #223) against a STATEFUL fake `gh` (labels added by
 * the gate stay on the PR; the merge call records the labels the PR carried at that instant),
 * so "a crew-route merge carries the watched label" is asserted on what the fake captured at
 * the merge, across two real sweeps — never on a hand-assembled fixture.
 *
 *   QUALIFICATION  sweep 1 writes `automerge:code-fix` FIRST, then candidate, then box; a failed
 *                  write of the filter label writes NEITHER of the merge-authorizing labels.
 *   MERGE INSTANT  sweep 2 (the bot-box merge) carries the label; a bot-boxed crew PR that lacks
 *                  it gets it written and does NOT merge that cycle (box door AND train door).
 *   SCOPE          Kevin's box (attended), plain human PRs and Kevin's `bugsquasher` lane are untouched.
 *   FILTER PAIRING the filter expression documented in the tripwire workflow matches the labels at
 *                  merge, and REJECTS the pre-change label set (negative control, Rule #322).
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyPrDiffClass, gateDecisionForClass, parseUnifiedDiff, reconcileFileClasses } from "../automerge-classify.js";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const reviewCreate = vi.hoisted(() => vi.fn());
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: () => ({ messages: { create: reviewCreate } }) }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluate, evaluateTrainReady, CODE_FIX_MERGE_LABEL } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/radio"; // the repo that carries the tripwire caller today
const TRAIN_REPO = "studio-b-ai/studiob"; // repoClassFor() === "train"
const PR = 777;
const HEAD = "7771a1b2c3d4e5f6777a1b2c3d4e5f6777a1b2c3";
const TIP = "2026-10-20T12:00:00Z";

const DIFF = [
  "diff --git a/src/fix.ts b/src/fix.ts",
  "--- a/src/fix.ts",
  "+++ b/src/fix.ts",
  "@@ -1,2 +1,3 @@",
  "-const a = 1;",
  "+const a = 2;",
  "+export const b = 3;",
  "",
].join("\n");

type BoxActor = "bot" | "kevin" | null;

interface World {
  /** The labels currently on the PR — mutated by the gate's `pr edit --add-label`. */
  labels: string[];
  /** Who applied `box` (the timeline's LabeledEvent actor). The gate sets "bot" when IT adds box. */
  boxActor: BoxActor;
  /** A label whose `--add-label` write throws (gh failure). */
  failLabel?: string;
  /** What the PR carried at each `pr merge` call. */
  mergedWithLabels: string[][];
}

let world: World;
type GhCall = string[];
let ghCalls: GhCall[];
let logLines: string[];

function prView(): string {
  return JSON.stringify({
    author: { login: "kbibelhausen" },
    createdAt: "2026-10-01T00:00:00Z",
    labels: world.labels.map((name) => ({ name })),
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    additions: 22,
    deletions: 2,
    headRefOid: HEAD,
    baseRefName: "main",
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-20T09:00:00Z" }],
    files: [{ path: "src/fix.ts" }],
    changedFiles: 1,
  });
}

function timeline(): string {
  const actor = world.boxActor === "bot" ? { __typename: "Bot", login: "studiob-fleet-bot" } : { __typename: "User", login: "kbibelhausen" };
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          timelineItems: {
            filteredCount: 2,
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: [
              { __typename: "PullRequestCommit" },
              { __typename: "LabeledEvent", label: { name: "box" }, actor, createdAt: "2026-10-20T10:30:00Z" },
            ],
          },
        },
      },
    },
  });
}

function install(w: Partial<World> & { labels: string[] }, repo: string) {
  world = { boxActor: null, mergedWithLabels: [], ...w };
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    ghCalls.push([cmd, ...args]);
    if (cmd === "sleep") return "";
    const a = args.join(" ");
    if (a.startsWith("api graphql")) return timeline();
    if (a.startsWith("pr view") && a.includes("--json comments")) return "0\n";
    if (a.startsWith("pr view") && a.includes("--json headRefOid")) return `${HEAD}\n`;
    if (a.startsWith("pr view")) return prView();
    if (a.startsWith(`api repos/${repo}/compare/`) && args.includes("-H")) return DIFF;
    if (a.startsWith(`api repos/${repo}/compare/`) && a.includes("per_page=1")) {
      return JSON.stringify({ ahead_by: 0, merge_base_date: TIP, file_count: 0, files: [] }); // FRESH base: this file is about labels
    }
    if (a.startsWith(`api repos/${repo}/commits/main`)) return `${TIP}\n`;
    if (a.startsWith("pr edit")) {
      const label = args[args.indexOf("--add-label") + 1];
      if (label === world.failLabel) throw new Error(`gh: could not add label '${label}' (HTTP 422)\nsecond line`);
      if (!world.labels.includes(label)) world.labels.push(label);
      if (label === "box") world.boxActor = "bot"; // the gate's own fleet-bot key
      return "";
    }
    if (a.startsWith("pr merge")) {
      world.mergedWithLabels.push([...world.labels]);
      return "";
    }
    if (a.startsWith("pr comment") || a.startsWith("api -X POST")) return "";
    throw new Error(`unexpected gh invocation in crew-tripwire-label test: ${a}`);
  });
}

const joined = (c: GhCall) => c.slice(1).join(" ");
const labelAdds = () => ghCalls.filter((c) => joined(c).startsWith("pr edit")).map((c) => c[c.indexOf("--add-label") + 1]);
const merges = () => ghCalls.filter((c) => joined(c).startsWith("pr merge"));
const receipts = () => logLines.filter((l) => l.startsWith("[gate-receipt]"));
const ENABLED = ["code-fix", "fleet-internal"] as never;
const sweep = (repo = REPO) => evaluate(repo, PR, ENABLED, [], ["src/**"], ["ci"], []);

// ───────── the tripwire filter, as documented in the reusable workflow's caller wiring ─────────

const WORKFLOW_PATH = new URL("../../../.github/workflows/post-merge-tripwire.yml", import.meta.url);

/** The caller-side `if:` expression from the workflow header's wiring block. */
function documentedCallerFilter(): string {
  const text = readFileSync(WORKFLOW_PATH, "utf-8");
  const m = /^#\s*if:\s*(.+)$/m.exec(text);
  if (!m) throw new Error("no `# if:` caller-wiring line found in post-merge-tripwire.yml's header");
  return m[1].trim();
}

/**
 * A faithful evaluation of the only expression shape the tripwire filter uses:
 * `github.event.pull_request.merged == true && contains(github.event.pull_request.labels.*.name, '<label>')`.
 * Every `contains(...labels.*.name, 'X')` literal must be present; `merged == true` is assumed (we are
 * asking about merged PRs). Throws on any other shape so a filter rewrite cannot slip past unexamined.
 */
function filterMatches(expr: string, labels: readonly string[]): boolean {
  const containsRe = /contains\(github\.event\.pull_request\.labels\.\*\.name,\s*'([^']+)'\)/g;
  const required = [...expr.matchAll(containsRe)].map((m) => m[1]);
  if (required.length === 0) throw new Error(`filter has no contains(labels.*.name, '…') term: ${expr}`);
  const rest = expr.replace(containsRe, "").replace(/github\.event\.pull_request\.merged\s*==\s*true/, "").replace(/&&/g, "").trim();
  if (rest !== "") throw new Error(`filter has terms this test does not model — extend filterMatches deliberately: '${rest}'`);
  return required.every((l) => labels.includes(l));
}

beforeEach(() => {
  ghCalls = [];
  logLines = [];
  execFileSyncMock.mockReset();
  reviewCreate.mockReset();
  reviewCreate.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "CLEAN" }] });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logLines.push(a.map(String).join(" "));
  });
});

describe("the contract between the gate and the tripwire's caller-side filter", () => {
  it("the gate's merge label is the one the documented filter keys on", () => {
    expect(CODE_FIX_MERGE_LABEL).toBe("automerge:code-fix");
    expect(documentedCallerFilter()).toContain(`'${CODE_FIX_MERGE_LABEL}'`);
  });

  it("the documented filter matches a PR carrying the label and REJECTS the pre-change crew label set (negative control)", () => {
    const filter = documentedCallerFilter();
    expect(filterMatches(filter, ["fleet-internal", "candidate", "box", CODE_FIX_MERGE_LABEL])).toBe(true);
    // what a crew-route merge carried BEFORE this change — invisible to the canary
    expect(filterMatches(filter, ["fleet-internal", "candidate", "box"])).toBe(false);
    expect(filterMatches(filter, [])).toBe(false);
  });

  it("the tripwire's re-derivation accepts what the crew route merges (same predicates it calls, no labels passed, as it does)", () => {
    const parsed = parseUnifiedDiff(DIFF);
    const files = reconcileFileClasses(["src/fix.ts"], parsed);
    const cls = classifyPrDiffClass({ files, totalChangedLines: 24, safePathGlobs: ["src/**"], sensitivePathPatterns: ["(^|/)(auth|credential|secret|token)"] });
    expect(cls.prClass).toBe("code-fix");
    const gate = gateDecisionForClass({ prClass: "code-fix", author: "kbibelhausen", labels: ["fleet-internal", "candidate", "box", CODE_FIX_MERGE_LABEL], ciClean: true, reviewVerdict: "CLEAN" });
    expect(gate.decision).toBe("merge");
  });
});

describe("crew route (standard repo) — qualification writes the filter label first; the next sweep's merge carries it", () => {
  it("END TO END over two real sweeps: the PR merged by the bot box carries automerge:code-fix, and the documented filter matches it", async () => {
    install({ labels: ["fleet-internal"] }, REPO);
    await sweep(); // sweep 1: qualification
    expect(labelAdds()).toEqual([CODE_FIX_MERGE_LABEL, "candidate", "box"]); // filter label FIRST
    expect(merges()).toHaveLength(0);

    await sweep(); // sweep 2: the gate's own bot box is honored
    expect(merges()).toHaveLength(1);
    expect(world.mergedWithLabels).toHaveLength(1);
    expect(world.mergedWithLabels[0]).toContain(CODE_FIX_MERGE_LABEL);
    expect(filterMatches(documentedCallerFilter(), world.mergedWithLabels[0])).toBe(true);
    expect(receipts().some((r) => r.includes("verdict=qualified"))).toBe(true);
  });

  it("a label already on the PR is not re-written (GitHub emits no event for a no-op add; the flap guard counts adds)", async () => {
    install({ labels: ["fleet-internal", CODE_FIX_MERGE_LABEL] }, REPO);
    await sweep();
    expect(labelAdds()).toEqual(["candidate", "box"]);
  });

  it("FAIL-CLOSED: if the filter label cannot be written, NEITHER merge-authorizing label is written and nothing merges", async () => {
    install({ labels: ["fleet-internal"], failLabel: CODE_FIX_MERGE_LABEL }, REPO);
    await sweep();
    expect(labelAdds()).toEqual([CODE_FIX_MERGE_LABEL]); // the one attempt; no candidate, no box
    expect(world.labels).toEqual(["fleet-internal"]);
    expect(merges()).toHaveLength(0);
    expect(logLines.some((l) => l.includes("NOT written") && l.includes(CODE_FIX_MERGE_LABEL))).toBe(true);
    await sweep(); // and a second sweep cannot merge what was never boxed
    expect(merges()).toHaveLength(0);
  });

  it("MERGE INSTANT: a bot-boxed crew PR that LACKS the label gets it written and does NOT merge that cycle; the next sweep merges with it", async () => {
    install({ labels: ["fleet-internal", "candidate", "box"], boxActor: "bot" }, REPO);
    await sweep();
    expect(merges()).toHaveLength(0);
    expect(labelAdds()).toEqual([CODE_FIX_MERGE_LABEL]);
    const r = receipts().find((l) => l.includes("leg=box"));
    expect(r).toContain("tripwire-label-missing");
    await sweep();
    expect(merges()).toHaveLength(1);
    expect(world.mergedWithLabels[0]).toContain(CODE_FIX_MERGE_LABEL);
  });

  it("MERGE INSTANT, FAIL-CLOSED: label missing and the write fails → no merge (an unwatched unattended merge is refused)", async () => {
    install({ labels: ["fleet-internal", "candidate", "box"], boxActor: "bot", failLabel: CODE_FIX_MERGE_LABEL }, REPO);
    await sweep();
    expect(merges()).toHaveLength(0);
    expect(receipts().find((l) => l.includes("leg=box"))).toContain("FAILED");
  });

  it("SCOPE: Kevin's OWN box is attended — a crew PR he boxes merges without the gate writing the filter label", async () => {
    install({ labels: ["fleet-internal", "candidate", "box"], boxActor: "kevin" }, REPO);
    await sweep();
    expect(merges()).toHaveLength(1);
    expect(labelAdds()).toEqual([]);
  });

  it("SCOPE: a plain human PR (no fleet-internal) with Kevin's box is untouched", async () => {
    install({ labels: ["box"], boxActor: "kevin" }, REPO);
    await sweep();
    expect(merges()).toHaveLength(1);
    expect(labelAdds()).toEqual([]);
  });
});

describe("crew route (train-class repo) — the same label rides the train block and the train door", () => {
  it("train block: a qualifying CREW code-fix gets the filter label first, then candidate + box", async () => {
    install({ labels: ["fleet-internal"] }, TRAIN_REPO);
    await evaluate(TRAIN_REPO, PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(labelAdds()).toEqual([CODE_FIX_MERGE_LABEL, "candidate", "box"]);
  });

  it("train block SCOPE: Kevin's bugsquasher lane is unchanged — candidate + box only, no filter label", async () => {
    install({ labels: ["bugsquasher"] }, TRAIN_REPO);
    await evaluate(TRAIN_REPO, PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(labelAdds()).toEqual(["candidate", "box"]);
  });

  it("train block FAIL-CLOSED: filter-label write fails → no candidate, no box", async () => {
    install({ labels: ["fleet-internal"], failLabel: CODE_FIX_MERGE_LABEL }, TRAIN_REPO);
    await evaluate(TRAIN_REPO, PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(labelAdds()).toEqual([CODE_FIX_MERGE_LABEL]);
    expect(world.labels).toEqual(["fleet-internal"]);
  });

  it("train door: a bot-boxed crew PR lacking the label is refused with the label written; the next pass merges with it", async () => {
    install({ labels: ["fleet-internal", "candidate", "box"], boxActor: "bot" }, TRAIN_REPO);
    const first = await evaluateTrainReady(TRAIN_REPO, PR, { door: null });
    expect(first.outcome).toBe("refused");
    expect(first.detail).toContain("tripwire-label-missing");
    expect(merges()).toHaveLength(0);
    expect(labelAdds()).toEqual([CODE_FIX_MERGE_LABEL]);
    const second = await evaluateTrainReady(TRAIN_REPO, PR, { door: null });
    expect(second.outcome).toBe("merged");
    expect(world.mergedWithLabels[0]).toContain(CODE_FIX_MERGE_LABEL);
  });

  it("train door SCOPE: Kevin's box on a crew PR is attended — merges, no filter-label write", async () => {
    install({ labels: ["fleet-internal", "box"], boxActor: "kevin" }, TRAIN_REPO);
    const res = await evaluateTrainReady(TRAIN_REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(labelAdds()).toEqual([]);
  });

  it("train door SCOPE: a human PR with Kevin's box is untouched", async () => {
    install({ labels: ["box"], boxActor: "kevin" }, TRAIN_REPO);
    const res = await evaluateTrainReady(TRAIN_REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(labelAdds()).toEqual([]);
  });
});
