/**
 * go-native P1 — SECRETS ARE NEVER SKIPPED, through the real `evaluatePr` (and `runReview` / `runPost` behind it) (#223).
 *
 * Category S must be evaluated on every head SHA whose verdict could be a SUCCESS, by a deterministic scan of the diff, BEFORE any waiver is
 * consulted. The two paths that used to post a success with no secret evaluation — the size-cap (Z) waiver and the model-down waiver — are
 * the ones pinned here, each with its known-bad (a planted fake credential + Kevin's approval → failure S) and its known-good (the same
 * diff, clean → the success the waiver is for). #322 / #471: the known-good is what proves the gate is not simply refusing everything.
 *
 * The fake credential is assembled at run time, so no line of this repo contains a contiguous secret shape (the repo's own gitleaks guard).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REVIEWER_SLUG, runPost, runReview } from "../../ai-review.js";
import { evaluatePr, type EvalResult } from "../../lib/ai-review-evaluate.js";
import { parseManifest } from "../../lib/ai-review-manifest.js";
import { SIZE_CAP } from "../../lib/ai-review-rubric.js";
import { CLEAN_DIFF, HEAD, MB1, MB2, OLD_HEAD, PASS, REPO, REVIEWER, block, makeClient, makeGh, makeWorld, noSleep, type PrFixture, type World } from "./helpers.js";

const j = (...p: string[]): string => p.join("");
const TOKEN = j("gh", "p_", "aZ3kQ9mT2vB7nL4xW8cR1dF6hJ5pY0sEuGaZ");
const PEM_BEGIN = j("-----BEGIN RSA PRIV", "ATE KEY-----");
const PEM_BODY = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun";

const diffAdding = (lines: string[], path = "docs/notes.md"): string =>
  [`diff --git a/${path} b/${path}`, "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => "+" + l)].join("\n") + "\n";
const SECRET_DIFF = diffAdding(["# notes", `deploy_token = ${TOKEN}`]);
const KEY_DIFF = diffAdding([PEM_BEGIN, PEM_BODY, PEM_BODY.split("").reverse().join("")], "ops/id.pem");
/** over the BYTE cap while small in lines and files: the model leg's own size gate */
const bytePadded = (tail: string): string => `${diffAdding(["x".repeat(SIZE_CAP.maxDiffBytes)])}${tail}`;

const APPROVE = (commit: string | null = HEAD): PrFixture["reviews"] => [{ id: 1, login: "kbibelhausen", state: "APPROVED", commit_id: commit }];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

