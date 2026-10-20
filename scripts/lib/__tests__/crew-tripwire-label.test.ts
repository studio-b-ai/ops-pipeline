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
 * `evaluate` / `evaluateTrainReady` (Rule #223) against the stateful fake GitHub
 * (fixtures/fake-gh.ts: labels the gate adds stay on the PR; the merge call records the labels
 * the PR carried at that instant), so "a crew-route merge carries the watched label" is asserted
 * on what the world captured at the merge, across real sweeps — never on a hand-assembled fixture.
 *
 *   QUALIFICATION  the label is written FIRST — before the paid vote, before candidate, before box —
 *                  and a failed write writes NO merge-authorizing label and spends no vote. The label is
 *                  CREATED in the repo when missing (toto/power-unit/lightsout do not have it).
 *   MERGE INSTANT  the bot-box merge carries the label; a bot-boxed crew PR that lacks it gets it written
 *                  and does NOT merge that cycle (box door AND train door).
 *   FLEET-INTERNAL a crew PR that resolves the fleet-internal class (outside the safe globs) merges
 *                  DIRECTLY — it gets the label first, fail-closed, and holds the cycle it was written.
 *   SCOPE          Kevin's box (attended), plain human PRs and Kevin's `bugsquasher` lane are untouched.
 *   FILTER PAIRING the filter expression documented in the tripwire workflow matches the labels at
 *                  merge, and REJECTS the pre-change label set (negative control, Rule #322).
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyPrDiffClass, gateDecisionForClass, parseUnifiedDiff, reconcileFileClasses } from "../automerge-classify.js";
import { FLEET_APP_SLUG, FRESH, World } from "./fixtures/fake-gh.js";

process.env.PR_AUTOMERGE_GATE_NO_MAIN = "1";

const reviewCreate = vi.hoisted(() => vi.fn());
vi.mock("../anthropic-credentials.js", () => ({ anthropicClient: () => ({ messages: { create: reviewCreate } }) }));

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

const { evaluate, evaluateTrainReady, CODE_FIX_MERGE_LABEL } = await import("../../pr-automerge-gate.js");

const REPO = "studio-b-ai/radio"; // the repo that carries the tripwire caller today
const TRAIN_REPO = "studio-b-ai/studiob"; // repoClassFor() === "train"
const PR = 777;

let world: World;
let logLines: string[];

function install(init: Partial<ConstructorParameters<typeof World>[0]> & { labels: string[] }, repo = REPO): World {
  world = new World({ repo, pr: PR, ...init });
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => world.handle(cmd, args));
  return world;
}
/** A bot-boxed candidate as a qualifying sweep leaves it, minus whichever of label/check the test removes. */
function botBoxed(over: { withLabel?: boolean; qualified?: boolean; repo?: string } = {}): World {
  const labels = ["fleet-internal", "candidate", "box", ...(over.withLabel === false ? [] : [CODE_FIX_MERGE_LABEL])];
  const w = install({ labels, boxBy: "bot", baseBehind: FRESH }, over.repo ?? REPO);
  if (over.qualified !== false) w.injectCheck({ name: "crew-qualified", head_sha: w.head, app: FLEET_APP_SLUG });
  return w;
}

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
    const w = new World({ repo: REPO, pr: PR, labels: ["fleet-internal"] });
    const files = reconcileFileClasses(["src/fix.ts"], parseUnifiedDiff(w.diff));
    const cls = classifyPrDiffClass({ files, totalChangedLines: 24, safePathGlobs: ["src/**"], sensitivePathPatterns: ["(^|/)(auth|credential|secret|token)"] });
    expect(cls.prClass).toBe("code-fix");
    const gate = gateDecisionForClass({ prClass: "code-fix", author: "kbibelhausen", labels: ["fleet-internal", "candidate", "box", CODE_FIX_MERGE_LABEL], ciClean: true, reviewVerdict: "CLEAN" });
    expect(gate.decision).toBe("merge");
  });
});

