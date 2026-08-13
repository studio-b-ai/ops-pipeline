import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  buildAcceptanceMap,
  effectiveStatus,
  evaluateAcceptance,
  findDanglingAcceptances,
  isValidReviewByDate,
  isWithinReviewWindow,
  type AcceptedVolume,
  type ManifestProjectEntry,
} from "../railway-volume-accept.js";

const validEntry = (over: Record<string, unknown> = {}) => ({
  volume_instance_id: "a622cddb-8faf-4364-9dc2-75ba1b063967",
  path: "wasala-platform/production/Postgres/postgres-volume",
  accepted_below_pct: 85,
  review_by: "2026-11-30",
  reason: "Diagnosed-static corpus (ops#12).",
  issue: 12,
  ...over,
});

// ───────────────────────────── isValidReviewByDate ─────────────────────────────

describe("isValidReviewByDate", () => {
  // Negative controls first (Rule #322) — this is the whole point of the round-trip check.
  it("REJECTS an invalid calendar date instead of silently normalizing it (test the Date.parse footgun directly)", () => {
    // new Date("2026-02-31T00:00:00.000Z") rolls forward to 2026-03-03 in this runtime — verified
    // live before writing this check. A bare Date.parse/isNaN validator would accept it.
    expect(isValidReviewByDate("2026-02-31")).toBe(false);
  });
  it("rejects an invalid month", () => {
    expect(isValidReviewByDate("2026-13-01")).toBe(false);
  });
  it("rejects Feb 29 in a non-leap year", () => {
    expect(isValidReviewByDate("2026-02-29")).toBe(false); // 2026 is not a leap year
  });
  it("rejects non-YYYY-MM-DD shapes", () => {
    expect(isValidReviewByDate("2026/11/30")).toBe(false);
    expect(isValidReviewByDate("11-30-2026")).toBe(false);
    expect(isValidReviewByDate("2026-11-30T00:00:00Z")).toBe(false);
    expect(isValidReviewByDate("2026-1-1")).toBe(false); // not zero-padded
  });
  it("rejects garbage and non-string values", () => {
    expect(isValidReviewByDate("not-a-date")).toBe(false);
    expect(isValidReviewByDate("")).toBe(false);
    expect(isValidReviewByDate(undefined)).toBe(false);
    expect(isValidReviewByDate(null)).toBe(false);
    expect(isValidReviewByDate(20261130)).toBe(false);
  });

  it("accepts a real, valid date", () => {
    expect(isValidReviewByDate("2026-11-30")).toBe(true);
  });
  it("accepts Feb 29 in a real leap year", () => {
    expect(isValidReviewByDate("2028-02-29")).toBe(true); // 2028 is a leap year
  });
});

// ───────────────────────────── isWithinReviewWindow ─────────────────────────────

describe("isWithinReviewWindow", () => {
  it("is false once today is PAST review_by", () => {
    expect(isWithinReviewWindow("2026-12-01", "2026-11-30")).toBe(false);
  });

  it("is true while today is before review_by", () => {
    expect(isWithinReviewWindow("2026-08-12", "2026-11-30")).toBe(true);
  });
  it("is true ON the review_by date itself (inclusive boundary)", () => {
    expect(isWithinReviewWindow("2026-11-30", "2026-11-30")).toBe(true);
  });
});

// ───────────────────────────── buildAcceptanceMap ─────────────────────────────