async function run(pr: Partial<PrFixture>, model: Parameters<typeof makeClient>[0] = [PASS, PASS, PASS], mode: "live" | "shadow" = "live", world?: World) {
  const w = world ?? makeWorld(REPO, { prs: [{ number: 7, ...pr }] });
  const g = makeGh(w);
  const c = makeClient(model);
  const result = await evaluatePr({ gh: g.gh, client: c.client, reviewerSlug: REVIEWER.slug, sleep: noSleep }, REPO, mode, 7);
  return { result, world: w, ...g, ...c };
}
function posted(r: EvalResult) {
  expect(r.kind).toBe("post");
  if (r.kind !== "post") throw new Error("unreachable");
  return r;
}
const compares = (calls: Array<{ path: string; accept?: string }>) => calls.filter((c) => /\/compare\//.test(c.path)).map((c) => (c.accept ? "diff" : "merge-base"));
const touched = (calls: Array<{ path: string }>, re: RegExp) => calls.some((c) => re.test(c.path));
const noSecretText = (s: string): void => {
  expect(s).not.toContain(TOKEN);
  expect(s).not.toContain(TOKEN.slice(6));
  expect(s).not.toContain(PEM_BODY.slice(0, 24));
};

describe("THE Z WAIVER: an oversized PR + Kevin's approval", () => {
  it("KNOWN-BAD (size by lines/files): planted fake token + Kevin's approval on the head → failure S, unwaived, never `waived:Z`", async () => {
    const r = await run({ additions: 9999, reviews: APPROVE(), diff: SECRET_DIFF });
    const p = posted(r.result);
    expect(p.conclusion).toBe("failure");
    expect(p.externalId).toBe(`v1:block:S:${MB1}`);
    expect(p.verdict).toEqual({ kind: "block", categories: ["S"], mergeBase: MB1 });
    expect(p.source).toBe("scan");
    expect(p.title).toBe("BLOCK (S)");
    expect(p.summary).toContain("secret scan: a GitHub token in docs/notes.md");
    expect(p.summary).toContain("changed lines in"); // the size is reported too
    expect(p.summary).toContain("S cannot be waived");
    expect(p.summary).not.toContain("approve this exact commit"); // an approval cannot clear this, so none is offered
    noSecretText(p.summary + p.title + p.externalId);
    expect(r.requests).toHaveLength(0); // no model call: S is decided without it
    expect(touched(r.calls, /\/reviews$/)).toBe(false); // the approval is never even read: S is not waivable
  });
  it("KNOWN-GOOD (same instrument, same size, same approval): the CLEAN oversized diff → success `waived:Z`", async () => {
    const r = await run({ additions: 9999, reviews: APPROVE(), diff: CLEAN_DIFF });
    const p = posted(r.result);
    expect(p.conclusion).toBe("success");
    expect(p.externalId).toBe("v1:waived:Z");
    expect(compares(r.calls)).toEqual(["merge-base", "diff"]); // the diff was read and scanned before the waiver could post
  });
  it("CONTROL (the other verdict): the clean oversized diff WITHOUT the approval is failure Z — the approval is what flips it, and only it", async () => {
    expect(posted((await run({ additions: 9999, diff: CLEAN_DIFF })).result)).toMatchObject({ conclusion: "failure", externalId: "v1:block:Z" });
    expect(posted((await run({ additions: 9999, diff: CLEAN_DIFF, reviews: APPROVE(OLD_HEAD) })).result)).toMatchObject({ conclusion: "failure", externalId: "v1:block:Z" });
  });
  it("KNOWN-BAD (size by BYTES, found after the fetch): planted token + approval → failure S; the clean padded diff + approval → waived:Z", async () => {
    const bad = await run({ reviews: APPROVE(), diff: bytePadded(diffAdding([`k=${TOKEN}`], "src/k.ts")) });
    expect(posted(bad.result)).toMatchObject({ conclusion: "failure", externalId: `v1:block:S:${MB1}` });
    expect(bad.requests).toHaveLength(0);
    const good = await run({ reviews: APPROVE(), diff: bytePadded("") });
    expect(posted(good.result)).toMatchObject({ conclusion: "success", externalId: "v1:waived:Z" });
    expect(good.requests).toHaveLength(0);
    expect(compares(good.calls)).toEqual(["merge-base", "diff"]); // read once, shared by the scan and the byte cap
  });
  it("a private key is found the same way (PEM block, oversized, approved) → failure S", async () => {
    const r = await run({ additions: 9999, reviews: APPROVE(), diff: KEY_DIFF });
    const p = posted(r.result);
    expect(p.externalId).toBe(`v1:block:S:${MB1}`);
    expect(p.summary).toContain("secret scan: a private key in ops/id.pem");
    noSecretText(p.summary);
  });
  it("S dominates Z with no approval too: the oversized PR with a secret reports S (so the author removes it), not just Z", async () => {
    const p = posted((await run({ additions: 9999, diff: SECRET_DIFF })).result);
    expect(p.externalId).toBe(`v1:block:S:${MB1}`);
    expect(p.conclusion).toBe("failure");
  });
  it("a PR that REMOVES the leaked credential is not blocked for it (oversized + approved + the token only on a `-` line → waived:Z)", async () => {
    const removal = ["diff --git a/a.md b/a.md", "--- a/a.md", "+++ b/a.md", "@@ -1,2 +1,1 @@", ` keep`, `-deploy_token = ${TOKEN}`, ""].join("\n");
    expect(posted((await run({ additions: 9999, reviews: APPROVE(), diff: removal })).result)).toMatchObject({ conclusion: "success", externalId: "v1:waived:Z" });
  });
  it("an oversized PR whose diff CANNOT BE READ never gets a success: with the approval, no verdict (the earlier failure stands); without it, still failure Z, and it says why", async () => {
    for (const [what, failOn, leg] of [
      ["diff", (req: { path: string; accept?: string }) => (/compare/.test(req.path) && req.accept ? 502 : null), "diff"],
      ["merge base", (req: { path: string; accept?: string }) => (/compare/.test(req.path) && !req.accept ? 502 : null), "base"],
    ] as const) {
      const world = makeWorld(REPO, { prs: [{ number: 7, additions: 9999, reviews: APPROVE() }] });
      world.failOn = failOn;
      expect((await run({}, [PASS], "live", world)).result, what).toEqual({ kind: "error", leg });
      const bare = makeWorld(REPO, { prs: [{ number: 7, additions: 9999 }] });
      bare.failOn = failOn;
      const p = posted((await run({}, [PASS], "live", bare)).result);
      expect(p.externalId, what).toBe("v1:block:Z");
      expect(p.summary).toContain("the secret scan could not read the diff");
    }
  });
  it("a failed reviews read is still no verdict for a CLEAN oversized PR (unchanged rule), but a secret is decided before the reviews are read at all", async () => {
    const clean = makeWorld(REPO, { prs: [{ number: 7, additions: 9999, diff: CLEAN_DIFF }] });
    clean.failOn = (req) => (/\/reviews$/.test(req.path) ? 500 : null);
    expect((await run({}, [PASS], "live", clean)).result).toEqual({ kind: "error", leg: "reviews" });
    const dirty = makeWorld(REPO, { prs: [{ number: 7, additions: 9999, diff: SECRET_DIFF }] });
    dirty.failOn = (req) => (/\/reviews$/.test(req.path) ? 500 : null);
    expect(posted((await run({}, [PASS], "live", dirty)).result).externalId).toBe(`v1:block:S:${MB1}`);
  });
});

describe("THE MODEL-DOWN WAIVER: no model verdict + Kevin's approval", () => {
  const down = [new Error("model down")];

  it("KNOWN-BAD: model down, planted token, Kevin approved the head → failure S (not `waived:`), with ZERO model calls — the scan runs first", async () => {
    const r = await run({ reviews: APPROVE(), diff: SECRET_DIFF }, down);
    const p = posted(r.result);
    expect(p.conclusion).toBe("failure");
    expect(p.externalId).toBe(`v1:block:S:${MB1}`);
    expect(p.externalId).not.toBe("v1:waived:");
    expect(r.requests).toHaveLength(0);
    expect(r.built()).toBe(0);
  });
  it("KNOWN-GOOD (same instrument): model down, CLEAN diff, Kevin approved the head → success `waived:` (the deadlock-avoidance the waiver exists for still works)", async () => {
    const r = await run({ reviews: APPROVE(), diff: CLEAN_DIFF }, down);
    expect(posted(r.result)).toMatchObject({ conclusion: "success", externalId: "v1:waived:" });
    expect(compares(r.calls)).toEqual(["merge-base", "diff"]);
  });
  it("federation down (the client cannot be built) + planted token + approval → still failure S", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 7, reviews: APPROVE(), diff: SECRET_DIFF }] });
    const g = makeGh(world);
    const result = await evaluatePr({ gh: g.gh, client: () => { throw new Error("WIF down"); }, reviewerSlug: REVIEWER.slug, sleep: noSleep }, REPO, "live", 7);
    expect(posted(result).externalId).toBe(`v1:block:S:${MB1}`);
  });
  it("the diff unreadable → the model-down waiver gives NO verdict (the scan could not run), for either unreadable leg", async () => {
    for (const [what, failOn, leg] of [
      ["diff", (req: { path: string; accept?: string }) => (/compare/.test(req.path) && req.accept ? 502 : null), "diff"],
      ["merge base", (req: { path: string; accept?: string }) => (/compare/.test(req.path) && !req.accept ? 502 : null), "base"],
    ] as const) {
      const world = makeWorld(REPO, { prs: [{ number: 7, reviews: APPROVE(), diff: CLEAN_DIFF }] });
      world.failOn = failOn;
      const r = await run({}, down, "live", world);
      expect(r.result, what).toEqual({ kind: "error", leg });
    }
  });
  it("no approval and the model down is still no verdict at all (unchanged); a Kevin approval of an OLDER sha does not resolve it", async () => {
    expect((await run({ diff: CLEAN_DIFF }, down)).result).toEqual({ kind: "error", leg: "model" });
    expect((await run({ diff: CLEAN_DIFF, reviews: APPROVE(OLD_HEAD) }, down)).result).toEqual({ kind: "error", leg: "model" });
  });
  it("a vote-level failure (inconclusive model) with a planted token is S as well — the scan does not depend on how the model fails", async () => {
    const r = await run({ reviews: APPROVE(), diff: SECRET_DIFF }, (i) => (i === 0 ? PASS : new Error("503")));
    expect(posted(r.result).externalId).toBe(`v1:block:S:${MB1}`);
  });
});

