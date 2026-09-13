/**
 * backlog-orphan-reconcile.ts — the absent-entity orphan sweep for the two LANES rule-17
 * backlog instruments: backlog-staleness-worker.ts (per-MANAGER aggregates, identified by
 * `[backlog-staleness] <manager> — N findings` title) and backlog-compliance-worker.ts
 * (per-LANE issues, identified by a `laneMarker(name)` BODY prefix).
 *
 * Origin: the SAME class of gap already fixed for gateway-token-watch.ts (#37),
 * railway-volume-monitor.ts (#71 Leg 1) and credential-expiry-monitor.ts (#74) — and never
 * ported to these two. Both workers' reconcile loops iterate their COMMITTED CONFIG only:
 *
 *   - backlog-staleness-worker.ts `main()` builds `managers` from `findingsByManager.keys()`,
 *     which is seeded exclusively from `scripts/backlog-managers.yaml`'s repo rows. It reads
 *     `openByManager` from live issues but never sweeps it, so a manager REMOVED from the
 *     registry (renamed, retired, merged into another seat) leaves its open aggregate issue
 *     orphaned forever — the close path only runs when the SAME manager is evaluated again,
 *     which a removed manager never is.
 *   - backlog-compliance-worker.ts's per-lane block iterates `results` (one per active,
 *     non-skip LANES row) with the identical consequence for a lane row that leaves the table.
 *
 * LIVE EVIDENCE this is not theoretical (probed 2026-09-13, ops-pipeline): the staleness
 * registry carries exactly 4 managers (Dispatcher, Engineer, Mechanic, Publicity) while SIX
 * `backlog-staleness` issues are open — #379 Mechanic / #378 Engineer / #377 Dispatcher are
 * live and updated daily, but #169 `CMO`, #166 `COO` and #157 `CTO` name managers that no
 * longer exist under the seat-roster rename. All three last moved 2026-09-08 and cannot be
 * reached by any future run: they are the orphans this sweep closes. An unreachable open
 * alert is worse than no alert (Rule #412) — it asserts a stale finding count for a seat that
 * has no owner, and it inflates every "how many backlog alarms are open" read.
 *
 * Which proven pattern this ports: the gateway-style NAME-IN-SET sweep
 * (`gateway-token-reconcile.ts`'s `orphanedStragglerIssues`, as ported by
 * `credential-reconcile.ts`) — NOT `railway-volume-reconcile.ts`'s three-way
 * (keep / close-absent / close-unprobed) machinery. The reasoning is `credential-reconcile.ts`'s
 * verbatim, and holds here for the same reasons:
 *
 *   - keep-blind / truncation guards exist because Railway's fetch can fail or paginate
 *     mid-run, so "absent from what we saw this run" is ambiguous. Both configs here are LOCAL
 *     COMMITTED FILES (`backlog-managers.yaml`, the LANES table) read once, in full — and both
 *     workers already throw/degrade before this module is reached if the config is unreadable.
 *     Absent from the entity set a run built IS "genuinely gone", unconditionally.
 *   - prefix resolution / UUID-suffix discrimination exist because a Railway volume key is a
 *     compound of independently-renameable parts. A manager name and a lane name are each ONE
 *     flat string and ARE the entity — nothing to decompose.
 *   - a RENAME is not a false-close here: closing the old name's issue as "no longer
 *     monitored" is the CORRECT outcome (the old name genuinely left the set), and the new
 *     name, if still alert-worthy, opens its own fresh issue via the normal reconcile loop.
 *
 * Deliberately NOT swept (Rule #287 — these shapes are by design, not defects):
 * `post-merge-tripwire.ts` and `railway-incident-ledger.ts` open issues and never close them
 * ON PURPOSE — the tripwire's `escalate()` documents them as point-event escalations humans
 * close ("there is no 'condition cleared' auto-close for a completed window"), and the ledger
 * is ONE standing issue reconciled by body-edit. Neither has an entity set to be absent from.
 *
 * Close comments say "no longer monitored", never "resolved" — this sweep never re-verifies a
 * removed entity's actual backlog state (Rule #412: an alert may not claim more than its
 * signal). The findings it named may well still be real; they are simply no longer owned by a
 * configured entity, and a human re-adds the entity if they still matter.
 *
 * Decision logic only — zero I/O, mirroring the reconcile/caller split used throughout this
 * repo's monitors (gateway-token-reconcile.ts, railway-volume-reconcile.ts,
 * credential-reconcile.ts).
 */

import { parseSeverityTitle } from "./severity-issue-reconcile.js";

export interface BacklogSweepIssue {
  number: number;
  title: string;
  state: string;
  /** Issue body — only consulted by the body-marker sweep (compliance); optional for title sweeps. */
  body?: string;
}

export interface BacklogSweepAction {
  number: number;
  title: string;
  entity: string;
}

export interface BacklogSweepOutcome {
  actions: BacklogSweepAction[];
}