describe("buildAcceptanceMap", () => {
  const project = (accepted_volumes: unknown[]): ManifestProjectEntry => ({
    id: "ad6f97b7-5b83-4104-b857-3550cebffff0",
    name: "wasala-platform",
    accepted_volumes: accepted_volumes as ManifestProjectEntry["accepted_volumes"],
  });

  // Negative controls first: every individual bad field drops the WHOLE entry (fail-fast, "that
  // ONE override ignored") and is reported as a defect instead of silently landing in the map.
  it("drops an entry with no volume_instance_id and flags it (id null — nothing else to key on)", () => {
    const { map, defects } = buildAcceptanceMap([project([validEntry({ volume_instance_id: undefined })])]);
    expect(map.size).toBe(0);
    expect(defects).toHaveLength(1);
    expect(defects[0].volumeInstanceId).toBeNull();
    expect(defects[0].reason).toMatch(/volume_instance_id/);
  });
  it("drops an entry with a missing/empty path", () => {
    const { map, defects } = buildAcceptanceMap([project([validEntry({ path: "" })])]);
    expect(map.size).toBe(0);
    expect(defects[0].reason).toMatch(/path/);
  });
  it("drops an entry with a missing/empty reason", () => {
    const { map, defects } = buildAcceptanceMap([project([validEntry({ reason: "   " })])]);
    expect(map.size).toBe(0);
    expect(defects[0].reason).toMatch(/reason/);
  });
  it("drops an entry with an unparseable review_by", () => {
    const { map, defects } = buildAcceptanceMap([project([validEntry({ review_by: "2026-02-31" })])]);
    expect(map.size).toBe(0);
    expect(defects[0].reason).toMatch(/review_by/);
  });
  it("drops an entry whose accepted_below_pct is AT the WARN threshold (must be strictly inside 75..90)", () => {
    const { map, defects } = buildAcceptanceMap([project([validEntry({ accepted_below_pct: 75 })])]);
    expect(map.size).toBe(0);
    expect(defects[0].reason).toMatch(/75/);
  });
  it("drops an entry whose accepted_below_pct is AT or ABOVE the CRITICAL threshold — an acceptance can never swallow a CRITICAL", () => {
    expect(buildAcceptanceMap([project([validEntry({ accepted_below_pct: 90 })])]).map.size).toBe(0);
    expect(buildAcceptanceMap([project([validEntry({ accepted_below_pct: 95 })])]).map.size).toBe(0);
  });
  it("drops an entry whose accepted_below_pct is not a number", () => {
    const { map, defects } = buildAcceptanceMap([project([validEntry({ accepted_below_pct: "85" })])]);
    expect(map.size).toBe(0);
    expect(defects[0].reason).toMatch(/accepted_below_pct/);
  });
  it("a project with no accepted_volumes at all contributes nothing and defects nothing", () => {
    const { map, defects } = buildAcceptanceMap([{ id: "x", name: "no-overrides-here" }]);
    expect(map.size).toBe(0);
    expect(defects).toHaveLength(0);
  });

  // codex review finding (P1): malformed YAML must never THROW — one bad manifest line must not
  // abort the entire monitor run before a single real volume gets checked.
  it("NEVER THROWS on a null entry (e.g. a YAML `- null` line) — flags a defect instead", () => {
    expect(() => buildAcceptanceMap([project([null])])).not.toThrow();
    const { map, defects } = buildAcceptanceMap([project([null])]);
    expect(map.size).toBe(0);
    expect(defects).toHaveLength(1);
    expect(defects[0].volumeInstanceId).toBeNull();
  });
  it("NEVER THROWS on a scalar/array entry where an object was expected", () => {
    expect(() => buildAcceptanceMap([project(["a bare string", 42, ["nested", "array"]])])).not.toThrow();
    const { map, defects } = buildAcceptanceMap([project(["a bare string", 42, ["nested", "array"]])]);
    expect(map.size).toBe(0);
    expect(defects).toHaveLength(3);
  });
  it("NEVER THROWS and flags a defect when accepted_volumes itself is not a list (a mapping or bare scalar)", () => {
    const badProject = { id: "x", name: "typo-project", accepted_volumes: { not: "a list" } } as unknown as ManifestProjectEntry;
    expect(() => buildAcceptanceMap([badProject])).not.toThrow();
    const { map, defects } = buildAcceptanceMap([badProject]);
    expect(map.size).toBe(0);
    expect(defects).toHaveLength(1);
    expect(defects[0].reason).toMatch(/not a list/);
    expect(defects[0].reason).toMatch(/typo-project/);
  });
  it("one malformed entry does not prevent a DIFFERENT valid entry (in the same or a different project) from landing in the map", () => {
    const { map, defects } = buildAcceptanceMap([project([null, validEntry()])]);
    expect(defects).toHaveLength(1);
    expect(map.size).toBe(1);
    expect(map.get("a622cddb-8faf-4364-9dc2-75ba1b063967")).toBeDefined();
  });

  it("accepts a pct just inside each boundary", () => {
    expect(buildAcceptanceMap([project([validEntry({ accepted_below_pct: 75.01 })])]).map.size).toBe(1);
    expect(buildAcceptanceMap([project([validEntry({ accepted_below_pct: 89.99 })])]).map.size).toBe(1);
  });
  it("builds a valid map entry keyed by volume_instance_id, with every field carried through", () => {
    const { map, defects } = buildAcceptanceMap([project([validEntry()])]);
    expect(defects).toEqual([]);
    const entry = map.get("a622cddb-8faf-4364-9dc2-75ba1b063967") as AcceptedVolume;
    expect(entry).toBeDefined();
    expect(entry.path).toBe("wasala-platform/production/Postgres/postgres-volume");
    expect(entry.acceptedBelowPct).toBe(85);
    expect(entry.reviewBy).toBe("2026-11-30");
    expect(entry.issue).toBe(12);
  });
  it("`issue` is null when absent rather than throwing or defaulting to 0", () => {
    const { map } = buildAcceptanceMap([project([validEntry({ issue: undefined })])]);
    expect(map.get("a622cddb-8faf-4364-9dc2-75ba1b063967")?.issue).toBeNull();
  });
  it("aggregates accepted_volumes across MULTIPLE projects into one map", () => {
    const p2 = { id: "y", name: "other-project", accepted_volumes: [validEntry({ volume_instance_id: "11111111-1111-1111-1111-111111111111", path: "other-project/production/Redis/cache" })] };
    const { map, defects } = buildAcceptanceMap([project([validEntry()]), p2]);
    expect(defects).toEqual([]);
    expect(map.size).toBe(2);
  });

  // #27 (this PR's chip prompt): the acceptance map is built DIRECTLY from the parsed manifest,
  // never from unionProjects(...)'s output. Proven structurally, not just asserted in prose:
  // buildAcceptanceMap's only parameter is the manifest project list itself — there is no
  // "discovered" argument for it to merge against, so a re-scoped token whose discovery starts
  // returning wasala-platform (and unionProjects's "discovered overwrites on conflict" dropping
  // the manifest copy's accepted_volumes) cannot affect this function's output at all. This test
  // locks the arity so a future refactor bolting on a second "discovered" parameter fails loud.
  it("takes exactly one parameter (the manifest project list) — proves it cannot be wired to unionProjects output", () => {
    expect(buildAcceptanceMap.length).toBe(1);
  });
});

