import { describe, expect, it } from "vitest";
import {
  MIN_FAILING_FOR_ZERO_SUCCESS,
  NEVER_FIRED_MIN_AGE_DAYS,
  classifyWorkflow,
  cronPeriodDays,
  failureStreak,
  isSystemic,
  mergeRunWindows,
  observedPeriodDays,
  renderDeadCronIssueBody,
  renderDegradationBody,
  resolveCronPeriodDays,
  resolvePeriodDays,
  sortRunsNewestFirst,
  streakThresholdK,
  summarizeDeadCron,
  DEAD_CRON_CLASSES,
  type DeadCronFinding,
  type ScheduledRun,
  type WorkflowObservation,
} from "../dead-cron-classify.js";

// ───────────────────────────── fixtures ─────────────────────────────

const NOW = "2026-08-15T00:00:00Z";

function run(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return { status: "completed", conclusion: "failure", createdAt: "2026-08-14T08:30:00Z", ...overrides };
}

/** N newest-first completed runs, one per day back from 8/14, all with `conclusion`. */
function dailyRuns(n: number, conclusion: string): ScheduledRun[] {
  const base = Date.parse("2026-08-14T08:30:00Z");
  return Array.from({ length: n }, (_, i) => run({ conclusion, createdAt: new Date(base - i * 86_400_000).toISOString() }));
}

function obs(overrides: Partial<WorkflowObservation> = {}): WorkflowObservation {
  return {
    repo: "client-asthetik",
    workflow: { name: "HubSpot Drift Detection", path: ".github/workflows/hubspot-drift-detection.yml", state: "active", createdAt: "2026-01-01T00:00:00Z" },
    crons: ["30 8 * * *"],
    runs: dailyRuns(25, "failure"),
    ...overrides,
  };
}

// ───────────────────────────── cron → period ─────────────────────────────

describe("cronPeriodDays", () => {
  it("daily (dom=* dow=*) → 1", () => {
    expect(cronPeriodDays("30 8 * * *")).toBe(1);
  });
  it("sub-daily collapses to 1 (hourly)", () => {
    expect(cronPeriodDays("0 * * * *")).toBe(1);
    expect(cronPeriodDays("*/15 * * * *")).toBe(1);
  });
  it("weekly single dow → 7 (the repo-hygiene Friday cron)", () => {
    expect(cronPeriodDays("0 9 * * 5")).toBe(7);
    expect(cronPeriodDays("0 9 * * MON")).toBe(7);
  });
  it("multi-dow (weekdays) → 3", () => {
    expect(cronPeriodDays("0 9 * * 1-5")).toBe(3);
    expect(cronPeriodDays("0 9 * * 1,3,5")).toBe(3);
  });
  it("monthly (dom restricted) → 31", () => {
    expect(cronPeriodDays("0 6 1 * *")).toBe(31);
  });
  it("both dom+dow restricted (cron ORs them → more frequent) → 3", () => {
    expect(cronPeriodDays("0 6 1 * 5")).toBe(3);
  });
  it("unparseable → null", () => {
    expect(cronPeriodDays("not a cron")).toBeNull();
    expect(cronPeriodDays("0 9 * *")).toBeNull(); // 4 fields
  });
  it("resolveCronPeriodDays takes the shortest across entries, null when none parse", () => {
    expect(resolveCronPeriodDays(["0 9 * * 5", "30 8 * * *"])).toBe(1);
    expect(resolveCronPeriodDays(["garbage"])).toBeNull();
    expect(resolveCronPeriodDays([])).toBeNull();
  });
});

