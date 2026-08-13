import { describe, expect, it } from "vitest";
import {
  classifySweepDisposition,
  findDuplicateProjectNames,
  hasUuidSuffix,
  resolveProjectByPrefix,
  sweepAbsentEntityIssues,
  VOLUME_MONITOR_BLIND_TITLE,
  PROBE_FAILED_PREFIX,
  type SweepContext,
  type SweepIssue,
} from "../railway-volume-reconcile.js";
import { buildSeverityTitle } from "../severity-issue-reconcile.js";

const UUID = "a622cddb-8faf-4364-9dc2-75ba1b063967";
const proj = (name: string, id = `id-${name}`) => ({ id, name });

// ───────────────────────────── hasUuidSuffix ─────────────────────────────

describe("hasUuidSuffix", () => {
  // Negative controls first (Rule #322).
  it("does NOT match an entity with no bracketed suffix at all", () => {
    expect(hasUuidSuffix("wasala-platform/production/Postgres/postgres-volume")).toBe(false);
  });
  it("does NOT match a bracketed suffix that isn't a UUID (e.g. shape B/C's coincidental parse)", () => {
    expect(hasUuidSuffix("PROBE FAILED")).toBe(false);
    expect(hasUuidSuffix("MONITOR BLIND")).toBe(false);
    expect(hasUuidSuffix("foo/bar [not-a-uuid]")).toBe(false);
  });
  it("does NOT match a UUID-shaped suffix that isn't at the very end", () => {
    expect(hasUuidSuffix(`foo/bar [${UUID}] trailing text`)).toBe(false);
  });

  it("matches a real volume-entity key's trailing ` [<uuid>]`", () => {
    expect(hasUuidSuffix(`wasala-platform/production/Postgres/postgres-volume [${UUID}]`)).toBe(true);
  });
  it("is case-insensitive on the hex digits", () => {
    expect(hasUuidSuffix(`foo/bar [${UUID.toUpperCase()}]`)).toBe(true);
  });
});

// ───────────────────────────── findDuplicateProjectNames ─────────────────────────────

describe("findDuplicateProjectNames", () => {
  it("returns empty for an all-unique project set (negative control)", () => {
    expect(findDuplicateProjectNames([proj("a"), proj("b"), proj("c")])).toEqual([]);
  });
  it("returns empty for an empty set", () => {
    expect(findDuplicateProjectNames([])).toEqual([]);
  });

  it("names every project name appearing more than once", () => {
    expect(findDuplicateProjectNames([proj("a", "id1"), proj("a", "id2"), proj("b")])).toEqual(["a"]);
  });
});

// ───────────────────────────── resolveProjectByPrefix ─────────────────────────────

describe("resolveProjectByPrefix", () => {
  // Negative controls first.
  it("returns null when no project name prefixes the entity", () => {
    expect(resolveProjectByPrefix("gone-project/production/svc/vol [x]", [proj("shuttle"), proj("wasala-platform")])).toBeNull();
  });
  it("does NOT treat a same-stem-but-different-name project as a match (no trailing slash boundary)", () => {
    // "wasala" is a real project but "wasala-platform/..." must NOT prefix-match "wasala/".
    expect(resolveProjectByPrefix("wasala-platform/production/Postgres/postgres-volume [x]", [proj("wasala")])).toBeNull();
  });

  it("resolves the single matching project", () => {
    const set = [proj("shuttle"), proj("wasala-platform")];
    expect(resolveProjectByPrefix("wasala-platform/production/Postgres/postgres-volume [x]", set)?.name).toBe("wasala-platform");
  });
  it("picks the LONGEST matching prefix when more than one project name prefixes the entity", () => {
    // Contrived (Railway project names are unlikely to contain "/"), but the design mandates
    // longest-match as the tie-break, so it is proven directly rather than assumed untestable.
    const set = [proj("a"), proj("a/b")];
    expect(resolveProjectByPrefix("a/b/production/svc/vol [x]", set)?.name).toBe("a/b");
  });
});

