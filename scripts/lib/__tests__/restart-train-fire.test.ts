import { describe, expect, it } from "vitest";
import {
  CA_HOURS_GATE_STEP,
  OBSERVE_WINDOW_MS,
  classifyCaRun,
  classifyStudiobDeployments,
  formatEndFailedLine,
  formatEndLine,
  formatStartLine,
  isRevertTitle,
  mergeTouchesDeployPaths,
  observeStateKey,
  observeTimeoutVerdict,
  pickDeployJob,
  pickLatestRun,
  type WorkflowJobLike,
  type WorkflowRunLike,
} from "../restart-train-fire.js";
import { RAILWAY_TERMINAL_STATUSES, type DeploymentRecord } from "../railway-deployment-probes.js";

const MERGED_AT = "2026-08-29T02:00:00Z";

/**
 * Railway deployment fixture. The status vocabulary here is Railway's DeploymentStatus enum
 * (SUCCESS/FAILED/CRASHED/BUILDING/SKIPPED/…) — nothing in this pure-classifier test touches
 * Postgres, so the Rule #141 sync_status registry does not apply.
 */
// pg-enum-drift-exempt: Railway DeploymentStatus vocabulary, not a Postgres enum — pure classifier test, no DB writes
function d(status: string, createdAt = "2026-08-29T02:01:00Z", id = "dddddddd-1111-2222-3333-444444444444"): DeploymentRecord {
  return { id, status, createdAt, updatedAt: createdAt };
}

function run(overrides: Partial<WorkflowRunLike>): WorkflowRunLike {
  return { id: 100, status: "completed", conclusion: "success", event: "push", created_at: "2026-08-29T02:01:00Z", ...overrides };
}

function job(conclusion: string | null, steps: Array<{ name: string; conclusion: string | null }> = []): WorkflowJobLike {
  return { name: "deploy / Deploy to production", conclusion, steps };
}

describe("isRevertTitle", () => {
  it("catches revert PR titles, leading whitespace included", () => {
    expect(isRevertTitle('Revert "feat: add thing"')).toBe(true);
    expect(isRevertTitle("revert: broken deploy")).toBe(true);
    expect(isRevertTitle("  Revert #612")).toBe(true);
  });

  it("does NOT trip on mid-title 'revert' (#322 negative control)", () => {
    expect(isRevertTitle("fix: no longer revert user prefs on logout")).toBe(false);
    expect(isRevertTitle("feat: add revertible migrations")).toBe(false);
  });
});

describe("classifyStudiobDeployments", () => {
  it("waits when no deployment postdates the merge", () => {
    const verdict = classifyStudiobDeployments(MERGED_AT, [d("SUCCESS", "2026-08-29T01:50:00Z")], RAILWAY_TERMINAL_STATUSES);
    expect(verdict.kind).toBe("waiting");
    expect(verdict.detail).toMatch(/no post-merge/);
  });

  it("a PRE-merge FAILED deployment can never fail the observe (#322 negative control)", () => {
    const verdict = classifyStudiobDeployments(MERGED_AT, [d("FAILED", "2026-08-29T01:50:00Z")], RAILWAY_TERMINAL_STATUSES);
    expect(verdict.kind).toBe("waiting");
  });

  it("waits while any post-merge deployment is still in flight", () => {
    expect(classifyStudiobDeployments(MERGED_AT, [d("BUILDING")], RAILWAY_TERMINAL_STATUSES).kind).toBe("waiting");
  });

  it("deployed on a post-merge SUCCESS", () => {
    expect(classifyStudiobDeployments(MERGED_AT, [d("SUCCESS")], RAILWAY_TERMINAL_STATUSES).kind).toBe("deployed");
  });

  it("any SUCCESS suffices even with a FAILED sibling (two overlapping deploy triggers)", () => {
    const ok = d("SUCCESS", "2026-08-29T02:01:00Z", "aaaaaaaa-0000-0000-0000-000000000000");
    const bad = d("FAILED", "2026-08-29T02:02:00Z", "bbbbbbbb-0000-0000-0000-000000000000");
    expect(classifyStudiobDeployments(MERGED_AT, [ok, bad], RAILWAY_TERMINAL_STATUSES).kind).toBe("deployed");
  });

  it("failed on post-merge FAILED/CRASHED with no successful sibling", () => {
    expect(classifyStudiobDeployments(MERGED_AT, [d("FAILED")], RAILWAY_TERMINAL_STATUSES).kind).toBe("failed");
    expect(classifyStudiobDeployments(MERGED_AT, [d("CRASHED")], RAILWAY_TERMINAL_STATUSES).kind).toBe("failed");
  });

  it("all-SKIPPED post-merge set keeps waiting (no restart observed — the timeout ladder owns it)", () => {
    const verdict = classifyStudiobDeployments(MERGED_AT, [d("SKIPPED")], RAILWAY_TERMINAL_STATUSES);
    expect(verdict.kind).toBe("waiting");
    expect(verdict.detail).toMatch(/SKIPPED/);
  });

  it("unparseable mergedAt or createdAt degrades to waiting, never a verdict", () => {
    expect(classifyStudiobDeployments("not-a-date", [d("SUCCESS")], RAILWAY_TERMINAL_STATUSES).kind).toBe("waiting");
    expect(classifyStudiobDeployments(MERGED_AT, [d("FAILED", "junk")], RAILWAY_TERMINAL_STATUSES).kind).toBe("waiting");
  });
});

