import { describe, expect, it } from "vitest";
import { installPublicGateLog, toPublicGateLine } from "../public-gate-log.js";
import { parseReceipts } from "../squasher-health-classify.js";

// Go-native Phase A, PR-A2 item 5 — gate logs carry only repo, PR, SHA and a verdict enum.
// Rule #223: the REAL toPublicGateLine / installPublicGateLog, fed RECORDED lines (verbatim from run 39524054966, 2026-10-21 00:58Z,
// the run the plan's review found leaking bolt-wms#3936's verdict text). Rule #322/#471: known-bad (every leak shape is gone) AND
// known-good (the fields the monitors and operators need survive; the health monitor's real parser still reads the receipts).

const LIVE_WAIT_FLAG =
  "[wait] pr-automerge-gate studio-b-ai/bolt-wms#3936: a review FLAG blue card already stands on head 6c39cf6 — parked; the model vote is NOT re-rolled under a flag (stint #724: re-rolling merged flagged PRs with no human key). Doors: a human `box` label on this head (sha-pinned, overrides every decision leg), the transition-week `reviewed` receipt, `hold` to park harder, or a new head.";
const LIVE_RECEIPT_FLAG =
  '[gate-receipt] repo=studio-b-ai/bolt-wms pr=3936 class=code-fix verdict=missed leg=review reasons="a review FLAG blue card already stands on head 6c39cf6 — parked; the model vote is NOT re-rolled under a flag (stint #724: re-rolling merged flagged PRs with no human key). Doors: a human `box` label on this head (sha-pinned, overrides every decision leg), the transition-week `reviewed` receipt, `hold` to park harder, or a new head."';
const LIVE_WAIT_BEHIND = "[wait] pr-automerge-gate studio-b-ai/claude-hooks#59: short-circuit — state=OPEN isDraft=false ciClean=true mergeStateStatus=BEHIND. No diff fetch, no review call.";
const LIVE_RECEIPT_BEHIND =
  '[gate-receipt] repo=studio-b-ai/claude-hooks pr=59 class=unclassified verdict=missed leg=ci-rollup reasons="state=OPEN isDraft=false ciClean=true mergeStateStatus=BEHIND"';
const SHA = "082fc0c49cc35bfff362ca97ea9d9b14046de91a";
const LIVE_INFO_SHA = `[info] pr-automerge-gate studio-b-ai/claude-hooks#62: DIRTY and update-branch refused (real conflict) — Command failed: gh api -X PUT repos/studio-b-ai/claude-hooks/pulls/62/update-branch -f expected_head_sha=${SHA}`;

describe("toPublicGateLine — known-bad: every recorded leak shape is reduced", () => {
  it("a [wait] line keeps its tag and repo#pr, loses the whole sentence", () => {
    expect(toPublicGateLine(LIVE_WAIT_FLAG)).toBe("[wait] pr-automerge-gate studio-b-ai/bolt-wms#3936");
    expect(toPublicGateLine(LIVE_WAIT_BEHIND)).toBe("[wait] pr-automerge-gate studio-b-ai/claude-hooks#59");
  });
  it("a [gate-receipt] line keeps repo, pr, class, verdict, leg and LOSES reasons=", () => {
    expect(toPublicGateLine(LIVE_RECEIPT_FLAG)).toBe("[gate-receipt] repo=studio-b-ai/bolt-wms pr=3936 class=code-fix verdict=missed leg=review");
    expect(toPublicGateLine(LIVE_RECEIPT_BEHIND)).toBe("[gate-receipt] repo=studio-b-ai/claude-hooks pr=59 class=unclassified verdict=missed leg=ci-rollup");
  });
  it("a [train-gate-receipt] line keeps the outcome enum and LOSES detail=", () => {
    const raw = '[train-gate-receipt] repo=studio-b-ai/client-asthetik pr=391 outcome=refused detail="not merge-ready (state=OPEN isDraft=false ciClean=true mergeStateStatus=DIRTY)"';
    expect(toPublicGateLine(raw)).toBe("[train-gate-receipt] repo=studio-b-ai/client-asthetik pr=391 outcome=refused");
  });
  it.each([
    ["safe-path globs", "GATE_SAFE_PATH_GLOBS: src/**,client/src/**,hubspot/src/**,scripts/**,docs/**"],
    ["a review's free-text detail", "review detail: the diff touches src/pricing/engine.ts and weakens the margin floor"],
    ["a stack trace head", "Error: gh: Resource not accessible by integration (HTTP 403)"],
    ["a stack trace frame", "    at execFileSync (node:child_process:1:2)"],
    ["an untagged diagnostic", "anthropic credentials: federation (rule fdrl_01ABC)"],
    ["an empty line", ""],
    ["a workflow command", "::error::something private"],
    ["an excluded line with trailing text", "excluded: native o/r and some private detail"],
  ])("drops %s", (_n, raw) => {
    const out = toPublicGateLine(raw);
    expect(out).toBeNull();
    expect(out ?? "").not.toMatch(/secret|private|pricing|src\/|rule fdrl/);
  });
  it("a receipt whose verdict is not an enum keeps its tag ONLY — no field survives unvalidated", () => {
    expect(toPublicGateLine('[gate-receipt] repo=o/r pr=1 class=x verdict=whatever reasons="secret"')).toBe("[gate-receipt]");
  });
  it("a tagged line's free text — even one that itself looks like a field — never survives", () => {
    const out = toPublicGateLine("[no-op] pr-automerge-gate o/r#9: the review said repo=evil/x pr=1 verdict=qualified because of the margin floor");
    expect(out).toBe("[no-op] pr-automerge-gate o/r#9");
  });
});

