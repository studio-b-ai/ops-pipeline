import { describe, expect, it } from "vitest";
import { formatFleetSweepReceiptLine } from "../squasher-fleet-not-the-door.js";

// ops#294 + stint #361 (L2D-12 — one PR, one door): a pr_number dispatch on a
// box PR where the fleet sweep is NOT the door (studiob or door:restart
// in squasher-fleet.json) must not print the same blind `box=0` receipt line
// it prints for a PR carrying no label at all. That repo's door is the
// restart train (heritage-restart-train.yml), not this sweep.
// Four groups per Rule #471 (plant the non-default verdict, control both directions):
//
//   1. planted: door:restart notify line (client-asthetik)
//   2. planted: train:false / studiob notify line (kept from ops#294)
//   3. control: fleet-door repos print the ordinary count line
//   4. control: scheduled sweep (no onlyPr) prints the ordinary count line

describe("formatFleetSweepReceiptLine (ops#294 + stint #361)", () => {
  // ── planted: door:restart ──

  it("planted: pr_number dispatch on a box PR in a door:restart repo prints the not-the-door line naming the restart train", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/client-asthetik",
      bugsquasherCount: 0,
      trainCount: 0,
      train: false,
      door: "restart",
      onlyPr: "372",
      onlyPrCarriesReadyLabel: true,
    });

    expect(line).toBe(
      "box PR studio-b-ai/client-asthetik#372 is not this sweep's to merge (fleet registry door:restart) — its door is the restart train: dispatch heritage-restart-train.yml (workflow_dispatch, dry_run=false)",
    );
    expect(line).toContain("client-asthetik#372");
    expect(line).toContain("door:restart");
    expect(line).toContain("heritage-restart-train.yml");
    expect(line).not.toContain("box=0");
  });

  it("planted: the scheduled sweep (no onlyPr) is unchanged for a door:restart repo", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/client-asthetik",
      bugsquasherCount: 0,
      trainCount: 0,
      train: false,
      door: "restart",
      onlyPr: null,
      onlyPrCarriesReadyLabel: false,
    });

    expect(line).toBe("studio-b-ai/client-asthetik: bugsquasher=0 box=0");
  });

  // ── planted: train:false / studiob (kept from ops#294) ──

  it("planted: pr_number dispatch on a box PR in studiob prints the not-the-door line", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/studiob",
      bugsquasherCount: 0,
      trainCount: 0,
      train: false,
      door: "fleet",
      onlyPr: "655",
      onlyPrCarriesReadyLabel: true,
    });

    expect(line).toBe(
      "box PR studio-b-ai/studiob#655 is not this sweep's to merge (fleet registry train:false (studiob)) — its door is the restart train: dispatch heritage-restart-train.yml (workflow_dispatch, dry_run=false)",
    );
    expect(line).toContain("studiob#655");
    expect(line).toContain("heritage-restart-train.yml");
    expect(line).not.toBe("studio-b-ai/studiob: bugsquasher=0 box=0");
    expect(line).not.toContain("box=0");
  });

  // ── control: fleet-door repos ──

  it("control: a pr_number dispatch in a fleet-door repo is unchanged", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/bolt-wms",
      bugsquasherCount: 0,
      trainCount: 1,
      train: true,
      door: "fleet",
      onlyPr: "1500",
      onlyPrCarriesReadyLabel: false,
    });

    expect(line).toBe("studio-b-ai/bolt-wms: bugsquasher=0 box=1");
  });

  it("control: a pr_number dispatch without the box label in a door:restart repo is unchanged", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/client-asthetik",
      bugsquasherCount: 2,
      trainCount: 0,
      train: false,
      door: "restart",
      onlyPr: "400",
      onlyPrCarriesReadyLabel: false,
    });

    expect(line).toBe("studio-b-ai/client-asthetik: bugsquasher=2 box=0");
  });

  it("control: a door:restart repo without onlyPr is unchanged", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/client-asthetik",
      bugsquasherCount: 0,
      trainCount: 0,
      train: false,
      door: "restart",
      onlyPr: null,
      onlyPrCarriesReadyLabel: false,
    });

    expect(line).toBe("studio-b-ai/client-asthetik: bugsquasher=0 box=0");
  });

  it("control: studiob without onlyPr is unchanged", () => {
    const line = formatFleetSweepReceiptLine({
      repo: "studio-b-ai/studiob",
      bugsquasherCount: 0,
      trainCount: 0,
      train: false,
      door: "fleet",
      onlyPr: null,
      onlyPrCarriesReadyLabel: false,
    });

    expect(line).toBe("studio-b-ai/studiob: bugsquasher=0 box=0");
  });
});