describe("pickLatestRun / pickDeployJob", () => {
  it("returns null on empty; newest by created_at otherwise", () => {
    expect(pickLatestRun([])).toBeNull();
    const older = run({ id: 1, created_at: "2026-08-29T02:01:00Z" });
    const newer = run({ id: 2, created_at: "2026-08-29T09:00:00Z", event: "workflow_dispatch" });
    expect(pickLatestRun([older, newer])?.id).toBe(2);
    expect(pickLatestRun([newer, older])?.id).toBe(2);
  });

  it("prefers the qualified deploy job name, falls back to bare 'deploy' (skipped variant), else null", () => {
    const qualified = job("success");
    const bare: WorkflowJobLike = { name: "deploy", conclusion: "skipped", steps: [] };
    const other: WorkflowJobLike = { name: "build", conclusion: "success", steps: [] };
    expect(pickDeployJob([other, bare, qualified])?.name).toBe("deploy / Deploy to production");
    expect(pickDeployJob([other, bare])?.name).toBe("deploy");
    expect(pickDeployJob([other])).toBeNull();
  });
});

describe("classifyCaRun", () => {
  it("waits with no run yet, and while the run is not completed", () => {
    expect(classifyCaRun(null, null).kind).toBe("waiting");
    expect(classifyCaRun(run({ status: "in_progress", conclusion: null }), null).kind).toBe("waiting");
  });

  it("fails CLOSED when a completed run has no recognizable deploy job", () => {
    const verdict = classifyCaRun(run({}), null);
    expect(verdict.kind).toBe("failed");
    expect(verdict.detail).toMatch(/no deploy job/);
  });

  it("success / skipped map to their END kinds", () => {
    expect(classifyCaRun(run({}), job("success")).kind).toBe("success");
    expect(classifyCaRun(run({}), job("skipped")).kind).toBe("skipped");
  });

  it("failure AT the hours-gate step is window-blocked", () => {
    const gated = job("failure", [{ name: CA_HOURS_GATE_STEP, conclusion: "failure" }]);
    expect(classifyCaRun(run({ conclusion: "failure" }), gated).kind).toBe("window-blocked");
  });

  it("failure at any OTHER step is failed, even with the gate step present-but-passing (#322 negative — step NAME match only, #425)", () => {
    const otherStep = job("failure", [
      { name: CA_HOURS_GATE_STEP, conclusion: "success" },
      { name: "Publish customization", conclusion: "failure" },
    ]);
    expect(classifyCaRun(run({ conclusion: "failure" }), otherStep).kind).toBe("failed");
    expect(classifyCaRun(run({ conclusion: "failure" }), job("failure", [])).kind).toBe("failed");
  });

  it("cancelled / timed_out / null conclusions fail closed", () => {
    expect(classifyCaRun(run({}), job("cancelled")).kind).toBe("failed");
    expect(classifyCaRun(run({}), job("timed_out")).kind).toBe("failed");
    expect(classifyCaRun(run({}), job(null)).kind).toBe("failed");
  });
});

