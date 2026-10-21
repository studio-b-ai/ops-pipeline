/**
 * ai-review.ts — the central AI review check `studiob-ai-review` (go-native, native-plan §4), scoped to the pilot manifest.
 *
 *   tsx ai-review.ts review    the `review` job: read PRs, derive verdicts (model + deterministic legs), SEAL them → $GITHUB_OUTPUT handoff=…
 *   tsx ai-review.ts post      the `post` job: open the sealed verdicts, post ONE check run per head SHA as the reviewer App
 *
 * The two halves run in separate jobs (.github/workflows/ai-review-sweep.yml): `review` federates to Anthropic through WIF and never
 * sees the reviewer App PEM; `post` holds the PEM (main-only environment `ai-review`) and never calls the model.
 *
 * Until the reviewer App exists (REVIEWER_APP_ID absent) `post` logs "reviewer app not configured; nothing posted" and exits 0 having
 * made no API call. Nothing here merges, labels, approves, comments, or changes a setting; the only write is POST repos/R/check-runs.
 *
 * Shadow never blocks. A repo with live:false is still served by the old merge robot, which reads any failing check as not clean, so every
 * check run posted for a shadow repo is `neutral` (the would-be verdict rides in external_id and output.summary). The review job derives the
 * conclusion from the manifest mode, and the post job RE-CHECKS it against its own read of the manifest: an entry whose conclusion is not
 * the one the manifest allows for that repo is skipped, never posted (`mode-mismatch`).
 *
 * ops-pipeline is a PUBLIC repo: the log carries repo, PR, SHA and verdict enums only (lib/ai-review-log.ts is the choke point). Reasons
 * go into the check run's output.summary on the private repo, and into the sealed handoff on the way there.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "./lib/anthropic-credentials.js";
import { evaluatePr } from "./lib/ai-review-evaluate.js";
import { createCheckRun, ghCli, listOpenPrs, listReviewCheckRuns, type GhApi } from "./lib/ai-review-github.js";
import { openHandoff, sealWithinLimit, type Handoff, type HandoffContext, type HandoffEntry } from "./lib/ai-review-handoff.js";
import { installAiReviewLog, logEvent } from "./lib/ai-review-log.js";
import { loadManifest, modeFor, SHADOW_PR_CAP, type Manifest } from "./lib/ai-review-manifest.js";
import { conclusionFor, parseExternalId, type ReviewMode } from "./lib/ai-review-verdict.js";

/** slug of the reviewer GitHub App; overridable with REVIEWER_APP_SLUG. A cache pre-filter only — the post job matches the numeric id. */
export const DEFAULT_REVIEWER_SLUG = "studiob-reviewer";
/** At most this many PRs may PRODUCE WORK per sweep across all repos (a new verdict to post, or an error): newest first, the rest wait for
 *  the next sweep. Bounds model spend, the handoff size, and the env-var size the post job receives it in. PRs whose verdict is already
 *  posted (`unchanged`) or that get no check (`skip`) cost no work and do NOT count — otherwise a live repo with more open PRs than this
 *  would starve its oldest PRs of a verdict forever. */
export const MAX_PRS_PER_RUN = 30;
/** Hard ceiling on PRs evaluated per sweep (each costs a few API reads, no model call when cached). */
export const MAX_EVALUATED_PER_RUN = 200;

