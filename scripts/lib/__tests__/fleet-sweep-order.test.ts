import { describe, expect, it } from "vitest";
import { orderFleetSweepEntries, type FleetSweepEntry } from "../fleet-sweep-order.js";

// ops#327 — squasher fleet sweep starvation. Both directions per Rule #322:
// the "planted" tests reproduce the exact starvation from the issue body
// (webhook-router#915 at position 28 of 30, sliced off every cycle) and
// prove the ordering fix evaluates it in the first cycle; the "control"
// tests assert the shape the fix must not disturb.

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
    // No repo occupies more than the per-repo cap.
    for (const repo of new Set(entries.map((e) => e.repo))) {
      const trainCount = ordered.filter((e) => e.repo === repo && e.train_ready).length;
      const bugsqCount = ordered.filter((e) => e.repo === repo && !e.train_ready).length;
      expect(trainCount).toBeLessThanOrEqual(5);
      expect(bugsqCount).toBeLessThanOrEqual(5);
    }
    // Global cap holds.
    expect(ordered.length).toBeLessThanOrEqual(20);
  });

  it("planted (stable-order starvation): rotation by runOffset moves the tail entries into the window on subsequent runs", () => {
    // 30 bugsquasher PRs in one repo, per-repo cap of 30 so the cap does
    // not itself do the rotation's job — proves the rotation contributes.
    const entries: FleetSweepEntry[] = Array.from({ length: 30 }, (_, i) =>
      mkBugsq("studio-b-ai/webhook-router", `${900 + i}`),
    );

    const runA = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 30, runOffset: 0 });
    const runB = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 30, runOffset: 20 });

    // Run A evaluates 900..919; run B (offset 20) evaluates 920..929 then 900..909.
    // The union covers every entry across two runs — no PR is stably starved.
    const covered = new Set<string>([...runA.map((e) => e.pr_number), ...runB.map((e) => e.pr_number)]);
    for (let i = 0; i < 30; i++) expect(covered.has(`${900 + i}`)).toBe(true);
    // And the two runs' first entries are different — the order actually moved.
    expect(runA[0].pr_number).not.toBe(runB[0].pr_number);
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

    // -1 mod 4 → 3, so element at index 3 becomes head.
    expect(ordered.map((e) => e.pr_number)).toEqual(["3", "0", "1", "2"]);
  });

  it("control: perRepoCap of 0 evaluates no bugsquasher entries — a stop-the-world kill switch", () => {
    const entries: FleetSweepEntry[] = [mkBugsq("studio-b-ai/bolt-wms", "1"), mkTrain("studio-b-ai/bolt-wms", "2")];

    const ordered = orderFleetSweepEntries(entries, { maxFanout: 20, perRepoCap: 0, runOffset: 0 });

    expect(ordered).toEqual([]);
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
