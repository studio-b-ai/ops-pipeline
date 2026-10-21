/**
 * go-native P1 — `main review` builds the Anthropic client through the REAL `anthropicClient()` seam (lib/anthropic-credentials), exactly as
 * the current gate does, and only when a model review is actually needed.
 *
 * The crew-113 lesson, pinned here: under WIF federation every `new Anthropic()` carries its OWN TokenCache and does its OWN exchange of the
 * single-use identity token, so N clients race and N-1 of them 401. The sweep must therefore build ONE client for every vote of every PR.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { HEAD, MB1, REPO, makeClient, makeGh, makeWorld, noSleep, sha } from "./helpers.js";

const anthropicClientMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/anthropic-credentials.js", () => ({ anthropicClient: anthropicClientMock }));

const { main } = await import("../../ai-review.js");
const { openHandoff } = await import("../../lib/ai-review-handoff.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_MANIFEST = join(HERE, "..", "manifest.json");
const KEY = "fleet-key-material";
const ENV = { GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", AI_REVIEW_HANDOFF_KEY: KEY, GH_TOKEN: "t" } as NodeJS.ProcessEnv;

beforeEach(() => {
  anthropicClientMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

async function sweep(world: ReturnType<typeof makeWorld>) {
  const g = makeGh(world);
  const lines: string[] = [];
  const code = await main(["review"], ENV, { gh: g.gh, manifestPath: REAL_MANIFEST, appendOutput: (l) => lines.push(l), sleep: noSleep });
  const blob = lines[0]?.slice("handoff=".length) ?? "";
  return { code, handoff: blob ? openHandoff(blob, KEY, { runId: "77", attempt: "1" }) : null, lines };
}

describe("main review — the Anthropic client", () => {
  it("builds ONE client (one TokenCache) for every vote of every PR in the sweep", async () => {
    const c = makeClient(["PASS", "PASS", "PASS"]);
    anthropicClientMock.mockImplementation(() => c.client() as Anthropic);
    const world = makeWorld(REPO, { prs: [1, 2, 3].map((n) => ({ number: n, sha: sha(String(n)) })) });
    const r = await sweep(world);
    expect(r.code).toBe(0);
    expect(r.handoff!.entries).toHaveLength(3);
    expect(c.requests).toHaveLength(9); // 3 PRs × 3 votes
    expect(anthropicClientMock).toHaveBeenCalledTimes(1);
  });

  it("builds NO client at all when no PR needs the model (held, fork, cached): federation can be down and the sweep still answers", async () => {
    anthropicClientMock.mockImplementation(() => {
      throw new Error("must not be called");
    });
    const world = makeWorld(REPO, { prs: [{ number: 1, sha: sha("1"), labels: ["hold"] }, { number: 2, sha: sha("2"), headRepo: "x/y" }, { number: 3, sha: HEAD }] });
    world.checkRuns[`${REPO}@${HEAD}`] = [{ id: 1, status: "completed", conclusion: "success", external_id: `v1:pass::${MB1}`, app: { id: 1, slug: "studiob-reviewer" } }];
    const r = await sweep(world);
    expect(r.code).toBe(0);
    expect(r.handoff!.entries.map((e) => e.externalId).sort()).toEqual(["v1:block:F", "v1:block:H"]);
    expect(anthropicClientMock).not.toHaveBeenCalled();
  });

  it("no credentials (anthropicClient throws): PRs that need the model get NO verdict, the sweep itself still succeeds, nothing is ever a success", async () => {
    anthropicClientMock.mockImplementation(() => {
      throw new Error("no Anthropic credentials");
    });
    const world = makeWorld(REPO, { prs: [{ number: 1, sha: sha("1") }, { number: 2, sha: sha("2"), labels: ["needs-human"] }] });
    const r = await sweep(world);
    expect(r.code).toBe(0);
    expect(r.handoff!.entries.map((e) => ({ pr: e.pr, conclusion: e.conclusion }))).toEqual([{ pr: 2, conclusion: "failure" }]);
    expect(anthropicClientMock).toHaveBeenCalled();
  });
});
