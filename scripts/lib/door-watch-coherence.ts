/**
 * door-watch-coherence.ts — pure guard for the RELEASE-door ↔ backlog-watch coherence
 * invariant (studio-b#112 leg 1, Mechanic crew stint 2026-09-13).
 *
 * WHY THIS EXISTS — the live defect it was born from, not a hypothetical. studio-b#112's
 * leg 1 flipped the RELEASE (`queued`) leg ON for five repos via ops-pipeline#405 (merged
 * 2026-09-13T00:49:46Z, mergeCommit 22e90c8), widening `scripts/squasher-fleet.json`'s
 * `train: true` set to include claude-config-plane, brain, radio, lightsout,
 * client-asthetik (+toto, added by #411). That flip gave those repos a MERGE door. It did
 * not give them a WATCH: `scripts/backlog-managers.yaml` — the registry
 * `backlog-staleness-worker.ts` reads to decide which repos' backlogs get the rule-17(d)
 * stall check — was never widened alongside it.
 *
 * Measured at authoring time (2026-09-13T13:0xZ, `gh pr list` / `gh issue list` against
 * each repo, the two registries read from the DEPLOYED ref per Rule #466 via
 * `git show origin/main:<path>`): FOUR repos carried `train: true` with no watch row —
 * claude-config-plane (9 open PRs incl. 1 DIRTY, 17 open issues), radio (8 open PRs incl.
 * 3 BLOCKED / 1 DIRTY / 2 UNSTABLE, 30 open issues), lightsout (1 open PR, 6 open
 * issues), toto (1 open PR, 0 open issues). 53 open issues in total sat in repos that the
 * daily 12:00Z staleness instrument structurally could not see, because an unmapped repo
 * "simply isn't scanned" (backlog-managers.yaml's own header — there is no
 * "unmapped repo" finding class in that leg, by design).
 *
 * THE ASYMMETRY IS THE BUG: opening a merge door widens what can LAND autonomously in a
 * repo, while the watch is what notices when that repo's backlog stalls. Flipping the
 * first without the second is exactly Rule #366's failure shape read backwards — a system
 * gained a leg and its sibling legs were not brought along. Rule #159 says every "NEVER do
 * X" becomes a code guard rather than a doc line, so the fix is not only the four config
 * rows (shipped in the same PR): it is THIS function, which fails the next time the two
 * registries drift apart. Rule #381 is why the guard and the rows ship together — widening
 * a registry is a CODE change, and a guard added without reconciling the existing
 * population would pass on day one while the four already-drifted repos stayed invisible.
 *
 * LAW — **flags-only, and PURE**. Nothing here edits either registry, opens a door,
 * enrolls a repo, or touches a PR; it returns findings that a human (or a follow-up PR)
 * acts on, in the same family as `required-checks-drift-classify.ts`,
 * `repo-hygiene-lib.ts` and `dead-cron-classify.ts`. Both inputs are ALREADY-PARSED
 * registry contents handed in by the caller — no `fs`, no network, no `new Date()` (this
 * leg needs no clock), so every case below is a single-function unit test with zero `gh`
 * mocking, matching this repo's existing test convention (no test in this suite mocks
 * `gh`/network at all).
 *
 * DIRECTION IS DELIBERATE (Rule #322 — the guard must be able to see both verdicts, but
 * only ONE direction is a defect): a `train: true` repo with no watch row is a finding; a
 * WATCHED repo absent from the door registry is NOT. The second is legitimate and live —
 * `asthetik-marketing` and `clients` are watched today and carry no door row at all, which
 * is simply a repo whose backlog a seat owns without the fleet sweep having a merge leg
 * there. Reporting those would make the guard fire on clean input, and "a detector that
 * fires on clean input is lying about dirty input too" (Rule #425, learned from the
 * `workflow_unparseable` tell that falsified 5/5 on its first firing). `train: false` door
 * rows are likewise not findings — no autonomous merge leg is open there.
 */

/** One row of `squasher-fleet.json`'s door registry, reduced to what this guard reads. */
export interface DoorRegistryRow {
  repo: string;
  /**
   * `squasher-fleet.json`'s `train` field — `true` = the RELEASE (`queued`) leg is live for
   * this repo, i.e. the fleet sweep enumerates its `queued` PRs and can merge them
   * autonomously. Absent/undefined is treated as `false` (the registry's own fallback
   * semantics: absent optional fields fall back to the gate's defaults).
   */
  train?: boolean;
}