describe("observedPeriodDays", () => {
  it("median gap of daily runs ≈ 1", () => {
    expect(observedPeriodDays(dailyRuns(5, "failure"))).toBe(1);
  });
  it("needs ≥3 runs", () => {
    expect(observedPeriodDays(dailyRuns(2, "failure"))).toBeNull();
    expect(observedPeriodDays([])).toBeNull();
  });
  it("weekly spacing reads ≈ 7", () => {
    const weekly = [
      run({ createdAt: "2026-08-14T09:00:00Z" }),
      run({ createdAt: "2026-08-07T09:00:00Z" }),
      run({ createdAt: "2026-07-31T09:00:00Z" }),
    ];
    expect(observedPeriodDays(weekly)).toBe(7);
  });
  it("clamps a wild gap to 45", () => {
    const sparse = [
      run({ createdAt: "2026-08-14T09:00:00Z" }),
      run({ createdAt: "2026-04-01T09:00:00Z" }),
      run({ createdAt: "2025-11-01T09:00:00Z" }),
    ];
    expect(observedPeriodDays(sparse)).toBe(45);
  });
  it("falls back to observed spacing when the cron is unreadable (resolvePeriodDays ladder)", () => {
    expect(resolvePeriodDays(obs({ crons: [], runs: dailyRuns(5, "failure") }))).toBe(1);
    expect(resolvePeriodDays(obs({ crons: ["30 8 * * *"], runs: [] }))).toBe(1);
    expect(resolvePeriodDays(obs({ crons: [], runs: [] }))).toBeNull();
  });
});

describe("streakThresholdK", () => {
  it("matches the spec's calibration (7 daily / 3 weekly), monotone in between and beyond", () => {
    expect(streakThresholdK(1)).toBe(7);
    expect(streakThresholdK(3)).toBe(5);
    expect(streakThresholdK(7)).toBe(3);
    expect(streakThresholdK(31)).toBe(2);
    expect(streakThresholdK(null)).toBe(7); // unknown → conservative end
  });
});

// ───────────────────────────── streak semantics ─────────────────────────────

describe("failureStreak", () => {
  it("counts consecutive failing from newest", () => {
    expect(failureStreak(dailyRuns(25, "failure"))).toBe(25);
  });
  it("a success breaks it", () => {
    const runs = [run({ conclusion: "failure" }), run({ conclusion: "failure" }), run({ conclusion: "success" }), run({ conclusion: "failure" })];
    expect(failureStreak(runs)).toBe(2);
  });
  it("a NEUTRAL conclusion (cancelled/skipped) also breaks it — Rule #425 conservative posture, and Rule #471's own history: superseded CANCELLED runs GitHub itself ignores must not count as evidence of death", () => {
    const runs = [run({ conclusion: "failure" }), run({ conclusion: "cancelled" }), run({ conclusion: "failure" }), run({ conclusion: "failure" })];
    expect(failureStreak(runs)).toBe(1);
  });
  it("timed_out and startup_failure count as failing", () => {
    const runs = [run({ conclusion: "timed_out" }), run({ conclusion: "startup_failure" }), run({ conclusion: "failure" })];
    expect(failureStreak(runs)).toBe(3);
  });
  it("in-progress runs are skipped (not completed), so they neither extend nor break", () => {
    const runs = [run({ status: "in_progress", conclusion: null }), run({ conclusion: "failure" }), run({ conclusion: "failure" })];
    expect(failureStreak(runs)).toBe(2);
  });
});

// ───────────────────────────── classification ─────────────────────────────

