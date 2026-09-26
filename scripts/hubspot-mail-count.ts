#!/usr/bin/env tsx
/**
 * hubspot-mail-count.ts — Count Kevin's open HubSpot mail threads across his
 * three Exec Triage channels and post the count to a morning-brief issue.
 *
 * Queries the HubSpot Conversations v3 threads API for the Exec Triage inbox
 * (1893833595), paginates through all threads, filters by OPEN status, groups
 * by the three channel accounts, and posts/updates a labeled GitHub issue so
 * the count is one ticket Kevin sees, not a promise in running prose.
 *
 * Channel accounts (live-verified 2026-09-20 via HubSpot threads API):
 *   exec@studiob.hs-inbox.com  → channelAccountId 3263518709
 *   kevin@bibelhausen.com      → channelAccountId 3789068973
 *   exec@heritagefabrics.com   → channelAccountId 3028501370
 *   kevin@asthetik.com         → channelAccountId 3405917603
 *   kevin@heritagefabrics.com  → channelAccountId 3405912046
 *   support                    → channelAccountId 3028448174
 *
 * Kevin's "three channels" (kevin@heritagefabrics.com,
 * kevin@asthetik.com, exec@b.studio) route through a combination
 * of these connected inbox accounts — the full set is listed here
 * so no thread shows as "unknown."
 *
 * Env required:
 *   HUBSPOT_ACCESS_TOKEN — PAT with conversations.read scope
 *
 * Exit codes:
 *   0 — success (count posted to issue)
 *   1 — HubSpot probe error
 *   2 — GitHub issue error
 *   3 — config error (missing env)
 */

import { execFileSync } from "node:child_process";

const HS = "https://api.hubapi.com";
const INBOX_ID = "1893833595";
const SELF_REPO = "studio-b-ai/ops-pipeline";
const BRIEF_LABEL = "morning-brief";
const LABEL_COLOR = "1D76DB";
const LABEL_DESC = "Daily HubSpot mail thread count — open threads on Kevin's three Exec Triage channels";
const PAGE_LIMIT = 100;

interface ChannelEntry {
  channelAccountId: string;
  address: string;
}

const CHANNELS: ChannelEntry[] = [
  { channelAccountId: "3263518709", address: "studiob (exec@studiob.hs-inbox.com)" },
  { channelAccountId: "3789068973", address: "kevin@bibelhausen.com" },
  { channelAccountId: "3028501370", address: "heritage (exec@heritagefabrics.com)" },
  { channelAccountId: "3405917603", address: "kevin@asthetik.com" },
  { channelAccountId: "3405912046", address: "kevin@heritagefabrics.com" },
  { channelAccountId: "3028448174", address: "support" },
];

const CHANNEL_MAP: Record<string, string> = Object.fromEntries(
  CHANNELS.map((c) => [c.channelAccountId, c.address]),
);

