import { describe, expect, it } from "vitest";
import { orderFleetSweepEntries, type FleetSweepEntry } from "../fleet-sweep-order.js";

// ops#327 / ops#341 P1+P2 — squasher fleet sweep starvation.
// P1: rotate per-repo BEFORE capping — a repo's 6th+ bugsquasher entries
//   see a different window every run (the old shape rotated AFTER capping,
//   so rotation only reordered the same first N entries forever).
// P2: exempt the train group from per-repo capping — Kevin's door-word
//   label is never silently dropped behind a per-repo limit (the global
//   fanout still bounds it).

function mkTrain(repo: string, pr: string): FleetSweepEntry {
  return {
    repo,
    pr_number: pr,
    train_ready: true,
    enabled_classes: "",
    sensitive_path_patterns: "",
    safe_path_globs: "",
    required_checks: "",
  };
}

function mkBugsq(repo: string, pr: string): FleetSweepEntry {
  return {
    repo,
    pr_number: pr,
    train_ready: false,
    enabled_classes: "docs-comment,code-fix",
    sensitive_path_patterns: "",
    safe_path_globs: "src/**",
    required_checks: "Build & Check",
  };
}

describe("orderFleetSweepEntries (ops#327)", () => {
  it("planted (queued starvation): a queued PR at fleet position 28 of 30 is evaluated in the first cycle, ahead of every bugsquasher", () => {
    // Reproduces the Dispatcher finding shape: five repos with many
    // bugsquasher PRs (well past the fanout), one train:true repo with a
    // single `queued` PR whose enumeration position is deep past the cap.
    const entries: FleetSweepEntry[] = [
      ...Array.from({ length: 7 }, (_, i) => mkBugsq("studio-b-ai/bolt-wms", `${900 + i}`)),
      ...Array.from({ length: 6 }, (_, i) => mkBugsq("studio-b-ai/studiob", `${700 + i}`)),
      ...Array.from({ length: 3 }, (_, i) => mkBugsq("studio-b-ai/studiob-price-sync", `${200 + i}`)),
      ...Array.from({ length: 1 }, (_, i) => mkBugsq("studio-b-ai/ops-pipeline", `${300 + i}`)),
      ...Array.from({ length: 13 }, (_, i) => mkBugsq("studio-b-ai/webhook-router", `${880 + i}`)),
      // The starved PR — buried at position 28 in enumeration order under the old shape.
      mkTrain("studio-b-ai/webhook-router", "915"),
    ];

    const ordered = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 5, runOffset: 0 });

    // #915 must be present, and at position 0 (queued-first, fleet-wide).
    expect(ordered[0]).toEqual(mkTrain("studio-b-ai/webhook-router", "915"));
    expect(ordered.some((e) => e.pr_number === "915" && e.train_ready)).toBe(true);
    // No repo occupies more than the per-repo cap IN THE BUGSQUASHER GROUP.
    // Train group is exempt from per-repo cap (P2); Kevin's door word is never
    // silently dropped behind a per-repo limit.
    for (const repo of new Set(entries.map((e) => e.repo))) {
      const bugsqCount = ordered.filter((e) => e.repo === repo && !e.train_ready).length;
      expect(bugsqCount).toBeLessThanOrEqual(5);
    }
    // Global cap holds.
    expect(ordered.length).toBeLessThanOrEqual(20);
  });

  it("planted (P1 per-repo rotation-before-cap): a repo with 13 bugsquasher PRs at perRepoCap=5 covers all 13 across consecutive runs", () => {
    // The old shape rotated AFTER capping: `runOffset` reordered the same
    // first-5 entries forever and the 6th+ were permanently starved.
    // Rotating each repo's entries BEFORE capping fixes it — across
    // ⌈13/5⌉ = 3 offsets the union covers all 13 entries.
    const entries: FleetSweepEntry[] = Array.from({ length: 13 }, (_, i) =>
      mkBugsq("studio-b-ai/webhook-router", `${900 + i}`),
    );

    const covered = new Set<string>();
    for (let offset = 0; offset < 3; offset++) {
      const ordered = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 5, runOffset: offset });
      // Each run gets at most 5 per repo (global fanout is 20 but only one repo).
      expect(ordered.length).toBeLessThanOrEqual(5);
      for (const e of ordered) covered.add(e.pr_number);
    }

    // All 13 entries were covered across the three rotations.
    for (let i = 0; i < 13; i++) expect(covered.has(`${900 + i}`)).toBe(true);
  });

  it("control: a small input (train + bugsquasher, all under per-repo cap and fanout) is returned exactly in queued-first order", () => {
    const entries: FleetSweepEntry[] = [
      mkBugsq("studio-b-ai/bolt-wms", "500"),
      mkTrain("studio-b-ai/bolt-wms", "600"),
      mkBugsq("studio-b-ai/studiob", "700"),
      mkTrain("studio-b-ai/webhook-router", "800"),
    ];

    const ordered = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 5, runOffset: 0 });

    expect(ordered).toEqual([
      mkTrain("studio-b-ai/bolt-wms", "600"),
      mkTrain("studio-b-ai/webhook-router", "800"),
      mkBugsq("studio-b-ai/bolt-wms", "500"),
      mkBugsq("studio-b-ai/studiob", "700"),
    ]);
  });

  it("control: an empty input returns an empty array (no throw)", () => {
    expect(orderFleetSweepEntries([], { maxFanout: 20, perRepoCap: 5, runOffset: 0 })).toEqual([]);
  });

  it("control: perRepoCap keeps first-appearance order inside each capped repo group", () => {
    const entries: FleetSweepEntry[] = [
      mkBugsq("studio-b-ai/bolt-wms", "1"),
      mkBugsq("studio-b-ai/bolt-wms", "2"),
      mkBugsq("studio-b-ai/bolt-wms", "3"),
      mkBugsq("studio-b-ai/bolt-wms", "4"),
      mkBugsq("studio-b-ai/bolt-wms", "5"),
      mkBugsq("studio-b-ai/bolt-wms", "6"),
      mkBugsq("studio-b-ai/bolt-wms", "7"),
    ];

    const ordered = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 3, runOffset: 0 });

    expect(ordered.map((e) => e.pr_number)).toEqual(["1", "2", "3"]);
  });

  it("control: rotation is a no-op when runOffset % length === 0", () => {
    const entries: FleetSweepEntry[] = Array.from({ length: 4 }, (_, i) => mkBugsq("studio-b-ai/repo-a", `${i}`));

    const zero = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 10, runOffset: 0 });
    const wrap = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 10, runOffset: 8 });

    expect(zero.map((e) => e.pr_number)).toEqual(["0", "1", "2", "3"]);
    expect(wrap.map((e) => e.pr_number)).toEqual(["0", "1", "2", "3"]);
  });

  it("control: rotation handles negative runOffset (defensive — the workflow passes a non-negative run_number)", () => {
    const entries: FleetSweepEntry[] = Array.from({ length: 4 }, (_, i) => mkBugsq("studio-b-ai/repo-a", `${i}`));

    const ordered = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 10, runOffset: -1 });

    // -1 * 10 = -10, -10 mod 4 → 2, so element at index 2 becomes head.
    expect(ordered.map((e) => e.pr_number)).toEqual(["2", "3", "0", "1"]);
  });

  it("control: perRepoCap of 0 evaluates only train entries — the bugsquasher group is empty (P2: train exempt from per-repo cap)", () => {
    const entries: FleetSweepEntry[] = [mkBugsq("studio-b-ai/bolt-wms", "1"), mkTrain("studio-b-ai/bolt-wms", "2")];

    const ordered = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 0, runOffset: 0 });

    // Train entries survive perRepoCap=0 (Kevin's door word is never dropped).
    // Bugsquasher entries are 0-capped.
    expect(ordered).toEqual([mkTrain("studio-b-ai/bolt-wms", "2")]);
  });

  it("control: maxFanout cap applies to the queued-first ordering (queued fills first, bugsquasher takes what remains)", () => {
    const entries: FleetSweepEntry[] = [
      ...Array.from({ length: 4 }, (_, i) => mkTrain("studio-b-ai/repo-a", `t${i}`)),
      ...Array.from({ length: 4 }, (_, i) => mkTrain("studio-b-ai/repo-b", `t${i}`)),
      ...Array.from({ length: 5 }, (_, i) => mkBugsq("studio-b-ai/repo-c", `b${i}`)),
    ];

    const ordered = orderFleetSweepEntries(entries, { maxFanout: 5, perRepoCap: 5, runOffset: 0 });

    // Queued fills first (8 queued, capped to 5).
    expect(ordered.length).toBe(5);
    expect(ordered.every((e) => e.train_ready)).toBe(true);
  });

  it("planted (P2 train exempt from per-repo cap): a repo with 8 queued PRs at perRepoCap=2 still contributes all 8 (global fanout bounds them)", () => {
    const entries: FleetSweepEntry[] = Array.from({ length: 8 }, (_, i) =>
      mkTrain("studio-b-ai/repo-a", `t${i}`),
    );
    // maxFanout=5, perRepoCap=2 — the old shape would cap at 2 per repo
    // and silently drop Kevin's door word for t2..t7. With P2, all 8 train
    // entries flow through and the global fanout takes the first 5.
    const ordered = orderFleetSweepEntries(entries, { maxFanout: 5, perRepoCap: 2, runOffset: 0 });
    expect(ordered.map((e) => e.pr_number)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(ordered.every((e) => e.train_ready)).toBe(true);
  });

  it("control: rotation applies to bugsquasher only — the queued group's registry order is preserved (Kevin's door word is not shuffled)", () => {
    const entries: FleetSweepEntry[] = [
      mkTrain("studio-b-ai/repo-a", "1"),
      mkTrain("studio-b-ai/repo-b", "2"),
      mkTrain("studio-b-ai/repo-c", "3"),
    ];

    const ordered = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 5, runOffset: 2 });

    expect(ordered.map((e) => e.pr_number)).toEqual(["1", "2", "3"]);
  });

  it("control: non-integer or garbled entry passes through the type layer unmolested (real JSON is what the workflow pipes; no schema validation here)", () => {
    // The workflow's jq already shapes the object; the pure core trusts it,
    // matching the pattern used by squasher-fleet-not-the-door.ts. Verify
    // the shape returned is byte-identical to the shape passed in (the gate
    // matrix ingests it verbatim, so any silent field renaming would break
    // the reusable workflow's inputs).
    const entry: FleetSweepEntry = {
      repo: "studio-b-ai/bolt-wms",
      pr_number: "999",
      train_ready: false,
      enabled_classes: "docs-comment,ci-infra,test-only,code-fix",
      sensitive_path_patterns: "^\\.github/actions/",
      safe_path_globs: "src/**",
      required_checks: "Client — TypeScript + Build,Server — TypeScript + Tests",
    };

    const ordered = orderFleetSweepEntries([entry], { maxFanout: 20, perRepoCap: 5, runOffset: 0 });

    expect(ordered).toEqual([entry]);
  });
});