export interface DoorWatchCoherenceFinding {
  class: "door_watch_incoherent";
  repo: string;
  /** The seat this repo's technical lane routes to, when the caller could resolve one; `null` when unknown. */
  suggestedManager: string | null;
  detail: string;
}

export interface DoorWatchCoherenceInput {
  /** Parsed `squasher-fleet.json` rows (the door registry). */
  doorRows: DoorRegistryRow[];
  /** `backlog-managers.yaml`'s `repos:` list, reduced to the repo full names it maps. */
  watchedRepos: string[];
  /**
   * Optional repo → seat map used ONLY to populate `suggestedManager` in the finding text,
   * so the human reading it does not have to guess an owner. A repo absent from this map
   * yields `suggestedManager: null` and a finding that says so explicitly rather than
   * inventing one — Rule #294: a named owner that nobody confirmed must never become
   * load-bearing, so the guard names the gap instead of filling it.
   */
  laneManagers?: Readonly<Record<string, string>>;
}

/**
 * Repos the invariant deliberately EXEMPTS, with the reason each is sanctioned. Keyed by
 * repo full name so an exemption is a reviewable one-line diff, never a silent predicate
 * widening (Rule #459's allowlist discipline applied to a detector rather than a merge).
 * Empty today: at authoring time all four drifted repos were FIXED by widening the watch
 * registry in the same PR, not exempted — an exemption here is for a repo that genuinely
 * should carry a door with no backlog watch, which no repo currently does.
 */
export const DOOR_WATCH_EXEMPT: Readonly<Record<string, string>> = {};

/**
 * Returns one finding per repo whose RELEASE leg is open (`train: true`) but which no
 * backlog-watch row covers. Deterministic ordering (repo name ascending) so an
 * already-open aggregate issue's body does not churn on a no-op re-run — the same
 * iteration-order discipline `backlog-staleness-lib.ts` documents.
 *
 * Duplicate door rows for one repo collapse (a repo is either behind the door or not);
 * `watchedRepos` is compared as an exact full-name set — no prefix/substring matching,
 * which would let `studio-b-ai/radio` be silently "covered" by a row for a differently
 * named sibling (Rule #282's exact-key discipline).
 */
export function findDoorWatchIncoherence(input: DoorWatchCoherenceInput): DoorWatchCoherenceFinding[] {
  const watched = new Set(input.watchedRepos);
  const managers = input.laneManagers ?? {};

  const behindTheDoor = new Set<string>();
  for (const row of input.doorRows) {
    if (row.train === true) behindTheDoor.add(row.repo);
  }

  const findings: DoorWatchCoherenceFinding[] = [];
  for (const repo of [...behindTheDoor].sort()) {
    if (watched.has(repo)) continue;
    if (repo in DOOR_WATCH_EXEMPT) continue;

    const suggestedManager = managers[repo] ?? null;
    const ownerClause =
      suggestedManager === null
        ? "No lane-manager mapping resolves for this repo, so the watch row's `manager:` must be set by a human who knows the owner — do NOT guess one (Rule #294)."
        : `Its technical lane routes to \`${suggestedManager}\`, which is the \`manager:\` value the watch row should carry unless a human says otherwise.`;

    findings.push({
      class: "door_watch_incoherent",
      repo,
      suggestedManager,
      detail:
        `\`${repo}\` carries \`train: true\` in \`scripts/squasher-fleet.json\` — its RELEASE (\`queued\`) leg is OPEN, so the fleet sweep can merge PRs there autonomously — but it has no row in \`scripts/backlog-managers.yaml\`, so \`backlog-staleness-worker.ts\` never scans its backlog ("an unmapped repo simply isn't scanned" — that file's own header). ` +
        `A repo with a merge door and no backlog watch can accumulate stalled issues and rotting PRs entirely unobserved. ${ownerClause} ` +
        `Resolve by adding a \`- repo: "${repo}"\` row (with a \`manager:\`) to \`backlog-managers.yaml\`, or — if this repo genuinely should have a door without a watch — by adding it to \`DOOR_WATCH_EXEMPT\` in \`scripts/lib/door-watch-coherence.ts\` with the reason.`,
    });
  }
  return findings;
}

/** One-line run summary for the worker's stdout receipt. */
export function summarizeDoorWatchCoherence(findings: DoorWatchCoherenceFinding[]): string {
  if (findings.length === 0) return "door/watch coherence: OK — every train:true repo carries a backlog-watch row";
  return `door/watch coherence: ${findings.length} repo(s) with an open RELEASE leg and no backlog watch: ${findings.map((f) => f.repo).join(", ")}`;
}
