import { describe, expect, it } from "vitest";
import {
  KNOWN_DEAD_SEATS,
  LIVE_SLOT_SEATS,
  raceEngineerForRepo,
  resolveDeadLaneRelabel,
} from "../dead-lane-guard.js";

describe("resolveDeadLaneRelabel — both directions (Rule #322)", () => {
  it("known-BAD: lane:engineer on a client-asthetik issue flips to lane:race-engineer-ae (the stint's own acceptance example, ca#376/377/378)", () => {
    const result = resolveDeadLaneRelabel("studio-b-ai/client-asthetik", ["bug", "P1", "lane:engineer", "zoom-intake"]);
    expect(result).toEqual({ from: "lane:engineer", to: "lane:race-engineer-ae" });
  });

  it("known-BAD: lane:controller (dead, asthetik) also flips", () => {
    const result = resolveDeadLaneRelabel("studio-b-ai/bolt-wms", ["lane:controller"]);
    expect(result).toEqual({ from: "lane:controller", to: "lane:race-engineer-ae" });
  });

  it("known-GOOD: lane:mechanic (live seat) is left alone — no relabel", () => {
    const result = resolveDeadLaneRelabel("studio-b-ai/ops-pipeline", ["bug", "lane:mechanic"]);
    expect(result).toBeNull();
  });

  it("known-GOOD: lane already the team RE — no-op, not a re-flip loop", () => {
    const result = resolveDeadLaneRelabel("studio-b-ai/client-asthetik", ["lane:race-engineer-ae"]);
    expect(result).toBeNull();
  });

  it("negative control: no lane:* label at all → null", () => {
    expect(resolveDeadLaneRelabel("studio-b-ai/client-asthetik", ["bug", "P1"])).toBeNull();
  });

  it("negative control: unresolvable repo (no team mapping) → null, never a guess", () => {
    expect(resolveDeadLaneRelabel("studio-b-ai/some-unmapped-repo", ["lane:engineer"])).toBeNull();
  });

  it("studio-b team repos resolve to race-engineer-sb", () => {
    const result = resolveDeadLaneRelabel("studio-b-ai/ops-pipeline", ["lane:engineer"]);
    expect(result).toEqual({ from: "lane:engineer", to: "lane:race-engineer-sb" });
  });
});

describe("raceEngineerForRepo", () => {
  it("resolves both teams", () => {
    expect(raceEngineerForRepo("studio-b-ai/ops-pipeline")).toBe("race-engineer-sb");
    expect(raceEngineerForRepo("studio-b-ai/client-asthetik")).toBe("race-engineer-ae");
  });
  it("unmapped repo → null", () => {
    expect(raceEngineerForRepo("studio-b-ai/nonexistent-zz")).toBeNull();
  });
});

describe("roster ground truth (Rule #4/#84/#333 — retest the stated fact, don't re-litigate it)", () => {
  it("engineer and controller are on the known-dead list, per the 9/12 garage ruling that supersedes the roster-lock", () => {
    expect(KNOWN_DEAD_SEATS).toContain("engineer");
    expect(KNOWN_DEAD_SEATS).toContain("controller");
  });
  it("engineer and controller are NOT in the live-slot set", () => {
    expect(LIVE_SLOT_SEATS).not.toContain("engineer");
    expect(LIVE_SLOT_SEATS).not.toContain("controller");
  });
});
