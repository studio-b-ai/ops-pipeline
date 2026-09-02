/**
 * Gate refusal → Kevin's decision block — ops-pipeline#260 leg 3 (part B).
 *
 * The auto-merge gate used to refuse silently: a `[gate-receipt] … verdict=missed`
 * log line in a GitHub Actions run nobody reads, and the PR sat. Kevin 9/02:
 * "auto merged or escalated to me to queue it for merge and deploy … all through
 * one channel." So every DECISION-CLASS refusal enrolls ONE line through
 * webhook-router's enroll door (`POST /internal/cos/decisions`, wr#844) into the
 * standing `merge-escalations` group of the §4a decision block — PR · reason ·
 * diff size · "reply `queued` to merge; `hold` to park". Nothing merges on
 * silence (#279).
 *
 * WHICH legs are decisions (the ruling's list: line cap, sensitive path, review
 * finding, missing/red check, class-match miss):
 *   class-match · line-cap · named-checks · review        → ENROLL
 * and which are NOT (a wait or a machinery state, never Kevin's call):
 *   ci-rollup (draft / CI pending / cold mergeability cache) · truncation ·
 *   eligibility ("not in the squasher's lane at all") · other (crash bucket)
 *
 * IDEMPOTENCY (#333): enrollment_key = `gate-refusal:<repo>#<pr>@<head sha>` —
 * a re-evaluation on the SAME head never re-asks (the door returns created:false);
 * a new push is a new diff and asks again. On merge the gate RESOLVES every key
 * for that PR (prefix `gate-refusal:<repo>#<pr>@`) so no stale line survives.
 *
 * FAIL-VISIBLE, never fail-closed for the gate itself: the door being down must
 * not break merging, but the lost line must not be silent either (#461) — every
 * skipped/failed enrollment prints a loud `[enroll-*]` line the health monitor
 * can parse. No env (`WEBHOOK_ROUTER_URL` + `SEAT_INBOX_TOKEN`) ⇒ `[enroll-skipped]`
 * — a deployment gap, visible in every run until someone fixes it (#464).
 *
 * Dual-store note (#99): SEAT_INBOX_TOKEN is the same server-side token
 * webhook-router validates (Railway env); this repo's GitHub Actions secret is
 * a SECOND store of it — rotate both or the gate 401s while the rail keeps
 * working. The per-seat capability (ops#258 step 1) retires this copy.
 */

import type { GateReceiptLeg } from "./automerge-telemetry.js";

export const MERGE_ESCALATIONS_GROUP_KEY = "merge-escalations";
export const MERGE_ESCALATIONS_GROUP_LABEL = "merge escalations";
export const GATE_ORIGINATOR = "pr-automerge-gate";

const DECISION_LEGS: ReadonlySet<GateReceiptLeg> = new Set(["class-match", "line-cap", "named-checks", "review"]);

/** True iff a refusal on this leg is a decision Kevin can make (vs a transient wait). */
export function isDecisionLeg(leg: GateReceiptLeg): boolean {
  return DECISION_LEGS.has(leg);
}

const SHORT_REPO: Readonly<Record<string, string>> = {
  "studio-b-ai/webhook-router": "wr",
  "studio-b-ai/bolt-wms": "bolt",
  "studio-b-ai/client-asthetik": "ca",
  "studio-b-ai/ops-pipeline": "ops",
  "studio-b-ai/studiob": "studiob",
  "studio-b-ai/asthetik-trade-theme": "theme",
  "studio-b-ai/studiob-price-sync": "price-sync",
  "studio-b-ai/aesthetik-portal": "portal",
};

export function shortRepo(repo: string): string {
  return SHORT_REPO[repo] ?? repo.split("/").pop() ?? repo;
}

export type GateRefusal = {
  repo: string;
  pr: number;
  headSha: string;
  leg: GateReceiptLeg;
  reasons: readonly string[];
  additions: number;
  deletions: number;
};

export type EnrollmentBody = {
  enrollment_key: string;
  group_key: string;
  group_label: string;
  member_label: string;
  detail: string;
  originator: string;
};

export function enrollmentKeyFor(repo: string, pr: number, headSha: string): string {
  return `gate-refusal:${repo}#${pr}@${headSha.slice(0, 12)}`;
}

export function enrollmentKeyPrefixFor(repo: string, pr: number): string {
  return `gate-refusal:${repo}#${pr}@`;
}

/** Pure: the exact body the door receives. Tests pin it; the fetch wrapper only ships it. */
export function buildEnrollment(r: GateRefusal): EnrollmentBody {
  const first = (r.reasons[0] ?? "refused").replace(/\s+/g, " ").trim();
  const reason = first.length > 160 ? `${first.slice(0, 157)}…` : first;
  return {
    enrollment_key: enrollmentKeyFor(r.repo, r.pr, r.headSha),
    group_key: MERGE_ESCALATIONS_GROUP_KEY,
    group_label: MERGE_ESCALATIONS_GROUP_LABEL,
    member_label: `${shortRepo(r.repo)}#${r.pr}`,
    // The verb names what WORKS today: the `queued` / `hold` LABEL on the PR is the
    // authority the gate reads (leg 4). "reply `queued`" arrives when the envelope's
    // reply→label path lands (Dispatcher seat) — until then that wording would be
    // prose broader than its signal (#412).
    detail:
      `https://github.com/${r.repo}/pull/${r.pr} · ${r.leg}: ${reason} · +${r.additions}/−${r.deletions}` +
      " · label `queued` to merge; `hold` to park",
    originator: GATE_ORIGINATOR,
  };
}