// ───────────────────────────── classifySweepDisposition ─────────────────────────────

describe("classifySweepDisposition", () => {
  const okCtx = (over: Partial<SweepContext> = {}): SweepContext => ({
    probedOkProjects: new Set(["wasala-platform"]),
    failedProjects: new Set(),
    truncatedProjects: new Set(),
    seenEntities: new Set([`wasala-platform/production/Postgres/postgres-volume [${UUID}]`]),
    projectSet: [proj("wasala-platform", "ad6f97b7-5b83-4104-b857-3550cebffff0")],
    ...over,
  });

  // Negative controls first (Rule #322): shapes/cases that must NEVER be swept.
  it("shape C (MONITOR BLIND, exact match) is never swept, regardless of context", () => {
    expect(classifySweepDisposition(VOLUME_MONITOR_BLIND_TITLE, okCtx())).toBe("keep");
    expect(classifySweepDisposition(VOLUME_MONITOR_BLIND_TITLE, okCtx({ probedOkProjects: new Set() }))).toBe("keep");
  });
  it("a near-miss of the blind title (not an exact match) falls through safely to keep, not to shape-B/A handling", () => {
    expect(classifySweepDisposition(`${VOLUME_MONITOR_BLIND_TITLE} `, okCtx())).toBe("keep");
    expect(classifySweepDisposition("[volume-monitor] monitor blind — all projects failed to fetch", okCtx())).toBe("keep");
  });
  it("shape B: project STILL in projectSet keeps (its own per-project reconcile owns it)", () => {
    expect(classifySweepDisposition(`${PROBE_FAILED_PREFIX}wasala-platform`, okCtx())).toBe("keep");
  });
  it("shape A: project probed OK and the entity is still seen this run → keep", () => {
    const title = buildSeverityTitle("volume-monitor", `wasala-platform/production/Postgres/postgres-volume [${UUID}]`, "WARN");
    expect(classifySweepDisposition(title, okCtx())).toBe("keep");
  });
  it("shape A: project FAILED to fetch this run → keep-blind even though the entity is absent from seenEntities (never close on a blind project — distinct from plain 'keep' so the run summary can count it)", () => {
    const title = buildSeverityTitle("volume-monitor", `wasala-platform/production/Postgres/postgres-volume [${UUID}]`, "WARN");
    const ctx = okCtx({ probedOkProjects: new Set(), failedProjects: new Set(["wasala-platform"]), seenEntities: new Set() });
    expect(classifySweepDisposition(title, ctx)).toBe("keep-blind");
  });
  it("a title that parses the generic [label] entity — status shape but lacks the UUID suffix → keep (shape B/C's coincidental-parse defense)", () => {
    // parseSeverityTitle("volume-monitor", "[volume-monitor] PROBE FAILED — context-engine") DOES parse
    // (entity="PROBE FAILED", status="context-engine") — this proves the UUID-suffix gate is what
    // keeps that parse from being treated as a real volume entity, independent of the shape-B prefix
    // check already catching it first.
    expect(classifySweepDisposition("[volume-monitor] PROBE FAILED — context-engine", okCtx({ projectSet: [] }))).not.toBe("close-absent");
  });
  it("any title outside the known shapes → keep", () => {
    expect(classifySweepDisposition("[volume-monitor] some future title nobody parses", okCtx())).toBe("keep");
    expect(classifySweepDisposition("totally unrelated issue", okCtx())).toBe("keep");
  });

  it("shape B: project NOT in projectSet → close-unprobed", () => {
    expect(classifySweepDisposition(`${PROBE_FAILED_PREFIX}context-engine`, okCtx({ projectSet: [proj("wasala-platform")] }))).toBe(
      "close-unprobed",
    );
  });
  it("shape A: no project prefix matches at all → close-unprobed (the project itself is gone)", () => {
    const title = buildSeverityTitle("volume-monitor", `context-engine/production/Postgres/pg-data [${UUID}]`, "WARN");
    expect(classifySweepDisposition(title, okCtx({ projectSet: [proj("wasala-platform")] }))).toBe("close-unprobed");
  });
  it("shape A: project probed OK but the entity is NOT in seenEntities → close-absent (volume itself gone, project fine)", () => {
    const title = buildSeverityTitle("volume-monitor", `wasala-platform/production/Postgres/deleted-volume [${UUID}]`, "WARN");
    expect(classifySweepDisposition(title, okCtx({ seenEntities: new Set() }))).toBe("close-absent");
  });

  // "rename-supersede" behavior: an issue titled under a project's OLD name closes as
  // close-unprobed on its own — this module's whole job. The complementary half (a fresh issue
  // opening under the NEW name because that entity is now in seenEntities) is the EXISTING
  // per-volume `reconcileSeverity` loop's job (severity-issue-reconcile.test.ts), not this
  // sweep's — the two operate on DIFFERENT entity strings (old-name vs new-name prefix) and so
  // never collide on the same issue number (see the invariant test below).
  it("a project rename disposes its OLD-name issue as close-unprobed (the new name gets a fresh issue via the normal severity reconcile, not this sweep)", () => {
    const title = buildSeverityTitle("volume-monitor", `old-name/production/Postgres/pg-data [${UUID}]`, "WARN");
    const ctx = okCtx({
      projectSet: [proj("new-name", "same-project-id")],
      probedOkProjects: new Set(["new-name"]),
      seenEntities: new Set([`new-name/production/Postgres/pg-data [${UUID}]`]),
    });
    expect(classifySweepDisposition(title, ctx)).toBe("close-unprobed");
  });

  // codex review finding (P1): the INVERSE rename scenario — discovery is unavailable this run
  // (a REAL, documented degradation path), so `projectSet` falls back to the raw manifest list,
  // whose cached project NAME lags Railway's current name for that same project id after a
  // rename. The fetch still succeeds by id, so the entity string this monitor itself builds (and
  // any issue it opens) carries the NEW live name — but `projectSet`'s prefix-resolution only
  // knows the OLD manifest name. Before the fix, `resolveProjectByPrefix` would find no match for
  // the old-name prefix against the new-name entity and this would false-close a volume the
  // per-volume loop, in this exact same run, just confirmed is still active.
  it("does NOT false-close when projectSet carries a STALE (manifest-lagging) name but the entity was fetched live THIS run under its NEW name", () => {
    const title = buildSeverityTitle("volume-monitor", `new-name/production/Postgres/pg-data [${UUID}]`, "WARN");
    const ctx = okCtx({
      projectSet: [proj("old-stale-manifest-name", "same-project-id")], // manifest hasn't caught up to the Railway rename
      probedOkProjects: new Set(["old-stale-manifest-name"]), // the loop uses projectSet's (stale) name as the key
      failedProjects: new Set(),
      seenEntities: new Set([`new-name/production/Postgres/pg-data [${UUID}]`]), // built from the LIVE fetch this run
    });
    expect(classifySweepDisposition(title, ctx)).toBe("keep");
  });

  // codex review finding (P1): the THIRD variant — same stale-name-after-rename setup, but this
  // time the stale-named project also FAILS to fetch this run (rather than succeeding). A failed
  // fetch populates neither seenEntities nor a resolvable projectSet entry under the entity's
  // live name, so the seenEntities-first check above cannot save this case the way it saves the
  // "succeeded" variant. Before the fix this fell straight to close-unprobed, falsely closing an
  // alert whose project merely failed to fetch (title carries the LIVE name from a prior
  // successful run; this run's projectSet still carries the stale manifest name in failedProjects).
  it("does NOT false-close when the stale-named project ALSO fails to fetch this run (downgrades to keep-blind, not close-unprobed)", () => {
    const title = buildSeverityTitle("volume-monitor", `new-name/production/Postgres/pg-data [${UUID}]`, "WARN");
    const ctx = okCtx({
      projectSet: [proj("old-stale-manifest-name", "same-project-id")],
      probedOkProjects: new Set(),
      failedProjects: new Set(["old-stale-manifest-name"]), // THIS run: fetch failed, keyed by the stale name
      seenEntities: new Set(), // nothing fetched — a failed fetch adds nothing
    });
    expect(classifySweepDisposition(title, ctx)).toBe("keep-blind");
  });

  // Negative control for the fix above: when NOTHING failed/was truncated anywhere this run,
  // "no project prefix matches" still means what it always meant — the project is genuinely gone.
  it("still correctly close-unprobes a genuinely-gone project when the run is otherwise completely clean (negative control)", () => {
    const title = buildSeverityTitle("volume-monitor", `context-engine/production/Postgres/pg-data [${UUID}]`, "WARN");
    const ctx = okCtx({
      projectSet: [proj("wasala-platform")],
      probedOkProjects: new Set(["wasala-platform"]),
      failedProjects: new Set(),
      truncatedProjects: new Set(),
    });
    expect(classifySweepDisposition(title, ctx)).toBe("close-unprobed");
  });
});

