/**
 * ai-review-handoff.ts — how verdicts (and their reasons) cross from the `review` job to the `post` job without touching a public log.
 *
 * Why this exists: ops-pipeline is a PUBLIC repo. The two jobs are split on purpose (the review job federates to Anthropic through
 * WIF and must have no `environment`; the post job holds the reviewer App PEM in the main-only `ai-review` environment), so the verdicts
 * have to cross a job boundary. Every channel across it is readable by anyone: a job output is echoed in the next step's `env:` header,
 * an artifact of a public repo is downloadable by any GitHub account. The reasons are text derived from private-repo diffs and belong ONLY
 * on the private repo's check run. So the payload is SEALED before it crosses:
 *
 *   key  = HKDF-SHA256(ikm = a repo secret both jobs can read, salt = run id + attempt, info = a fixed label)   — 32 bytes
 *   blob = base64( iv(12) | gcm tag(16) | AES-256-GCM( gzip(JSON) ) ), with the same run-bound context as the AAD
 *
 * The ciphertext (not the reasons) may therefore appear in a public log; nothing derivable from it does without the secret. The blob is
 * bound to the run: a blob lifted from another run, or edited, fails authentication and `openHandoff` throws a fixed error.
 * (The workflow passes the FLEET App key as the ikm: a secret that already exists at repo scope, so no new credential is needed, and
 * the reviewer PEM never reaches the review job.)
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { conclusionAgrees, encodeExternalId, parseExternalId } from "./ai-review-verdict.js";
import type { Conclusion } from "./ai-review-verdict.js";

export interface HandoffEntry {
  repo: string;
  pr: number;
  headSha: string;
  conclusion: Conclusion;
  externalId: string;
  title: string;
  summary: string;
}
export interface Handoff {
  v: 1;
  entries: HandoffEntry[];
}
export interface HandoffContext {
  runId: string;
  attempt: string;
}

const INFO = Buffer.from("studiob-ai-review handoff v1");
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function material(ikm: string, ctx: HandoffContext): { key: Buffer; aad: Buffer } {
  if (ikm.trim() === "") throw new Error("handoff: no key material");
  if (!/^\d+$/.test(ctx.runId) || !/^\d+$/.test(ctx.attempt)) throw new Error("handoff: no run context");
  const salt = Buffer.from(`run=${ctx.runId};attempt=${ctx.attempt}`);
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(ikm, "utf-8"), salt, INFO, 32));
  return { key, aad: salt };
}

export function sealHandoff(h: Handoff, ikm: string, ctx: HandoffContext): string {
  const { key, aad } = material(ikm, ctx);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(h), "utf-8"))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** The post job receives the blob in ONE environment variable (Linux caps a single env string at 128 KiB); stay well under it. */
export const MAX_SEALED_CHARS = 100_000;

/**
 * Seal, dropping trailing entries until the blob fits. A dropped entry is simply not posted this sweep; it has no check run, so the next
 * sweep derives it again (fail closed: a missing verdict never reads as a success). Returns what was sealed and how many were dropped.
 */
export function sealWithinLimit(h: Handoff, ikm: string, ctx: HandoffContext, limit = MAX_SEALED_CHARS): { blob: string; dropped: number } {
  let entries = h.entries;
  for (;;) {
    const blob = sealHandoff({ v: 1, entries }, ikm, ctx);
    if (blob.length <= limit || entries.length === 0) return { blob, dropped: h.entries.length - entries.length };
    entries = entries.slice(0, Math.max(0, entries.length - Math.max(1, Math.ceil(entries.length / 4))));
  }
}

/** Throws a FIXED error ("handoff: cannot open") on any failure — wrong key, wrong run, tampering, bad shape. Never echoes content. */
export function openHandoff(blob: string, ikm: string, ctx: HandoffContext): Handoff {
  try {
    const { key, aad } = material(ikm, ctx);
    const raw = Buffer.from(blob, "base64");
    if (raw.length < 12 + 16 + 1) throw new Error("short");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = gunzipSync(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])).toString("utf-8");
    return validateHandoff(JSON.parse(json));
  } catch {
    throw new Error("handoff: cannot open");
  }
}

/** Defense in depth: even an authenticated payload is shape-checked before the post job acts on it. */
export function validateHandoff(x: unknown): Handoff {
  const o = x as { v?: unknown; entries?: unknown } | null;
  if (!o || o.v !== 1 || !Array.isArray(o.entries)) throw new Error("bad shape");
  const entries = o.entries.map((e: unknown): HandoffEntry => {
    const r = e as Record<string, unknown>;
    if (
      typeof r.repo !== "string" || !REPO_RE.test(r.repo) ||
      !Number.isInteger(r.pr) || (r.pr as number) <= 0 ||
      typeof r.headSha !== "string" || !SHA_RE.test(r.headSha) ||
      (r.conclusion !== "success" && r.conclusion !== "failure" && r.conclusion !== "neutral") ||
      typeof r.externalId !== "string" || typeof r.title !== "string" || typeof r.summary !== "string"
    ) {
      throw new Error("bad entry");
    }
    const verdict = parseExternalId(r.externalId);
    // the external_id must be canonical (encode∘parse round-trips) and the conclusion must be one this verdict can carry: `neutral` (a shadow
    // repo, any verdict) or the live conclusion. A block can never travel as `success`. Which of the two a repo gets is the manifest's call,
    // which the post job re-checks (runPost); this is only the shape.
    if (!verdict || encodeExternalId(verdict) !== r.externalId || !conclusionAgrees(verdict.kind, r.conclusion)) throw new Error("bad entry");
    return { repo: r.repo, pr: r.pr as number, headSha: r.headSha, conclusion: r.conclusion, externalId: r.externalId, title: r.title, summary: r.summary };
  });
  return { v: 1, entries };
}
