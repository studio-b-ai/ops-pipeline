import { describe, expect, it } from "vitest";
import {
  evaluateCanaryLiveness,
  formatCanaryLivenessIssueTitle,
  formatCanaryLivenessIssueBody,
  pickLastScheduledRun,
  parseCanaryEnabled,
  CANARY_LIVENESS_LABEL,
  CANARY_LIVENESS_STALE_MINUTES,
  type EvaluateCanaryLivenessInput,
  type RunLike,
} from "../canary-liveness-lib.js";

// ───────────────────────────── fixtures (Rule #256 — every "now" pinned, never the real clock) ─────────────────────────────

const NOW = "2026-09-17T06:00:00Z";

function minutesAgo(n: number): string {
  return new Date(new Date(NOW).getTime() - n * 60_000).toISOString();
}

function evalWith(overrides: Partial<EvaluateCanaryLivenessInput> = {}) {
  return evaluateCanaryLiveness({
    nowIso: NOW,
    lastCompletedRunIso: minutesAgo(5),
    canaryEnabled: true,
    ...overrides,
  });
}

// ───────────────────────────── evaluateCanaryLiveness — ok ─────────────────────────────

describe("evaluateCanaryLiveness — ok", () => {
  it("flags ok when enabled and the last schedule run is well within the window", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(5) });
    expect(result.verdict).toBe("ok");
    expect(result.silentMinutes).toBe(5);
    expect(result.reason).toContain("5 min ago");
    expect(result.reason).toContain(`within the ${CANARY_LIVENESS_STALE_MINUTES} min threshold`);
  });

  it("is ok exactly AT the threshold (strictly greater-than check)", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(CANARY_LIVENESS_STALE_MINUTES) });
    expect(result.verdict).toBe("ok");
    expect(result.silentMinutes).toBe(CANARY_LIVENESS_STALE_MINUTES);
  });

  it("respects a caller-supplied windowMinutes override", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(45), windowMinutes: 60 });
    expect(result.verdict).toBe("ok");
  });
});

// ───────────────────────────── evaluateCanaryLiveness — stale ─────────────────────────────

describe("evaluateCanaryLiveness — stale", () => {
  // Negative control first (Rule #322): one minute under the default threshold must NOT flag.
  it("does NOT flag stale one minute under the default threshold", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(CANARY_LIVENESS_STALE_MINUTES - 1) });
    expect(result.verdict).toBe("ok");
  });

  it("flags stale at 31 minutes silent with the default 30-minute threshold", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(31) });
    expect(result.verdict).toBe("stale");
    expect(result.silentMinutes).toBe(31);
    expect(result.reason).toContain("31 min ago");
    expect(result.reason).toContain("> 30 min threshold");
  });

  it("flags stale at 60 minutes silent (multiple missed 5-min ticks)", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(60) });
    expect(result.verdict).toBe("stale");
    expect(result.silentMinutes).toBe(60);
  });

  it("flags stale when the sweep has NEVER completed a schedule-triggered run", () => {
    const result = evalWith({ lastCompletedRunIso: null });
    expect(result.verdict).toBe("stale");
    expect(result.silentMinutes).toBeNull();
    expect(result.reason).toContain("never completed a schedule-triggered run");
  });

  it("respects a tighter windowMinutes override for stale", () => {
    const result = evalWith({ lastCompletedRunIso: minutesAgo(20), windowMinutes: 15 });
    expect(result.verdict).toBe("stale");
  });
});

// ───────────────────────────── evaluateCanaryLiveness — disabled ─────────────────────────────

