import { describe, expect, it } from "vitest";
import { formatFleetSweepReceiptLine } from "../squasher-fleet-not-the-door.js";

// ops#294: the fleet sweep's "evaluate NOW" dispatch (repo + pr_number) must not
// print the same blind `box(train)=0` for a ready-labeled PR in a train:false repo
// that it prints for a PR carrying no label at all — that repo's door is the
// restart train, not this sweep. Three cases per Rule #471 (plant the verdict the
// old behavior did NOT default to, then control both directions the fix must not
// touch), lifted straight from the issue's own reproduction (studiob#655).
// 2026-09-15 ("Box is the one key"): the ready label is `box` (`queued` = the
// transition-week alias); the receipt line names the new key.

describe("formatFleetSweepReceiptLine (ops#294)", () => {
  it("planted: pr_number dispatch on a box PR in a train:false repo prints the not-the-door line, not the blind box(train)=0", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/studiob",
      bugsquasherCount: 0,
      trainCount: 0,
      train: false,
      onlyPr: "655",
      onlyPrCarriesReadyLabel: true,
    });

    expect(line).toBe(
      "box PR studio-b-ai/studiob#655 is not this sweep's to merge (fleet registry train:false) — its door is the restart train: dispatch heritage-restart-train.yml (workflow_dispatch, dry_run=false)",
    );
    expect(line).toContain("studio-b-ai/studiob#655");
    expect(line).toContain("heritage-restart-train.yml");
    expect(line).not.toBe("studio-b-ai/studiob: bugsquasher=0 box(train)=0");
    expect(line).not.toContain("box(train)=0");
  });

  it("control: the same pr_number dispatch shape in a train:true repo is unchanged", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      bugsquasherCount: 0,
      trainCount: 1,
      train: true,
      onlyPr: "1500",
      // train:true repos never probe this — the caller passes a safe default.
      onlyPrCarriesReadyLabel: false,
    });

    expect(line).toBe("studio-b-ai/bolt-wms: bugsquasher=0 box(train)=1");
  });

  it("control: a pr_number dispatch on a PR without the ready label in a train:false repo is unchanged", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/studiob",
      bugsquasherCount: 2,
      trainCount: 0,
      train: false,
      onlyPr: "700",
      onlyPrCarriesReadyLabel: false,
    });

    expect(line).toBe("studio-b-ai/studiob: bugsquasher=2 box(train)=0");
  });

  it("control: the scheduled whole-fleet sweep (no pr_number) is unchanged for a train:false repo, even with a ready-labeled PR present", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/studiob",
      bugsquasherCount: 0,
      trainCount: 0,
      train: false,
      onlyPr: null,
      // Never probed on the scheduled path (onlyPr is null) — default false.
      onlyPrCarriesReadyLabel: false,
    });

    expect(line).toBe("studio-b-ai/studiob: bugsquasher=0 box(train)=0");
  });
});