describe("classifyWorkflow", () => {
  it("the client-asthetik specimen: 25/25 failing daily runs → zero-success-history (not failure-streak — strongest applicable of the two history classes)", () => {
    const f = classifyWorkflow(obs(), NOW);
    expect(f?.class).toBe("zero-success-history");
    expect(f?.detail).toContain("0 successes");
  });

  it("healthy daily cron (ran yesterday, mixed history with successes) → null", () => {
    const runs = [run({ conclusion: "success", createdAt: "2026-08-14T08:30:00Z" }), ...dailyRuns(10, "success").slice(1)];
    expect(classifyWorkflow(obs({ runs }), NOW)).toBeNull();
  });

  it("failure-streak fires at K for a daily cron (7) with prior successes", () => {
    const runs = [...dailyRuns(7, "failure"), run({ conclusion: "success", createdAt: "2026-08-07T08:30:00Z" }), ...dailyRuns(10, "success").map((r, i) => ({ ...r, createdAt: `2026-07-${String(28 - i).padStart(2, "0")}T08:30:00Z` }))];
    const f = classifyWorkflow(obs({ runs }), NOW);
    expect(f?.class).toBe("failure-streak");
    expect(f?.detail).toContain("K=7");
  });

  it("6 straight failures of a daily cron (below K=7) → null (not yet)", () => {
    const runs = [...dailyRuns(6, "failure"), run({ conclusion: "success", createdAt: "2026-08-08T08:30:00Z" })];
    expect(classifyWorkflow(obs({ runs }), NOW)).toBeNull();
  });

  it("weekly cron with 3 straight failures fires (K=3)", () => {
    const runs = [
      run({ createdAt: "2026-08-14T09:00:00Z" }),
      run({ createdAt: "2026-08-07T09:00:00Z" }),
      run({ createdAt: "2026-07-31T09:00:00Z" }),
      run({ conclusion: "success", createdAt: "2026-07-24T09:00:00Z" }),
    ];
    const f = classifyWorkflow(obs({ crons: ["0 9 * * 5"], runs }), NOW);
    expect(f?.class).toBe("failure-streak");
    expect(f?.detail).toContain("K=3");
  });

  it("the hubspot-configs specimen: disabled_inactivity → scheduled-but-silent, regardless of run history", () => {
    const f = classifyWorkflow(
      obs({
        workflow: { name: "Drift", path: ".github/workflows/drift.yml", state: "disabled_inactivity", createdAt: "2025-01-01T00:00:00Z" },
        runs: dailyRuns(25, "success"), // even a healthy-looking history: GitHub turned the cron OFF
      }),
      NOW,
    );
    expect(f?.class).toBe("scheduled-but-silent");
    expect(f?.detail).toContain("disabled_inactivity");
  });

  it("active daily cron silent for 5 days (≥2×period) → scheduled-but-silent", () => {
    const runs = [run({ conclusion: "success", createdAt: "2026-08-10T08:30:00Z" })];
    const f = classifyWorkflow(obs({ runs }), NOW);
    expect(f?.class).toBe("scheduled-but-silent");
    expect(f?.detail).toContain("stopped firing");
  });

  it("weekly cron that ran 8 days ago (under 2×7) → null", () => {
    const runs = [
      run({ conclusion: "success", createdAt: "2026-08-07T09:00:00Z" }),
      run({ conclusion: "success", createdAt: "2026-07-31T09:00:00Z" }),
      run({ conclusion: "success", createdAt: "2026-07-24T09:00:00Z" }),
    ];
    expect(classifyWorkflow(obs({ crons: ["0 9 * * 5"], runs }), NOW)).toBeNull();
  });

  it("never-fired: old workflow with a cron and zero runs → scheduled-but-silent (the #280 class)", () => {
    const f = classifyWorkflow(obs({ runs: [] }), NOW);
    expect(f?.class).toBe("scheduled-but-silent");
    expect(f?.detail).toContain("ZERO scheduled runs ever");
  });

  it("never-fired guard: a YOUNG workflow with zero runs → null (created 3 days ago)", () => {
    const wf = { name: "New", path: ".github/workflows/new.yml", state: "active", createdAt: "2026-08-12T00:00:00Z" };
    expect(classifyWorkflow(obs({ workflow: wf, runs: [] }), NOW)).toBeNull();
    // and the age floor is the constant, not hardcoded prose:
    expect(NEVER_FIRED_MIN_AGE_DAYS).toBeGreaterThan(0);
  });

  it("never-fired requires a READ cron — zero runs with unreadable file → null (can't distinguish 'no cron' from 'never fired')", () => {
    expect(classifyWorkflow(obs({ crons: [], runs: [] }), NOW)).toBeNull();
  });

  it("disabled_manually NEVER flags — a human chose that (Rule #157)", () => {
    const wf = { name: "Off", path: ".github/workflows/off.yml", state: "disabled_manually", createdAt: "2025-01-01T00:00:00Z" };
    expect(classifyWorkflow(obs({ workflow: wf, runs: dailyRuns(25, "failure") }), NOW)).toBeNull();
  });

  it("zero-success needs ≥MIN_FAILING failing runs — 5 failures, 0 successes, recent → null (young failing cron matures via streak, K=7)", () => {
    const runs = dailyRuns(5, "failure");
    expect(classifyWorkflow(obs({ runs }), NOW)).toBeNull();
    expect(MIN_FAILING_FOR_ZERO_SUCCESS).toBe(10);
  });

  it("25 cancelled runs (zero successes, zero failures) → null — neutral conclusions are not evidence of death", () => {
    const runs = dailyRuns(25, "cancelled");
    expect(classifyWorkflow(obs({ runs }), NOW)).toBeNull();
  });

  it("non-scheduled workflow (no cron, no scheduled runs) → null even when broken", () => {
    expect(classifyWorkflow(obs({ crons: [], runs: [] }), NOW)).toBeNull();
  });
});

