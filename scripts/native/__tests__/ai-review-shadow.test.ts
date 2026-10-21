/**
 * go-native P1 — SHADOW MUST NOT BLOCK, through the real functions (#223).
 *
 * toto is still served by the old merge robot, whose `isRollupClean` treats ANY failing latest-per-name check as "not clean". So while a repo's
 * manifest entry is shadow (live:false) every check run the sweep posts must be conclusion `neutral` — whatever the verdict — and only a
 * live:true repo may get success / failure. The would-be verdict rides in external_id and output.summary.
 *
 * Every guard has its known-bad and its known-good through the same instrument (#322 / #471):
 *   known-bad   a shadow repo PR that the model BLOCKs posts neutral, not failure
 *   known-good  the SAME PR with the repo live:true posts failure
 * and the old robot's own `isRollupClean` is run on what was actually posted (neutral is clean, failure is not — the control that makes the
 * clean result mean something).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_REVIEWER_SLUG, main, runPost, runReview } from "../../ai-review.js";
import { evaluatePr, type EvalResult } from "../../lib/ai-review-evaluate.js";
import { openHandoff, sealHandoff, type Handoff, type HandoffEntry } from "../../lib/ai-review-handoff.js";
import { formatLogEvent, toPublicLine } from "../../lib/ai-review-log.js";
import { parseManifest, type Manifest } from "../../lib/ai-review-manifest.js";
import { SIZE_CAP } from "../../lib/ai-review-rubric.js";
import { isRollupClean, type RollupItem } from "../../lib/automerge-classify.js";
import { CLEAN_DIFF, HEAD, MB1, PASS, REPO, REVIEWER, block, makeClient, makeGh, makeWorld, noSleep, sha, type PrFixture, type World } from "./helpers.js";

const manifestOf = (live: boolean, shadow: boolean): Manifest => parseManifest({ repos: [{ repo: REPO, live, shadow }] });
const SHADOW = manifestOf(false, true);
const LIVE = manifestOf(true, false);
const PASS_ID = `v1:pass::${MB1}`;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

async function evaluate(world: World, mode: "live" | "shadow", model: Parameters<typeof makeClient>[0], pr = 7) {
  const g = makeGh(world);
  const c = makeClient(model);
  const result = await evaluatePr({ gh: g.gh, client: c.client, reviewerSlug: REVIEWER.slug, sleep: noSleep }, REPO, mode, pr);
  return { result, ...g, ...c };
}
function posted(r: EvalResult) {
  expect(r.kind).toBe("post");
  if (r.kind !== "post") throw new Error("unreachable");
  return r;
}
const worldOf = (pr: Partial<PrFixture> = {}, codeowners: "ok" | "absent" | "errors" = "ok"): World => makeWorld(REPO, { prs: [{ number: 7, ...pr }], codeowners });

/** One whole sweep, as the two jobs run it: review (reads) then post (writes, as the reviewer App), against one world. */
async function sweep(world: World, manifest: Manifest, model: Parameters<typeof makeClient>[0]) {
  const g = makeGh(world);
  const c = makeClient(model);
  const { handoff, counts } = await runReview({ gh: g.gh, client: c.client, manifest, reviewerSlug: DEFAULT_REVIEWER_SLUG, sleep: noSleep });
  const p = makeGh(world); // the post half: the reviewer App's identity
  const r = await runPost({ gh: p.gh, manifest, handoff, reviewerAppId: REVIEWER.id });
  return { handoff, counts, r, posts: p.posts, requests: c.requests };
}
const conclusionOf = (req: { body?: unknown }): string => (req.body as { conclusion: string }).conclusion;
const externalIdOf = (req: { body?: unknown }): string => (req.body as { external_id: string }).external_id;
const headOf = (req: { body?: unknown }): string => (req.body as { head_sha: string }).head_sha;