export interface ReviewCounts {
  repos: number;
  prs: number;
  post: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

export interface ReviewDeps {
  gh: GhApi;
  client: () => Anthropic;
  manifest: Manifest;
  reviewerSlug: string;
  sleep?: (ms: number) => Promise<void>;
  /** work budget: PRs that may produce a verdict to post or an error this sweep (default MAX_PRS_PER_RUN) */
  maxPrs?: number;
  /** evaluation ceiling (default MAX_EVALUATED_PER_RUN) */
  maxEvaluated?: number;
}

export async function runReview(deps: ReviewDeps): Promise<{ handoff: Handoff; counts: ReviewCounts }> {
  const counts: ReviewCounts = { repos: 0, prs: 0, post: 0, unchanged: 0, skipped: 0, errors: 0 };
  const entries: HandoffEntry[] = [];
  let work = deps.maxPrs ?? MAX_PRS_PER_RUN;
  let evaluated = deps.maxEvaluated ?? MAX_EVALUATED_PER_RUN;

  for (const entry of deps.manifest.repos) {
    const mode = modeFor(entry);
    if (mode === "off") continue;
    counts.repos++;

    let open;
    try {
      open = await listOpenPrs(deps.gh, entry.repo);
    } catch {
      counts.errors++;
      logEvent({ e: "list-failed", repo: entry.repo });
      continue;
    }
    // drafts get no check; shadow mode looks only at the SHADOW_PR_CAP most recent (the list is newest-first)
    const candidates = open.filter((p) => !p.draft);
    const selected = mode === "shadow" ? candidates.slice(0, SHADOW_PR_CAP) : candidates;

    for (const pr of selected) {
      if (work <= 0 || evaluated <= 0) {
        counts.skipped++;
        continue;
      }
      evaluated--;
      counts.prs++;
      const r = await evaluatePr({ gh: deps.gh, client: deps.client, reviewerSlug: deps.reviewerSlug, sleep: deps.sleep }, entry.repo, mode, pr.number);
      switch (r.kind) {
        case "skip":
          counts.skipped++;
          logEvent({ e: "skip", repo: entry.repo, pr: pr.number, reason: r.reason });
          break;
        case "error":
          work--;
          counts.errors++;
          logEvent({ e: "no-verdict", repo: entry.repo, pr: pr.number, leg: r.leg });
          break;
        case "unchanged":
          counts.unchanged++;
          logEvent({ e: "verdict", repo: entry.repo, pr: pr.number, sha: r.headSha, verdict: r.verdict.kind, categories: r.verdict.categories.join(""), source: r.source, action: "unchanged", conclusion: conclusionFor(r.verdict.kind, mode) });
          break;
        case "post":
          work--;
          counts.post++;
          entries.push({ repo: entry.repo, pr: pr.number, headSha: r.headSha, conclusion: r.conclusion, externalId: r.externalId, title: r.title, summary: r.summary });
          logEvent({ e: "verdict", repo: entry.repo, pr: pr.number, sha: r.headSha, verdict: r.verdict.kind, categories: r.verdict.categories.join(""), source: r.source, action: "post", conclusion: r.conclusion });
          break;
      }
    }
  }
  logEvent({ e: "sweep", ...counts });
  return { handoff: { v: 1, entries }, counts };
}

export interface PostDeps {
  gh: GhApi;
  manifest: Manifest;
  handoff: Handoff;
  reviewerAppId: number;
}

export async function runPost(deps: PostDeps): Promise<{ posted: number; skipped: number; failed: number }> {
  // repo → mode, from the post job's OWN read of the (Kevin-owned) manifest; the handoff is authenticated but never decides what a repo may conclude
  const modes = new Map<string, ReviewMode>();
  for (const e of deps.manifest.repos) {
    const m = modeFor(e);
    if (m !== "off") modes.set(e.repo.toLowerCase(), m);
  }
  let posted = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of deps.handoff.entries) {
    // the handoff is authenticated, but the post job still acts only on repos the (owned) manifest names
    const mode = modes.get(e.repo.toLowerCase());
    if (mode === undefined) {
      skipped++;
      logEvent({ e: "post-skipped", repo: e.repo, pr: e.pr, reason: "not-in-manifest" });
      continue;
    }
    // shadow → neutral, live → success/failure, decided HERE from the manifest. An entry that disagrees (a stale review job, a manifest that
    // changed between the jobs, a forged-but-authenticated payload) is not posted: a failure must never land on a shadow repo, and a repo
    // that is live must never receive a neutral that no one will enforce. The next sweep re-derives it.
    const verdict = parseExternalId(e.externalId);
    if (verdict === null || e.conclusion !== conclusionFor(verdict.kind, mode)) {
      skipped++;
      logEvent({ e: "post-skipped", repo: e.repo, pr: e.pr, reason: "mode-mismatch" });
      continue;
    }
    try {
      // authoritative dedupe by NUMERIC app id (the review job's slug filter is only a pre-filter)
      const runs = await listReviewCheckRuns(deps.gh, e.repo, e.headSha);
      const newest = runs.filter((r) => r.status === "completed" && r.appId === deps.reviewerAppId).sort((a, b) => b.id - a.id)[0];
      if (newest && newest.externalId === e.externalId && newest.conclusion === e.conclusion) {
        skipped++;
        logEvent({ e: "post-skipped", repo: e.repo, pr: e.pr, reason: "unchanged" });
        continue;
      }
      await createCheckRun(deps.gh, e.repo, { headSha: e.headSha, conclusion: e.conclusion, externalId: e.externalId, title: e.title, summary: e.summary });
      posted++;
      logEvent({ e: "posted", repo: e.repo, pr: e.pr, sha: e.headSha, conclusion: e.conclusion });
    } catch {
      failed++;
      logEvent({ e: "post-failed", repo: e.repo, pr: e.pr });
    }
  }
  logEvent({ e: "post-done", posted, skipped, failed });
  return { posted, skipped, failed };
}