// ───────────────────────────── summary + bodies ─────────────────────────────

describe("summarizeDeadCron", () => {
  it("always prints every class including 0 (Rule #465)", () => {
    const s = summarizeDeadCron([]);
    for (const c of DEAD_CRON_CLASSES) expect(s).toContain(`${c}=0`);
    expect(s).toContain("total=0");
  });
});

describe("renderDeadCronIssueBody", () => {
  const findings: DeadCronFinding[] = [
    { repo: "client-asthetik", workflowName: "PG Backup", workflowPath: ".github/workflows/pg-backup.yml", class: "zero-success-history", detail: "0 successes across 25 runs." },
    { repo: "client-asthetik", workflowName: "Drift", workflowPath: ".github/workflows/drift.yml", class: "scheduled-but-silent", detail: "auto-disabled." },
  ];
  it("groups by class, carries workflow paths, states the flags-only contract and the weekly cadence honestly (Rules #412/#448)", () => {
    const body = renderDeadCronIssueBody(findings, { repo: "client-asthetik", generatedAt: NOW });
    expect(body).toContain("Scheduled but silent (1)");
    expect(body).toContain("Zero-success history (1)");
    expect(body).toContain("pg-backup.yml");
    expect(body).toContain("flags, never acts");
    expect(body).toContain("WEEKLY");
    expect(body).toContain("total=2");
  });
});

describe("degradation (Rule #464 — the leg must say when it is blind)", () => {
  it("isSystemic: all-failed = systemic; partial or zero-attempted is not", () => {
    expect(isSystemic({ attempted: 5, failed: 5 })).toBe(true);
    expect(isSystemic({ attempted: 5, failed: 4 })).toBe(false);
    expect(isSystemic({ attempted: 0, failed: 0 })).toBe(false);
  });
  it("body names the missing permission per dead capability and the ops#104 remediation", () => {
    const body = renderDegradationBody(
      {
        workflowsList: { attempted: 90, failed: 90, firstError: "HTTP 403" },
        contentReads: { attempted: 0, failed: 0, firstError: null },
      },
      NOW,
    );
    expect(body).toContain("Actions");
    expect(body).toContain("ops#104");
    expect(body).toContain("MUST NOT be read as \"fleet healthy\"");
    expect(body).not.toContain("Workflow-file reads dead");
  });
});

// ───────────────────────────── transient-read guard (ui-test-suite#44, 2026-08-15) ─────────────────────────────

/** Weekly Monday runs, newest-first, ending 8/10 — the real tighten-sync-baseline shape (18 runs 4/13→8/10). */
function weeklyRuns(n: number, conclusion = "success", newestIso = "2026-08-10T04:51:56Z"): ScheduledRun[] {
  const base = Date.parse(newestIso);
  return Array.from({ length: n }, (_, i) => run({ id: 1000 - i, conclusion, createdAt: new Date(base - i * 7 * 86_400_000).toISOString() }));
}

const WEEKLY_OBS = (runs: ScheduledRun[]): WorkflowObservation =>
  obs({
    repo: "ui-test-suite",
    workflow: { name: "Tighten Sync Baseline", path: ".github/workflows/tighten-sync-baseline.yml", state: "active", createdAt: "2026-04-09T16:10:20Z" },
    crons: ["30 5 * * 1"],
    runs,
  });

