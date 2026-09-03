import { describe, expect, it } from "vitest";
import {
  evaluateTrainLiveness,
  formatLivenessIssueTitle,
  formatLivenessIssueBody,
  pickLastScheduledRun,
  parseTrainEnabled,
  TRAIN_LIVENESS_LABEL,
  TRAIN_LIVENESS_STALE_MINUTES,
  type EvaluateTrainLivenessInput,
  type LivenessQueuedTicket,
  type RunLike,
} from "../train-liveness-lib.js";

// ───────────────────────────── fixtures (Rule #256 — every "now" pinned, never the real clock) ─────────────────────────────

const NOW = "2026-08-31T00:30:00Z"; // the incident's own window edge (23:55Z→00:30Z, 35 min silent)

function minutesAgo(n: number): string {
  return new Date(new Date(NOW).getTime() - n * 60_000).toISOString();
}

function evalWith(overrides: Partial<EvaluateTrainLivenessInput> = {}) {
  return evaluateTrainLiveness({
    nowIso: NOW,
    lastCompletedRunIso: minutesAgo(5),
    queuedTickets: 1,
    trainEnabled: true,
    ...overrides,
  });
}

// ───────────────────────────── evaluateTrainLiveness — ok ─────────────────────────────

describe("evaluateTrainLiveness — ok", () => {
  it("flags ok when queued and the last run is well within the window", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(5), queuedTickets: 3 });
    expect(result.verdict).toBe("ok");
    expect(result.silentMinutes).toBe(5);
    expect(result.reason).toContain("3 train:ready ticket(s) queued");
    expect(result.reason).toContain("5 min ago");
  });

  it("is ok exactly AT the threshold (strictly greater-than, mirrors backlog-staleness-lib's '> Nd' wording)", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(TRAIN_LIVENESS_STALE_MINUTES), queuedTickets: 1 });
    expect(result.verdict).toBe("ok");
    expect(result.silentMinutes).toBe(TRAIN_LIVENESS_STALE_MINUTES);
  });

  it("respects a caller-supplied windowMinutes override", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(45), queuedTickets: 1, windowMinutes: 60 });
    expect(result.verdict).toBe("ok");
  });
});

// ───────────────────────────── evaluateTrainLiveness — stale ─────────────────────────────

describe("evaluateTrainLiveness — stale", () => {
  // Negative control first (Rule #322): one minute under the default threshold must NOT flag.
  it("does NOT flag stale one minute under the default threshold", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(TRAIN_LIVENESS_STALE_MINUTES - 1), queuedTickets: 1 });
    expect(result.verdict).toBe("ok");
  });

  it("flags stale at 31 minutes silent with the default 30-minute threshold (tonight's incident shape)", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(31), queuedTickets: 1 });
    expect(result.verdict).toBe("stale");
    expect(result.silentMinutes).toBe(31);
    expect(result.reason).toContain("31 min ago");
    expect(result.reason).toContain("> 30 min threshold");
  });

  it("flags stale at the incident's real 35-minute gap", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(35), queuedTickets: 1 });
    expect(result.verdict).toBe("stale");
    expect(result.silentMinutes).toBe(35);
  });

  it("flags stale when the train has NEVER completed a run, with tickets queued", () => {
    const result = evalWith({ lastCompletedRunIso: null, queuedTickets: 2 });
    expect(result.verdict).toBe("stale");
    expect(result.silentMinutes).toBeNull();
    expect(result.reason).toContain("never completed a run");
  });

  it("respects a caller-supplied windowMinutes override for stale too", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(45), queuedTickets: 1, windowMinutes: 30 });
    expect(result.verdict).toBe("stale");
  });
});

// ───────────────────────────── evaluateTrainLiveness — idle ─────────────────────────────

describe("evaluateTrainLiveness — idle", () => {
  it("flags idle when zero tickets are queued, even after 5 hours of silence", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(5 * 60), queuedTickets: 0 });
    expect(result.verdict).toBe("idle");
    expect(result.silentMinutes).toBe(5 * 60);
    expect(result.reason).toContain("0 train:ready ticket(s) queued");
  });

  it("flags idle when zero tickets are queued and the train has never completed a run", () => {
    const result = evalWith({ lastCompletedRunIso: null, queuedTickets: 0 });
    expect(result.verdict).toBe("idle");
    expect(result.silentMinutes).toBeNull();
  });

  it("idle takes priority over disabled-adjacent staleness — a queue of zero is never stale regardless of window", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(10_000), queuedTickets: 0, windowMinutes: 1 });
    expect(result.verdict).toBe("idle");
  });
});

// ───────────────────────────── evaluateTrainLiveness — disabled ─────────────────────────────

