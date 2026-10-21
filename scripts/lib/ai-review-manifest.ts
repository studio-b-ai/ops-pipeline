/**
 * ai-review-manifest.ts — which repos the central AI review check (`studiob-ai-review`) covers, and in what mode (go-native, native-plan §4).
 *
 *   scripts/native/manifest.json   {"repos":[{"repo":"studio-b-ai/toto","live":false,"shadow":true}]}
 *
 *   live   → the repo is native: every open non-draft PR gets a verdict (no cap).
 *   shadow → pilot posting only: at most SHADOW_PR_CAP most-recent open non-draft PRs get a verdict (the docs ceiling on content-
 *            generating requests is 500/hour — native-plan §4 "Shadow posting limits").
 *   neither → the repo is listed but not reviewed.
 *
 * Strict on purpose: this file decides which private repos the reviewer reads and posts on, and it is Kevin-owned. Unknown keys, a repo
 * outside the org, a duplicate, or a non-boolean flag throws — a manifest that cannot be read exactly is never "mostly applied".
 * Error text names an entry INDEX only, never entry content (ops-pipeline is a public repo; logs are public).
 */
import { readFileSync } from "node:fs";

export const ORG = "studio-b-ai";
/** Shadow mode reviews at most this many of a repo's most-recent open non-draft PRs. */
export const SHADOW_PR_CAP = 3;

const REPO_RE = /^studio-b-ai\/[A-Za-z0-9_.-]+$/;

export interface ManifestEntry {
  repo: string;
  live: boolean;
  shadow: boolean;
}
export interface Manifest {
  repos: ManifestEntry[];
}
export type RepoMode = "live" | "shadow" | "off";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function parseManifest(raw: unknown): Manifest {
  if (!isRecord(raw) || Object.keys(raw).some((k) => k !== "repos") || !Array.isArray(raw.repos)) {
    throw new Error("manifest invalid: the top level must be exactly {repos: [...]}");
  }
  const seen = new Set<string>();
  const repos = raw.repos.map((e: unknown, i: number): ManifestEntry => {
    if (!isRecord(e)) throw new Error(`manifest invalid: entry ${i} is not an object`);
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "live,repo,shadow") throw new Error(`manifest invalid: entry ${i} must have exactly the keys repo, live, shadow`);
    if (typeof e.repo !== "string" || !REPO_RE.test(e.repo)) throw new Error(`manifest invalid: entry ${i} repo must be ${ORG}/<name>`);
    if (typeof e.live !== "boolean" || typeof e.shadow !== "boolean") throw new Error(`manifest invalid: entry ${i} live and shadow must be booleans`);
    const key = e.repo.toLowerCase();
    if (seen.has(key)) throw new Error(`manifest invalid: entry ${i} duplicates an earlier repo`);
    seen.add(key);
    return { repo: e.repo, live: e.live, shadow: e.shadow };
  });
  return { repos };
}

export function loadManifest(path: string): Manifest {
  return parseManifest(JSON.parse(readFileSync(path, "utf-8")));
}

/** live wins over shadow (a live repo is never capped — an uncapped repo with a cap would strand PRs without a verdict). */
export function modeFor(entry: ManifestEntry): RepoMode {
  if (entry.live) return "live";
  if (entry.shadow) return "shadow";
  return "off";
}

/** The repo NAMES (no org) of every reviewed repo — the `repositories:` scope for the workflow's installation tokens. */
export function activeRepoNames(manifest: Manifest): string[] {
  return manifest.repos.filter((e) => modeFor(e) !== "off").map((e) => e.repo.slice(ORG.length + 1));
}
