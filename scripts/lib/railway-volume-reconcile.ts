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

export type SweepDisposition = "keep" | "keep-blind" | "close-absent" | "close-unprobed";

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
  /**
   * Names of projects whose fetch SUCCEEDED but hit a pagination cap this run (any of
   * services/environments/volumeInstances reported `hasNextPage: true` — see
   * `lib/railway-volume-probes.ts`'s `ParsedProjectVolumes.truncated`). codex review finding (P1,
   * fixed here): a truncated project's `seenEntities` is KNOWN INCOMPLETE — a real, still-existing
   * WARN/CRITICAL volume can simply be sitting past the fetched page, and treating its absence
   * from `seenEntities` as "gone" would falsely close a genuinely-active alert. Absence evidence
   * from a truncated project is exactly as untrustworthy as absence evidence from a failed one.
   */
  truncatedProjects: Set<string>;
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
 *        - entity string is IN `seenEntities` (fetched live THIS run) → keep, unconditionally,
 *          checked BEFORE any project-name resolution (codex review finding, P1: `projectSet`'s
 *          name can lag Railway's live name for the same project id when discovery is unavailable
 *          — e.g. after a Railway rename the manifest hasn't caught up — and resolving by the
 *          STALE name first would misclassify a volume just confirmed active as gone)
 *        - no project prefix matches AND no project in this run's set failed/was truncated →
 *          close-unprobed (the project itself is genuinely gone — trustworthy ONLY when every
 *          project this run resolved cleanly; see the codex P1 note below)
 *        - no project prefix matches BUT at least one project failed/was truncated this run →
 *          keep-blind (codex review finding, P1: the seenEntities-first check above only protects
 *          a stale-manifest-name project that SUCCEEDED this run — it never fires when that same
 *          project instead FAILS to fetch, since a failed fetch populates neither seenEntities nor
 *          a resolvable projectSet entry under the entity's live name; we cannot rule out the
 *          unresolvable entity belongs to one of THIS run's blind projects under a name we don't
 *          currently trust, so stay conservative rather than risk a false-close)
 *        - project FAILED to fetch OR was TRUNCATED this run → keep-blind (never close on
 *          absence-evidence we can't trust — this is DISTINCT from plain "keep" so the caller can
 *          report "kept (project probe failed): M" in the run summary per the design review,
 *          rather than folding a "we genuinely can't tell if this is absent" case into the same
 *          bucket as "confirmed still there")
 *        - anything else at this point (project probed OK, not truncated, entity confirmed NOT
 *          in `seenEntities` by the first check above) → close-absent (project's fine, fully
 *          fetched, this volume specifically is gone — deleted, detached, or resized to 0)
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

  // codex review finding (P1, fixed here): check `seenEntities` FIRST, before attempting to
  // resolve an owning project by name-prefix at all. If the EXACT entity string was fetched live
  // THIS run, it unambiguously still exists — full stop — regardless of what `projectSet`'s
  // (possibly manifest-stale) name-prefix resolution would conclude. This matters when project
  // discovery is unavailable (a REAL, documented degradation path — see
  // railway-projects.manifest.yaml's header): `projectSet` then falls back to the raw manifest
  // list, whose cached project NAME can lag Railway's actual current name for that same project
  // id after a rename. The fetch still succeeds (Railway keys by id, not name), so `allVolumes`
  // — and therefore `seenEntities` — carries the NEW live name, while `projectSet` still carries
  // the OLD manifest name. The old prefix-first logic would then find no match for the old-name
  // prefix against the new-name entity and misclassify a volume the per-volume loop just
  // confirmed is active as `close-unprobed` — a real false-close.
  if (ctx.seenEntities.has(parsed.entity)) return "keep";

  const project = resolveProjectByPrefix(parsed.entity, ctx.projectSet);
  if (!project) {
    // codex review finding (P1, fixed here): "no project prefix matches" is only a TRUSTWORTHY
    // "this project is truly gone" signal when EVERY project in this run's set was cleanly
    // resolved (no failures, no truncations). The seenEntities-first check above only protects
    // the case where the stale-named project SUCCEEDED this run; it does nothing when that same
    // project instead FAILS to fetch (a failed fetch never populates seenEntities at all) — a
    // volume issue titled under a project's CURRENT live name (from a prior successful run) can
    // then be unresolvable against this run's STALE manifest name (discovery unavailable + a
    // Railway rename the manifest hasn't caught up to) while that stale-named project sits in
    // `failedProjects`. Without this guard the entity falls straight to close-unprobed, falsely
    // closing an active alert whose project merely failed to fetch. Staying conservative whenever
    // ANYTHING failed/was truncated this run costs a delayed orphan-close (self-heals next clean
    // run); a false-close on a real CRITICAL is the failure mode this whole monitor exists to
    // prevent (Rule #4) — never trade the former's convenience for the latter's risk.
    return ctx.failedProjects.size > 0 || ctx.truncatedProjects.size > 0 ? "keep-blind" : "close-unprobed";
  }
  // A TRUNCATED project's seenEntities is exactly as untrustworthy for absence-detection as a
  // FAILED one — both mean "we cannot confirm this volume is actually gone," so both take the
  // keep-blind path, never close-absent.
  if (ctx.failedProjects.has(project.name) || ctx.truncatedProjects.has(project.name)) return "keep-blind";
  if (!ctx.probedOkProjects.has(project.name)) return "keep"; // conservative: not recorded as OK either — leave alone
  return "close-absent"; // seenEntities was already checked above and was false, or we wouldn't be here
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
  /**
   * Count of OPEN issues that resolved to "keep-blind" — a volume-entity issue whose owning
   * project either failed to fetch OR was truncated (pagination cap hit) this run, so absence
   * could not be confirmed either way. Surfaced separately from the (silent) ordinary "keep"
   * count so the run summary can report "kept (project probe failed): M" per the design review,
   * distinct from "orphans closed: N".
   */
  keptBlindCount: number;
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
    return { actions: [], warnings, keptBlindCount: 0 };
  }

  const dupNames = findDuplicateProjectNames(ctx.projectSet);
  if (dupNames.length > 0) {
    warnings.push(
      `railway-volume-monitor: duplicate project name(s) in this run's project set (${dupNames.join(", ")}) — absent-entity sweep skipped entirely this run (ambiguous longest-prefix resolution).`,
    );
    return { actions: [], warnings, keptBlindCount: 0 };
  }

  const actions: SweepAction[] = [];
  let keptBlindCount = 0;
  for (const issue of issues) {
    if (issue.state !== "OPEN") continue;
    const disposition = classifySweepDisposition(issue.title, ctx);
    if (disposition === "close-absent" || disposition === "close-unprobed") {
      actions.push({ number: issue.number, title: issue.title, disposition });
    } else if (disposition === "keep-blind") {
      keptBlindCount++;
    }
  }
  return { actions, warnings, keptBlindCount };
}