describe("toPublicGateLine — known-good: repo, PR, SHA and the verdict enum survive", () => {
  it("a 40-hex SHA anywhere in a tagged line is kept (and only that)", () => {
    expect(toPublicGateLine(LIVE_INFO_SHA)).toBe(`[info] pr-automerge-gate studio-b-ai/claude-hooks#62 sha=${SHA}`);
  });
  it("[merged] keeps tag, repo#pr and the merged SHA", () => {
    expect(toPublicGateLine(`[merged] pr-automerge-gate o/r#12: all legs passed, squash-merged at ${SHA}.`)).toBe(`[merged] pr-automerge-gate o/r#12 sha=${SHA}`);
  });
  it("a qualified receipt (no leg) is unchanged", () => {
    const raw = "[gate-receipt] repo=studio-b-ai/bolt-wms pr=50 class=ci-infra verdict=qualified";
    expect(toPublicGateLine(raw)).toBe(raw);
  });
  it("enroll-style lines keep repo#pr and the enum leg", () => {
    expect(toPublicGateLine("[enroll-skipped] studio-b-ai/bolt-wms#3936 leg=review: no enroll door configured (WEBHOOK_ROUTER_URL + SEAT_INBOX_TOKEN)")).toBe(
      "[enroll-skipped] studio-b-ai/bolt-wms#3936 leg=review",
    );
  });
  it("the native-exclusion lines pass verbatim", () => {
    for (const l of [
      "excluded: native studio-b-ai/toto",
      "excluded: native-check-failed studio-b-ai/toto (fail-closed: ruleset read failed)",
      "excluded: native-check-failed <invalid-repo-name> (fail-closed: ruleset read failed)",
    ]) {
      expect(toPublicGateLine(l)).toBe(l);
    }
  });
  it("the crash line is reduced to a fixed sentence (the stack is dropped)", () => {
    expect(toPublicGateLine("pr-automerge-gate failed: Error: boom")).toBe("pr-automerge-gate failed (detail withheld from the public log)");
  });
  it("the health monitor's REAL parser reads the sanitized receipts exactly as it read the raw ones (no monitor regression)", () => {
    const raw = [LIVE_RECEIPT_FLAG, LIVE_RECEIPT_BEHIND, "[gate-receipt] repo=studio-b-ai/bolt-wms pr=50 class=ci-infra verdict=qualified", '[gate-receipt] repo=studio-b-ai/bolt-wms pr=7 class=unclassified verdict=missed leg=other reasons="unexpected error: x"'].join("\n");
    const sanitized = raw.split("\n").map((l) => toPublicGateLine(l)).join("\n");
    expect(parseReceipts(sanitized)).toEqual(parseReceipts(raw));
    expect(parseReceipts(sanitized)).toHaveLength(4);
    expect(sanitized).not.toContain("reasons=");
  });
});

describe("installPublicGateLog — the console is the choke point", () => {
  function fakeConsole() {
    const out: Record<string, string[]> = { log: [], info: [], warn: [], error: [], debug: [] };
    const c = Object.fromEntries(Object.keys(out).map((m) => [m, (...a: unknown[]) => void out[m].push(a.map(String).join(" "))])) as unknown as Pick<Console, "log" | "info" | "warn" | "error" | "debug">;
    return { c, out };
  }
  it("every method is wrapped; a multi-line message is sanitized line by line; unknown lines vanish", () => {
    const { c, out } = fakeConsole();
    installPublicGateLog(c);
    c.log(`${LIVE_WAIT_FLAG}\nsomething private\n${LIVE_RECEIPT_FLAG}`);
    c.error("pr-automerge-gate failed: Error: boom\n    at x (y.ts:1:2)");
    c.warn("warning with private text");
    c.info(`[info] pr-automerge-gate o/r#1: detail ${SHA}`);
    c.debug("debug private");
    expect(out.log).toEqual(["[wait] pr-automerge-gate studio-b-ai/bolt-wms#3936", "[gate-receipt] repo=studio-b-ai/bolt-wms pr=3936 class=code-fix verdict=missed leg=review"]);
    expect(out.error).toEqual(["pr-automerge-gate failed (detail withheld from the public log)"]);
    expect(out.warn).toEqual([]);
    expect(out.info).toEqual([`[info] pr-automerge-gate o/r#1 sha=${SHA}`]);
    expect(out.debug).toEqual([]);
  });
  it("format arguments are applied before sanitizing (console.log('%s', …) cannot smuggle text past it)", () => {
    const { c, out } = fakeConsole();
    installPublicGateLog(c);
    c.log("[wait] pr-automerge-gate o/r#2: %s", "private reason");
    expect(out.log).toEqual(["[wait] pr-automerge-gate o/r#2"]);
  });
  it("idempotent (a second install does not double-wrap) and restorable", () => {
    const { c, out } = fakeConsole();
    const originalLog = c.log;
    const restore = installPublicGateLog(c);
    const wrapped = c.log;
    installPublicGateLog(c);
    expect(c.log).toBe(wrapped);
    c.log(LIVE_WAIT_BEHIND);
    expect(out.log).toEqual(["[wait] pr-automerge-gate studio-b-ai/claude-hooks#59"]); // once, not twice
    restore();
    expect(c.log).toBe(originalLog);
  });
});