interface ThreadSummary {
  id: string;
  status?: string;
  originalChannelAccountId?: string;
  [key: string]: unknown;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

const HS_TOKEN = requireEnv("HUBSPOT_ACCESS_TOKEN");

async function fetchThreadsPage(after?: string): Promise<{
  results: ThreadSummary[];
  nextAfter?: string;
}> {
  const params = new URLSearchParams({ inboxId: INBOX_ID, limit: String(PAGE_LIMIT) });
  if (after) params.set("after", after);

  const res = await fetch(`${HS}/conversations/v3/conversations/threads?${params.toString()}`, {
    headers: { Authorization: `Bearer ${HS_TOKEN}`, "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 400 && body.includes("UNPARSEABLE_TOKEN")) {
      return { results: [], nextAfter: undefined };
    }
    throw new Error(`HubSpot threads list failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    results?: ThreadSummary[];
    paging?: { next?: { after?: string } };
  };

  return {
    results: data.results ?? [],
    nextAfter: data.paging?.next?.after,
  };
}

async function countOpenThreads(): Promise<{
  counts: Record<string, number>;
  total: number;
  threadCount: number;
}> {
  const counts: Record<string, number> = {};
  let totalOpen = 0;
  let totalThreads = 0;
let after: string | undefined;
  let page = 0;
  const maxPages = 200;

  do {
    page++;
    console.error(`[hubspot-mail-count] fetching page ${page}${after ? ` (after ${after.slice(0, 8)}…)` : ""}`);

    const { results, nextAfter } = await fetchThreadsPage(after);
    after = nextAfter;
    totalThreads += results.length;

    for (const t of results) {
      if (t.status === "OPEN") {
        totalOpen++;
        const channelId = t.originalChannelAccountId ?? "unknown";
        const key = CHANNEL_MAP[channelId] ?? `unknown:${channelId}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  } while (after && page < maxPages);

  if (after && page >= maxPages) {
    console.error(`[hubspot-mail-count] WARNING: pagination cap reached at ${maxPages} pages (${totalThreads} threads scanned) — count may be incomplete`);
  }
  return { counts, total: totalOpen, threadCount: totalThreads };
}

function buildBriefBody(
  counts: Record<string, number>,
  total: number,
  utcNow: string,
  pageInfo: { pages: number; totalThreads: number },
): string {
  const dateStr = utcNow.slice(0, 16).replace("T", " ");
  const lines = [
    `## HubSpot mail queue — ${dateStr} UTC`,
    "",
    `**${total} open thread${total === 1 ? "" : "s"}** across ${CHANNELS.length} channels (${pageInfo.totalThreads} total threads scanned, ${pageInfo.pages} page${pageInfo.pages === 1 ? "" : "s"})`,
    "",
    "| Channel | Open |",
    "|---------|------|",
  ];

  for (const { address } of CHANNELS) {
    const n = counts[address] ?? 0;
    lines.push(`| ${address} | **${n}** |`);
  }

  const unknownKeys = Object.keys(counts).filter(
    (k) => !CHANNELS.some((c) => c.address === k),
  );
  for (const k of unknownKeys) {
    lines.push(`| ${k} | ${counts[k]} |`);
  }

  lines.push("", total === 0 ? "✅ Mail queue clear." : "📬 Open threads remain.");
  return lines.join("\n");
}

async function postBrief(body: string, titlePrefix: string): Promise<string> {
  gh(["label", "create", BRIEF_LABEL, "--repo", SELF_REPO, "--force",
    "--description", LABEL_DESC, "--color", LABEL_COLOR]);

  const title = `${titlePrefix}: ${body.split("\n")[0].replace("## ", "").trim()}`;

  const existingRaw = gh([
    "issue", "list", "--repo", SELF_REPO, "--label", BRIEF_LABEL,
    "--state", "open", "--limit", "5", "--json", "number,title",
  ]);
  const existing: Array<{ number: number; title: string }> = JSON.parse(existingRaw);

  if (existing.length > 0) {
    const num = existing[0].number;
    gh(["issue", "edit", String(num), "--repo", SELF_REPO, "--title", title, "--body", body]);
    return `https://github.com/${SELF_REPO}/issues/${num}`;
  }

  const out = gh(["issue", "create", "--repo", SELF_REPO, "--label", BRIEF_LABEL, "--title", title, "--body", body]);
  return out.trim();
}

async function main(): Promise<void> {
  const token = requireEnv("HUBSPOT_ACCESS_TOKEN");

  console.error("[hubspot-mail-count] counting open threads in Exec Triage inbox…");
  const { counts, total, threadCount } = await countOpenThreads();
  console.error(`[hubspot-mail-count] ${total} open / ${threadCount} total`);

  const utcNow = new Date().toISOString();
  const pagesEstimate = Math.ceil(threadCount / PAGE_LIMIT);
  const body = buildBriefBody(counts, total, utcNow, {
    pages: pagesEstimate,
    totalThreads: threadCount,
  });

  const titlePrefix = "morning brief";
  const url = await postBrief(body, titlePrefix);
  console.log(url);

  for (const { address } of CHANNELS) {
    const n = counts[address] ?? 0;
    console.error(`  ${address}: ${n}`);
  }
  console.error(`  total: ${total}`);
}

main().catch((err) => {
  console.error(`[hubspot-mail-count] FATAL: ${(err as Error).message}`);
  process.exit(1);
});