describe("evaluateTrainLiveness — disabled", () => {
  it("flags disabled when trainEnabled is false, even with tickets queued and a long silence", () => {
    const result = evalWith({ trainEnabled: false, lastCompletedRunIso: minutesAgo(10_000), queuedTickets: 5 });
    expect(result.verdict).toBe("disabled");
    expect(result.reason).toContain("HERITAGE_TRAIN_ENABLED");
  });

  it("disabled takes priority over idle too — checked first regardless of queue state", () => {
    const result = evalWith({ trainEnabled: false, queuedTickets: 0 });
    expect(result.verdict).toBe("disabled");
  });

  it("flags disabled even when the train has never completed a run", () => {
    const result = evalWith({ trainEnabled: false, lastCompletedRunIso: null, queuedTickets: 3 });
    expect(result.verdict).toBe("disabled");
    expect(result.silentMinutes).toBeNull();
  });
});

// ───────────────────────────── formatLivenessIssueTitle ─────────────────────────────

describe("formatLivenessIssueTitle", () => {
  it("names the label, minutes silent, and queued count", () => {
    const title = formatLivenessIssueTitle(31, 2);
    expect(title).toBe(`[${TRAIN_LIVENESS_LABEL}] restart train silent 31 min with 2 ticket(s) queued`);
  });

  it("handles a null silentMinutes (never-ran case) without crashing or printing 'null'", () => {
    const title = formatLivenessIssueTitle(null, 1);
    expect(title).not.toContain("null");
    expect(title).toContain("no completed run ever recorded");
    expect(title).toContain("1 ticket(s) queued");
  });

  it("appends the PLANTED CONTROL suffix when planted=true", () => {
    const title = formatLivenessIssueTitle(45, 1, true);
    expect(title).toContain("(PLANTED CONTROL)");
    expect(title.endsWith("(PLANTED CONTROL)")).toBe(true);
  });

  it("omits the PLANTED suffix by default", () => {
    const title = formatLivenessIssueTitle(45, 1);
    expect(title).not.toContain("PLANTED");
  });
});

// ───────────────────────────── formatLivenessIssueBody ─────────────────────────────

describe("formatLivenessIssueBody", () => {
  const TICKETS: LivenessQueuedTicket[] = [
    { repo: "studio-b-ai/studiob", number: 501 },
    { repo: "studio-b-ai/client-asthetik", number: 280 },
  ];

  it("names the last run URL, every queued ticket, the threshold, and the recovery command", () => {
    const body = formatLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 35,
      queuedTickets: TICKETS,
      lastRunUrl: "https://github.com/studio-b-ai/ops-pipeline/actions/runs/12345",
      windowMinutes: 30,
    });
    expect(body).toContain("https://github.com/studio-b-ai/ops-pipeline/actions/runs/12345");
    expect(body).toContain("studio-b-ai/studiob#501");
    expect(body).toContain("studio-b-ai/client-asthetik#280");
    expect(body).toContain("threshold: 30 min");
    expect(body).toContain("35 min");
    expect(body).toContain("gh workflow run heritage-restart-train.yml --repo studio-b-ai/ops-pipeline -f dry_run=false");
    expect(body).not.toContain("PLANTED");
  });

  it("names 'none recorded' when there is no last run", () => {
    const body = formatLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: null,
      queuedTickets: TICKETS,
      lastRunUrl: null,
      windowMinutes: 30,
    });
    expect(body).toContain("none recorded");
    expect(body).toContain("unknown (no completed run ever recorded)");
  });

  it("carries the PLANTED CONTROL banner when planted=true", () => {
    const body = formatLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 45,
      queuedTickets: TICKETS,
      lastRunUrl: null,
      windowMinutes: 30,
      planted: true,
    });
    expect(body).toContain("PLANTED CONTROL");
    expect(body).toContain("Rule #471");
  });

  it("flags an empty queued list as unexpected rather than silently rendering a blank section", () => {
    const body = formatLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 45,
      queuedTickets: [],
      lastRunUrl: null,
      windowMinutes: 30,
    });
    expect(body).toContain("unexpected on a `stale` verdict");
  });

  it("mentions a last manual tick informationally, distinct from the verdict-driving schedule run", () => {
    const body = formatLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 45,
      queuedTickets: TICKETS,
      lastRunUrl: null,
      windowMinutes: 30,
      lastManualTick: { url: "https://github.com/studio-b-ai/ops-pipeline/actions/runs/99999", updatedAt: "2026-08-31T00:20:00Z" },
    });
    expect(body).toContain("Last manual tick");
    expect(body).toContain("https://github.com/studio-b-ai/ops-pipeline/actions/runs/99999");
    expect(body).toContain("does NOT feed this verdict");
  });

  it("omits the manual-tick line entirely when there is none", () => {
    const body = formatLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 45,
      queuedTickets: TICKETS,
      lastRunUrl: null,
      windowMinutes: 30,
    });
    expect(body).not.toContain("Last manual tick");
  });
});

