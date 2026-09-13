import { describe, expect, it } from "vitest";
import {
  orphanCloseComment,
  sweepOrphanedMarkerIssues,
  sweepOrphanedTitleIssues,
  type BacklogSweepIssue,
} from "../backlog-orphan-reconcile.js";
import { buildSeverityTitle } from "../severity-issue-reconcile.js";

const STALENESS_LABEL = "backlog-staleness";
/** The real staleness title shape: `[backlog-staleness] <manager> — N findings`. */
const stale = (manager: string, n: number): string =>
  buildSeverityTitle(STALENESS_LABEL, manager, `${n} findings`);

/** The real compliance body-marker shape. */
const laneMarker = (name: string): string => `<!-- backlog-compliance:lane:${name} -->`;
const ROLLUP_MARKER = "<!-- backlog-compliance:rollup -->";

describe("sweepOrphanedTitleIssues (backlog-staleness per-manager aggregates)", () => {
  // ── negative controls first (Rule #322) ──

  // The most important test in this file, mirroring credential-reconcile.ts's own guard test:
  // an empty entity set must NEVER be read as "everything is an orphan" — that would close
  // every open backlog alarm in one run on a caller bug that failed to populate the set.
  it("global guard: configuredEntities.size === 0 → whole sweep no-ops, even with a genuine orphan present (the close-all guard)", () => {
    const orphan: BacklogSweepIssue = { number: 169, title: stale("CMO", 29), state: "OPEN" };
    const out = sweepOrphanedTitleIssues([orphan], new Set(), STALENESS_LABEL);
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on a manager still in the registry, even at a high finding count (the known-good)", () => {
    const live: BacklogSweepIssue = { number: 379, title: stale("Mechanic", 37), state: "OPEN" };
    const out = sweepOrphanedTitleIssues([live], new Set(["Mechanic"]), STALENESS_LABEL);
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on a manager still in the registry at ZERO findings — the main loop owns that close path", () => {
    const clean: BacklogSweepIssue = { number: 379, title: stale("Mechanic", 0), state: "OPEN" };
    const out = sweepOrphanedTitleIssues([clean], new Set(["Mechanic"]), STALENESS_LABEL);
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on an already-CLOSED orphan (no orphan state left to resolve)", () => {
    const closed: BacklogSweepIssue = { number: 169, title: stale("CMO", 29), state: "CLOSED" };
    const out = sweepOrphanedTitleIssues([closed], new Set(["Mechanic"]), STALENESS_LABEL);
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on a human-filed issue under the label (title has no ` — <status>` tail)", () => {
    const human: BacklogSweepIssue = {
      number: 500,
      title: "[backlog-staleness] please re-rank the Mechanic queue",
      state: "OPEN",
    };
    const out = sweepOrphanedTitleIssues([human], new Set(["Mechanic"]), STALENESS_LABEL);
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on a FOREIGN-label title — the exact `[<label>] ` prefix is required", () => {
    const foreign: BacklogSweepIssue = {
      number: 287,
      title: buildSeverityTitle("volume-monitor", "aesthetik-production/postgres", "WARN"),
      state: "OPEN",
    };
    const out = sweepOrphanedTitleIssues([foreign], new Set(["Mechanic"]), STALENESS_LABEL);
    expect(out.actions).toEqual([]);
  });

  it("does NOT rescue an orphan merely because it is a string-PREFIX of a configured name (exact match only, Rule #315)", () => {
    const prefixy: BacklogSweepIssue = { number: 600, title: stale("Mech", 3), state: "OPEN" };
    const out = sweepOrphanedTitleIssues([prefixy], new Set(["Mechanic"]), STALENESS_LABEL);
    expect(out.actions).toEqual([{ number: 600, title: stale("Mech", 3), entity: "Mech" }]);
  });

  // ── the positive control: the REAL live orphans probed on ops-pipeline 2026-09-13 ──

  it("FIRES on the three real orphans (#169 CMO / #166 COO / #157 CTO) against the real 4-manager registry", () => {
    const issues: BacklogSweepIssue[] = [
      { number: 379, title: stale("Mechanic", 37), state: "OPEN" },
      { number: 378, title: stale("Engineer", 159), state: "OPEN" },
      { number: 377, title: stale("Dispatcher", 28), state: "OPEN" },
      { number: 169, title: stale("CMO", 29), state: "OPEN" },
      { number: 166, title: stale("COO", 124), state: "OPEN" },
      { number: 157, title: stale("CTO", 59), state: "OPEN" },
    ];
    // The live registry, verbatim from scripts/backlog-managers.yaml on origin/main.
    const configured = new Set(["Dispatcher", "Engineer", "Mechanic", "Publicity"]);

    const out = sweepOrphanedTitleIssues(issues, configured, STALENESS_LABEL);

    expect(out.actions.map((a) => a.number).sort((x, y) => x - y)).toEqual([157, 166, 169]);
    expect(out.actions.map((a) => a.entity).sort()).toEqual(["CMO", "COO", "CTO"]);
  });

  it("a configured manager with NO open issue produces no action (nothing to sweep)", () => {
    const out = sweepOrphanedTitleIssues([], new Set(["Publicity"]), STALENESS_LABEL);
    expect(out.actions).toEqual([]);
  });
});