describe("sortRunsNewestFirst", () => {
  it("orders newest-first regardless of input order, stable, unparseable last", () => {
    const a = run({ id: 1, createdAt: "2026-08-01T00:00:00Z" });
    const b = run({ id: 2, createdAt: "2026-08-10T00:00:00Z" });
    const c = run({ id: 3, createdAt: "2026-08-05T00:00:00Z" });
    const bad = run({ id: 4, createdAt: "not-a-date" });
    expect(sortRunsNewestFirst([a, bad, c, b]).map((r) => r.id)).toEqual([2, 3, 1, 4]);
  });

  it("does not mutate its input", () => {
    const input = [run({ id: 1, createdAt: "2026-08-01T00:00:00Z" }), run({ id: 2, createdAt: "2026-08-10T00:00:00Z" })];
    sortRunsNewestFirst(input);
    expect(input.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("classifyWorkflow never trusts input order (the runs[0]-as-newest assumption)", () => {
  it("a mis-ordered healthy weekly window (6/22 first, 8/10 buried) is NOT silent", () => {
    const healthy = weeklyRuns(18); // newest 8/10 → 5d silent, threshold 14d
    const misordered = [healthy[7], ...healthy.slice(0, 7), ...healthy.slice(8)]; // 6/22 run first, exactly the #44 response shape
    expect(misordered[0].createdAt.startsWith("2026-06-22")).toBe(true);
    expect(classifyWorkflow(WEEKLY_OBS(healthy), NOW)).toBeNull();
    expect(classifyWorkflow(WEEKLY_OBS(misordered), NOW)).toBeNull();
  });

  it("a mis-ordered window cannot fake a failure streak either (newest success buried under older failures)", () => {
    const runs = [...dailyRuns(10, "failure").slice(1), run({ conclusion: "success", createdAt: "2026-08-14T08:30:00Z" })]; // success is the TRUE newest but listed last
    expect(classifyWorkflow(obs({ runs }), NOW)).toBeNull();
    // and reversed (oldest-first) input classifies identically to newest-first input
    const newestFirst = dailyRuns(25, "failure");
    expect(classifyWorkflow(obs({ runs: [...newestFirst].reverse() }), NOW)).toEqual(classifyWorkflow(obs({ runs: newestFirst }), NOW));
  });

  it("the #44 primary shape alone (window truncated at 6/22 — 7 newest runs missing) DOES flag silent — the merge is what saves it", () => {
    const truncated = weeklyRuns(18).slice(7); // newest = 6/22, 54d silent at NOW
    const finding = classifyWorkflow(WEEKLY_OBS(truncated), NOW);
    expect(finding?.class).toBe("scheduled-but-silent");
    expect(finding?.detail).toContain("2026-06-22");
  });
});

describe("mergeRunWindows (two differently-shaped reads → union)", () => {
  it("adds runs the primary missed and reports how many were NEWER than primary's newest", () => {
    const full = weeklyRuns(18);
    const primary = full.slice(7); // truncated at 6/22
    const secondary = full.slice(0, 13); // created>=90d read: 8/10 back to 5/18
    const merged = mergeRunWindows(primary, secondary);
    expect(merged.added).toBe(7);
    expect(merged.addedNewer).toBe(7);
    expect(merged.runs.map((r) => r.id)).toEqual(full.map((r) => r.id)); // union == the real 18, newest-first
    expect(classifyWorkflow(WEEKLY_OBS(merged.runs), NOW)).toBeNull(); // and it classifies healthy
  });

  it("dedupes by id, and by createdAt+status+conclusion when ids are absent", () => {
    const withIds = weeklyRuns(5);
    expect(mergeRunWindows(withIds, withIds).added).toBe(0);
    const noIds = dailyRuns(5, "failure");
    const m = mergeRunWindows(noIds, [...noIds, run({ conclusion: "failure", createdAt: "2026-08-15T00:00:00Z" })]);
    expect(m.added).toBe(1);
    expect(m.addedNewer).toBe(1);
  });

  it("caps to the window newest-first, and an older-only addition is added but not addedNewer", () => {
    const primary = weeklyRuns(25);
    const older = weeklyRuns(30).slice(25); // 5 runs older than anything in primary
    const m = mergeRunWindows(primary, older, 25);
    expect(m.added).toBe(5);
    expect(m.addedNewer).toBe(0);
    expect(m.runs).toHaveLength(25);
    expect(m.runs[0].id).toBe(primary[0].id);
  });

  it("empty primary: everything from the secondary counts as newer; empty secondary: primary unchanged", () => {
    const sec = weeklyRuns(3);
    expect(mergeRunWindows([], sec)).toEqual({ runs: sec, added: 3, addedNewer: 3 });
    const prim = weeklyRuns(3);
    expect(mergeRunWindows(prim, [])).toEqual({ runs: prim, added: 0, addedNewer: 0 });
  });
});