// ───────────────────────────── findDanglingAcceptances ─────────────────────────────

describe("findDanglingAcceptances", () => {
  const map = new Map<string, AcceptedVolume>([
    ["a622cddb-8faf-4364-9dc2-75ba1b063967", { volumeInstanceId: "a622cddb-8faf-4364-9dc2-75ba1b063967", path: "p", acceptedBelowPct: 85, reviewBy: "2026-11-30", reason: "r", issue: 12 }],
  ]);

  // Negative controls first.
  it("does NOT flag an id that matches a live volume this run", () => {
    expect(findDanglingAcceptances(map, new Set(["a622cddb-8faf-4364-9dc2-75ba1b063967"]))).toEqual([]);
  });
  it("an empty map flags nothing", () => {
    expect(findDanglingAcceptances(new Map(), new Set(["some-live-id"]))).toEqual([]);
  });

  it("flags an id matching NO live volume this run as dangling", () => {
    const out = findDanglingAcceptances(map, new Set(["some-other-live-id"]));
    expect(out).toHaveLength(1);
    expect(out[0].volumeInstanceId).toBe("a622cddb-8faf-4364-9dc2-75ba1b063967");
    expect(out[0].reason).toMatch(/dangling/i);
  });
});

// ───────────────────────────── evaluateAcceptance (the predicate) ─────────────────────────────

