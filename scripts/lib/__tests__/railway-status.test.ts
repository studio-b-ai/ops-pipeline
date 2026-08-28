/**
 * railway-status.test.ts — parser + verdict battery for scripts/lib/railway-status.ts
 * (ops-pipeline#167). Fixtures under fixtures/railway-status/ are REAL captured bytes
 * from a full status.railway.com download (2026-08-28, generatedAt 08:20:34Z); the
 * synthetic-active-* files carry real incident records with only their PLACEMENT (as
 * active) synthesized — Rule #223/#314: fixture shapes come from live captures, never
 * hand-crafted guesses. Both-direction coverage per Rule #471: every verdict the
 * evaluator can emit (CLEAR / HOLD / PARSE_ERROR) has a fixture that produces it.
 *
 * NOTE for the enum-drift guard: `status` here is the Railway STATUS-PAGE incident
 * status (INVESTIGATING/RESOLVED/...), never a Postgres column — nothing in this
 * module touches a database.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateStatusHtml,
  extractBalancedObjects,
  extractSegment,
  gateRelevance,
  normalizeName,
  parseIncidentObject,
  type StatusIncident,
} from "../railway-status.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/railway-status/${name}`, import.meta.url), "utf-8");

const NOW = Date.parse("2026-08-28T09:00:00Z");

describe("evaluateStatusHtml on the real captured tail (all-clear page)", () => {
  const snap = evaluateStatusHtml(fixture("tail-clear.txt"), NOW);

  it("verdict CLEAR with zero active incidents", () => {
    expect(snap.verdict).toBe("CLEAR");
    expect(snap.activeGateRelevant).toHaveLength(0);
    expect(snap.activeIgnored).toHaveLength(0);
  });

  it("parses generatedAt and computes staleness", () => {
    expect(snap.generatedAt).toBe("2026-08-28T08:20:34.132Z");
    expect(snap.staleHours).toBeGreaterThan(0.5);
    expect(snap.staleHours).toBeLessThan(1);
  });

  it("reach control (#322/#465): recentIncidents parsed, known slugs present with full fields", () => {
    expect(snap.recentIncidents.length).toBeGreaterThanOrEqual(10);
    const slugs = snap.recentIncidents.map((i) => i.slug);
    for (const known of ["VVL3A03V", "YYU63JUO", "28BGWVE8"]) expect(slugs).toContain(known);
    const yyu = snap.recentIncidents.find((i) => i.slug === "YYU63JUO")!;
    expect(yyu.title).toMatch(/Deployments are slow to progress/);
    expect(yyu.status).toBe("RESOLVED");
    expect(yyu.createdAt.startsWith("2026-08-18T23:19")).toBe(true);
    expect(yyu.resolvedAt).not.toBeNull();
    expect(yyu.components.some((c) => c.name === "Deployments")).toBe(true);
  });

  it("maintenances empty on the capture", () => {
    expect(snap.maintenancesRaw).toBe("");
  });

  it("flags a stale page (>6h) in the reason without changing the verdict", () => {
    const stale = evaluateStatusHtml(fixture("tail-clear.txt"), NOW + 12 * 3_600_000);
    expect(stale.verdict).toBe("CLEAR");
    expect(stale.reason).toMatch(/generatedAt is 1[12]\.\dh old/);
  });
});

describe("HOLD verdict — real deploy-path incident placed active", () => {
  it("VVL3A03V (Deployments PARTIAL_OUTAGE incl. US East/US West) holds", () => {
    const snap = evaluateStatusHtml(fixture("synthetic-active-hold.txt"), NOW);
    expect(snap.verdict).toBe("HOLD");
    expect(snap.activeGateRelevant.map((i) => i.slug)).toEqual(["VVL3A03V"]);
    expect(snap.reason).toMatch(/Deployments/);
    expect(snap.reason).toMatch(/US East/);
  });
});

describe("CLEAR-ignored verdict — real foreign-region incident placed active", () => {
  it("28BGWVE8 (SEA-only Deployments + OPERATIONAL global storage) is ignored on both grounds", () => {
    const snap = evaluateStatusHtml(fixture("synthetic-active-ignored.txt"), NOW);
    expect(snap.verdict).toBe("CLEAR");
    expect(snap.activeGateRelevant).toHaveLength(0);
    expect(snap.activeIgnored.map((i) => i.slug)).toEqual(["28BGWVE8"]);
    expect(snap.reason).toMatch(/ignored/);
  });
});

describe("PARSE_ERROR — a blind instrument must never read as CLEAR (#465)", () => {
  it("marker absent", () => {
    const snap = evaluateStatusHtml("<html><body>maintenance page</body></html>", NOW);
    expect(snap.verdict).toBe("PARSE_ERROR");
    expect(snap.reason).toMatch(/activeIncidents/);
  });

  it("marker duplicated", () => {
    const doubled = fixture("synthetic-active-hold.txt") + "\n<!-- activeIncidents:,recentIncidents:,maintenances:,generatedAt: -->";
    const snap = evaluateStatusHtml(doubled, NOW);
    expect(snap.verdict).toBe("PARSE_ERROR");
  });

  it("extractSegment returns null on zero or multiple markers, text between on exactly one", () => {
    expect(extractSegment("aXbYc", "X", "Y")).toBe("b");
    expect(extractSegment("abc", "X", "Y")).toBeNull();
    expect(extractSegment("aXbXbYc", "X", "Y")).toBeNull();
  });
});

describe("gateRelevance component filter (#425 precision battery)", () => {
  const inc = (components: StatusIncident["components"]): StatusIncident => ({
    id: "00000000-0000-0000-0000-000000000000",
    slug: "TEST0000",
    title: "test",
    // pg-enum-drift-exempt: Railway status-page incident status (no database in this module)
    status: "INVESTIGATING",
    createdAt: "2026-08-28T00:00:00+00:00",
    resolvedAt: null,
    components,
  });
  const c = (name: string, groupName: string | null, impact: string) => ({ id: "11111111-1111-1111-1111-111111111111", name, groupName, impact });

  it("holds: gate component, null group", () => {
    expect(gateRelevance(inc([c("Deployments", null, "DEGRADED_PERFORMANCE")])).relevant).toBe(true);
  });
  it("holds: gate component, US region", () => {
    expect(gateRelevance(inc([c("Builds", "US West (California, USA)", "PARTIAL_OUTAGE")])).relevant).toBe(true);
  });
  it("holds: em-dash GitHub — Auto-Deploys in the non-regional integrations group", () => {
    expect(gateRelevance(inc([c("GitHub — Auto-Deploys", "External & Third-Party Integrations", "DEGRADED_PERFORMANCE")])).relevant).toBe(true);
  });
  it("holds: API — backboard.railway.com", () => {
    expect(gateRelevance(inc([c("API — backboard.railway.com", null, "MAJOR_OUTAGE")])).relevant).toBe(true);
  });
  it("holds: UNKNOWN new region group (fail-toward-HOLD)", () => {
    expect(gateRelevance(inc([c("Deployments", "US Central (Texas, USA)", "DEGRADED_PERFORMANCE")])).relevant).toBe(true);
  });
  it("ignores: foreign region only", () => {
    expect(gateRelevance(inc([c("Deployments", "Southeast Asia (Singapore)", "MAJOR_OUTAGE")])).relevant).toBe(false);
    expect(gateRelevance(inc([c("Deployments", "EU West (Amsterdam, Netherlands)", "MAJOR_OUTAGE")])).relevant).toBe(false);
  });
  it("ignores: non-gate component even at MAJOR_OUTAGE global", () => {
    expect(gateRelevance(inc([c("Railway Storage Buckets", null, "MAJOR_OUTAGE")])).relevant).toBe(false);
    expect(gateRelevance(inc([c("Logs", null, "MAJOR_OUTAGE")])).relevant).toBe(false);
  });
  it("ignores: OPERATIONAL impact on a gate component", () => {
    expect(gateRelevance(inc([c("Deployments", "US East (Virginia, USA)", "OPERATIONAL")])).relevant).toBe(false);
  });
  it("mixed: one relevant component suffices", () => {
    const r = gateRelevance(inc([
      c("Deployments", "Southeast Asia (Singapore)", "MAJOR_OUTAGE"),
      c("Deployments", "US East (Virginia, USA)", "DEGRADED_PERFORMANCE"),
    ]));
    expect(r.relevant).toBe(true);
    expect(r.matched).toHaveLength(1);
  });
});

describe("parser internals", () => {
  it("normalizeName folds dash variants and case", () => {
    expect(normalizeName("GitHub — Auto-Deploys")).toBe("github - auto-deploys");
    expect(normalizeName("API – backboard.railway.com")).toBe("api - backboard.railway.com");
  });

  it("extractBalancedObjects survives escaped quotes and braces inside strings", () => {
    const seg = '$R[1]=[{id:"a",msg:"has \\"quotes\\" and { brace"},{id:"b"}]';
    const objs = extractBalancedObjects(seg);
    expect(objs).toHaveLength(2);
    expect(objs[0]).toContain("brace");
  });

  it("parseIncidentObject on the real YYU63JUO record", () => {
    const rec = fixture("incident-yyu-aug18.txt");
    const inc = parseIncidentObject(rec)!;
    expect(inc.slug).toBe("YYU63JUO");
    expect(inc.status).toBe("RESOLVED");
    expect(inc.components.length).toBeGreaterThan(0);
    expect(gateRelevance(inc).relevant).toBe(true);
  });

  it("parseIncidentObject returns null for non-incident objects", () => {
    // pg-enum-drift-exempt: string literal is a status-page uptime-calendar cell fixture, not SQL
    expect(parseIncidentObject('{date:"2026-08-28",status:"operational"}')).toBeNull();
  });
});