// ───────────────────────────── sweepAbsentEntityIssues ─────────────────────────────

describe("sweepAbsentEntityIssues", () => {
  const baseCtx: SweepContext = {
    probedOkProjects: new Set(["wasala-platform"]),
    failedProjects: new Set(),
    truncatedProjects: new Set(),
    seenEntities: new Set(),
    projectSet: [proj("wasala-platform")],
  };
  const closableIssue: SweepIssue = { number: 1, title: `${PROBE_FAILED_PREFIX}context-engine`, state: "OPEN" };

  // Negative controls first.
  it("global guard: probedOkProjects.size === 0 → whole sweep no-ops, even with an otherwise-closable issue", () => {
    const out = sweepAbsentEntityIssues([closableIssue], { ...baseCtx, probedOkProjects: new Set() });
    expect(out.actions).toEqual([]);
  });
  it("global guard: duplicate project names → whole sweep no-ops and logs loudly, even with an otherwise-closable issue", () => {
    const dupCtx: SweepContext = { ...baseCtx, projectSet: [proj("wasala-platform", "id1"), proj("wasala-platform", "id2")] };
    const out = sweepAbsentEntityIssues([closableIssue], dupCtx);
    expect(out.actions).toEqual([]);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.warnings[0]).toMatch(/duplicate project name/i);
  });
  it("ignores CLOSED issues even when they would otherwise close-unprobed", () => {
    const out = sweepAbsentEntityIssues([{ ...closableIssue, state: "CLOSED" }], baseCtx);
    expect(out.actions).toEqual([]);
  });
  it("an issue that resolves to keep is absent from the actions list entirely (not returned with disposition 'keep')", () => {
    const stillHere: SweepIssue = { number: 2, title: `${PROBE_FAILED_PREFIX}wasala-platform`, state: "OPEN" };
    const out = sweepAbsentEntityIssues([stillHere], baseCtx);
    expect(out.actions).toEqual([]);
  });

  it("produces close-unprobed for a project-gone issue and close-absent for a volume-gone issue in the same run", () => {
    const projectGone: SweepIssue = { number: 10, title: `${PROBE_FAILED_PREFIX}context-engine`, state: "OPEN" };
    const volumeGone: SweepIssue = {
      number: 11,
      title: buildSeverityTitle("volume-monitor", `wasala-platform/production/Postgres/deleted-vol [${UUID}]`, "CRITICAL"),
      state: "OPEN",
    };
    const out = sweepAbsentEntityIssues([projectGone, volumeGone], baseCtx);
    expect(out.actions).toHaveLength(2);
    expect(out.actions.find((a) => a.number === 10)?.disposition).toBe("close-unprobed");
    expect(out.actions.find((a) => a.number === 11)?.disposition).toBe("close-absent");
    expect(out.keptBlindCount).toBe(0);
  });

  it("counts keep-blind issues separately from actions — a run-summary receipt distinct from 'orphans closed' (both failed AND truncated projects count)", () => {
    const ctx: SweepContext = {
      probedOkProjects: new Set(["wasala-platform"]),
      failedProjects: new Set(["shuttle"]), // a SECOND project, blind this run
      truncatedProjects: new Set(["gi-lint"]), // a THIRD project, fetched OK but paginated-truncated
      seenEntities: new Set(),
      projectSet: [proj("wasala-platform"), proj("shuttle"), proj("gi-lint")],
    };
    const blindOne: SweepIssue = {
      number: 20,
      title: buildSeverityTitle("volume-monitor", `shuttle/production/Postgres/data [${UUID}]`, "WARN"),
      state: "OPEN",
    };
    const blindTwo: SweepIssue = {
      number: 21,
      title: buildSeverityTitle("volume-monitor", `shuttle/production/Redis/cache [11111111-1111-1111-1111-111111111111]`, "CRITICAL"),
      state: "OPEN",
    };
    const truncatedOne: SweepIssue = {
      number: 23,
      title: buildSeverityTitle("volume-monitor", `gi-lint/production/Postgres/data [22222222-2222-2222-2222-222222222222]`, "WARN"),
      state: "OPEN",
    };
    const closable: SweepIssue = { number: 22, title: `${PROBE_FAILED_PREFIX}context-engine`, state: "OPEN" };
    const out = sweepAbsentEntityIssues([blindOne, blindTwo, truncatedOne, closable], ctx);
    expect(out.keptBlindCount).toBe(3);
    // None of the blind/truncated-project issues appear in actions — only the genuinely-closable one does.
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].number).toBe(22);
  });

  // codex review finding (P1): a truncated project's seenEntities is known-incomplete — a real
  // still-open WARN/CRITICAL volume can be sitting past the fetched page. This must NEVER close.
  it("a truncated (but not failed) project's volume-entity issue never closes, even though the entity is absent from seenEntities", () => {
    const title = buildSeverityTitle("volume-monitor", `wasala-platform/production/Postgres/postgres-volume [${UUID}]`, "WARN");
    const ctx: SweepContext = {
      probedOkProjects: new Set(["wasala-platform"]),
      failedProjects: new Set(),
      truncatedProjects: new Set(["wasala-platform"]),
      seenEntities: new Set(), // KNOWN INCOMPLETE — the real volume may just be past the page cap
      projectSet: [proj("wasala-platform")],
    };
    expect(classifySweepDisposition(title, ctx)).toBe("keep-blind");
    const out = sweepAbsentEntityIssues([{ number: 30, title, state: "OPEN" }], ctx);
    expect(out.actions).toEqual([]);
    expect(out.keptBlindCount).toBe(1);
  });

  // The #29 invariant (design Q4 — ordering hazard between the sweep and the per-volume
  // reconcile loop, both of which push into ONE `planned` list applied in order): the sweep can
  // ONLY ever select an issue whose entity is NOT in `seenEntities` (or not resolvable to any
  // current project at all). The per-volume reconcile loop, by construction, only ever
  // retitles/closes issues for entities that ARE in `seenEntities` (it iterates `allVolumes`,
  // which is exactly what populates `seenEntities`). The two sets of issue numbers these two
  // mechanisms can act on are therefore always disjoint — proven here by showing the sweep
  // refuses to act on the one entity that IS seen.
  it("never targets an issue whose entity the per-volume reconcile loop would also be considering this run (disjoint by construction)", () => {
    const seenTitle = buildSeverityTitle("volume-monitor", `wasala-platform/production/Postgres/postgres-volume [${UUID}]`, "WARN");
    const ctx: SweepContext = { ...baseCtx, seenEntities: new Set([`wasala-platform/production/Postgres/postgres-volume [${UUID}]`]) };
    const out = sweepAbsentEntityIssues([{ number: 99, title: seenTitle, state: "OPEN" }], ctx);
    expect(out.actions.find((a) => a.number === 99)).toBeUndefined();
  });
});