// ───────────────────────────── evaluateTrainLiveness — timestamp validation (P3, codex review ops-pipeline#272) ─────────────────────────────

describe("evaluateTrainLiveness — timestamp validation", () => {
  it("throws on a malformed nowIso rather than silently computing NaN", () => {
    expect(() => evalWith({ nowIso: "not-a-timestamp" })).toThrow(/invalid ISO timestamp: not-a-timestamp/);
  });

  it("throws on a malformed lastCompletedRunIso rather than silently computing NaN", () => {
    expect(() => evalWith({ lastCompletedRunIso: "definitely-not-iso" })).toThrow(/invalid ISO timestamp: definitely-not-iso/);
  });

  it("a null lastCompletedRunIso is still handled as never-ran, not as a malformed timestamp", () => {
    const result = evalWith({ lastCompletedRunIso: null, queuedTickets: 1 });
    expect(result.verdict).toBe("stale");
    expect(result.silentMinutes).toBeNull();
  });

  it("never silently passes as ok with a NaN silentMinutes (the exact P3 failure shape)", () => {
    let threw = false;
    let result: ReturnType<typeof evaluateTrainLiveness> | undefined;
    try {
      result = evalWith({ lastCompletedRunIso: "garbage" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(result).toBeUndefined();
  });
});

// ───────────────────────────── pickLastScheduledRun (P1, codex review ops-pipeline#272) ─────────────────────────────

describe("pickLastScheduledRun", () => {
  function run(overrides: Partial<RunLike> = {}): RunLike {
    return {
      event: "schedule",
      updatedAt: NOW,
      createdAt: NOW,
      url: "https://github.com/studio-b-ai/ops-pipeline/actions/runs/1",
      databaseId: 1,
      ...overrides,
    };
  }

  it("returns null for an empty list", () => {
    expect(pickLastScheduledRun([])).toBeNull();
  });

  it("returns null for a dispatch-only list (no schedule-triggered run at all)", () => {
    const runs = [
      run({ databaseId: 1, event: "workflow_dispatch", updatedAt: minutesAgo(5) }),
      run({ databaseId: 2, event: "workflow_dispatch", updatedAt: minutesAgo(10) }),
    ];
    expect(pickLastScheduledRun(runs)).toBeNull();
  });

  it("picks the newest schedule-triggered run out of a mixed list, ignoring dispatch runs entirely", () => {
    const olderSchedule = run({ databaseId: 1, event: "schedule", updatedAt: minutesAgo(20) });
    const newerDispatch = run({ databaseId: 2, event: "workflow_dispatch", updatedAt: minutesAgo(2) }); // newest overall, but NOT schedule
    const newestSchedule = run({ databaseId: 3, event: "schedule", updatedAt: minutesAgo(5) });
    const result = pickLastScheduledRun([olderSchedule, newerDispatch, newestSchedule]);
    expect(result?.databaseId).toBe(3);
  });

  it("a single schedule run in an otherwise-empty list is returned as-is", () => {
    const only = run({ databaseId: 42, event: "schedule" });
    expect(pickLastScheduledRun([only])?.databaseId).toBe(42);
  });
});

// ───────────────────────────── parseTrainEnabled (P1, codex review ops-pipeline#272) ─────────────────────────────

describe("parseTrainEnabled", () => {
  it("returns enabled: true on a clean 'true' read", () => {
    const result = parseTrainEnabled({ stdout: "true\n", stderr: "", exitCode: 0 });
    expect(result).toEqual({ enabled: true });
  });

  it("returns enabled: false on a clean 'false' read", () => {
    const result = parseTrainEnabled({ stdout: "false\n", stderr: "", exitCode: 0 });
    expect(result).toEqual({ enabled: false });
  });

  it("treats a genuinely-absent variable (gh's own 'not found' phrasing) as enabled: false", () => {
    const result = parseTrainEnabled({
      stdout: "",
      stderr: "GraphQL: Could not resolve to a Variable with the name 'HERITAGE_TRAIN_ENABLED'. (repository.variable) not found",
      exitCode: 1,
    });
    expect(result).toEqual({ enabled: false });
  });

  it("treats a bare HTTP 404 as enabled: false too", () => {
    const result = parseTrainEnabled({ stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 });
    expect(result).toEqual({ enabled: false });
  });

  it("returns an error (never enabled: false) on an auth failure — a blind read must never look like a confirmed 'disabled'", () => {
    const result = parseTrainEnabled({ stdout: "", stderr: "HTTP 401: Bad credentials", exitCode: 1 });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("HTTP 401");
  });

  it("returns an error on a transient 5xx too", () => {
    const result = parseTrainEnabled({ stdout: "", stderr: "HTTP 503: couldn't respond to your request in time", exitCode: 1 });
    expect("error" in result).toBe(true);
  });
});
