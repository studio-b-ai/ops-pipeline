/**
 * railway-volume-reconcile.ts — the Leg-1 "absent-entity sweep" for railway-volume-monitor.ts
 * (ops-pipeline#71, design approved by Kevin 2026-08-12 — see the issue's design-review comment).
 *
 * Origin: the PROBE FAILED close path lives inside the successful-fetch branch of the
 * per-project loop — a project REMOVED from the probe set entirely (deleted from Railway AND
 * dropped from the manifest, as context-engine/relay/aesthetik-staging were on 8/12) can never
 * fetch successfully again, so its open issue orphans forever. Three such issues (#62/#63/#64)
 * had to be closed by hand. The same gap plausibly exists for volume-severity issues whose
 * volume/service was deleted while its PROJECT is still probed fine. This module classifies
 * every OPEN `volume-monitor` issue into exactly one disposition, run AFTER the per-project loop
 * and the per-volume reconcile loop (railway-volume-monitor.ts wires the call site + the close
 * comments; this file is pure decision logic, fully unit-testable, mirroring the split between
 * gateway-token-reconcile.ts and its caller).
 *
 * Rule #109 (this PR's chip prompt): this deliberately does NOT generalize
 * `gateway-token-reconcile.ts`'s `orphanedStragglerIssues` to serve both monitors — the volume
 * sweep has its own three-way disposition (keep / close-absent / close-unprobed) driven by TWO
 * independent title shapes (per-project binary + per-volume severity-tiered), which
 * `orphanedStragglerIssues`'s single-shape name-in-set check cannot express.
 */

import type { ProjectRef } from "./railway-volume-probes.js";
import { parseSeverityTitle } from "./severity-issue-reconcile.js";

export type SweepDisposition = "keep" | "close-absent" | "close-unprobed";

/** `[volume-monitor] MONITOR BLIND — all projects failed to fetch` — title shape C, exact match, NEVER swept. */
export const VOLUME_MONITOR_BLIND_TITLE = "[volume-monitor] MONITOR BLIND — all projects failed to fetch";

/** `[volume-monitor] PROBE FAILED — <project>` — title shape B's fixed prefix. */
export const PROBE_FAILED_PREFIX = "[volume-monitor] PROBE FAILED — ";

/** The label every severity-tiered volume-entity title (shape A) carries, per `severity-issue-reconcile.ts`. */
const VOLUME_MONITOR_LABEL = "volume-monitor";

/**
 * Strict UUID (v1-v5, case-insensitive) trailing-suffix discriminator: `... [<uuid>]` at the very
 * end of the entity string. This is what keeps shape A's `parseSeverityTitle` call from
 * accidentally matching shape B or C titles — both of THOSE also parse successfully under
 * `parseSeverityTitle`'s generic `[label] entity — status` shape (documented live behavior: the
 * design review noted `PROBE FAILED — context-engine` parses into entity="PROBE FAILED",
 * status="context-engine", and the deployed monitor already inserts that into `openVolumeByEntity`
 * harmlessly, because nothing looks it up). Requiring the UUID suffix is the ONLY thing that
 * disambiguates a real volume-entity key (`.../volume [8-4-4-4-12 hex]`) from any other title that
 * happens to fit the generic two-part shape.
 */
const ENTITY_UUID_SUFFIX_RE = / \[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]$/i;

export function hasUuidSuffix(entity: string): boolean {
  return ENTITY_UUID_SUFFIX_RE.test(entity);
}