export interface MainIo {
  gh?: GhApi;
  client?: () => Anthropic;
  manifestPath?: string;
  /** where `review` writes `handoff=<blob>`; defaults to the file named by $GITHUB_OUTPUT (nothing when unset, e.g. a local run) */
  appendOutput?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

function handoffContext(env: NodeJS.ProcessEnv): HandoffContext | null {
  const runId = env.GITHUB_RUN_ID ?? "";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "";
  return /^\d+$/.test(runId) && /^\d+$/.test(attempt) ? { runId, attempt } : null;
}

/** Returns the process exit code. Never throws; every failure is one enum line (`failed leg=…`) and exit 1. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: MainIo = {}): Promise<number> {
  const cmd = argv[0];
  try {
    if (cmd !== "review" && cmd !== "post") {
      logEvent({ e: "failed", leg: "usage" });
      return 2;
    }

    // `post` first: with no reviewer App there is nothing to do, and nothing may be called — not the API, not the handoff, not the manifest
    if (cmd === "post") {
      const rawId = (env.REVIEWER_APP_ID ?? "").trim();
      if (rawId === "") {
        logEvent({ e: "not-configured" });
        return 0;
      }
      if (!/^[1-9]\d{0,15}$/.test(rawId)) {
        logEvent({ e: "failed", leg: "app-id" });
        return 1;
      }
      const ctx = handoffContext(env);
      const key = env.AI_REVIEW_HANDOFF_KEY ?? "";
      if (!ctx || key.trim() === "" || (!io.gh && !(env.GH_TOKEN ?? "").trim())) {
        logEvent({ e: "failed", leg: "env" });
        return 1;
      }
      const manifest = loadManifestSafe(io);
      if (!manifest) return 1;
      const blob = (env.AI_REVIEW_HANDOFF ?? "").trim();
      let handoff: Handoff = { v: 1, entries: [] };
      if (blob !== "") {
        try {
          handoff = openHandoff(blob, key, ctx);
        } catch {
          logEvent({ e: "failed", leg: "handoff" });
          return 1;
        }
      }
      const r = await runPost({ gh: io.gh ?? ghCli, manifest, handoff, reviewerAppId: Number(rawId) });
      return r.failed > 0 ? 1 : 0;
    }

    // review
    const ctx = handoffContext(env);
    const key = env.AI_REVIEW_HANDOFF_KEY ?? "";
    if (!ctx || key.trim() === "" || (!io.gh && !(env.GH_TOKEN ?? "").trim())) {
      logEvent({ e: "failed", leg: "env" });
      return 1;
    }
    const slug = (env.REVIEWER_APP_SLUG ?? "").trim() || DEFAULT_REVIEWER_SLUG;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      logEvent({ e: "failed", leg: "env" });
      return 1;
    }
    const manifest = loadManifestSafe(io);
    if (!manifest) return 1;
    let shared: Anthropic | undefined;
    const client = io.client ?? ((): Anthropic => (shared ??= anthropicClient())); // ONE client (one TokenCache) for every vote of the sweep
    const { handoff } = await runReview({ gh: io.gh ?? ghCli, client, manifest, reviewerSlug: slug, sleep: io.sleep });
    const { blob: sealed } = sealWithinLimit(handoff, key, ctx);
    const append = io.appendOutput ?? ((line: string): void => (env.GITHUB_OUTPUT ? appendFileSync(env.GITHUB_OUTPUT, line + "\n") : undefined));
    append(`handoff=${sealed}`);
    return 0;
  } catch {
    logEvent({ e: "failed", leg: "internal" });
    return 1;
  }
}

function loadManifestSafe(io: MainIo): Manifest | null {
  try {
    return loadManifest(io.manifestPath ?? join(dirname(fileURLToPath(import.meta.url)), "native", "manifest.json"));
  } catch {
    logEvent({ e: "failed", leg: "manifest" });
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installAiReviewLog();
  process.exitCode = await main(process.argv.slice(2), process.env);
}