/** The old robot's view of one PR's checks: `qa / node-guards` green plus every `studiob-ai-review` run, as GitHub's rollup reports them (upper-case). */
function rollup(world: World, headSha: string, repo: string = REPO): RollupItem[] {
  const runs = world.checkRuns[`${repo}@${headSha}`] ?? [];
  // pg-enum-drift-exempt: GitHub check-run status in a statusCheckRollup item, not a Postgres enum
  const qa: RollupItem = { name: "qa / node-guards", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-21T00:00:00Z" };
  return [
    qa,
    ...runs.map(
      (r): RollupItem => ({
        name: r.name ?? "studiob-ai-review",
        // pg-enum-drift-exempt: GitHub check-run status in a statusCheckRollup item, not a Postgres enum
        status: "COMPLETED",
        conclusion: (r.conclusion ?? "").toUpperCase(),
        completedAt: new Date(Date.parse("2026-10-21T01:00:00Z") + r.id * 1000).toISOString(),
      }),
    ),
  ];
}

describe("KNOWN-BAD vs KNOWN-GOOD: the same PR, the model BLOCKs it", () => {
  it("SHADOW repo → the check run is NEUTRAL, with the would-be verdict in external_id and summary", async () => {
    const r = await evaluate(worldOf(), "shadow", [block("D"), block("D"), block("D")]);
    const p = posted(r.result);
    expect(p.conclusion).toBe("neutral");
    expect(p.conclusion).not.toBe("failure");
    expect(p.externalId).toBe(`v1:block:D:${MB1}`);
    expect(p.verdict).toEqual({ kind: "block", categories: ["D"], mergeBase: MB1 });
    expect(p.title).toBe("SHADOW, would be BLOCK (D)");
    expect(p.summary.split("\n")[0]).toBe("**studiob-ai-review (shadow): would be BLOCK**");
    expect(p.summary).toContain("this check run is NEUTRAL and blocks nothing");
    expect(p.summary).toContain("- D:");
  });
  it("the SAME PR with the repo LIVE → failure", async () => {
    const r = await evaluate(worldOf(), "live", [block("D"), block("D"), block("D")]);
    const p = posted(r.result);
    expect(p.conclusion).toBe("failure");
    expect(p.externalId).toBe(`v1:block:D:${MB1}`);
    expect(p.title).toBe("BLOCK (D)");
  });
});

describe("shadow: EVERY verdict kind is neutral (a gate failure, a size failure, a secret, a waiver, a pass), never success or failure", () => {
  const TOKEN = ["gh", "p_", "aZ3kQ9mT2vB7nL4xW8cR1dF6hJ5pY0sEuGaZ"].join("");
  const SECRET_DIFF = `diff --git a/a.txt b/a.txt\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+k=${TOKEN}\n`;
  const APPROVE = [{ id: 1, login: "kbibelhausen", state: "APPROVED", commit_id: HEAD }];
  const cases: Array<{ name: string; pr: Partial<PrFixture>; model: Parameters<typeof makeClient>[0]; id: string; live: "success" | "failure" }> = [
    { name: "pass", pr: {}, model: [PASS, PASS, PASS], id: PASS_ID, live: "success" },
    { name: "model block", pr: {}, model: [block("K"), block("K"), block("K")], id: `v1:block:K:${MB1}`, live: "failure" },
    { name: "model block waived by Kevin", pr: { reviews: APPROVE }, model: [block("K"), block("K"), block("K")], id: `v1:waived:K:${MB1}`, live: "success" },
    { name: "fork (F)", pr: { headRepo: "x/y" }, model: [PASS], id: "v1:block:F", live: "failure" },
    { name: "held (H)", pr: { labels: ["hold"] }, model: [PASS], id: "v1:block:H", live: "failure" },
    { name: "stacked base (B)", pr: { baseRef: "stack-a" }, model: [PASS], id: "v1:block:B", live: "failure" },
    { name: "oversize (Z)", pr: { additions: 9999 }, model: [PASS], id: "v1:block:Z", live: "failure" },
    { name: "oversize waived (Z)", pr: { additions: 9999, reviews: APPROVE }, model: [PASS], id: "v1:waived:Z", live: "success" },
    { name: "secret (S)", pr: { diff: SECRET_DIFF }, model: [PASS], id: `v1:block:S:${MB1}`, live: "failure" },
    { name: "model down + Kevin approval", pr: { reviews: APPROVE }, model: [new Error("down")], id: "v1:waived:", live: "success" },
  ];
  for (const c of cases) {
    it(`${c.name}: shadow → neutral; live → ${c.live} (same external_id: the would-be verdict)`, async () => {
      const shadow = posted((await evaluate(worldOf(c.pr), "shadow", c.model)).result);
      expect(shadow.conclusion).toBe("neutral");
      expect(shadow.externalId).toBe(c.id);
      const live = posted((await evaluate(worldOf(c.pr), "live", c.model)).result);
      expect(live.conclusion).toBe(c.live);
      expect(live.externalId).toBe(c.id);
    });
  }
  it("the CODEOWNERS leg (C) is neutral too: errors in shadow post neutral, the same errors live post failure", async () => {
    const w = makeWorld(REPO, { prs: [{ number: 7 }], codeowners: "errors" });
    expect(posted((await evaluate(w, "shadow", [PASS])).result)).toMatchObject({ conclusion: "neutral", externalId: "v1:block:C" });
    expect(posted((await evaluate(w, "live", [PASS])).result)).toMatchObject({ conclusion: "failure", externalId: "v1:block:C" });
  });
});

describe("shadow: re-posting is by (verdict, conclusion): a second shadow sweep posts nothing", () => {
  it("shadow → neutral posted → a second SHADOW sweep is `unchanged`, no new model spend", async () => {
    const world = worldOf();
    const first = await sweep(world, SHADOW, [block("D"), block("D"), block("D")]);
    expect(first.posts).toHaveLength(1);
    expect(conclusionOf(first.posts[0])).toBe("neutral");
    const again = await sweep(world, SHADOW, [PASS, PASS, PASS]);
    expect(again.counts).toMatchObject({ unchanged: 1, post: 0 });
    expect(again.posts).toHaveLength(0);
    expect(again.requests).toHaveLength(0);
  });
});

describe("a later live:true flip RE-DERIVES the verdict — a neutral is never reused as a pass", () => {
  it("a shadow-neutral BLOCK flips to failure on the live sweep (re-posted, not `unchanged`), reusing the cached MODEL verdict (no new spend)", async () => {
    const world = worldOf();
    const s1 = await sweep(world, SHADOW, [block("D"), block("D"), block("D")]);
    expect(conclusionOf(s1.posts[0])).toBe("neutral");
    expect(isRollupClean(rollup(world, HEAD))).toBe(true); // the old robot is not held by it

    const s2 = await sweep(world, LIVE, [PASS, PASS, PASS]); // the model would now PASS: it must not be asked again
    expect(s2.requests).toHaveLength(0);
    expect(s2.counts).toMatchObject({ post: 1, unchanged: 0 });
    expect(s2.posts).toHaveLength(1);
    expect(conclusionOf(s2.posts[0])).toBe("failure");
    expect(externalIdOf(s2.posts[0])).toBe(`v1:block:D:${MB1}`);
    expect(isRollupClean(rollup(world, HEAD))).toBe(false); // live: the block now blocks
  });
  it("a shadow-neutral PASS flips to success on the live sweep (a fresh post, with the live conclusion)", async () => {
    const world = worldOf();
    const s1 = await sweep(world, SHADOW, [PASS, PASS, PASS]);
    expect(conclusionOf(s1.posts[0])).toBe("neutral");
    const s2 = await sweep(world, LIVE, [block("D")]);
    expect(s2.requests).toHaveLength(0);
    expect(s2.posts).toHaveLength(1);
    expect(conclusionOf(s2.posts[0])).toBe("success");
    expect(externalIdOf(s2.posts[0])).toBe(PASS_ID);
  });
  it("the neutral is not evidence about the gates: a neutral PASS posted for a PR with no CODEOWNERS (clean in shadow) does NOT carry through a live flip (block C)", async () => {
    const world = worldOf({}, "absent");
    const s1 = await sweep(world, SHADOW, [PASS, PASS, PASS]);
    expect(externalIdOf(s1.posts[0])).toBe(PASS_ID);
    expect(conclusionOf(s1.posts[0])).toBe("neutral");
    const s2 = await sweep(world, LIVE, [PASS, PASS, PASS]);
    expect(s2.posts).toHaveLength(1);
    expect(externalIdOf(s2.posts[0])).toBe("v1:block:C");
    expect(conclusionOf(s2.posts[0])).toBe("failure");
  });
  it("…nor about a label added after it: neutral PASS, then `hold`, then LIVE → failure H", async () => {
    const world = worldOf();
    await sweep(world, SHADOW, [PASS, PASS, PASS]);
    world.repos[REPO].prs[0].labels = ["hold"];
    const s2 = await sweep(world, LIVE, [PASS]);
    expect(externalIdOf(s2.posts[0])).toBe("v1:block:H");
    expect(conclusionOf(s2.posts[0])).toBe("failure");
  });
  it("a neutral run planted straight into the world (a `pass` external_id the sweep did not derive) is no pass either: live re-derives from the PR", async () => {
    const world = worldOf({ labels: ["hold"] });
    world.checkRuns[`${REPO}@${HEAD}`] = [{ id: 5, status: "completed", conclusion: "neutral", external_id: PASS_ID, app: REVIEWER }];
    const r = await evaluate(world, "live", [PASS]);
    expect(posted(r.result)).toMatchObject({ conclusion: "failure", externalId: "v1:block:H" });
  });
  it("rolling BACK to shadow supersedes a live failure with a neutral (the failure stops blocking), and the next sweep is quiet", async () => {
    const world = worldOf();
    await sweep(world, LIVE, [block("D"), block("D"), block("D")]);
    expect(isRollupClean(rollup(world, HEAD))).toBe(false);
    const back = await sweep(world, SHADOW, [PASS]);
    expect(back.requests).toHaveLength(0);
    expect(conclusionOf(back.posts[0])).toBe("neutral");
    expect(isRollupClean(rollup(world, HEAD))).toBe(true);
    const quiet = await sweep(world, SHADOW, [PASS]);
    expect(quiet.posts).toHaveLength(0);
  });
});

describe("the whole shadow sweep, every kind of PR: nothing posted is a failure, and the old robot's rollup reads every PR as clean", () => {
  const TOKEN = ["gh", "p_", "aZ3kQ9mT2vB7nL4xW8cR1dF6hJ5pY0sEuGaZ"].join("");
  const OTHER = "studio-b-ai/other";
  // shadow reviews at most the 3 newest PRs of a repo, so the six kinds of PR sit in two shadow repos
  const A: PrFixture[] = [
    { number: 1, sha: sha("1"), diff: CLEAN_DIFF }, // clean → pass
    { number: 2, sha: sha("2"), diff: "diff --git a/x b/x\n+++ b/x\n+// disabled assert\n" }, // the model BLOCKs this one
    { number: 3, sha: sha("3"), labels: ["hold"] },
  ];
  const B: PrFixture[] = [
    { number: 4, sha: sha("4"), headRepo: "evil/other" },
    { number: 5, sha: sha("5"), additions: SIZE_CAP.maxChangedLines + 1 },
    { number: 6, sha: sha("6"), diff: `diff --git a/a b/a\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+k=${TOKEN}\n` },
  ];
  const both = (live: boolean): Manifest =>
    parseManifest({ repos: [{ repo: REPO, live, shadow: !live }, { repo: OTHER, live, shadow: !live }] });
  const rollups = (world: World, n: number): RollupItem[] => rollup(world, sha(String(n)), n <= 3 ? REPO : OTHER);

  /** answers by what the framed diff contains: BLOCK D for the disabled assertion, PASS for everything else */
  function contentClient() {
    const requests: Array<{ messages: Array<{ content: string }> }> = [];
    const create = vi.fn(async (req: { messages: Array<{ content: string }> }) => {
      requests.push(req);
      return { content: [{ type: "text", text: req.messages[0].content.includes("disabled assert") ? block("D") : PASS }], stop_reason: "end_turn" };
    });
    return { client: () => ({ messages: { create } }) as unknown as Anthropic, requests };
  }
  const run = async (world: World, manifest: Manifest, client: () => Anthropic) => {
    const g = makeGh(world);
    const { handoff } = await runReview({ gh: g.gh, client, manifest, reviewerSlug: DEFAULT_REVIEWER_SLUG, sleep: noSleep });
    const p = makeGh(world);
    const r = await runPost({ gh: p.gh, manifest, handoff, reviewerAppId: REVIEWER.id });
    return { r, posts: p.posts };
  };

  it("six PRs, shadow: six check runs, all neutral, all rollups clean; the same six LIVE: the blocks fail, the clean one succeeds, no new model spend", async () => {
    const world: World = { repos: { [REPO]: { prs: A }, [OTHER]: { prs: B } }, checkRuns: {} };
    const model = contentClient();
    const shadow = await run(world, both(false), model.client);
    expect(shadow.r).toEqual({ posted: 6, skipped: 0, failed: 0 });
    expect(shadow.posts.map(conclusionOf)).toEqual(Array(6).fill("neutral"));
    // the would-be verdicts: a model block (D), F, H, Z, S, and one pass — read from the external_id with the merge base stripped
    const kinds = shadow.posts.map((x) => externalIdOf(x).replace(/:[0-9a-f]{40}$/, "")).sort();
    expect(kinds).toEqual(["v1:block:D", "v1:block:F", "v1:block:H", "v1:block:S", "v1:block:Z", "v1:pass:"]);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(isRollupClean(rollups(world, n)), `PR ${n}`).toBe(true);

    // CONTROL (#322): the same rollup carrying what the OLD code would have posted for a blocked PR is NOT clean — the instrument can reject
    const wouldHaveBeen = rollups(world, 3).map((i) => (i.name === "studiob-ai-review" ? { ...i, conclusion: "FAILURE" } : i));
    expect(isRollupClean(wouldHaveBeen)).toBe(false);

    const spent = model.requests.length;
    expect(spent).toBe(6); // PRs 1 and 2 were voted on (3 votes each); the other four never reached the model
    const live = await run(world, both(true), model.client);
    expect(model.requests.length).toBe(spent); // the cached MODEL verdicts of PRs 1 and 2 were reused
    const byHead = new Map(live.posts.map((x) => [headOf(x), conclusionOf(x)]));
    expect([...byHead.entries()].sort()).toEqual([
      [sha("1"), "success"],
      [sha("2"), "failure"],
      [sha("3"), "failure"],
      [sha("4"), "failure"],
      [sha("5"), "failure"],
      [sha("6"), "failure"],
    ]);
    expect(isRollupClean(rollups(world, 1))).toBe(true);
    for (const n of [2, 3, 4, 5, 6]) expect(isRollupClean(rollups(world, n)), `PR ${n}`).toBe(false);
  });
});

describe("the post job re-checks the conclusion against the manifest (a failure can never land on a shadow repo)", () => {
  const entry = (over: Partial<HandoffEntry> = {}): HandoffEntry => ({ repo: REPO, pr: 5, headSha: HEAD, conclusion: "neutral", externalId: `v1:block:D:${MB1}`, title: "t", summary: "s", ...over });
  const post = async (manifest: Manifest, entries: HandoffEntry[]) => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD }] });
    const g = makeGh(world);
    const r = await runPost({ gh: g.gh, manifest, handoff: { v: 1, entries } as Handoff, reviewerAppId: REVIEWER.id });
    return { r, posts: g.posts, calls: g.calls };
  };

  it("KNOWN-BAD: a `failure` entry for a SHADOW repo (a stale review job, a manifest that changed between the jobs, a forged-but-authenticated payload) is skipped — no POST, no API call", async () => {
    const x = await post(SHADOW, [entry({ conclusion: "failure" })]);
    expect(x.r).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(x.calls).toHaveLength(0);
  });
  it("KNOWN-GOOD (same instrument): the neutral entry for the same shadow repo is posted, as neutral", async () => {
    const x = await post(SHADOW, [entry()]);
    expect(x.r).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(conclusionOf(x.posts[0])).toBe("neutral");
  });
  it("a `success` entry for a SHADOW repo is skipped too (a shadow review enforces and endorses nothing)", async () => {
    expect((await post(SHADOW, [entry({ conclusion: "success", externalId: PASS_ID })])).r).toEqual({ posted: 0, skipped: 1, failed: 0 });
  });
  it("the reverse: a LIVE repo never receives a neutral — it would read as enforced and enforce nothing; the live failure is posted", async () => {
    expect((await post(LIVE, [entry({ conclusion: "neutral" })])).r).toEqual({ posted: 0, skipped: 1, failed: 0 });
    const ok = await post(LIVE, [entry({ conclusion: "failure" })]);
    expect(ok.r).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(conclusionOf(ok.posts[0])).toBe("failure");
  });
  it("the sealed handoff still refuses a block that claims `success` (neutral is the only conclusion that fits any verdict; success/failure must match the live mapping)", () => {
    const KEY = "k";
    const CTX = { runId: "1", attempt: "1" };
    const opens = (e: HandoffEntry): boolean => {
      try {
        openHandoff(sealHandoff({ v: 1, entries: [e] }, KEY, CTX), KEY, CTX);
        return true;
      } catch {
        return false;
      }
    };
    expect(opens(entry({ conclusion: "neutral" }))).toBe(true);
    expect(opens(entry({ conclusion: "failure" }))).toBe(true);
    expect(opens(entry({ conclusion: "neutral", externalId: PASS_ID }))).toBe(true);
    expect(opens(entry({ conclusion: "success", externalId: PASS_ID }))).toBe(true);
    // known-bad: a block that claims success, a pass that claims failure, a conclusion outside the three
    expect(opens(entry({ conclusion: "success" }))).toBe(false);
    expect(opens(entry({ conclusion: "failure", externalId: PASS_ID }))).toBe(false);
    expect(opens(entry({ conclusion: "cancelled" as unknown as "neutral" }))).toBe(false);
  });
  it("the mismatch is a log line of enums: `post-skipped … reason=mode-mismatch`, accepted by the public-log grammar", () => {
    const line = formatLogEvent({ e: "post-skipped", repo: REPO, pr: 5, reason: "mode-mismatch" });
    expect(line).toBe(`[ai-review] post-skipped ${REPO}#5 reason=mode-mismatch`);
    expect(toPublicLine(line)).toBe(line);
  });
  it("the verdict log line and the posted line carry the conclusion enum (so the public log shows shadow = neutral)", () => {
    const v = formatLogEvent({ e: "verdict", repo: REPO, pr: 1, sha: HEAD, verdict: "block", categories: "S", source: "scan", action: "post", conclusion: "neutral" });
    expect(v).toBe(`[ai-review] ${REPO}#1 sha=${HEAD} verdict=block categories=S source=scan action=post conclusion=neutral`);
    expect(toPublicLine(v)).toBe(v);
    const p = formatLogEvent({ e: "posted", repo: REPO, pr: 1, sha: HEAD, conclusion: "neutral" });
    expect(toPublicLine(p)).toBe(p);
    expect(toPublicLine(`[ai-review] ${REPO}#1 sha=${HEAD} verdict=block categories=S source=scan action=post conclusion=maybe`)).toBeNull();
  });
});