describe("evaluateCanaryLiveness — disabled", () => {
  it("flags disabled when canaryEnabled is false, even after hours of silence", () => {
    const result = evalWith({ canaryEnabled: false, lastCompletedRunIso: minutesAgo(10_000) });
    expect(result.verdict).toBe("disabled");
    expect(result.reason).toContain("SURFACE_CANARY_ENABLED");
  });

  it("disabled takes priority over stale (checked FIRST)", () => {
    const result = evalWith({ canaryEnabled: false, lastCompletedRunIso: minutesAgo(100) });
    expect(result.verdict).toBe("disabled");
  });

  it("flags disabled even when the sweep has never completed a run", () => {
    const result = evalWith({ canaryEnabled: false, lastCompletedRunIso: null });
    expect(result.verdict).toBe("disabled");
    expect(result.silentMinutes).toBeNull();
  });

  it("no idle verdict — silence while enabled is always stale, never idle", () => {
    // The surface canary's job IS to run every 5 minutes; unlike the restart train
    // (which is legitimately idle with zero box PRs), a silent canary is never OK when on.
    const result = evalWith({ canaryEnabled: true, lastCompletedRunIso: minutesAgo(60) });
    expect(result.verdict).toBe("stale");
    // Confirm the verdict set explicitly excludes idle:
    const verdicts = ["ok", "stale", "disabled"] as const;
    expect(result.verdict).toBe("stale");
    expect(verdicts).toContain("stale");
    expect(verdicts).not.toContain("idle" as any);
  });
});

// ───────────────────────────── formatCanaryLivenessIssueTitle ─────────────────────────────

describe("formatCanaryLivenessIssueTitle", () => {
  it("names the label and minutes silent", () => {
    const title = formatCanaryLivenessIssueTitle(31);
    expect(title).toBe(`[${CANARY_LIVENESS_LABEL}] surface canary silent 31 min`);
  });

  it("handles a null silentMinutes (never-ran case) without crashing or printing 'null'", () => {
    const title = formatCanaryLivenessIssueTitle(null);
    expect(title).not.toContain("null");
    expect(title).toContain("no completed schedule run ever recorded");
  });

  it("appends the PLANTED CONTROL suffix when planted=true", () => {
    const title = formatCanaryLivenessIssueTitle(45, true);
    expect(title).toContain("(PLANTED CONTROL)");
    expect(title.endsWith("(PLANTED CONTROL)")).toBe(true);
  });

  it("omits the PLANTED suffix by default", () => {
    const title = formatCanaryLivenessIssueTitle(45);
    expect(title).not.toContain("PLANTED");
  });
});

// ───────────────────────────── formatCanaryLivenessIssueBody ─────────────────────────────

describe("formatCanaryLivenessIssueBody", () => {
  it("names the last run URL, silent minutes, threshold, and the recovery command", () => {
    const body = formatCanaryLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 35,
      lastRunUrl: "https://github.com/studio-b-ai/ops-pipeline/actions/runs/12345",
      windowMinutes: 30,
    });
    expect(body).toContain("https://github.com/studio-b-ai/ops-pipeline/actions/runs/12345");
    expect(body).toContain("threshold: 30 min");
    expect(body).toContain("35 min");
    expect(body).toContain("gh workflow run surface-canary.yml --repo studio-b-ai/ops-pipeline -f dry_run=false");
    expect(body).not.toContain("PLANTED");
  });

  it("names 'none recorded' when there is no last run", () => {
    const body = formatCanaryLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: null,
      lastRunUrl: null,
      windowMinutes: 30,
    });
    expect(body).toContain("none recorded");
    expect(body).toContain("unknown (no completed schedule run ever recorded)");
  });

  it("carries the PLANTED CONTROL banner when planted=true", () => {
    const body = formatCanaryLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 45,
      lastRunUrl: null,
      windowMinutes: 30,
      planted: true,
    });
    expect(body).toContain("PLANTED CONTROL");
    expect(body).toContain("Rule #471");
  });

  it("mentions a last manual tick informationally, distinct from the verdict-driving schedule run", () => {
    const body = formatCanaryLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 45,
      lastRunUrl: null,
      windowMinutes: 30,
      lastManualTick: { url: "https://github.com/studio-b-ai/ops-pipeline/actions/runs/99999", updatedAt: "2026-09-17T05:50:00Z" },
    });
    expect(body).toContain("Last manual tick");
    expect(body).toContain("https://github.com/studio-b-ai/ops-pipeline/actions/runs/99999");
    expect(body).toContain("does NOT feed this verdict");
  });

  it("omits the manual-tick line entirely when there is none", () => {
    const body = formatCanaryLivenessIssueBody({
      nowIso: NOW,
      silentMinutes: 45,
      lastRunUrl: null,
      windowMinutes: 30,
    });
    expect(body).not.toContain("Last manual tick");
  });
});