describe("evaluateAcceptance", () => {
  const override: AcceptedVolume = {
    volumeInstanceId: "a622cddb-8faf-4364-9dc2-75ba1b063967",
    path: "wasala-platform/production/Postgres/postgres-volume",
    acceptedBelowPct: 85,
    reviewBy: "2026-11-30",
    reason: "Diagnosed-static corpus (ops#12).",
    issue: 12,
  };
  const passingInput = {
    override,
    liveEntityPath: "wasala-platform/production/Postgres/postgres-volume",
    usagePct: 79.3,
    todayIso: "2026-08-12",
  };

  // Negative controls first (Rule #322) — each of the four conjuncts independently blocks
  // acceptance even when every OTHER condition is satisfied.
  it("no override at all → not accepted, no reject reason (nothing to reject)", () => {
    expect(evaluateAcceptance({ ...passingInput, override: undefined })).toEqual({ accepted: false, rejectReason: null });
  });
  it("path mismatch → rejected, even though pct/date are fine (silent-suppression guard: a manifest copy/paste or a moved volume must NOT silently apply)", () => {
    const out = evaluateAcceptance({ ...passingInput, liveEntityPath: "wasala-platform/staging/Postgres/postgres-volume" });
    expect(out).toEqual({ accepted: false, rejectReason: "path-mismatch" });
  });
  it("expired review window → rejected, even though path/pct are fine", () => {
    const out = evaluateAcceptance({ ...passingInput, todayIso: "2026-12-01" });
    expect(out).toEqual({ accepted: false, rejectReason: "expired" });
  });
  it("usage AT the accepted ceiling → rejected (strictly less-than, not less-or-equal)", () => {
    const out = evaluateAcceptance({ ...passingInput, usagePct: 85 });
    expect(out).toEqual({ accepted: false, rejectReason: "usage-at-or-above-accepted" });
  });
  it("usage ABOVE the accepted ceiling → rejected", () => {
    const out = evaluateAcceptance({ ...passingInput, usagePct: 86 });
    expect(out).toEqual({ accepted: false, rejectReason: "usage-at-or-above-accepted" });
  });

  it("all four conjuncts satisfied → accepted, using the real ops#12 numbers", () => {
    expect(evaluateAcceptance(passingInput)).toEqual({ accepted: true, rejectReason: null });
  });
  it("today ON review_by (inclusive boundary) still accepts", () => {
    expect(evaluateAcceptance({ ...passingInput, todayIso: "2026-11-30" })).toEqual({ accepted: true, rejectReason: null });
  });
  it("usage just under the ceiling accepts", () => {
    expect(evaluateAcceptance({ ...passingInput, usagePct: 84.99 })).toEqual({ accepted: true, rejectReason: null });
  });
});

// ───────────────────────────── effectiveStatus ─────────────────────────────

describe("effectiveStatus", () => {
  it("passes computedStatus through UNCHANGED when not accepted (negative control)", () => {
    expect(effectiveStatus(false, "WARN")).toBe("WARN");
    expect(effectiveStatus(false, "CRITICAL")).toBe("CRITICAL");
    expect(effectiveStatus(false, "OK")).toBe("OK");
  });

  it("maps accepted → the literal 'OK', regardless of computed status", () => {
    expect(effectiveStatus(true, "WARN")).toBe("OK");
    expect(effectiveStatus(true, "CRITICAL")).toBe("OK");
  });
});

// ───────────────────────────── #28: CI parses the REAL manifest ─────────────────────────────

describe("real railway-projects.manifest.yaml", () => {
  const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "railway-projects.manifest.yaml");

  it("parses and every accepted_volumes block in it validates with zero defects", () => {
    const doc = parseYaml(readFileSync(manifestPath, "utf-8")) as { projects?: ManifestProjectEntry[] };
    expect(doc.projects?.length ?? 0).toBeGreaterThan(0);
    const { map, defects } = buildAcceptanceMap(doc.projects ?? []);
    expect(defects).toEqual([]);
    // wasala-platform's ops#12 acceptance is the one Kevin-authorized override as of this PR
    // (2026-08-12) — locked at accepted_below_pct: 85, review_by: 2026-11-30.
    const wasala = map.get("a622cddb-8faf-4364-9dc2-75ba1b063967");
    expect(wasala).toBeDefined();
    expect(wasala?.path).toBe("wasala-platform/production/Postgres/postgres-volume");
    expect(wasala?.acceptedBelowPct).toBe(85);
    expect(wasala?.reviewBy).toBe("2026-11-30");
    expect(wasala?.issue).toBe(12);
  });
});
