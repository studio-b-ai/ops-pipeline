/**
 * go-native P1 — the sweep end to end: the REAL `runReview`, `runPost` and `main` against the recording fake GitHub (#223).
 *   - shadow cap (3 most-recent), live = uncapped; the review half never writes
 *   - the exact check-run payload; reasons ONLY in output.summary
 *   - missing reviewer-App config posts nothing and calls nothing
 *   - the sealed handoff: ciphertext only, bound to the run, tamper-evident
 *   - public-log hygiene: no reason text (and nothing outside the grammar) ever reaches a log line
 */
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REVIEWER_SLUG, main, MAX_PRS_PER_RUN, runPost, runReview } from "../../ai-review.js";
import { openHandoff, sealHandoff, sealWithinLimit, type Handoff, type HandoffEntry } from "../../lib/ai-review-handoff.js";
import { formatLogEvent, installAiReviewLog, toPublicLine } from "../../lib/ai-review-log.js";
import { CATEGORY_ORDER } from "../../lib/ai-review-verdict.js";
import { loadManifest, parseManifest } from "../../lib/ai-review-manifest.js";
import { HEAD, MB1, MB2, PASS, REPO, REVIEWER, block, makeClient, makeGh, makeWorld, noSleep, sha, type PrFixture, type World } from "./helpers.js";