describe("observeTimeoutVerdict", () => {
  const T0 = "2026-08-29T02:00:00Z";
  const plus = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

  it("studiob: quiet under 20 min, overdue at 1×–2×, escalate at ≥40 min", () => {
    expect(observeTimeoutVerdict(T0, plus(19), "studiob")).toBe("within-window");
    expect(observeTimeoutVerdict(T0, plus(20), "studiob")).toBe("overdue");
    expect(observeTimeoutVerdict(T0, plus(39), "studiob")).toBe("overdue");
    expect(observeTimeoutVerdict(T0, plus(40), "studiob")).toBe("escalate");
  });

  it("client-asthetik: 60-min window, escalate at ≥120 min", () => {
    expect(observeTimeoutVerdict(T0, plus(59), "client-asthetik")).toBe("within-window");
    expect(observeTimeoutVerdict(T0, plus(61), "client-asthetik")).toBe("overdue");
    expect(observeTimeoutVerdict(T0, plus(120), "client-asthetik")).toBe("escalate");
  });

  it("fails closed: unparseable stamps or an unknown repo class escalate (#382)", () => {
    expect(observeTimeoutVerdict("junk", plus(1), "studiob")).toBe("escalate");
    expect(observeTimeoutVerdict(T0, "junk", "studiob")).toBe("escalate");
    expect(observeTimeoutVerdict(T0, plus(1), "other")).toBe("escalate");
  });

  it("windows are the locked constants (20 min / 60 min)", () => {
    expect(OBSERVE_WINDOW_MS.studiob).toBe(20 * 60_000);
    expect(OBSERVE_WINDOW_MS["client-asthetik"]).toBe(60 * 60_000);
  });
});

describe("ledger line formats + observe state keys", () => {
  it("START carries the short sha and rung-3 attribution", () => {
    const line = formatStartLine("2026-08-29T02:00:00Z", "studio-b-ai/studiob", 620, "abcdef0123456789");
    expect(line).toBe(
      "START 2026-08-29T02:00:00Z · studio-b-ai/studiob#620 @ abcdef0 squash-merged by restart-train (rung 3) — observing restart",
    );
  });

  it("END and END · FAILED are kind-first and carry the detail", () => {
    expect(formatEndLine("2026-08-29T02:10:00Z", "studio-b-ai/studiob", 620, "Railway deployment abcd SUCCESS")).toBe(
      "END 2026-08-29T02:10:00Z · studio-b-ai/studiob#620 restart observed complete — Railway deployment abcd SUCCESS",
    );
    expect(formatEndFailedLine("2026-08-29T02:10:00Z", "studio-b-ai/studiob", 620, "deployment CRASHED")).toBe(
      "END · FAILED 2026-08-29T02:10:00Z · studio-b-ai/studiob#620 — deployment CRASHED",
    );
  });

  it("observe state keys are per (PR, sha, phase) — never per tick", () => {
    const a = observeStateKey("studio-b-ai/studiob", 620, "abc123", "end-success");
    expect(a).toBe("observe :: studio-b-ai/studiob#620 @ abc123 :: end-success");
    expect(observeStateKey("studio-b-ai/studiob", 620, "abc123", "end-failed")).not.toBe(a);
  });
});

describe("mergeTouchesDeployPaths", () => {
  const CA = "studio-b-ai/client-asthetik";

  it("client-asthetik workflow-only change matches no deploy-trigger path (the client-asthetik#362 defect)", () => {
    expect(mergeTouchesDeployPaths(CA, [".github/workflows/require-review-label.yml"])).toBe(false);
    expect(mergeTouchesDeployPaths(CA, [".github/workflows/x.yml"])).toBe(false);
  });

  it("client-asthetik Customization change matches (recursive **)", () => {
    expect(mergeTouchesDeployPaths(CA, ["acumatica/Customization/Bolt/Pages/SB/SB501010.aspx"])).toBe(true);
  });

  it("client-asthetik exact-file globs match", () => {
    expect(mergeTouchesDeployPaths(CA, ["acumatica/acuops.yaml"])).toBe(true);
    expect(mergeTouchesDeployPaths(CA, ["acumatica/instance-manifest.json"])).toBe(true);
  });

  it("client-asthetik src/** matches", () => {
    expect(mergeTouchesDeployPaths(CA, ["src/Bolt/Graphs/X.cs"])).toBe(true);
  });

  it("a mixed file list matches if ANY file matches", () => {
    expect(mergeTouchesDeployPaths(CA, [".github/workflows/x.yml", "src/Bolt/Graphs/X.cs", "README.md"])).toBe(true);
  });

  it("unknown repo fails toward observing (true), never toward skipping", () => {
    expect(mergeTouchesDeployPaths("studio-b-ai/some-other-repo", ["README.md"])).toBe(true);
  });

  it("empty file list fails toward observing (true) — an empty read is not evidence of nothing (#401)", () => {
    expect(mergeTouchesDeployPaths(CA, [])).toBe(true);
  });

  it("studiob has no paths: filter (deploy-api.yml carries no push trigger at all, Rule #480) — always true", () => {
    expect(mergeTouchesDeployPaths("studio-b-ai/studiob", [".github/workflows/require-review-label.yml"])).toBe(true);
    expect(mergeTouchesDeployPaths("studio-b-ai/studiob", ["src/index.ts"])).toBe(true);
  });
});
