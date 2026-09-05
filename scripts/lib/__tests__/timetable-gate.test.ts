/**
 * timetable-gate tests (ops-pipeline#242 unit 2).
 *
 * #471 discipline: this is a FAIL-CLOSED gate, so the load-bearing control is
 * the known-GOOD facts object that produces DEPART — every negative test would
 * pass on an engine that can only say no. Then one negative control per check
 * (#322 both directions), each flipping exactly ONE fact off the known-good.
 *
 * Note for the pg-enum-drift guard: every `status:` literal in this file is the
 * windows.yaml registry vocabulary (RULED / RULED-GATED / PROPOSED), YAML in
 * the brain vault — no Postgres column is involved anywhere in this module.
 */

import { describe, expect, it } from "vitest";
import {
  type DepartureFacts,
  DEFAULT_TICKET_CLASS,
  evaluateDeparture,
  evaluateWindow,
  formatLedgerLine,
  GATE_DENYLIST,
  globToRegExp,
  parseArcs,
  parseHolds,
  parseWindows,
  pathMatchesAny,
  type Registries,
  resolveClassBand,
  TICKET_CLASSES,
  type WindowEntry,
} from "../timetable-gate.js";

const TODAY = new Date("2026-09-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Glob matcher
// ---------------------------------------------------------------------------

describe("globToRegExp", () => {
  it("`*` does not cross slashes; `**` does", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
    expect(globToRegExp("src/**").test("src/deep/nested/a.ts")).toBe(true);
  });

  it("`**/x/**` matches nested and top-level directories", () => {
    expect(pathMatchesAny("hooks/pre-commit.py", ["**/hooks/**"])).toBe(true);
    expect(pathMatchesAny("a/b/hooks/x.py", ["**/hooks/**"])).toBe(true);
    expect(pathMatchesAny("src/hookless/x.py", ["**/hooks/**"])).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(globToRegExp("a.b/c.ts").test("a.b/c.ts")).toBe(true);
    expect(globToRegExp("a.b/c.ts").test("aXb/cXts")).toBe(false);
  });

  it("the gate denylist catches workflow, hook, lint, Customization and pricing paths", () => {
    for (const p of [
      ".github/workflows/deploy.yml",
      "hooks/enforce.py",
      "scripts/my-hook-thing.py",
      "scripts/lint-webhook-handler-db-tests.ts",
      "Customization/StudioBWMS/project.xml",
      "src/pricing/resolver.ts",
    ]) {
      expect(pathMatchesAny(p, GATE_DENYLIST)).toBe(true);
    }
    expect(pathMatchesAny("src/routes/orders.ts", GATE_DENYLIST)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const GOOD_ARC_YAML = `
arcs:
  - slug: wr-notice-lane
    repo: studio-b-ai/webhook-router
    surface: railway:test-svc
    allowed_paths:
      - "src/**"
    decision_doc: library/decisions/2026-08-30-example.md
    registered_by: '"register wr-notice-lane: webhook-router src until 9/10" — 2026-08-30T18:00Z'
    expires: "2026-09-10"
    lane_manager: mechanic
    single_n_proven: "receipt: wr#783 chain"
`;

describe("parseArcs", () => {
  it("accepts a fully-formed, quoted, in-date entry", () => {
    const { valid, rejected } = parseArcs(GOOD_ARC_YAML, TODAY);
    expect(rejected).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0].slug).toBe("wr-notice-lane");
    expect(valid[0].single_n_proven).toBe("receipt: wr#783 chain");
  });

  it("rejects an entry whose registered_by lacks a QUOTED verbatim word", () => {
    const y = GOOD_ARC_YAML.replace(
      /registered_by: .*/,
      "registered_by: 'kevin said go — 2026-08-30T18:00Z'",
    );
    const { valid, rejected } = parseArcs(y, TODAY);
    expect(valid).toEqual([]);
    expect(rejected[0].reason).toMatch(/QUOTED verbatim word/);
  });

  it("rejects an expired arc (renewal = a fresh word)", () => {
    const y = GOOD_ARC_YAML.replace('expires: "2026-09-10"', 'expires: "2026-08-25"');
    const { valid, rejected } = parseArcs(y, TODAY);
    expect(valid).toEqual([]);
    expect(rejected[0].reason).toMatch(/expired/);
  });

  it("rejects an expiry more than 14 days out (outside the §4a contract)", () => {
    const y = GOOD_ARC_YAML.replace('expires: "2026-09-10"', 'expires: "2026-10-15"');
    const { valid, rejected } = parseArcs(y, TODAY);
    expect(valid).toEqual([]);
    expect(rejected[0].reason).toMatch(/>14 days out/);
  });

  it("14-day boundary is exact: day 14 accepted, day 15 rejected", () => {
    const at14 = GOOD_ARC_YAML.replace('expires: "2026-09-10"', 'expires: "2026-09-15"');
    expect(parseArcs(at14, TODAY).valid).toHaveLength(1);
    const at15 = GOOD_ARC_YAML.replace('expires: "2026-09-10"', 'expires: "2026-09-16"');
    const r = parseArcs(at15, TODAY);
    expect(r.valid).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/>14 days out/);
  });

  it("rejects a nonexistent calendar day — Date.parse normalization is not validation", () => {
    const y = GOOD_ARC_YAML.replace('expires: "2026-09-10"', 'expires: "2026-09-31"');
    const { valid, rejected } = parseArcs(y, TODAY);
    expect(valid).toEqual([]);
    expect(rejected[0].reason).toMatch(/not a real calendar day/);
  });

  it("rejects a missing required field and an empty allowed_paths", () => {
    const noRepo = GOOD_ARC_YAML.replace(/ *repo: .*\n/, "");
    expect(parseArcs(noRepo, TODAY).valid).toEqual([]);
    const noPaths = GOOD_ARC_YAML.replace(/allowed_paths:\n +- "src\/\*\*"/, "allowed_paths: []");
    const r = parseArcs(noPaths, TODAY);
    expect(r.valid).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/allowed_paths/);
  });

  it("rejects a non-positive diff_cap; empty registry parses clean", () => {
    const y = GOOD_ARC_YAML.replace("lane_manager: mechanic", "lane_manager: mechanic\n    diff_cap: 0");
    expect(parseArcs(y, TODAY).valid).toEqual([]);
    expect(parseArcs("arcs: []", TODAY)).toEqual({ valid: [], rejected: [] });
  });

  it("throws on a malformed FILE (broken deployment, loud)", () => {
    expect(() => parseArcs("- not-a-mapping", TODAY)).toThrow(/not a mapping/);
  });
});

describe("parseHolds", () => {
  it("parses empty and populated holds", () => {
    expect(parseHolds("holds: []")).toEqual([]);
    const h = parseHolds('holds:\n  - slug: x\n    held_by: "\\"hold x\\" — 2026-08-30"');
    expect(h[0].slug).toBe("x");
  });

  it("throws on missing slug/held_by — caller must treat as ALL ARCS HELD", () => {
    expect(() => parseHolds("holds:\n  - slug: x")).toThrow(/held_by/);
    expect(() => parseHolds("holds: {}")).toThrow(/not a list/);
  });
});

describe("parseWindows", () => {
  it("parses a RULED entry and preserves gate_note on RULED-GATED", () => {
    // pg-enum-drift-exempt: windows.yaml status vocabulary in a YAML fixture, no Postgres
    const w = parseWindows(
      'windows:\n  - surface: s1\n    band: always\n    status: RULED\n  - surface: s2\n    band: "Wed 12:00 ET"\n    status: RULED-GATED\n    gate_note: closed until classifier',
    );
    expect(w).toHaveLength(2);
    expect(w[1].gate_note).toBe("closed until classifier");
  });

  it("throws on an unknown status or missing band", () => {
    // pg-enum-drift-exempt: windows.yaml status vocabulary in a YAML fixture, no Postgres
    expect(() =>
      parseWindows("windows:\n  - surface: s1\n    band: always\n    status: MAYBE"),
    ).toThrow(/status must be/);
    // pg-enum-drift-exempt: windows.yaml status vocabulary in a YAML fixture, no Postgres
    expect(() => parseWindows("windows:\n  - surface: s1\n    status: RULED")).toThrow(/missing band/);
  });
});

// ---------------------------------------------------------------------------
// Window evaluation (2026-09-02 is a Wednesday; ET = EDT = UTC-4 in September)
// ---------------------------------------------------------------------------

// pg-enum-drift-exempt: WindowEntry.status is the YAML registry vocabulary, no Postgres
const ruled = (band: string, extra?: Partial<WindowEntry>): WindowEntry => ({
  surface: "test",
  band,
  status: "RULED",
  ...extra,
});

describe("evaluateWindow", () => {
  const WED_1230_ET = new Date("2026-09-02T16:30:00Z");
  const WED_1330_ET = new Date("2026-09-02T17:30:00Z");
  const THU_1230_ET = new Date("2026-09-03T16:30:00Z");

  it("always / on demand are open; PROPOSED and RULED-GATED are closed", () => {
    expect(evaluateWindow(ruled("always"), WED_1230_ET).open).toBe(true);
    expect(evaluateWindow(ruled("on demand"), WED_1230_ET).open).toBe(true);
    // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
    expect(evaluateWindow({ ...ruled("always"), status: "PROPOSED" }, WED_1230_ET).open).toBe(false);
    const gated = evaluateWindow(
      // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
      { ...ruled("Wed 12:00 ET"), status: "RULED-GATED", gate_note: "closed until classifier" },
      WED_1230_ET,
    );
    expect(gated.open).toBe(false);
    expect(gated.reason).toMatch(/closed until classifier/);
  });

  it("weekly band: inside the hour opens, after it closes, wrong day closes", () => {
    expect(evaluateWindow(ruled("Wed 12:00 ET"), WED_1230_ET).open).toBe(true);
    expect(evaluateWindow(ruled("Wed 12:00 ET"), WED_1330_ET).open).toBe(false);
    expect(evaluateWindow(ruled("Wed 12:00 ET"), THU_1230_ET).open).toBe(false);
  });

  it("outside-business band: weekday noon closed, weekday evening + weekend open", () => {
    const band = "outside 08:00-18:00 ET weekdays";
    expect(evaluateWindow(ruled(band), WED_1230_ET).open).toBe(false);
    expect(evaluateWindow(ruled(band), new Date("2026-09-02T23:30:00Z")).open).toBe(true); // 19:30 ET
    expect(evaluateWindow(ruled(band), new Date("2026-09-05T16:00:00Z")).open).toBe(true); // Saturday
  });

  it("out-of-range clocks and inverted spans fail closed, never open", () => {
    // `outside 25:00-26:00` would otherwise be open every weekday (codex P2).
    const bad = evaluateWindow(ruled("outside 25:00-26:00 ET weekdays"), WED_1230_ET);
    expect(bad.open).toBe(false);
    expect(bad.reason).toMatch(/invalid clock/);
    const weekly = evaluateWindow(ruled("Wed 25:00 ET"), WED_1230_ET);
    expect(weekly.open).toBe(false);
    expect(weekly.reason).toMatch(/invalid clock/);
    const inverted = evaluateWindow(ruled("outside 18:00-08:00 ET weekdays"), WED_1230_ET);
    expect(inverted.open).toBe(false);
    expect(inverted.reason).toMatch(/inverted or empty span/);
  });

  it("BARRED and unrecognized bands are closed even when RULED", () => {
    expect(
      evaluateWindow(ruled("quiet-window catch-up crons ONLY (#480); BARRED from Wed 12:00 ET"), WED_1230_ET)
        .open,
    ).toBe(false);
    const v = evaluateWindow(ruled("whenever feels right"), WED_1230_ET);
    expect(v.open).toBe(false);
    expect(v.reason).toMatch(/unrecognized band/);
  });
});

// ---------------------------------------------------------------------------
// The evaluator — known-good DEPART + one negative control per check
// ---------------------------------------------------------------------------

function goodRegistries(): Registries {
  return {
    arcs: parseArcs(GOOD_ARC_YAML, TODAY),
    holds: [],
    // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
    windows: [{ surface: "railway:test-svc", band: "always", status: "RULED" }],
  };
}

function goodFacts(): DepartureFacts {
  return {
    repo: "studio-b-ai/webhook-router",
    changedPaths: ["src/routes/notice.ts", "src/lib/notice-format.ts"],
    changedLineCount: 42,
    headSha: "abc1234def5678900000000000000000000000000",
    ciChecks: [
      { name: "test", bucket: "pass" },
      { name: "gitleaks", bucket: "pass" },
    ],
    codexReceipt: { headSha: "abc1234def5678900000000000000000000000000", clean: true },
    isPureRevert: false,
    rollbackRef: "live-deployed@f00dfeed",
    qaReceipt: { score: 99, ageDays: 2, buildMatches: true },
    expectedPublishTime: new Date("2026-09-02T16:30:00Z"),
    openP0Count: 0,
    poolSaturated429Count15m: 0,
    minutesSinceLastSubstrateDeploy: 120,
    mergeActor: "mechanic",
    mergeStateStatus: "CLEAN",
    invokedVia: "bash-gh-merge-hook",
  };
}

describe("evaluateDeparture — known-good control (#471: the non-default verdict)", () => {
  it("a fully-satisfied facts object DEPARTS with all 13 checks passing", () => {
    const r = evaluateDeparture(goodRegistries(), goodFacts());
    expect(r.failures).toEqual([]);
    expect(r.verdict).toBe("DEPART");
    expect(r.arcSlug).toBe("wr-notice-lane");
    expect(r.checks).toHaveLength(13);
    expect(r.checks.map((c) => c.id)).toEqual(
      ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13"],
    );
  });
});

describe("evaluateDeparture — one negative control per check", () => {
  const run = (
    mutFacts?: (f: DepartureFacts) => void,
    mutReg?: (r: Registries) => void,
  ) => {
    const reg = goodRegistries();
    const facts = goodFacts();
    mutFacts?.(facts);
    mutReg?.(reg);
    return evaluateDeparture(reg, facts);
  };

  it("01: a path outside the arc falls through naming the check", () => {
    const r = run((f) => f.changedPaths.push("docs/readme.md"));
    expect(r.verdict).toBe("FALL_THROUGH");
    expect(r.failures[0]).toMatch(/^\[01\]/);
  });

  it("01: a DENYLIST path fails even when the arc's globs would allow it", () => {
    const reg = goodRegistries();
    reg.arcs.valid[0].allowed_paths = ["**"];
    const facts = goodFacts();
    facts.changedPaths = [".github/workflows/deploy.yml"];
    const r = evaluateDeparture(reg, facts);
    expect(r.verdict).toBe("FALL_THROUGH");
    expect(r.failures[0]).toMatch(/DENYLIST/);
  });

  it("01: empty diff and ambiguous multi-arc coverage both fail closed", () => {
    expect(run((f) => (f.changedPaths = [])).failures[0]).toMatch(/empty changed-path/);
    const r = run(undefined, (reg) => {
      reg.arcs.valid.push({ ...reg.arcs.valid[0], slug: "second-arc" });
    });
    expect(r.failures[0]).toMatch(/ambiguous/);
  });

  it("02: a hold blocks; an unparseable holds file holds ALL arcs", () => {
    const held = run(undefined, (reg) => {
      reg.holds = [{ slug: "wr-notice-lane", held_by: '"hold it" — 2026-08-30' }];
    });
    expect(held.failures[0]).toMatch(/^\[02\].*HELD/);
    const broken = run(undefined, (reg) => (reg.holds = null));
    expect(broken.failures[0]).toMatch(/ALL arcs held/);
  });

  it("03: a non-pass bucket and an EMPTY check set both fail", () => {
    expect(run((f) => (f.ciChecks![0].bucket = "fail")).failures[0]).toMatch(/^\[03\]/);
    expect(run((f) => (f.ciChecks = [])).failures[0]).toMatch(/empty rollup never counts/);
  });

  it("04: a stale codex sha and a not-clean verdict both fail", () => {
    expect(
      run((f) => (f.codexReceipt = { headSha: "0000000000", clean: true })).failures[0],
    ).toMatch(/stale/);
    expect(
      run((f) => (f.codexReceipt = { headSha: f.headSha!, clean: false })).failures[0],
    ).toMatch(/not clean/);
  });

  it("05: neither revert nor single_n_proven fails", () => {
    const r = run(undefined, (reg) => (reg.arcs.valid[0].single_n_proven = null));
    expect(r.failures[0]).toMatch(/^\[05\].*#169/);
  });

  it("06: missing rollback ref fails (#34)", () => {
    expect(run((f) => (f.rollbackRef = undefined)).failures[0]).toMatch(/^\[06\]/);
    expect(run((f) => (f.rollbackRef = "  ")).failures[0]).toMatch(/^\[06\]/);
  });

  it("07: 98 exactly FAILS (bar is strictly >98), stale + wrong-build receipts fail", () => {
    expect(run((f) => (f.qaReceipt!.score = 98)).failures[0]).toMatch(/STRICTLY >98/);
    expect(run((f) => (f.qaReceipt!.ageDays = 15)).failures[0]).toMatch(/>14d/);
    expect(run((f) => (f.qaReceipt!.buildMatches = false)).failures[0]).toMatch(/DEPLOYED build/);
    expect(run((f) => (f.qaReceipt = undefined)).failures[0]).toMatch(/^\[07\]/);
  });

  it("08: an unlisted surface and an un-RULED window both fail", () => {
    expect(run(undefined, (reg) => (reg.windows = [])).failures[0]).toMatch(/unlisted surfaces/);
    // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
    const r = run(undefined, (reg) => (reg.windows[0].status = "PROPOSED"));
    expect(r.failures[0]).toMatch(/PROPOSED/);
  });

  it("09: P0s, saturation 429s, tight spacing and unresolved probes all fail", () => {
    expect(run((f) => (f.openP0Count = 1)).failures[0]).toMatch(/open P0/);
    expect(run((f) => (f.poolSaturated429Count15m = 3)).failures[0]).toMatch(/#437/);
    expect(run((f) => (f.minutesSinceLastSubstrateDeploy = 10)).failures[0]).toMatch(/spacing/);
    expect(run((f) => (f.openP0Count = undefined)).failures[0]).toMatch(/unresolved/);
  });

  it("10: over-cap diff fails; a pure revert is cap-exempt", () => {
    expect(run((f) => (f.changedLineCount = 301)).failures[0]).toMatch(/> cap 300/);
    const revert = run((f) => {
      f.isPureRevert = true;
      f.changedLineCount = 5000;
    });
    expect(revert.checks.find((c) => c.id === "10")?.verdict).toBe("pass");
  });

  it("11: a merge actor other than the arc's lane_manager fails", () => {
    expect(run((f) => (f.mergeActor = "dispatcher")).failures[0]).toMatch(/lane_manager/);
  });

  it("12: any mergeStateStatus other than CLEAN fails (#433)", () => {
    expect(run((f) => (f.mergeStateStatus = "BLOCKED")).failures[0]).toMatch(/^\[12\]/);
    expect(run((f) => (f.mergeStateStatus = undefined)).failures[0]).toMatch(/unresolved/);
  });

  it("13: an undeclared interception point fails", () => {
    expect(run((f) => (f.invokedVia = undefined)).failures[0]).toMatch(/out-of-band/);
  });

  it("13: an UNSANCTIONED interception point fails — truthiness is not membership", () => {
    const r = run((f) => (f.invokedVia = "manual-script"));
    expect(r.verdict).toBe("FALL_THROUGH");
    expect(r.failures[0]).toMatch(/not a sanctioned interception point/);
  });
});

// ---------------------------------------------------------------------------
// Ledger line
// ---------------------------------------------------------------------------

describe("formatLedgerLine", () => {
  it("emits parseable jsonl keyed for the merge sha, carrying every check", () => {
    const r = evaluateDeparture(goodRegistries(), goodFacts());
    const line = formatLedgerLine(r, goodFacts(), new Date("2026-09-02T16:00:00Z"), "deadbeef");
    const parsed = JSON.parse(line);
    expect(parsed.verdict).toBe("DEPART");
    expect(parsed.merge_sha).toBe("deadbeef");
    expect(parsed.checks).toHaveLength(13);
    expect(parsed.ts).toBe("2026-09-02T16:00:00.000Z");
    expect(line).not.toContain("\n");
  });

  it("records ticket_class exactly as the evaluator resolved it (default enhancement, never nullable)", () => {
    // A class-less caller must appear as `enhancement` in the ledger (never `null`
    // / `unknown`) — a ledger reader that treats those as distinct states would
    // diverge from what the gate actually evaluated. Kevin 2026-09-03 (ops#281).
    const line = formatLedgerLine(
      evaluateDeparture(goodRegistries(), goodFacts()),
      goodFacts(),
      new Date("2026-09-02T16:00:00Z"),
    );
    expect(JSON.parse(line).ticket_class).toBe("enhancement");
    const bugfixFacts: DepartureFacts = { ...goodFacts(), ticketClass: "bugfix" };
    expect(JSON.parse(
      formatLedgerLine(
        evaluateDeparture(goodRegistries(), bugfixFacts),
        bugfixFacts,
        new Date("2026-09-02T16:00:00Z"),
      ),
    ).ticket_class).toBe("bugfix");
    const garbageFacts = { ...goodFacts(), ticketClass: "hotfix" as unknown as "bugfix" };
    expect(JSON.parse(
      formatLedgerLine(
        evaluateDeparture(goodRegistries(), garbageFacts),
        garbageFacts,
        new Date("2026-09-02T16:00:00Z"),
      ),
    ).ticket_class).toBe("enhancement");
  });
});

// ---------------------------------------------------------------------------
// Class-aware bands (Kevin 2026-09-03 — ops-pipeline#281)
//
// Kevin verbatim: "if it's a bug fix, I think those go afterhours any time. if
// they're enhancements, they go anytime to test but production is only
// wednesday at noon". Fail-closed default: enhancement (the narrower band) —
// the wider bugfix band is NEVER granted by omission.
// ---------------------------------------------------------------------------

describe("TICKET_CLASSES + DEFAULT_TICKET_CLASS", () => {
  it("enumerates exactly the two Kevin-named classes; default is enhancement (fail-closed)", () => {
    expect([...TICKET_CLASSES]).toEqual(["bugfix", "enhancement"]);
    expect(DEFAULT_TICKET_CLASS).toBe("enhancement");
  });
});

describe("parseWindows — per-class bands", () => {
  it("parses `bands` alongside `band`, preserving the legacy enhancement default", () => {
    // pg-enum-drift-exempt: windows.yaml status vocabulary, no Postgres
    const w = parseWindows(
      [
        "windows:",
        "  - surface: acumatica-prod",
        "    band: \"Wed 12:00 ET\"",
        "    status: RULED",
        "    bands:",
        "      bugfix: \"after-hours any day\"",
        "      enhancement: \"Wed 12:00 ET\"",
      ].join("\n"),
    );
    expect(w[0].band).toBe("Wed 12:00 ET");
    expect(w[0].bands).toEqual({ bugfix: "after-hours any day", enhancement: "Wed 12:00 ET" });
  });

  it("rejects an unknown class key in `bands` (typo cannot silently fall through)", () => {
    expect(() =>
      // pg-enum-drift-exempt: windows.yaml status vocabulary, no Postgres
      parseWindows(
        [
          "windows:",
          "  - surface: s",
          "    band: always",
          "    status: RULED",
          "    bands:",
          "      hotfix: whenever",
        ].join("\n"),
      ),
    ).toThrow(/unknown class/);
  });

  it("rejects a non-string / empty `bands.<class>` value", () => {
    expect(() =>
      // pg-enum-drift-exempt: windows.yaml status vocabulary, no Postgres
      parseWindows(
        [
          "windows:",
          "  - surface: s",
          "    band: always",
          "    status: RULED",
          "    bands:",
          "      bugfix: \"\"",
        ].join("\n"),
      ),
    ).toThrow(/must be a non-empty string/);
    expect(() =>
      // pg-enum-drift-exempt: windows.yaml status vocabulary, no Postgres
      parseWindows(
        [
          "windows:",
          "  - surface: s",
          "    band: always",
          "    status: RULED",
          "    bands:",
          "      bugfix: 42",
        ].join("\n"),
      ),
    ).toThrow(/must be a non-empty string/);
  });

  it("accepts a windows.yaml row WITHOUT `bands` (back-compat: legacy single-band rows)", () => {
    // pg-enum-drift-exempt: windows.yaml status vocabulary, no Postgres
    const w = parseWindows("windows:\n  - surface: s\n    band: always\n    status: RULED");
    expect(w[0].bands).toBeUndefined();
    expect(w[0].band).toBe("always");
  });
});

describe("resolveClassBand — precedence", () => {
  // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
  const both: WindowEntry = {
    surface: "s",
    band: "Wed 12:00 ET",
    bands: { bugfix: "after-hours any day", enhancement: "Wed 12:00 ET" },
    status: "RULED",
  };
  // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
  const legacy: WindowEntry = { surface: "s", band: "always", status: "RULED" };

  it("picks bands[class] when present, for both classes", () => {
    expect(resolveClassBand(both, "bugfix")).toEqual({ band: "after-hours any day" });
    expect(resolveClassBand(both, "enhancement")).toEqual({ band: "Wed 12:00 ET" });
  });

  it("falls back to `band` for ENHANCEMENT when `bands` is absent (legacy row)", () => {
    expect(resolveClassBand(legacy, "enhancement")).toEqual({ band: "always" });
  });

  it("bugfix has NO fallback — a legacy row fails closed for bugfix", () => {
    const r = resolveClassBand(legacy, "bugfix");
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/no band configured for class .bugfix./);
  });

  it("a partial `bands` (only bugfix) still lets enhancement inherit `band`", () => {
    // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
    const partial: WindowEntry = {
      surface: "s",
      band: "Wed 12:00 ET",
      bands: { bugfix: "after-hours any day" },
      status: "RULED",
    };
    expect(resolveClassBand(partial, "bugfix")).toEqual({ band: "after-hours any day" });
    expect(resolveClassBand(partial, "enhancement")).toEqual({ band: "Wed 12:00 ET" });
  });
});

describe("evaluateWindow — 'after-hours any day' grammar", () => {
  // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
  const ah: WindowEntry = { surface: "s", band: "after-hours any day", status: "RULED" };

  it("closed inside weekday 06:00-18:00 ET", () => {
    const wedNoon = new Date("2026-09-02T16:30:00Z"); // Wed 12:30 ET (EDT = UTC-4)
    const v = evaluateWindow(ah, wedNoon);
    expect(v.open).toBe(false);
    expect(v.reason).toMatch(/inside business hours/);
  });

  it("open weekday evening (past 18:00 ET) and weekday early morning (before 06:00 ET)", () => {
    expect(evaluateWindow(ah, new Date("2026-09-02T23:30:00Z")).open).toBe(true); // Wed 19:30 ET
    expect(evaluateWindow(ah, new Date("2026-09-02T09:30:00Z")).open).toBe(true); // Wed 05:30 ET
  });

  it("open all day Saturday and Sunday", () => {
    expect(evaluateWindow(ah, new Date("2026-09-05T16:00:00Z")).open).toBe(true); // Sat 12:00 ET
    expect(evaluateWindow(ah, new Date("2026-09-06T16:00:00Z")).open).toBe(true); // Sun 12:00 ET
  });

  it("boundary: 18:00 ET is OPEN (half-open), 05:59 ET is OPEN, 06:00 ET is CLOSED", () => {
    // Wed 18:00 ET = 22:00 UTC (EDT)
    expect(evaluateWindow(ah, new Date("2026-09-02T22:00:00Z")).open).toBe(true);
    // Wed 06:00 ET = 10:00 UTC (EDT)
    expect(evaluateWindow(ah, new Date("2026-09-02T10:00:00Z")).open).toBe(false);
    // Wed 05:59 ET = 09:59 UTC (EDT)
    expect(evaluateWindow(ah, new Date("2026-09-02T09:59:00Z")).open).toBe(true);
  });
});

describe("evaluateWindow — ticketClass argument", () => {
  // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
  const dual: WindowEntry = {
    surface: "s",
    band: "Wed 12:00 ET",
    bands: { bugfix: "after-hours any day", enhancement: "Wed 12:00 ET" },
    status: "RULED",
  };
  const WED_1230_ET = new Date("2026-09-02T16:30:00Z");
  const SAT_NOON_ET = new Date("2026-09-05T16:00:00Z");

  it("bugfix uses bands.bugfix (after-hours any day) — Saturday opens, Wed noon closes", () => {
    expect(evaluateWindow(dual, SAT_NOON_ET, 60, "bugfix").open).toBe(true);
    expect(evaluateWindow(dual, WED_1230_ET, 60, "bugfix").open).toBe(false);
  });

  it("enhancement uses bands.enhancement (Wed 12:00 ET) — Wed noon opens, Saturday closes", () => {
    expect(evaluateWindow(dual, WED_1230_ET, 60, "enhancement").open).toBe(true);
    expect(evaluateWindow(dual, SAT_NOON_ET, 60, "enhancement").open).toBe(false);
  });

  it("default class is enhancement (fail-closed for omission — no bugfix by silence)", () => {
    // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
    const bugfixOnly: WindowEntry = {
      surface: "s",
      band: "Wed 12:00 ET",
      bands: { bugfix: "after-hours any day" },
      status: "RULED",
    };
    // Saturday would OPEN under bugfix but must CLOSE under the default enhancement.
    const v = evaluateWindow(bugfixOnly, SAT_NOON_ET);
    expect(v.open).toBe(false);
  });

  it("an unrecognized ticketClass string coerces to enhancement (never bugfix by garbage)", () => {
    // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
    const bugfixOnly: WindowEntry = {
      surface: "s",
      band: "Wed 12:00 ET",
      bands: { bugfix: "after-hours any day" },
      status: "RULED",
    };
    // Cast through unknown to simulate a runtime caller outside TS's union.
    const v = evaluateWindow(bugfixOnly, SAT_NOON_ET, 60, "hotfix" as unknown as "bugfix");
    expect(v.open).toBe(false);
  });

  it("bugfix on a legacy row (no bands) fails closed — the wider band is never inherited", () => {
    // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
    const legacy: WindowEntry = { surface: "s", band: "always", status: "RULED" };
    const v = evaluateWindow(legacy, WED_1230_ET, 60, "bugfix");
    expect(v.open).toBe(false);
    expect(v.reason).toMatch(/no band configured for class .bugfix./);
  });
});

describe("evaluateDeparture — check 08 class-aware evaluation", () => {
  function classAwareWindows(): WindowEntry[] {
    // pg-enum-drift-exempt: WindowEntry.status YAML vocabulary, no Postgres
    return [
      {
        surface: "railway:test-svc",
        band: "Wed 12:00 ET",
        bands: { bugfix: "after-hours any day", enhancement: "Wed 12:00 ET" },
        status: "RULED",
      },
    ];
  }

  it("bugfix ticket DEPARTS on a Saturday against a per-class bands map", () => {
    const reg: Registries = { ...goodRegistries(), windows: classAwareWindows() };
    const facts: DepartureFacts = {
      ...goodFacts(),
      ticketClass: "bugfix",
      expectedPublishTime: new Date("2026-09-05T16:00:00Z"), // Sat 12:00 ET
    };
    const r = evaluateDeparture(reg, facts);
    expect(r.verdict).toBe("DEPART");
    expect(r.failures).toEqual([]);
    const c08 = r.checks.find((c) => c.id === "08");
    expect(c08?.reason).toMatch(/class=bugfix/);
    expect(c08?.reason).toMatch(/band=`after-hours any day`/);
  });

  it("enhancement ticket at Wed 12:30 ET DEPARTS; the same slot fails bugfix (business hours)", () => {
    const reg: Registries = { ...goodRegistries(), windows: classAwareWindows() };
    const wedNoon: DepartureFacts = {
      ...goodFacts(),
      ticketClass: "enhancement",
      expectedPublishTime: new Date("2026-09-02T16:30:00Z"),
    };
    expect(evaluateDeparture(reg, wedNoon).verdict).toBe("DEPART");
    const bugfixSameSlot: DepartureFacts = { ...wedNoon, ticketClass: "bugfix" };
    const r = evaluateDeparture(reg, bugfixSameSlot);
    expect(r.verdict).toBe("FALL_THROUGH");
    expect(r.failures.some((f) => /^\[08\].*class=bugfix.*business hours/.test(f))).toBe(true);
  });

  it("absent ticketClass defaults to enhancement — never bugfix by omission (fail-closed)", () => {
    const reg: Registries = { ...goodRegistries(), windows: classAwareWindows() };
    // Saturday would open under bugfix; the default enhancement gates it to Wed.
    const facts: DepartureFacts = {
      ...goodFacts(),
      ticketClass: undefined,
      expectedPublishTime: new Date("2026-09-05T16:00:00Z"),
    };
    const r = evaluateDeparture(reg, facts);
    expect(r.verdict).toBe("FALL_THROUGH");
    const f08 = r.failures.find((f) => /^\[08\]/.test(f));
    expect(f08).toBeDefined();
    expect(f08).toMatch(/class=enhancement/);
  });

  it("check 08 reason names the class + resolved band structurally (PLAN-line consumer)", () => {
    const reg: Registries = { ...goodRegistries(), windows: classAwareWindows() };
    const facts: DepartureFacts = {
      ...goodFacts(),
      ticketClass: "bugfix",
      expectedPublishTime: new Date("2026-09-02T16:30:00Z"), // Wed noon — bugfix closed here
    };
    const r = evaluateDeparture(reg, facts);
    const c08 = r.checks.find((c) => c.id === "08");
    expect(c08?.reason).toMatch(/^class=bugfix band=`after-hours any day`:/);
  });

  it("bugfix on a legacy (single-band) row fails check 08 — the wider band is never inherited", () => {
    // Legacy windows[0] has only `band: always`, no `bands`. A bugfix ticket
    // must NOT slip through under the enhancement default.
    const facts: DepartureFacts = { ...goodFacts(), ticketClass: "bugfix" };
    const r = evaluateDeparture(goodRegistries(), facts);
    expect(r.verdict).toBe("FALL_THROUGH");
    const f08 = r.failures.find((f) => /^\[08\]/.test(f));
    expect(f08).toMatch(/no band configured for class .bugfix./);
  });
});