describe("crew route (standard repo) — qualification writes the filter label first; the next sweep's merge carries it", () => {
  it("END TO END over two real sweeps: the PR merged by the bot box carries automerge:code-fix, and the documented filter matches it", async () => {
    const w = install({ labels: ["fleet-internal"] });
    await sweep(); // sweep 1: qualification
    expect(w.labelAddAttempts()).toEqual([CODE_FIX_MERGE_LABEL, "candidate", "box"]); // filter label FIRST
    expect(w.mergeCalls()).toHaveLength(0);

    await sweep(); // sweep 2: the gate's own bot box is honored
    expect(w.mergeCalls()).toHaveLength(1);
    expect(w.merges).toHaveLength(1);
    expect(w.merges[0].labels).toContain(CODE_FIX_MERGE_LABEL);
    expect(filterMatches(documentedCallerFilter(), w.merges[0].labels)).toBe(true);
    expect(receipts().some((r) => r.includes("verdict=qualified"))).toBe(true);
  });

  it("the filter label is written BEFORE the paid vote: a crew PR that gets it written spends the vote once, on this sweep", async () => {
    const w = install({ labels: ["fleet-internal"] });
    await sweep();
    const firstAdd = w.calls.findIndex((c) => w.joined(c).includes(`--add-label ${CODE_FIX_MERGE_LABEL}`));
    expect(firstAdd).toBeGreaterThan(-1);
    expect(reviewCreate).toHaveBeenCalledTimes(3);
  });

  it("a label already on the PR is not re-written (GitHub emits no event for a no-op add; the flap guard counts adds)", async () => {
    const w = install({ labels: ["fleet-internal", CODE_FIX_MERGE_LABEL] });
    await sweep();
    expect(w.labelAddAttempts()).toEqual(["candidate", "box"]);
  });

  it("the label is CREATED in a repo that does not have it (toto, power-unit, lightsout), then added — and an existing label is never overwritten", async () => {
    const w = install({ labels: ["fleet-internal"], repoLabels: ["fleet-internal", "candidate", "box", "needs-human"] }); // no automerge:code-fix
    await sweep();
    const creates = w.callsMatching("label create");
    expect(creates).toHaveLength(1);
    expect(creates[0][3]).toBe(CODE_FIX_MERGE_LABEL);
    expect(creates[0]).not.toContain("--force"); // a label a repo already curates is not overwritten
    expect(w.labelAddAttempts()).toEqual([CODE_FIX_MERGE_LABEL, "candidate", "box"]);

    const w2 = install({ labels: ["fleet-internal"] }); // label exists
    await sweep();
    expect(w2.callsMatching("label create")).toHaveLength(0);
  });

  it("FAIL-CLOSED: if the filter label cannot be written, NO vote is spent, NEITHER merge-authorizing label is written, and nothing merges", async () => {
    const w = install({ labels: ["fleet-internal"] });
    w.failLabelAdd = CODE_FIX_MERGE_LABEL;
    await sweep();
    expect(w.labelAddAttempts()).toEqual([CODE_FIX_MERGE_LABEL]); // the one attempt; no candidate, no box
    expect(w.labels).toEqual(["fleet-internal"]);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(w.checkPosts("crew-qualified")).toHaveLength(0);
    expect(w.mergeCalls()).toHaveLength(0);
    expect(receipts().some((r) => r.includes("leg=tripwire-label") && r.includes("FAILED"))).toBe(true);
    await sweep(); // and a second sweep cannot merge what was never boxed
    expect(w.mergeCalls()).toHaveLength(0);
  });

  it("MERGE INSTANT: a bot-boxed crew PR that LACKS the label gets it written and does NOT merge that cycle; the next sweep merges with it", async () => {
    const w = botBoxed({ withLabel: false });
    await sweep();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.labelAddAttempts()).toEqual([CODE_FIX_MERGE_LABEL]);
    expect(receipts().find((l) => l.includes("leg=tripwire-label"))).toContain("tripwire-label-missing");
    await sweep();
    expect(w.mergeCalls()).toHaveLength(1);
    expect(w.merges[0].labels).toContain(CODE_FIX_MERGE_LABEL);
  });

  it("MERGE INSTANT, FAIL-CLOSED: label missing and the write fails → no merge (an unwatched unattended merge is refused)", async () => {
    const w = botBoxed({ withLabel: false });
    w.failLabelAdd = CODE_FIX_MERGE_LABEL;
    await sweep();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(receipts().find((l) => l.includes("leg=tripwire-label"))).toContain("FAILED");
  });

  it("SCOPE: Kevin's OWN box is attended — a crew PR he boxes merges without the gate writing the filter label", async () => {
    const w = install({ labels: ["fleet-internal", "candidate", "box"], boxBy: "kevin", baseBehind: FRESH });
    await sweep();
    expect(w.mergeCalls()).toHaveLength(1);
    expect(w.labelAddAttempts()).toEqual([]);
  });

  it("SCOPE: a plain human PR (no fleet-internal) with Kevin's box is untouched", async () => {
    const w = install({ labels: ["box"], boxBy: "kevin", baseBehind: FRESH });
    await sweep();
    expect(w.mergeCalls()).toHaveLength(1);
    expect(w.labelAddAttempts()).toEqual([]);
  });
});