/** Project names appearing more than once in `projectSet` — the sweep cannot safely resolve a longest-prefix match while these exist. */
export function findDuplicateProjectNames(projectSet: ProjectRef[]): string[] {
  const counts = new Map<string, number>();
  for (const p of projectSet) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

/**
 * Resolve a volume-entity string's owning project by the LONGEST `projectName + "/"` prefix
 * among `projectSet`. Longest wins so a project whose name is itself a prefix segment of another
 * project's name (e.g. "a" and "a/b", however unlikely in practice) resolves to the more specific
 * match rather than the first one found. Returns null when no project in `projectSet` prefixes
 * the entity at all — that IS the "project no longer probed" signal.
 */
export function resolveProjectByPrefix(entity: string, projectSet: ProjectRef[]): ProjectRef | null {
  let best: ProjectRef | null = null;
  for (const p of projectSet) {
    const prefix = `${p.name}/`;
    if (entity.startsWith(prefix) && (!best || p.name.length > best.name.length)) {
      best = p;
    }
  }
  return best;
}

export interface SweepContext {
  /** Names of projects that fetched successfully THIS run. */
  probedOkProjects: Set<string>;
  /** Names of projects that failed to fetch THIS run — never close on a blind project. */
  failedProjects: Set<string>;
  /** Full `volumeEntityKey(...)` strings actually seen (i.e. still exist) THIS run, across every successfully-probed project. */
  seenEntities: Set<string>;
  /** This run's full project set (probedOkProjects ∪ failedProjects, by name). */
  projectSet: ProjectRef[];
}

/**
 * Single-issue-title classifier — pure, no I/O. Implements the exhaustive ordered disposition
 * list from the design review (checked in this exact order):
 *
 *   1. Title shape C (MONITOR BLIND, exact match) → keep, never swept.
 *   2. Title shape B (`PROBE FAILED — <project>` prefix) → project still in `projectSet` → keep
 *      (its own per-project reconcile owns it); otherwise → close-unprobed.
 *   3. Title shape A (`parseSeverityTitle` matches AND entity ends with ` [<uuid>]`):
 *        - no project prefix matches at all → close-unprobed (the project itself is gone)
 *        - project FAILED to fetch this run → keep (never close on a blind project)
 *        - project probed OK + entity in `seenEntities` → keep (still there)
 *        - project probed OK + entity NOT in `seenEntities` → close-absent (project's fine, this
 *          volume specifically is gone — deleted, detached, or resized to 0)
 *   4. Any other title (doesn't even match the generic `[label] entity — status` shape, or matches
 *      but lacks the UUID suffix) → keep.
 */
export function classifySweepDisposition(title: string, ctx: SweepContext): SweepDisposition {
  // 1. Shape C — exact match only, never inspected further.
  if (title === VOLUME_MONITOR_BLIND_TITLE) return "keep";

  // 2. Shape B — fixed prefix, entity is the remainder (the project name verbatim).
  if (title.startsWith(PROBE_FAILED_PREFIX)) {
    const projectName = title.slice(PROBE_FAILED_PREFIX.length);
    const stillInProjectSet = ctx.projectSet.some((p) => p.name === projectName);
    return stillInProjectSet ? "keep" : "close-unprobed";
  }

  // 3. Shape A — must match the generic severity shape AND carry the UUID suffix.
  const parsed = parseSeverityTitle(VOLUME_MONITOR_LABEL, title);
  if (!parsed || !hasUuidSuffix(parsed.entity)) return "keep"; // 4. anything else → keep.

  const project = resolveProjectByPrefix(parsed.entity, ctx.projectSet);
  if (!project) return "close-unprobed"; // no project prefix matches at all
  if (ctx.failedProjects.has(project.name)) return "keep"; // never close on a blind project
  if (!ctx.probedOkProjects.has(project.name)) return "keep"; // conservative: not recorded as OK either — leave alone
  return ctx.seenEntities.has(parsed.entity) ? "keep" : "close-absent";
}

export interface SweepIssue {
  number: number;
  title: string;
  state: string;
}

export interface SweepAction {
  number: number;
  title: string;
  disposition: "close-absent" | "close-unprobed";
}

export interface SweepOutcome {
  actions: SweepAction[];
  /** Loud, caller-logged warnings (e.g. duplicate project names) — this module does no I/O itself. */
  warnings: string[];
}

/**
 * Batch sweep over every OPEN `volume-monitor` issue. Two GLOBAL guards short-circuit the WHOLE
 * sweep to a no-op (both listed as top-level rules in the design review, not scoped to shape A):
 *
 *   - `probedOkProjects.size === 0` — nothing succeeded this run; closing anything based on
 *     absence would be closing against a run that proved nothing.
 *   - Duplicate names in `projectSet` — the longest-prefix resolution used for shape A becomes
 *     ambiguous (two different projects could each match `<name>/` and only one may actually be
 *     the volume's real owner), so the entire sweep stands down rather than guess.
 *
 * Closed issues are never classified (only `state === "OPEN"` is considered) — this module has
 * no closed-issue history need, matching `listIssuesByLabel(repo, label, "open")`'s caller
 * contract elsewhere in this monitor.
 */
export function sweepAbsentEntityIssues(issues: SweepIssue[], ctx: SweepContext): SweepOutcome {
  const warnings: string[] = [];

  if (ctx.probedOkProjects.size === 0) {
    return { actions: [], warnings };
  }

  const dupNames = findDuplicateProjectNames(ctx.projectSet);
  if (dupNames.length > 0) {
    warnings.push(
      `railway-volume-monitor: duplicate project name(s) in this run's project set (${dupNames.join(", ")}) — absent-entity sweep skipped entirely this run (ambiguous longest-prefix resolution).`,
    );
    return { actions: [], warnings };
  }

  const actions: SweepAction[] = [];
  for (const issue of issues) {
    if (issue.state !== "OPEN") continue;
    const disposition = classifySweepDisposition(issue.title, ctx);
    if (disposition !== "keep") {
      actions.push({ number: issue.number, title: issue.title, disposition });
    }
  }
  return { actions, warnings };
}