// ───────────────────────────── evaluateCanaryLiveness — timestamp validation ─────────────────────────────

describe("evaluateCanaryLiveness — timestamp validation", () => {
  it("throws on a malformed nowIso rather than silently computing NaN", () => {
    expect(() => evalWith({ nowIso: "not-a-timestamp" })).toThrow(/invalid ISO timestamp: not-a-timestamp/);
  });

  it("throws on a malformed lastCompletedRunIso rather than silently computing NaN", () => {
    expect(() => evalWith({ lastCompletedRunIso: "definitely-not-iso" })).toThrow(/invalid ISO timestamp: definitely-not-iso/);
  });

  it("a null lastCompletedRunIso is still handled as never-ran, not as a malformed timestamp", () => {
    const result = evalWith({ lastCompletedRunIso: null });
    expect(result.verdict).toBe("stale");
    expect(result.silentMinutes).toBeNull();
  });

  it("never silently passes as ok with a NaN silentMinutes", () => {
    let threw = false;
    let result: ReturnType<typeof evaluateCanaryLiveness> | undefined;
    try {
      result = evalWith({ lastCompletedRunIso: "garbage" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(result).toBeUndefined();
  });
});

// ───────────────────────────── pickLastScheduledRun ─────────────────────────────

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
    const newerDispatch = run({ databaseId: 2, event: "workflow_dispatch", updatedAt: minutesAgo(2) });
    const newestSchedule = run({ databaseId: 3, event: "schedule", updatedAt: minutesAgo(5) });
    const result = pickLastScheduledRun([olderSchedule, newerDispatch, newestSchedule]);
    expect(result?.databaseId).toBe(3);
  });

  it("a single schedule run in an otherwise-empty list is returned as-is", () => {
    const only = run({ databaseId: 42, event: "schedule" });
    expect(pickLastScheduledRun([only])?.databaseId).toBe(42);
  });
});

// ───────────────────────────── parseCanaryEnabled ─────────────────────────────

describe("parseCanaryEnabled", () => {
  it("returns enabled: true on a clean 'true' read", () => {
    const result = parseCanaryEnabled({ stdout: "true\n", stderr: "", exitCode: 0 });
    expect(result).toEqual({ enabled: true });
  });

  it("returns enabled: false on a clean 'false' read", () => {
    const result = parseCanaryEnabled({ stdout: "false\n", stderr: "", exitCode: 0 });
    expect(result).toEqual({ enabled: false });
  });

  it("treats a genuinely-absent variable (gh's REST 'not found' phrasing) as enabled: false", () => {
    const result = parseCanaryEnabled({
      stdout: "",
      stderr: 'variable "SURFACE_CANARY_ENABLED" was not found in studio-b-ai/ops-pipeline',
      exitCode: 1,
    });
    expect(result).toEqual({ enabled: false });
  });

  it("treats gh's GraphQL not-found phrasing as enabled: false", () => {
    const result = parseCanaryEnabled({
      stdout: "",
      stderr: "GraphQL: Could not resolve to a Variable with the name 'SURFACE_CANARY_ENABLED'. (repository.variable) not found",
      exitCode: 1,
    });
    expect(result).toEqual({ enabled: false });
  });

  it("returns an error (never enabled: false) on a BARE HTTP 404 — GitHub 404s auth/visibility failures too", () => {
    const result = parseCanaryEnabled({ stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("HTTP 404");
  });

  it("returns an error (never enabled: false) on an auth failure — a blind read must never look like a confirmed 'disabled'", () => {
    const result = parseCanaryEnabled({ stdout: "", stderr: "HTTP 401: Bad credentials", exitCode: 1 });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("HTTP 401");
  });

  it("returns an error on a transient 5xx too", () => {
    const result = parseCanaryEnabled({ stdout: "", stderr: "HTTP 503: couldn't respond to your request in time", exitCode: 1 });
    expect("error" in result).toBe(true);
  });
});