export type DoorEnv = { url: string; token: string } | null;

/** Reads the door config from env; null (not throw) when absent — the gate must keep running. */
export function doorEnvFrom(env: NodeJS.ProcessEnv = process.env): DoorEnv {
  const url = (env.WEBHOOK_ROUTER_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.SEAT_INBOX_TOKEN ?? "").trim();
  return url && token ? { url, token } : null;
}

export type EnrollOutcome =
  | { outcome: "enrolled"; created: boolean; key: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string; key: string };

type DoorResponse = { httpStatus: number; text(): Promise<string> };
type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<DoorResponse>;

/** Adapts the global fetch to the narrow shape the helpers consume (and tests fake). */
function defaultFetch(): FetchLike {
  return async (input, init) => {
    const res = await fetch(input, init);
    return { httpStatus: res.status, text: () => res.text() };
  };
}

async function postToDoor(door: { url: string; token: string }, path: string, body: unknown, fetchImpl: FetchLike): Promise<DoorResponse> {
  return fetchImpl(`${door.url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${door.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Opts = { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; log?: (line: string) => void };

/**
 * Enroll one decision-class refusal. Never throws; every outcome is logged loudly.
 * `fetchImpl` is injectable so the wire test asserts the ACTUAL request (#223).
 */
export async function enrollGateRefusal(r: GateRefusal, opts: Opts = {}): Promise<EnrollOutcome> {
  const log = opts.log ?? ((l: string) => console.log(l));
  if (!isDecisionLeg(r.leg)) {
    return { outcome: "skipped", reason: `leg ${r.leg} is a wait, not a decision` };
  }
  const door = doorEnvFrom(opts.env);
  const body = buildEnrollment(r);
  if (!door) {
    log(`[enroll-skipped] ${r.repo}#${r.pr} leg=${r.leg}: no enroll door configured (WEBHOOK_ROUTER_URL + SEAT_INBOX_TOKEN) — the decision line was NOT delivered`);
    return { outcome: "skipped", reason: "door not configured" };
  }
  try {
    const res = await postToDoor(door, "/internal/cos/decisions", body, opts.fetchImpl ?? defaultFetch());
    if (res.httpStatus !== 200) {
      const text = (await res.text()).slice(0, 200);
      log(`[enroll-failed] ${r.repo}#${r.pr} leg=${r.leg}: door HTTP ${res.httpStatus} ${text} — the decision line was NOT delivered`);
      return { outcome: "failed", reason: `HTTP ${res.httpStatus}`, key: body.enrollment_key };
    }
    let created = false;
    try {
      created = (JSON.parse(await res.text()) as { created?: boolean }).created === true;
    } catch {
      /* a 200 without a parsable body still means the door accepted it */
    }
    log(`[enroll] ${r.repo}#${r.pr} leg=${r.leg} key=${body.enrollment_key} created=${created}`);
    return { outcome: "enrolled", created, key: body.enrollment_key };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[enroll-failed] ${r.repo}#${r.pr} leg=${r.leg}: ${msg} — the decision line was NOT delivered`);
    return { outcome: "failed", reason: msg, key: body.enrollment_key };
  }
}

export type ResolveOutcome = { outcome: "resolved"; count: number } | { outcome: "skipped"; reason: string } | { outcome: "failed"; reason: string };

/**
 * On merge: resolve EVERY refusal line this PR ever enrolled (any head sha) so
 * nothing stale survives in Kevin's block. Never throws; loud on failure.
 */
export async function resolveGateRefusals(
  repo: string,
  pr: number,
  opts: Opts & { resolution?: "merged" | "held" } = {},
): Promise<ResolveOutcome> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const door = doorEnvFrom(opts.env);
  const prefix = enrollmentKeyPrefixFor(repo, pr);
  const resolution = opts.resolution ?? "merged";
  if (!door) {
    log(`[enroll-resolve-skipped] ${repo}#${pr}: no enroll door configured — any open decision line stays until resolved by hand`);
    return { outcome: "skipped", reason: "door not configured" };
  }
  try {
    const res = await postToDoor(door, "/internal/cos/decisions/resolve", { key_prefix: prefix, resolution }, opts.fetchImpl ?? defaultFetch());
    if (res.httpStatus !== 200) {
      const text = (await res.text()).slice(0, 200);
      log(`[enroll-resolve-failed] ${repo}#${pr}: door HTTP ${res.httpStatus} ${text}`);
      return { outcome: "failed", reason: `HTTP ${res.httpStatus}` };
    }
    let count = 0;
    try {
      count = Number((JSON.parse(await res.text()) as { resolved?: number }).resolved ?? 0);
    } catch {
      /* accepted */
    }
    log(`[enroll-resolve] ${repo}#${pr}: resolved ${count} decision line(s) with prefix ${prefix} as ${resolution}`);
    return { outcome: "resolved", count };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[enroll-resolve-failed] ${repo}#${pr}: ${msg}`);
    return { outcome: "failed", reason: msg };
  }
}
