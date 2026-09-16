import { describe, expect, it } from "vitest";
import {
  decideCanonicalDrift,
  summarizeCanonicalScan,
  type CanonicalProbe,
} from "../squasher-fleet-canonical.js";

// Mechanic crew stint #380 (2026-09-15) — the canonical-name guard for the
// squasher-fleet door registry. The live defect: the registry carried BOTH
// "studio-b-ai/roundhouse" (a post-8/30 GitHub redirect) AND "studio-b-ai/lightsout"
// (the canonical name) for the SAME repo, double-enumerating every open lightsout
// PR under two gate configs. Controls per Rules #322/#471: the planted known-bad
// (today's pre-fix registry, roundhouse row resolving to lightsout) MUST produce a
// finding naming that row; the known-good (the 16 canonical entries, and the
// post-deletion registry) MUST produce zero. The direction discipline cases
// (Rule #425) prove the guard never fires on clean input, and the systemic-failure
// cases prove it fails CLOSED — never a blind clean zero (Rule #465) — when the
// instrument itself is broken.

const ok = (entry: string): CanonicalProbe => ({
  entry,
  canonicalFullName: entry,
  probeError: null,
});

describe("decideCanonicalDrift (stint #380)", () => {
  it("planted known-bad: the pre-fix registry's roundhouse row resolving to lightsout is flagged renamed-or-moved", () => {
    const probes: CanonicalProbe[] = [
      ok("studio-b-ai/bolt-wms"),
      { entry: "studio-b-ai/roundhouse", canonicalFullName: "studio-b-ai/lightsout", probeError: null },
      ok("studio-b-ai/lightsout"),
    ];
    const result = decideCanonicalDrift(probes);

    expect(result.systemicFailure).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].entry).toBe("studio-b-ai/roundhouse");
    expect(result.findings[0].class).toBe("renamed-or-moved");
    expect(result.findings[0].detail).toContain("studio-b-ai/lightsout");
    expect(result.findings[0].detail).toContain("squasher-fleet.json");
  });

  it("control known-good: a fully-canonical registry produces zero findings", () => {
    const entries = [
      "studio-b-ai/bolt-wms",
      "studio-b-ai/studiob",
      "studio-b-ai/studiob-price-sync",
      "studio-b-ai/asthetik-website",
      "studio-b-ai/asthetik-portal",
      "studio-b-ai/radio",
      "studio-b-ai/ops-pipeline",
      "studio-b-ai/acuops-pipeline",
      "studio-b-ai/acudev",
      "studio-b-ai/note-intelligence",
      "studio-b-ai/power-unit",
      "studio-b-ai/claude-config-plane",
      "studio-b-ai/claude-hooks",
      "studio-b-ai/lightsout",
      "studio-b-ai/client-asthetik",
      "studio-b-ai/toto",
    ];
    const result = decideCanonicalDrift(entries.map(ok));

    expect(result.systemicFailure).toBe(false);
    expect(result.probedCount).toBe(16);
    expect(result.findings).toEqual([]);
    expect(summarizeCanonicalScan(result)).toContain("OK");
  });

  it("comparison is case-insensitive: a case-only difference is NOT drift", () => {
    const result = decideCanonicalDrift([
      { entry: "studio-b-ai/LightsOut", canonicalFullName: "studio-b-ai/lightsout", probeError: null },
    ]);
    expect(result.findings).toEqual([]);
  });

  it("an owner move (org drift) is flagged — the full_name assert sees what .name alone cannot", () => {
    const result = decideCanonicalDrift([
      { entry: "studio-b-ai/lightsout", canonicalFullName: "other-org/lightsout", probeError: null },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].class).toBe("renamed-or-moved");
  });

  it("a per-entry probe error (repo gone) is an unresolvable finding, not a silent skip", () => {
    const result = decideCanonicalDrift([
      ok("studio-b-ai/lightsout"),
      { entry: "studio-b-ai/deleted-repo", canonicalFullName: null, probeError: "gh: Not Found (HTTP 404)" },
    ]);
    expect(result.systemicFailure).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].class).toBe("unresolvable");
    expect(result.findings[0].detail).toContain("404");
  });

  it("EVERY probe erroring is a systemic instrument failure (exit-2 class), never a drift report", () => {
    const result = decideCanonicalDrift([
      { entry: "studio-b-ai/lightsout", canonicalFullName: null, probeError: "gh: auth required" },
      { entry: "studio-b-ai/toto", canonicalFullName: null, probeError: "gh: auth required" },
    ]);
    expect(result.systemicFailure).toBe(true);
    expect(summarizeCanonicalScan(result)).toContain("COULD NOT RUN");
  });

  it("an empty population is not systemic (the caller's malformed-registry exit-2 handles that class upstream)", () => {
    const result = decideCanonicalDrift([]);
    expect(result.systemicFailure).toBe(false);
    expect(result.findings).toEqual([]);
  });
});