describe("main post with the REAL manifest (toto, shadow): a failure entry is refused, a neutral one is posted", () => {
  const KEY = "handoff-key-material";
  const CTX = { runId: "4242", attempt: "1" };
  const ENV = { GITHUB_RUN_ID: CTX.runId, GITHUB_RUN_ATTEMPT: CTX.attempt, AI_REVIEW_HANDOFF_KEY: KEY, GH_TOKEN: "t", REVIEWER_APP_ID: String(REVIEWER.id) } as NodeJS.ProcessEnv;
  const REAL = new URL("../manifest.json", import.meta.url).pathname;
  const run = async (conclusion: "neutral" | "failure") => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD }] });
    const g = makeGh(world);
    const e: HandoffEntry = { repo: REPO, pr: 5, headSha: HEAD, conclusion, externalId: `v1:block:D:${MB1}`, title: "t", summary: "s" };
    const code = await main(["post"], { ...ENV, AI_REVIEW_HANDOFF: sealHandoff({ v: 1, entries: [e] }, KEY, CTX) }, { gh: g.gh, manifestPath: REAL });
    return { code, posts: g.posts };
  };
  it("failure → exit 0, nothing posted", async () => {
    const r = await run("failure");
    expect(r.code).toBe(0);
    expect(r.posts).toHaveLength(0);
  });
  it("neutral → posted", async () => {
    const r = await run("neutral");
    expect(r.code).toBe(0);
    expect(r.posts).toHaveLength(1);
    expect(conclusionOf(r.posts[0])).toBe("neutral");
  });
});