describe("THE NORMAL PATHS: the scan runs before the model, so a model PASS cannot let a secret through", () => {
  it("KNOWN-BAD: planted token and a model that would PASS → failure S, the model is never called", async () => {
    const r = await run({ diff: SECRET_DIFF }, [PASS, PASS, PASS]);
    const p = posted(r.result);
    expect(p.conclusion).toBe("failure");
    expect(p.externalId).toBe(`v1:block:S:${MB1}`);
    expect(r.requests).toHaveLength(0);
    expect(r.built()).toBe(0);
  });
  it("KNOWN-GOOD: the clean diff with the same model → pass", async () => {
    const r = await run({ diff: CLEAN_DIFF }, [PASS, PASS, PASS]);
    expect(posted(r.result).externalId).toBe(`v1:pass::${MB1}`);
    expect(r.requests).toHaveLength(3);
  });
  it("a waivable model block (K) with a planted token is S, not a waived K: Kevin's approval for K cannot carry a secret", async () => {
    const r = await run({ reviews: APPROVE(), diff: SECRET_DIFF }, [block("K"), block("K"), block("K")]);
    expect(posted(r.result)).toMatchObject({ conclusion: "failure", externalId: `v1:block:S:${MB1}` });
    expect(r.requests).toHaveLength(0);
    // …known-good through the same instrument: without the token, the same model block + approval IS waived
    const ok = await run({ reviews: APPROVE(), diff: CLEAN_DIFF }, [block("K"), block("K"), block("K")]);
    expect(posted(ok.result)).toMatchObject({ conclusion: "success", externalId: `v1:waived:K:${MB1}` });
  });
  it("the model's own S is still honored when the scan finds nothing (the model stays on top of the floor)", async () => {
    const r = await run({ diff: CLEAN_DIFF, reviews: APPROVE() }, [block("S"), block("S"), block("S")]);
    expect(posted(r.result)).toMatchObject({ conclusion: "failure", externalId: `v1:block:S:${MB1}` });
  });
  it("the S block is cached like any model verdict: the next sweep reads the merge base, not the diff, spends nothing, and posts nothing", async () => {
    const first = await run({ diff: SECRET_DIFF });
    const p = posted(first.result);
    first.world.checkRuns[`${REPO}@${HEAD}`] = [{ id: 100, status: "completed", conclusion: p.conclusion, external_id: p.externalId, app: REVIEWER }];
    const again = await run({}, [PASS, PASS, PASS], "live", first.world);
    expect(again.result.kind).toBe("unchanged");
    expect(compares(again.calls)).toEqual(["merge-base"]);
    expect(again.requests).toHaveLength(0);
  });
  it("…and Kevin's approval does not waive a cached S either; moving the merge base re-scans the new diff (a fixed PR clears)", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 7, reviews: APPROVE(), diff: SECRET_DIFF }] });
    world.checkRuns[`${REPO}@${HEAD}`] = [{ id: 100, status: "completed", conclusion: "failure", external_id: `v1:block:S:${MB1}`, app: REVIEWER }];
    const cached = await run({}, [PASS], "live", world);
    expect(cached.result.kind).toBe("unchanged");
    const pr = world.repos[REPO].prs[0];
    pr.mergeBase = MB2;
    pr.diff = CLEAN_DIFF;
    const fixed = await run({}, [PASS, PASS, PASS], "live", world);
    expect(posted(fixed.result)).toMatchObject({ conclusion: "success", externalId: `v1:pass::${MB2}` });
  });
  it("the deterministic gates that return failure before any diff is read are unchanged: fork, hold, stacked base, CODEOWNERS never touch the diff", async () => {
    for (const pr of [{ headRepo: "x/y" }, { labels: ["hold"] }, { baseRef: "stack-a" }] as Array<Partial<PrFixture>>) {
      const r = await run({ ...pr, diff: SECRET_DIFF });
      expect(posted(r.result).conclusion).toBe("failure");
      expect(compares(r.calls)).toEqual([]);
    }
  });
});

