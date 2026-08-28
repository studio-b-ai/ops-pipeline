/**
 * railway-ledger.test.ts — ledger body-builder battery for scripts/lib/railway-ledger.ts
 * (ops-pipeline#167). Incident inputs are the REAL captured records under
 * fixtures/railway-status/ parsed through the production parser (Rule #223 — the test
 * invokes the actual functions end-to-end, never re-assembles rows by hand).
 *
 * NOTE for the enum-drift guard: `status` here is the Railway STATUS-PAGE incident
 * status — nothing in this module touches a database.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIncidentObject, type StatusIncident } from "../railway-status.js";
import { buildLedgerBody, formatLedgerRow, LEDGER_ROW_CAP, parseLedgerRows } from "../railway-ledger.js";

const record = (name: string): StatusIncident => {
  const raw = readFileSync(new URL(`./fixtures/railway-status/${name}`, import.meta.url), "utf-8");
  const inc = parseIncidentObject(raw);
  if (!inc) throw new Error(`fixture ${name} did not parse — reach control failed (#322)`);
  return inc;
};

const NOW_ISO = "2026-08-28T09:00:00.000Z";
const GEN_AT = "2026-08-28T08:20:34.132Z";

const yyu = record("incident-yyu-aug18.txt");
const vvl = record("incident-vvl-aug20.txt");
const sea = record("incident-sea-jun5.txt");

describe("formatLedgerRow", () => {
  it("real deploy-path incident renders slug, YES flag, duration, non-operational components", () => {
    const row = formatLedgerRow(yyu);
    expect(row).toContain("`YYU63JUO`");
    expect(row).toContain("| **YES** |");
    expect(row).toMatch(/\| \d+m \|/);
    expect(row).toMatch(/^\| 2026-08-18 23:19Z \|/);
    expect(row).toContain("Deployments");
    expect(row).not.toContain("\n");
  });

  it("foreign-region incident renders as deploy-path no", () => {
    const row = formatLedgerRow(sea);
    expect(row).toContain("`28BGWVE8`");
    expect(row).toContain("| no |");
    expect(row).toContain("SEA");
  });

  it("escapes pipes and strips newlines so a row stays one table row", () => {
    const evil: StatusIncident = {
      ...yyu,
      slug: "PIPE0001",
      title: "Deploys | broken\nacross regions",
    };
    const row = formatLedgerRow(evil);
    expect(row).not.toContain("\n");
    expect(row).toContain("Deploys \\| broken across regions");
    const parsed = parseLedgerRows(row);
    expect([...parsed.keys()]).toEqual(["PIPE0001"]);
  });
});

describe("buildLedgerBody", () => {
  it("first build adds every incident, newest first, with deploy-path count in the header", () => {
    const r = buildLedgerBody("", [yyu, vvl, sea], GEN_AT, NOW_ISO);
    expect(r.addedSlugs.sort()).toEqual(["28BGWVE8", "VVL3A03V", "YYU63JUO"]);
    expect(r.updatedSlugs).toEqual([]);
    expect(r.totalRows).toBe(3);
    const rows = [...parseLedgerRows(r.body).keys()];
    expect(rows).toEqual(["VVL3A03V", "YYU63JUO", "28BGWVE8"]); // 8/20 > 8/18 > 6/05
    expect(r.body).toContain("(2 deploy-path)");
    expect(r.body).toContain(GEN_AT);
  });

  it("second build over the same data is a zero-delta no-op (quiet timeline, #292)", () => {
    const first = buildLedgerBody("", [yyu, vvl, sea], GEN_AT, NOW_ISO);
    const second = buildLedgerBody(first.body, [yyu, vvl, sea], GEN_AT, "2026-08-28T15:00:00.000Z");
    expect(second.addedSlugs).toEqual([]);
    expect(second.updatedSlugs).toEqual([]);
    expect(parseLedgerRows(second.body)).toEqual(parseLedgerRows(first.body));
  });

  it("rows SURVIVE when incidents age off the page (#453 — deliberately not a mirror)", () => {
    const first = buildLedgerBody("", [yyu, vvl, sea], GEN_AT, NOW_ISO);
    const later = buildLedgerBody(first.body, [vvl], GEN_AT, "2026-12-01T00:00:00.000Z");
    expect(later.addedSlugs).toEqual([]);
    expect(later.updatedSlugs).toEqual([]);
    expect(later.totalRows).toBe(3);
    expect([...parseLedgerRows(later.body).keys()]).toContain("28BGWVE8");
  });

  it("fresh data wins per slug — a status change updates the row", () => {
    const first = buildLedgerBody("", [yyu, vvl], GEN_AT, NOW_ISO);
    const mutated: StatusIncident = {
      ...yyu,
      // pg-enum-drift-exempt: Railway status-page incident status (no database in this module)
      status: "MONITORING",
      resolvedAt: null,
    };
    const r = buildLedgerBody(first.body, [mutated, vvl], GEN_AT, NOW_ISO);
    expect(r.addedSlugs).toEqual([]);
    expect(r.updatedSlugs).toEqual(["YYU63JUO"]);
    expect(r.body).toContain("MONITORING");
    expect(r.totalRows).toBe(2);
  });

  it("caps at LEDGER_ROW_CAP keeping the newest", () => {
    const many: StatusIncident[] = Array.from({ length: LEDGER_ROW_CAP + 5 }, (_, i) => ({
      ...yyu,
      slug: `SYN${String(i).padStart(5, "0")}`,
      createdAt: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 86_400_000).toISOString(),
    }));
    const r = buildLedgerBody("", many, GEN_AT, NOW_ISO);
    expect(r.totalRows).toBe(LEDGER_ROW_CAP);
    const rows = parseLedgerRows(r.body);
    expect(rows.has(`SYN${String(LEDGER_ROW_CAP + 4).padStart(5, "0")}`)).toBe(true); // newest kept
    expect(rows.has("SYN00000")).toBe(false); // oldest dropped
  });

  it("hand-noise lines in an existing body do not corrupt parsing", () => {
    const first = buildLedgerBody("", [vvl], GEN_AT, NOW_ISO);
    const noisy = `${first.body}\n\nSome trailing hand comment that is not a table row.\n| not | a real row`;
    const r = buildLedgerBody(noisy, [vvl], GEN_AT, NOW_ISO);
    expect(r.totalRows).toBe(1);
    expect(r.addedSlugs).toEqual([]);
    expect(r.updatedSlugs).toEqual([]);
  });
});