describe("sweepOrphanedMarkerIssues (backlog-compliance per-lane issues)", () => {
  it("global guard: configuredEntities.size === 0 → whole sweep no-ops (the close-all guard)", () => {
    const orphan: BacklogSweepIssue = {
      number: 10,
      title: "[backlog-compliance] Retired Lane — 2 finding(s)",
      state: "OPEN",
      body: `${laneMarker("Retired Lane")}\nstuff`,
    };
    const out = sweepOrphanedMarkerIssues([orphan], new Set(), laneMarker, ROLLUP_MARKER);
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on a lane whose row is still active", () => {
    const live: BacklogSweepIssue = {
      number: 11,
      title: "[backlog-compliance] Mechanic — 1 finding(s)",
      state: "OPEN",
      body: `${laneMarker("Mechanic")}\nstuff`,
    };
    const out = sweepOrphanedMarkerIssues([live], new Set(["Mechanic"]), laneMarker, ROLLUP_MARKER);
    expect(out.actions).toEqual([]);
  });

  // Without this exclusion the sweep would close the rollup as an orphan on every
  // pre-cutover run — the rollup is not a per-lane issue and owns its own cutover-close.
  it("does NOT act on the ROLLUP issue (it is not a per-entity issue and has its own close path)", () => {
    const rollup: BacklogSweepIssue = {
      number: 12,
      title: "[backlog-compliance] rollup",
      state: "OPEN",
      body: `${ROLLUP_MARKER}\nthe census table`,
    };
    const out = sweepOrphanedMarkerIssues([rollup], new Set(["Mechanic"]), laneMarker, ROLLUP_MARKER);
    expect(out.actions).toEqual([]);
  });

  it("does NOT act blind on an issue with no readable body (Rules #322/#465)", () => {
    const bodyless: BacklogSweepIssue = {
      number: 13,
      title: "[backlog-compliance] Ghost — 1 finding(s)",
      state: "OPEN",
    };
    const out = sweepOrphanedMarkerIssues([bodyless], new Set(["Mechanic"]), laneMarker, ROLLUP_MARKER);
    expect(out.actions).toEqual([]);
  });

  it("does NOT act on an already-CLOSED orphan", () => {
    const closed: BacklogSweepIssue = {
      number: 14,
      title: "[backlog-compliance] Retired — 1 finding(s)",
      state: "CLOSED",
      body: `${laneMarker("Retired")}\nstuff`,
    };
    const out = sweepOrphanedMarkerIssues([closed], new Set(["Mechanic"]), laneMarker, ROLLUP_MARKER);
    expect(out.actions).toEqual([]);
  });

  it("FIRES on a lane issue whose row left the LANES table, alongside a live lane and the rollup", () => {
    const issues: BacklogSweepIssue[] = [
      { number: 11, title: "[backlog-compliance] Mechanic — 1 finding(s)", state: "OPEN", body: `${laneMarker("Mechanic")}\nx` },
      { number: 12, title: "[backlog-compliance] rollup", state: "OPEN", body: `${ROLLUP_MARKER}\nx` },
      { number: 15, title: "[backlog-compliance] Ästhetik Brand · Publicity — 4 finding(s)", state: "OPEN", body: `${laneMarker("Ästhetik Brand · Publicity")}\nx` },
    ];
    const out = sweepOrphanedMarkerIssues(issues, new Set(["Mechanic"]), laneMarker, ROLLUP_MARKER);
    expect(out.actions.map((a) => a.number)).toEqual([15]);
  });

  it("works with no excludeMarker supplied (the arg is optional)", () => {
    const orphan: BacklogSweepIssue = {
      number: 16,
      title: "[backlog-compliance] Gone — 1 finding(s)",
      state: "OPEN",
      body: `${laneMarker("Gone")}\nx`,
    };
    const out = sweepOrphanedMarkerIssues([orphan], new Set(["Mechanic"]), laneMarker);
    expect(out.actions.map((a) => a.number)).toEqual([16]);
  });
});

describe("orphanCloseComment", () => {
  it("says 'no longer monitored' and explicitly does NOT claim the findings were resolved (Rule #412)", () => {
    const c = orphanCloseComment("CMO", "scripts/backlog-managers.yaml");
    expect(c).toContain("no longer present in `scripts/backlog-managers.yaml`");
    expect(c).toContain("no longer monitored");
    expect(c).toContain("were NOT re-verified");
    // "resolved" may appear ONLY inside the disclaimer that denies it — never as a claim.
    expect(c).toContain("says nothing about whether the findings above were actually resolved");
    expect(c).not.toContain("has been resolved");
    expect(c).not.toContain("now compliant");
  });
});