/**
 * Title-shape sweep, for backlog-staleness's per-manager aggregates.
 *
 * The staleness title is `[backlog-staleness] <manager> — <N> findings`, which
 * `parseSeverityTitle(label, …)` already splits on the LAST " — " (so a manager name is taken
 * verbatim and the `N findings` tail becomes `status`, which this sweep ignores — membership is
 * decided on the ENTITY alone, never on the finding count).
 *
 * Global guard FIRST (mirrors the `manifestNames.size === 0` guard it ports): an empty
 * `configuredEntities` no-ops the WHOLE sweep. Both callers already refuse to proceed on an
 * empty/unreadable config, but this pure function must not TRUST its caller — an empty set
 * reaching here on some future path would classify EVERY open issue as an orphan and close all
 * of them in one run, exactly the close-all the mirrored guard exists to prevent.
 *
 * Per issue:
 *   - `state !== "OPEN"` → skip (a closed issue has no orphan state left to resolve).
 *   - Title doesn't parse under `parseSeverityTitle(label, …)` → skip, silently. Covers a
 *     human-filed issue under the label (no ` — <status>` suffix) and a title carrying a
 *     DIFFERENT label (the parse requires an exact `[<label>] ` prefix, so a foreign-label
 *     title never reaches the entity check). This sweep only acts on titles its own worker built.
 *   - Parsed entity IN `configuredEntities` → skip; the main reconcile loop owns it. This is
 *     where disjointness comes from: an entity still in config is still evaluated every run
 *     (even at zero findings, which is the main loop's own close path), so the two never race.
 *   - Parsed entity NOT in `configuredEntities` → sweep action (the orphan).
 *
 * Exact-match `Set.has` membership only (Rule #315's spirit) — no prefix/fuzzy logic: an issue
 * entity that is merely a string-prefix of a still-configured name is NOT rescued by that
 * resemblance. Its own name left the set; it is gone.
 */
export function sweepOrphanedTitleIssues(
  issues: BacklogSweepIssue[],
  configuredEntities: Set<string>,
  label: string,
): BacklogSweepOutcome {
  if (configuredEntities.size === 0) {
    return { actions: [] };
  }

  const actions: BacklogSweepAction[] = [];
  for (const issue of issues) {
    if (issue.state !== "OPEN") continue;
    const parsed = parseSeverityTitle(label, issue.title);
    if (!parsed) continue; // unparseable (human-filed, or a foreign label) — keep, silently.
    if (configuredEntities.has(parsed.entity)) continue; // still configured — the main loop owns it.
    actions.push({ number: issue.number, title: issue.title, entity: parsed.entity });
  }
  return { actions };
}

/**
 * Body-marker sweep, for backlog-compliance's per-lane issues.
 *
 * Compliance deliberately identifies its issues by a BODY marker, not by title (its own header:
 * "identified by `laneMarker(name)`… never by title — title is cosmetic here"), because a lane
 * name can contain the separator characters a title parse would choke on. So this sweep takes a
 * `markerFor(entity)` builder plus the entity set, and matches the same way the worker does:
 * `body.startsWith(markerFor(entity))`.
 *
 * An issue matching NO configured entity's marker is the orphan — with one critical exclusion:
 * an issue whose body matches `excludeMarker` (compliance's ROLLUP_MARKER) is skipped, because
 * the rollup is not a per-entity issue at all and has its own deliberate cutover-close path.
 * Without that exclusion this sweep would close the rollup as an orphan on every pre-cutover run.
 *
 * Same global empty-set guard and same OPEN-only / silent-skip discipline as the title sweep.
 * Issues with no body (`undefined`) are skipped — a body-marker sweep cannot classify an issue
 * whose body it cannot see, and a blind instrument never acts (Rules #322/#465).
 */
export function sweepOrphanedMarkerIssues(
  issues: BacklogSweepIssue[],
  configuredEntities: Set<string>,
  markerFor: (entity: string) => string,
  excludeMarker?: string,
): BacklogSweepOutcome {
  if (configuredEntities.size === 0) {
    return { actions: [] };
  }

  const markers = [...configuredEntities].map((e) => ({ entity: e, marker: markerFor(e) }));

  const actions: BacklogSweepAction[] = [];
  for (const issue of issues) {
    if (issue.state !== "OPEN") continue;
    if (issue.body === undefined) continue; // cannot classify without a body — never act blind.
    if (excludeMarker !== undefined && issue.body.startsWith(excludeMarker)) continue; // the rollup, not a lane.
    if (markers.some((m) => issue.body!.startsWith(m.marker))) continue; // still configured.
    actions.push({ number: issue.number, title: issue.title, entity: issue.title });
  }
  return { actions };
}

/**
 * The close comment, shared by both sweeps. Says "no longer monitored", never "resolved" —
 * this sweep never re-verified the entity's backlog state (Rule #412).
 */
export function orphanCloseComment(entity: string, configFile: string): string {
  return [
    `\`${entity}\` is no longer present in \`${configFile}\` — no longer monitored.`,
    ``,
    `This says nothing about whether the findings above were actually resolved (they were NOT re-verified):`,
    `the entity simply left the configured set, so no future run can reach this issue to update or close it.`,
    `If this work still matters, re-add the entity to the config and a fresh issue opens on the next run.`,
    ``,
    `Auto-closed by the backlog orphan sweep (studio-b#112 leg: detector closers).`,
  ].join("\n");
}