const PASS_ID = `v1:pass::${MB1}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_MANIFEST = join(HERE, "..", "manifest.json");
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nfleet-key-material-for-tests\n-----END RSA PRIVATE KEY-----";
const CTX = { runId: "4242424242", attempt: "1" };
const ENV = { GITHUB_RUN_ID: CTX.runId, GITHUB_RUN_ATTEMPT: CTX.attempt, AI_REVIEW_HANDOFF_KEY: KEY, GH_TOKEN: "unused-token" } as NodeJS.ProcessEnv;

// the sweep prints its (grammar-only) log lines; keep the test output quiet unless a test captures them itself
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const manifestOf = (...entries: Array<{ repo: string; live: boolean; shadow: boolean }>) => parseManifest({ repos: entries });
const SHADOW = manifestOf({ repo: REPO, live: false, shadow: true });
const LIVE = manifestOf({ repo: REPO, live: true, shadow: false });
const deps = (world: World, model: Parameters<typeof makeClient>[0], manifest = SHADOW) => {
  const g = makeGh(world);
  const c = makeClient(model);
  return { g, c, d: { gh: g.gh, client: c.client, manifest, reviewerSlug: DEFAULT_REVIEWER_SLUG, sleep: noSleep } };
};
const prs = (...nums: number[]): PrFixture[] => nums.map((n) => ({ number: n, sha: sha(String(n % 10)) }));

describe("the real manifest", () => {
  it("is exactly toto, shadow — the pilot scope this PR was asked to ship", () => {
    expect(loadManifest(REAL_MANIFEST)).toEqual({ repos: [{ repo: "studio-b-ai/toto", live: false, shadow: true }] });
  });
});

describe("shadow cap and live mode", () => {
  const six = (): World => makeWorld(REPO, { prs: [{ number: 60, draft: true }, ...prs(59, 58, 57, 56, 55)] });
  const prReads = (calls: Array<{ path: string }>): number[] =>
    calls.map((c) => /\/pulls\/(\d+)$/.exec(c.path)?.[1]).filter((n): n is string => !!n).map(Number);

  it("shadow reviews only the 3 most-recent NON-DRAFT PRs (newest first); the draft and the older PRs are never read", async () => {
    const { g, d } = deps(six(), [PASS, PASS, PASS]);
    const r = await runReview(d);
    expect(prReads(g.calls)).toEqual([59, 58, 57]);
    expect(r.counts).toMatchObject({ repos: 1, prs: 3, post: 3 });
    expect(r.handoff.entries.map((e) => e.pr)).toEqual([59, 58, 57]);
  });
  it("known-bad control (same instrument): LIVE mode on the same world reviews all five non-draft PRs", async () => {
    const { g, d } = deps(six(), [PASS, PASS, PASS], LIVE);
    const r = await runReview(d);
    expect(prReads(g.calls)).toEqual([59, 58, 57, 56, 55]);
    expect(r.counts.prs).toBe(5);
  });
  it("the per-sweep budget bounds a live repo (newest first); the rest wait for the next sweep", async () => {
    const { g, d } = deps(six(), [PASS, PASS, PASS], LIVE);
    const r = await runReview({ ...d, maxPrs: 2 });
    expect(prReads(g.calls)).toEqual([59, 58]);
    expect(r.counts).toMatchObject({ prs: 2, skipped: 3 });
    expect(MAX_PRS_PER_RUN).toBeGreaterThan(3);
  });
  it("PRs whose verdict is already posted do not use up the work budget — they cannot starve the older PRs that still need one", async () => {
    const world = six();
    for (const n of [9, 8, 7]) world.checkRuns[`${REPO}@${sha(String(n))}`] = [{ id: 1, status: "completed", conclusion: "success", external_id: PASS_ID, app: REVIEWER }];
    const { g, d } = deps(world, [PASS, PASS, PASS], LIVE);
    const r = await runReview({ ...d, maxPrs: 2 });
    expect(prReads(g.calls)).toEqual([59, 58, 57, 56, 55]);
    expect(r.counts).toMatchObject({ prs: 5, unchanged: 3, post: 2, skipped: 0 });
    expect(r.handoff.entries.map((e) => e.pr)).toEqual([56, 55]);
  });
  it("the evaluation ceiling bounds the API reads of one sweep", async () => {
    const { g, d } = deps(six(), [PASS, PASS, PASS], LIVE);
    const r = await runReview({ ...d, maxEvaluated: 3 });
    expect(prReads(g.calls)).toEqual([59, 58, 57]);
    expect(r.counts).toMatchObject({ prs: 3, skipped: 2 });
  });
  it("a repo that is listed but neither live nor shadow is not touched", async () => {
    const m = manifestOf({ repo: REPO, live: false, shadow: false });
    const { g, d } = deps(six(), [PASS], m);
    const r = await runReview(d);
    expect(g.calls).toHaveLength(0);
    expect(r.counts.repos).toBe(0);
  });
});

describe("the review half never writes", () => {
  it("every request of a full sweep is a GET (no check run, no label, no comment, no merge)", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 1, sha: sha("1") }, { number: 2, sha: sha("2"), labels: ["hold"] }, { number: 3, sha: sha("3"), headRepo: "x/y" }] });
    const { g, d } = deps(world, [block("K"), block("K"), block("K")]);
    const r = await runReview(d);
    expect(r.counts.post).toBe(3);
    expect(g.calls.filter((c) => (c.method ?? "GET") !== "GET")).toEqual([]);
    expect(g.posts).toHaveLength(0);
  });
  it("a repo whose PR list cannot be read is counted, logged, and does not stop the other repos", async () => {
    const world: World = { repos: { [REPO]: { prs: prs(1) }, "studio-b-ai/other": { prs: prs(2) } }, checkRuns: {} };
    world.failOn = (req) => (req.path === `repos/${REPO}/pulls` ? 500 : null);
    const { d } = deps(world, [PASS, PASS, PASS], manifestOf({ repo: REPO, live: false, shadow: true }, { repo: "studio-b-ai/other", live: false, shadow: true }));
    const r = await runReview(d);
    expect(r.counts.errors).toBe(1);
    expect(r.handoff.entries.map((e) => e.repo)).toEqual(["studio-b-ai/other"]);
  });
});

describe("post: the exact check run, reasons only in output.summary", () => {
  it("POSTs one completed `studiob-ai-review` run on the head SHA, with the cache external_id", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD, diff: "REASON-IN-DIFF" }] });
    const { g, d } = deps(world, [block("D", "src/a.ts: REASON-CANARY-7 plain bug"), block("D", "src/a.ts: REASON-CANARY-7 plain bug"), block("D", "src/a.ts: REASON-CANARY-7 plain bug")]);
    const { handoff } = await runReview(d);
    const post = makeGh(world); // post half: a different token/identity, same world
    const r = await runPost({ gh: post.gh, manifest: SHADOW, handoff, reviewerAppId: REVIEWER.id });
    expect(r).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(g.posts).toHaveLength(0);
    expect(post.posts).toHaveLength(1);
    const req = post.posts[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe(`repos/${REPO}/check-runs`);
    expect(req.body).toEqual({
      name: "studiob-ai-review",
      head_sha: HEAD,
      status: "completed",
      conclusion: "failure",
      external_id: `v1:block:D:${MB1}`,
      output: { title: "BLOCK (D)", summary: expect.stringContaining("REASON-CANARY-7") },
    });
    const body = req.body as { name: string; head_sha: string; external_id: string; output: { title: string; summary: string } };
    for (const field of [body.name, body.head_sha, body.external_id, body.output.title]) expect(field).not.toContain("REASON-CANARY-7");
    expect(body.output.summary).not.toContain("REASON-IN-DIFF");
  });

  it("posting twice is idempotent: the reviewer App's own identical verdict is not posted again", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD }] });
    const { d } = deps(world, [PASS, PASS, PASS]);
    const { handoff } = await runReview(d);
    const post = makeGh(world);
    await runPost({ gh: post.gh, manifest: SHADOW, handoff, reviewerAppId: REVIEWER.id });
    const again = await runPost({ gh: post.gh, manifest: SHADOW, handoff, reviewerAppId: REVIEWER.id });
    expect(again).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(post.posts).toHaveLength(1);
  });
  it("…but an identical verdict posted by ANOTHER app does not count (numeric app id, the authoritative match)", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD }] });
    world.checkRuns[`${REPO}@${HEAD}`] = [{ id: 1, status: "completed", conclusion: "success", external_id: PASS_ID, app: { id: 15368, slug: REVIEWER.slug } }];
    const handoff: Handoff = { v: 1, entries: [entry({ externalId: PASS_ID, conclusion: "success" })] };
    const post = makeGh(world);
    const r = await runPost({ gh: post.gh, manifest: SHADOW, handoff, reviewerAppId: REVIEWER.id });
    expect(r.posted).toBe(1);
  });
  it("acts only on repos the manifest names (an authenticated handoff entry for another repo is skipped)", async () => {
    const world: World = { repos: { [REPO]: { prs: [] }, "studio-b-ai/bolt-wms": { prs: [] } }, checkRuns: {} };
    const post = makeGh(world);
    const handoff: Handoff = { v: 1, entries: [entry({ repo: "studio-b-ai/bolt-wms" })] };
    const r = await runPost({ gh: post.gh, manifest: SHADOW, handoff, reviewerAppId: REVIEWER.id });
    expect(r).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(post.calls).toHaveLength(0);
  });
  it("a failed POST is counted as failed and leaves no success (the next sweep re-derives it)", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD }] });
    world.failOn = (req) => ((req.method ?? "GET") === "POST" ? 403 : null);
    const post = makeGh(world);
    const r = await runPost({ gh: post.gh, manifest: SHADOW, handoff: { v: 1, entries: [entry()] }, reviewerAppId: REVIEWER.id });
    expect(r).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(world.checkRuns[`${REPO}@${HEAD}`] ?? []).toHaveLength(0);
  });
});

describe("a retarget, through the whole sweep (runReview → runPost): a verdict never outlives the base it was computed against", () => {
  const MAINDIFF = "diff --git a/qa/qa.mjs b/qa/qa.mjs\n--- a/qa/qa.mjs\n+++ b/qa/qa.mjs\n@@ -1 +1 @@\n-assert(x)\n+// assert(x) disabled\n";
  const sweep = async (world: World, model: Parameters<typeof makeClient>[0]) => {
    const { d, c } = deps(world, model);
    const { handoff } = await runReview(d);
    const post = makeGh(world); // the post half: the reviewer App's identity, same world
    const r = await runPost({ gh: post.gh, manifest: SHADOW, handoff, reviewerAppId: REVIEWER.id });
    return { handoff, r, posts: post.posts, requests: c.requests };
  };

  it("stacked → B posted and no model spend; retargeted to main → ONE fresh review against main; unchanged afterwards → nothing posted, nothing spent", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD, baseRef: "stack-a", mergeBase: MB1 }] });

    const s1 = await sweep(world, [PASS, PASS, PASS]);
    expect(s1.r).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(s1.requests).toHaveLength(0);
    expect((s1.posts[0].body as { external_id: string; conclusion: string }).external_id).toBe("v1:block:B");

    // the crew retargets the PR to main (same head, a different merge base and diff); the model now sees what main would receive
    const pr = world.repos[REPO].prs[0];
    pr.baseRef = "main";
    pr.mergeBase = MB2;
    pr.diff = MAINDIFF;
    const s2 = await sweep(world, [block("D"), block("D"), block("D")]);
    expect(s2.requests).toHaveLength(3);
    expect(s2.r).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(s2.posts[0].body).toMatchObject({ conclusion: "failure", external_id: `v1:block:D:${MB2}` });

    // nothing moved: the verdict stands, is not re-posted, and costs nothing
    const s3 = await sweep(world, [PASS, PASS, PASS]);
    expect(s3.requests).toHaveLength(0);
    expect(s3.r).toEqual({ posted: 0, skipped: 0, failed: 0 });
    expect(s3.handoff.entries).toHaveLength(0);
  });

  it("a PR that PASSED on main and then moved to a stacked base fails B on the next sweep; back on main with the SAME merge base the earlier PASS is reused (no spend)", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD, mergeBase: MB1 }] });
    const s1 = await sweep(world, [PASS, PASS, PASS]);
    expect(s1.posts[0].body).toMatchObject({ conclusion: "success", external_id: PASS_ID });

    const pr = world.repos[REPO].prs[0];
    pr.baseRef = "stack-a";
    const s2 = await sweep(world, [PASS, PASS, PASS]);
    expect(s2.posts[0].body).toMatchObject({ conclusion: "failure", external_id: "v1:block:B" });
    expect(s2.requests).toHaveLength(0);

    pr.baseRef = "main";
    const s3 = await sweep(world, [block("D")]);
    expect(s3.requests).toHaveLength(0); // the PASS for this exact merge base is still valid
    expect(s3.posts[0].body).toMatchObject({ conclusion: "success", external_id: PASS_ID });
  });

  it("runPost dedupe is by the whole external_id, merge base included: the same verdict for ANOTHER merge base is posted, the identical one is skipped", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD }] });
    world.checkRuns[`${REPO}@${HEAD}`] = [{ id: 1, status: "completed", conclusion: "success", external_id: PASS_ID, app: REVIEWER }];
    const post = makeGh(world);
    const other = await runPost({ gh: post.gh, manifest: SHADOW, handoff: { v: 1, entries: [entry({ externalId: `v1:pass::${MB2}` })] }, reviewerAppId: REVIEWER.id });
    expect(other).toEqual({ posted: 1, skipped: 0, failed: 0 });
    const same = await runPost({ gh: post.gh, manifest: SHADOW, handoff: { v: 1, entries: [entry({ externalId: `v1:pass::${MB2}` })] }, reviewerAppId: REVIEWER.id });
    expect(same).toEqual({ posted: 0, skipped: 1, failed: 0 });
  });

  it("the sealed handoff refuses a model verdict with no merge base, and a gate verdict that carries one", () => {
    for (const externalId of ["v1:pass:", "v1:block:D", `v1:block:H:${MB1}`, `v1:waived::${MB1}`, `v1:pass::${"1".repeat(12)}`]) {
      const conclusion = externalId.startsWith("v1:block") ? "failure" : "success";
      expect(() => openHandoff(sealHandoff({ v: 1, entries: [entry({ externalId, conclusion })] }, KEY, CTX), KEY, CTX), externalId).toThrow("handoff: cannot open");
    }
    // known-good through the same instrument
    expect(() => openHandoff(sealHandoff({ v: 1, entries: [entry({ externalId: PASS_ID, conclusion: "success" })] }, KEY, CTX), KEY, CTX)).not.toThrow();
    expect(() => openHandoff(sealHandoff({ v: 1, entries: [entry({ externalId: "v1:block:B", conclusion: "failure" })] }, KEY, CTX), KEY, CTX)).not.toThrow();
  });
});

function entry(over: Partial<HandoffEntry> = {}): HandoffEntry {
  return { repo: REPO, pr: 5, headSha: HEAD, conclusion: "success", externalId: PASS_ID, title: "PASS", summary: "ok", ...over };
}

describe("main post — the reviewer App is not configured yet", () => {
  const exploding = vi.fn(async () => {
    throw new Error("the API must not be called when the reviewer app is not configured");
  });
  afterEach(() => exploding.mockClear());

  async function capture<T>(fn: () => Promise<T>): Promise<{ out: string[]; result: T }> {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(format(...a)));
    const restoreSpyOnly = spy;
    try {
      return { out, result: await fn() };
    } finally {
      restoreSpyOnly.mockRestore();
    }
  }

  for (const id of [undefined, "", "   "]) {
    it(`REVIEWER_APP_ID=${JSON.stringify(id)} → logs "reviewer app not configured; nothing posted", exits 0, posts and calls NOTHING`, async () => {
      const blob = sealHandoff({ v: 1, entries: [entry()] }, KEY, CTX);
      const { out, result } = await capture(() => main(["post"], { ...ENV, REVIEWER_APP_ID: id, AI_REVIEW_HANDOFF: blob }, { gh: exploding, manifestPath: REAL_MANIFEST }));
      expect(result).toBe(0);
      expect(out).toEqual(["[ai-review] reviewer app not configured; nothing posted"]);
      expect(exploding).not.toHaveBeenCalled();
    });
  }
  it("it does not even need the handoff, the key or a token to say so", async () => {
    const { out, result } = await capture(() => main(["post"], {} as NodeJS.ProcessEnv, { gh: exploding, manifestPath: REAL_MANIFEST }));
    expect(result).toBe(0);
    expect(out).toEqual(["[ai-review] reviewer app not configured; nothing posted"]);
  });
  it("known-good control through the same instrument: WITH an app id the same handoff is posted", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD }] });
    const g = makeGh(world);
    const blob = sealHandoff({ v: 1, entries: [entry()] }, KEY, CTX);
    const { result } = await capture(() => main(["post"], { ...ENV, REVIEWER_APP_ID: String(REVIEWER.id), AI_REVIEW_HANDOFF: blob }, { gh: g.gh, manifestPath: REAL_MANIFEST }));
    expect(result).toBe(0);
    expect(g.posts).toHaveLength(1);
  });
  it("a garbage app id is a loud failure, not a silent 'not configured'", async () => {
    const { out, result } = await capture(() => main(["post"], { ...ENV, REVIEWER_APP_ID: "not-a-number" }, { gh: exploding, manifestPath: REAL_MANIFEST }));
    expect(result).toBe(1);
    expect(out).toEqual(["[ai-review] failed leg=app-id"]);
    expect(exploding).not.toHaveBeenCalled();
  });
  it("an empty handoff (the review job had no active repo) posts nothing and succeeds", async () => {
    const g = makeGh(makeWorld());
    const { result } = await capture(() => main(["post"], { ...ENV, REVIEWER_APP_ID: String(REVIEWER.id), AI_REVIEW_HANDOFF: "" }, { gh: g.gh, manifestPath: REAL_MANIFEST }));
    expect(result).toBe(0);
    expect(g.calls).toHaveLength(0);
  });
});

describe("the sealed handoff", () => {
  const H: Handoff = { v: 1, entries: [entry({ summary: "SEALED-CANARY-REASON" })] };

  it("round-trips for the same key and run", () => {
    expect(openHandoff(sealHandoff(H, KEY, CTX), KEY, CTX)).toEqual(H);
  });
  it("carries no plaintext: neither the reasons nor the repo name appear in the blob or in its decoded bytes", () => {
    const blob = sealHandoff(H, KEY, CTX);
    const raw = Buffer.from(blob, "base64");
    for (const needle of ["SEALED-CANARY-REASON", REPO, "studiob-ai-review", "v1:pass"]) {
      expect(blob).not.toContain(needle);
      expect(raw.toString("latin1")).not.toContain(needle);
    }
    // a second seal of the same payload differs (fresh IV)
    expect(sealHandoff(H, KEY, CTX)).not.toBe(blob);
  });
  it("is rejected with a FIXED error for a wrong key, another run, another attempt, a flipped byte, truncation or garbage", () => {
    const blob = sealHandoff(H, KEY, CTX);
    const flipped = Buffer.from(blob, "base64");
    flipped[flipped.length - 1] ^= 0x01;
    const cases: Array<[string, () => unknown]> = [
      ["wrong key", () => openHandoff(blob, KEY + "x", CTX)],
      ["another run", () => openHandoff(blob, KEY, { ...CTX, runId: "4242424243" })],
      ["another attempt", () => openHandoff(blob, KEY, { ...CTX, attempt: "2" })],
      ["flipped byte", () => openHandoff(flipped.toString("base64"), KEY, CTX)],
      ["truncated", () => openHandoff(blob.slice(0, 20), KEY, CTX)],
      ["garbage", () => openHandoff("not base64 at all !!", KEY, CTX)],
      ["empty key", () => openHandoff(blob, "  ", CTX)],
    ];
    for (const [name, fn] of cases) expect(fn, name).toThrow("handoff: cannot open");
  });
  it("an authenticated payload is still shape-checked: a conclusion that contradicts its external_id, or a non-canonical id, is refused", () => {
    expect(() => openHandoff(sealHandoff({ v: 1, entries: [entry({ conclusion: "failure", externalId: PASS_ID })] }, KEY, CTX), KEY, CTX)).toThrow("handoff: cannot open");
    expect(() => openHandoff(sealHandoff({ v: 1, entries: [entry({ conclusion: "failure", externalId: "v1:block:DK" })] }, KEY, CTX), KEY, CTX)).toThrow("handoff: cannot open");
    expect(() => openHandoff(sealHandoff({ v: 1, entries: [entry({ headSha: "abc" })] }, KEY, CTX), KEY, CTX)).toThrow("handoff: cannot open");
    expect(() => openHandoff(sealHandoff({ v: 1, entries: [entry({ repo: "../etc/passwd" })] }, KEY, CTX), KEY, CTX)).toThrow("handoff: cannot open");
  });
  it("sealWithinLimit drops trailing entries until the blob fits (they are re-derived next sweep)", () => {
    // incompressible summaries (gzip would otherwise shrink repeated text to nothing and nothing would need dropping)
    const many: Handoff = { v: 1, entries: Array.from({ length: 40 }, (_, i) => entry({ pr: i + 1, summary: randomBytes(3000).toString("base64") })) };
    const { blob, dropped } = sealWithinLimit(many, KEY, CTX, 8000);
    expect(blob.length).toBeLessThanOrEqual(8000);
    expect(dropped).toBeGreaterThan(0);
    const opened = openHandoff(blob, KEY, CTX);
    expect(opened.entries.map((e) => e.pr)).toEqual(many.entries.slice(0, opened.entries.length).map((e) => e.pr));
    expect(sealWithinLimit(H, KEY, CTX).dropped).toBe(0);
  });
});

describe("main post — tamper evidence", () => {
  async function post(blob: string, env: Partial<NodeJS.ProcessEnv> = {}) {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD }] });
    const g = makeGh(world);
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(format(...a)));
    try {
      const code = await main(["post"], { ...ENV, REVIEWER_APP_ID: String(REVIEWER.id), AI_REVIEW_HANDOFF: blob, ...env }, { gh: g.gh, manifestPath: REAL_MANIFEST });
      return { code, out, posts: g.posts };
    } finally {
      spy.mockRestore();
    }
  }
  it("known-good: the genuine blob posts", async () => {
    const r = await post(sealHandoff({ v: 1, entries: [entry()] }, KEY, CTX));
    expect(r.code).toBe(0);
    expect(r.posts).toHaveLength(1);
  });
  it("a blob sealed under another run is refused and nothing is posted", async () => {
    const r = await post(sealHandoff({ v: 1, entries: [entry()] }, KEY, { runId: "1", attempt: "1" }));
    expect(r.code).toBe(1);
    expect(r.out).toEqual(["[ai-review] failed leg=handoff"]);
    expect(r.posts).toHaveLength(0);
  });
  it("a blob sealed under another key is refused", async () => {
    const r = await post(sealHandoff({ v: 1, entries: [entry()] }, "some other secret", CTX));
    expect(r.code).toBe(1);
    expect(r.posts).toHaveLength(0);
  });
});

describe("main review", () => {
  it("seals the verdicts into $GITHUB_OUTPUT; the blob opens only with the key + run", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 5, sha: HEAD, diff: "diff-with-DIFF-CANARY" }] });
    const g = makeGh(world);
    const c = makeClient([block("K", "REASON-CANARY-review"), block("K", "REASON-CANARY-review"), block("K", "REASON-CANARY-review")]);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let code: number;
    try {
      code = await main(["review"], ENV, { gh: g.gh, client: c.client, manifestPath: REAL_MANIFEST, appendOutput: (l) => lines.push(l), sleep: noSleep });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^handoff=[A-Za-z0-9+/=]+$/);
    const blob = lines[0].slice("handoff=".length);
    expect(blob).not.toContain("REASON-CANARY-review");
    const opened = openHandoff(blob, KEY, CTX);
    expect(opened.entries).toHaveLength(1);
    expect(opened.entries[0]).toMatchObject({ repo: REPO, pr: 5, headSha: HEAD, conclusion: "failure", externalId: `v1:block:K:${MB1}` });
    expect(opened.entries[0].summary).toContain("REASON-CANARY-review");
    expect(() => openHandoff(blob, KEY, { ...CTX, runId: "9" })).toThrow();
  });
  it("refuses to run without the key / run context / a token (exit 1, one enum line)", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(format(...a)));
    try {
      expect(await main(["review"], { ...ENV, AI_REVIEW_HANDOFF_KEY: "" }, { manifestPath: REAL_MANIFEST })).toBe(1);
      expect(await main(["review"], { ...ENV, GITHUB_RUN_ID: "" }, { manifestPath: REAL_MANIFEST })).toBe(1);
      expect(await main(["review"], { ...ENV, GH_TOKEN: "" }, { manifestPath: REAL_MANIFEST })).toBe(1);
      expect(await main(["review"], { ...ENV, REVIEWER_APP_SLUG: "Bad Slug!" }, { gh: makeGh(makeWorld()).gh, manifestPath: REAL_MANIFEST })).toBe(1);
      expect(await main(["bogus"], ENV)).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(out).toEqual(["[ai-review] failed leg=env", "[ai-review] failed leg=env", "[ai-review] failed leg=env", "[ai-review] failed leg=env", "[ai-review] failed leg=usage"]);
  });
  it("a manifest that cannot be read exactly fails closed (exit 1, leg manifest)", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(format(...a)));
    try {
      expect(await main(["review"], ENV, { gh: makeGh(makeWorld()).gh, manifestPath: join(HERE, "does-not-exist.json") })).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(out).toEqual(["[ai-review] failed leg=manifest"]);
  });
});

describe("public-log hygiene — no reason text, and nothing outside the grammar, reaches a log line", () => {
  const CANARIES = ["REASON-CANARY-log", "DIFF-CANARY-log", "LABEL-CANARY-log", "SECRET-CANARY-codeowners", "ERR-CANARY-log"];

  function capture(install: boolean) {
    const out: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(format(...a))));
    const restore = install ? installAiReviewLog() : () => undefined;
    return {
      out,
      done: () => {
        restore();
        for (const s of spies) s.mockRestore();
      },
    };
  }

  it("CONTROL (#322): without the choke point a stray log line DOES reach the output — so the clean result below is not a vacuous pass", () => {
    const cap = capture(false);
    console.log("reason: REASON-CANARY-log");
    cap.done();
    expect(cap.out.join("\n")).toContain("REASON-CANARY-log");
  });

  it("a full sweep + post over every leg (model block with reasons, hold label, CODEOWNERS errors, fork, API failures) logs only grammar lines and no canary", async () => {
    const world: World = {
      repos: {
        [REPO]: {
          prs: [
            { number: 11, sha: sha("1"), diff: "+x DIFF-CANARY-log" },
            { number: 12, sha: sha("2"), labels: ["needs-human", "LABEL-CANARY-log"] },
            { number: 13, sha: sha("3"), headRepo: "evil/toto" },
            { number: 14, sha: sha("4") },
          ],
        },
        "studio-b-ai/other": { prs: [{ number: 21, sha: sha("5") }], codeowners: "errors" },
        "studio-b-ai/third": { prs: [{ number: 31, sha: sha("6") }] },
      },
      checkRuns: {},
    };
    world.failOn = (req) => (req.path.startsWith("repos/studio-b-ai/third/pulls") && !/\/pulls\/\d+/.test(req.path) ? 500 : req.path.endsWith(`${sha("4")}/check-runs`) ? 403 : null);
    const manifest = manifestOf({ repo: REPO, live: true, shadow: false }, { repo: "studio-b-ai/other", live: true, shadow: false }, { repo: "studio-b-ai/third", live: true, shadow: false });
    const g = makeGh(world);
    const c = makeClient([block("K", "src/a.ts: REASON-CANARY-log"), block("K", "src/a.ts: REASON-CANARY-log"), block("K", "src/a.ts: REASON-CANARY-log")]);
    const cap = capture(true);
    try {
      // hostile direct prints from "elsewhere in the process" (an SDK warning, the credential-mode line, a stack)
      console.log("anthropic credentials: federation (rule fdrl_ERR-CANARY-log)");
      console.error(new Error("ERR-CANARY-log"));
      const { handoff, counts } = await runReview({ gh: g.gh, client: c.client, manifest, reviewerSlug: DEFAULT_REVIEWER_SLUG, sleep: noSleep });
      expect(counts.errors).toBeGreaterThanOrEqual(2); // the failing repo list and the failing check-runs read
      expect(handoff.entries.length).toBeGreaterThanOrEqual(3);
      // the reasons really are in the handoff (so absence from the log is meaningful)…
      expect(JSON.stringify(handoff)).toContain("REASON-CANARY-log");
      expect(JSON.stringify(handoff)).toContain("SECRET-CANARY-codeowners");
      const post = makeGh(world);
      await runPost({ gh: post.gh, manifest, handoff, reviewerAppId: REVIEWER.id });
      expect(post.posts.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(post.posts[0].body)).toMatch(/CANARY/);
    } finally {
      cap.done();
    }
    // …and not in the log
    const log = cap.out.join("\n");
    for (const canary of CANARIES) expect(log).not.toContain(canary);
    expect(cap.out.length).toBeGreaterThan(5);
    for (const line of cap.out) expect(toPublicLine(line), line).toBe(line);
  });

  it("every category letter of the closed vocabulary (all ten, B included) survives the log grammar — it never collapses to `-`", () => {
    const all = CATEGORY_ORDER.join("");
    const line = formatLogEvent({ e: "verdict", repo: REPO, pr: 1, sha: HEAD, verdict: "block", categories: all, source: "gate", action: "post" });
    expect(line).toContain(`categories=${all} `);
    expect(toPublicLine(line)).toBe(line);
    expect(formatLogEvent({ e: "verdict", repo: REPO, pr: 1, sha: HEAD, verdict: "block", categories: "B", source: "gate", action: "post" })).toContain("categories=B ");
    // known-bad: a category string outside the closed letters is still replaced, not printed
    expect(formatLogEvent({ e: "verdict", repo: REPO, pr: 1, sha: HEAD, verdict: "block", categories: "K reason=x", source: "gate", action: "post" })).toContain("categories=- ");
  });

  it("the grammar refuses free text even when it is shaped like a log line", () => {
    for (const bad of [
      "[ai-review] studio-b-ai/toto#1 verdict=block categories=K reason=REASON-CANARY",
      "[ai-review] studio-b-ai/toto#1 sha=xyz verdict=block categories=K source=model action=post",
      "[ai-review] failed leg=Some Free Text",
      "[ai-review] posted studio-b-ai/toto#1 sha=" + "a".repeat(40) + " conclusion=success extra",
      "anything else",
    ]) {
      expect(toPublicLine(bad), bad).toBeNull();
    }
    expect(toPublicLine("[ai-review] failed leg=model")).toBe("[ai-review] failed leg=model");
  });
});