describe("shadow: the S verdicts are neutral and carry the would-be verdict", () => {
  it("Z waiver path: oversized + token + approval in SHADOW → neutral, external_id `v1:block:S:…`, summary says it would block", async () => {
    const r = await run({ additions: 9999, reviews: APPROVE(), diff: SECRET_DIFF }, [PASS], "shadow");
    const p = posted(r.result);
    expect(p.conclusion).toBe("neutral");
    expect(p.externalId).toBe(`v1:block:S:${MB1}`);
    expect(p.title).toBe("SHADOW, would be BLOCK (S)");
    expect(p.summary).toContain("would be BLOCK");
    noSecretText(p.summary);
  });
  it("…and the clean oversized PR in shadow → neutral `waived:Z` (known-good control)", async () => {
    expect(posted((await run({ additions: 9999, reviews: APPROVE(), diff: CLEAN_DIFF }, [PASS], "shadow")).result)).toMatchObject({ conclusion: "neutral", externalId: "v1:waived:Z" });
  });
});

describe("the whole sweep (runReview → runPost): a secret never reaches a check run, a log line, or the handoff in the clear", () => {
  it("oversized + token + approval, LIVE: ONE check run, failure, `v1:block:S:…`; the token appears nowhere that was posted, logged, or sealed", async () => {
    const world = makeWorld(REPO, { prs: [{ number: 7, additions: 9999, reviews: APPROVE(), diff: SECRET_DIFF }] });
    const out: string[] = [];
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const manifest = parseManifest({ repos: [{ repo: REPO, live: true, shadow: false }] });
    const g = makeGh(world);
    const c = makeClient([PASS, PASS, PASS]);
    const { handoff } = await runReview({ gh: g.gh, client: c.client, manifest, reviewerSlug: DEFAULT_REVIEWER_SLUG, sleep: noSleep });
    const p = makeGh(world);
    const r = await runPost({ gh: p.gh, manifest, handoff, reviewerAppId: REVIEWER.id });
    expect(r).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0].body).toMatchObject({ conclusion: "failure", external_id: `v1:block:S:${MB1}` });
    noSecretText(JSON.stringify(p.posts[0].body));
    noSecretText(JSON.stringify(handoff));
    noSecretText(out.join("\n"));
    expect(out.join("\n")).toContain("categories=S source=scan action=post conclusion=failure");
    expect(c.requests).toHaveLength(0);
  });
});