describe("crew PRs that resolve the fleet-internal class merge DIRECTLY — they carry the label too (review F1/F2)", () => {
  const OUTSIDE_GLOBS = { labels: ["fleet-internal"], files: ["tools/helper.ts"], baseBehind: FRESH };

  it("END TO END: sweep 1 writes the label and HOLDS (no merge in the cycle that wrote it); sweep 2 merges directly, carrying the label", async () => {
    const w = install(OUTSIDE_GLOBS);
    await sweep();
    expect(w.labelAddAttempts()).toEqual([CODE_FIX_MERGE_LABEL]); // no candidate / box on this route
    expect(w.mergeCalls()).toHaveLength(0);
    expect(receipts().some((r) => r.includes("class=fleet-internal") && r.includes("leg=tripwire-label"))).toBe(true);
    expect(reviewCreate).not.toHaveBeenCalled(); // the label step is before the vote: held cycles spend nothing

    await sweep();
    expect(w.mergeCalls()).toHaveLength(1);
    expect(w.merges[0].labels).toContain(CODE_FIX_MERGE_LABEL);
    expect(filterMatches(documentedCallerFilter(), w.merges[0].labels)).toBe(true);
    expect(receipts().some((r) => r.includes("class=fleet-internal") && r.includes("verdict=qualified"))).toBe(true);
  });

  it("FAIL-CLOSED: a failed label write refuses the direct merge, now and on every later sweep, and spends no vote", async () => {
    const w = install(OUTSIDE_GLOBS);
    w.failLabelAdd = CODE_FIX_MERGE_LABEL;
    await sweep();
    await sweep();
    expect(w.mergeCalls()).toHaveLength(0);
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(receipts().filter((r) => r.includes("leg=tripwire-label") && r.includes("FAILED"))).toHaveLength(2);
  });

  it("SCOPE: Kevin's lane (bugsquasher + fleet-internal) is Kevin's cap and Kevin's route — no filter label is written for it by this leg", async () => {
    const w = install({ labels: ["fleet-internal", "bugsquasher"], files: ["tools/helper.ts"], baseBehind: FRESH });
    await sweep();
    expect(w.labelAddAttempts().filter((l) => l === CODE_FIX_MERGE_LABEL)).toEqual([]);
  });
});

describe("crew route (train-class repo) — the same label rides the train block and the train door", () => {
  it("train block: a qualifying CREW code-fix gets the filter label first, then candidate + box", async () => {
    const w = install({ labels: ["fleet-internal"] }, TRAIN_REPO);
    await evaluate(TRAIN_REPO, PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(w.labelAddAttempts()).toEqual([CODE_FIX_MERGE_LABEL, "candidate", "box"]);
  });

  it("train block SCOPE: Kevin's bugsquasher lane is unchanged — candidate + box only, no filter label, no qualification check", async () => {
    const w = install({ labels: ["bugsquasher"] }, TRAIN_REPO);
    await evaluate(TRAIN_REPO, PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(w.labelAddAttempts()).toEqual(["candidate", "box"]);
    expect(w.checkPosts()).toHaveLength(0);
  });

  it("train block FAIL-CLOSED: filter-label write fails → no candidate, no box", async () => {
    const w = install({ labels: ["fleet-internal"] }, TRAIN_REPO);
    w.failLabelAdd = CODE_FIX_MERGE_LABEL;
    await evaluate(TRAIN_REPO, PR, ["code-fix"], [], ["src/**"], ["ci"], []);
    expect(w.labelAddAttempts()).toEqual([CODE_FIX_MERGE_LABEL]);
    expect(w.labels).toEqual(["fleet-internal"]);
  });

  it("train door: a bot-boxed crew PR lacking the label is refused with the label written; the next pass merges with it", async () => {
    const w = botBoxed({ withLabel: false, repo: TRAIN_REPO });
    const first = await evaluateTrainReady(TRAIN_REPO, PR, { door: null });
    expect(first.outcome).toBe("refused");
    expect(first.detail).toContain("tripwire-label-missing");
    expect(w.mergeCalls()).toHaveLength(0);
    expect(w.labelAddAttempts()).toEqual([CODE_FIX_MERGE_LABEL]);
    const second = await evaluateTrainReady(TRAIN_REPO, PR, { door: null });
    expect(second.outcome).toBe("merged");
    expect(w.merges[0].labels).toContain(CODE_FIX_MERGE_LABEL);
  });

  it("train door SCOPE: Kevin's box on a crew PR is attended — merges, no filter-label write", async () => {
    const w = install({ labels: ["fleet-internal", "box"], boxBy: "kevin", baseBehind: FRESH }, TRAIN_REPO);
    const res = await evaluateTrainReady(TRAIN_REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(w.labelAddAttempts()).toEqual([]);
  });

  it("train door SCOPE: a human PR with Kevin's box is untouched", async () => {
    const w = install({ labels: ["box"], boxBy: "kevin", baseBehind: FRESH }, TRAIN_REPO);
    const res = await evaluateTrainReady(TRAIN_REPO, PR, { door: null });
    expect(res.outcome).toBe("merged");
    expect(w.labelAddAttempts()).toEqual([]);
  });
});
