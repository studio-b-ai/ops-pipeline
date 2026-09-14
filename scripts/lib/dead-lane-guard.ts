/**
 * dead-lane-guard.ts — stint #243 (Guard 1 of the HERFAB post-mortem 9/13).
 *
 * Pure decision logic: refuse any `lane:<seat>` label whose seat does not have a
 * live slot in the roster, and re-label it to the OWNING TEAM's race engineer
 * (`lane:race-engineer-sb` for studio-b, `lane:race-engineer-ae` for asthetik).
 *
 * Ground truth for "live slot": the roster-lock's own supersession. The garage
 * doc (library/architecture/2026-09-12-the-garage-two-bays-one-crew.md, Kevin
 * RULED 2026-09-12 ~7:4xpm) explicitly SUPERSEDES the roster-lock's "Engineer,
 * Controller as seats" framing: "`race-engineer-sb` · `race-engineer-ae` born;
 * `engineer` · `controller` retire." `shifts.yaml` (the runner's live file) has
 * NOT yet been swept to remove `engineer`/`controller` — that is a separate,
 * already-flagged follow-up (Mechanic stint prior lap, D20260913T235720Z), not
 * a reason to withhold this guard. Per Rule #333 (a decision Kevin has stated
 * is LOCKED — proceed on it), the later RULED doc is the ground truth this
 * guard encodes.
 *
 * Zero I/O — caller resolves the live-seat set and the label list; this file
 * only decides. Mirrors every other reconcile lib in this repo.
 */

/** Seats considered to have a live slot as of the 2026-09-12 garage ruling.
 * `engineer` and `controller` are deliberately ABSENT — they retired as seats;
 * their bays' clipboards are owned by the team's race engineer now. Keep this
 * in lock-step with `~/.lightsout/shift-runner/shifts.yaml` `seats:` keys
 * (Rule #235: a fact change gets grepped and fixed everywhere in-scope) —
 * this constant is the SOURCE the sweep script diffs the live file against,
 * not a mirror of whatever the file currently says. */
export const LIVE_SLOT_SEATS: readonly string[] = [
  "team-principal",
  "race-engineer-sb",
  "race-engineer-ae",
  "mechanic",
  "financial-sb",
  "commercial",
  "crew-chief-sb",
  "scout",
] as const;

const LIVE_SLOT_SEATS_SET: ReadonlySet<string> = new Set(LIVE_SLOT_SEATS);

/** Known-dead seats (retired-but-still-labeled lane owners) — documentation/
 * audit list only. resolveDeadLaneRelabel does NOT gate on this constant:
 * it refuses ANY `lane:<seat>` absent from LIVE_SLOT_SEATS, treating a
 * genuinely new/typo'd seat name identically to a known-dead one. */
export const KNOWN_DEAD_SEATS: readonly string[] = ["engineer", "controller"] as const;

export const LANE_LABEL_PREFIX = "lane:";

/** Repo → owning team, for resolving which race engineer inherits a dead lane.
 * Covers all repos listed in `~/Documents/brain/kits/{studio-b,asthetik}.yaml`
 * `repos:` with their matching team, plus two repos not yet in either kit file
 * — `studio-b-ai/claude-hooks` (studio-b) and `studio-b-ai/studiob` (asthetik)
 * — kept here because dead-lane issues can land on them today. */
export const REPO_TEAM: Readonly<Record<string, "studio-b" | "asthetik">> = {
  "studio-b-ai/ops-pipeline": "studio-b",
  "studio-b-ai/claude-config-plane": "studio-b",
  "studio-b-ai/claude-hooks": "studio-b",
  "studio-b-ai/brain": "studio-b",
  "studio-b-ai/toto": "studio-b",
  "studio-b-ai/lightsout": "studio-b",
  "studio-b-ai/radio": "studio-b",
  "studio-b-ai/client-asthetik": "asthetik",
  "studio-b-ai/bolt-wms": "asthetik",
  "studio-b-ai/studiob": "asthetik",
  "studio-b-ai/studiob-price-sync": "asthetik",
  "studio-b-ai/asthetik-trade-theme": "asthetik",
  "studio-b-ai/asthetik-portal": "asthetik",
};

const TEAM_RACE_ENGINEER: Record<"studio-b" | "asthetik", string> = {
  "studio-b": "race-engineer-sb",
  asthetik: "race-engineer-ae",
};

export function raceEngineerForRepo(repoFullName: string): string | null {
  const team = REPO_TEAM[repoFullName];
  return team ? TEAM_RACE_ENGINEER[team] : null;
}

export interface LaneRelabel {
  /** The dead `lane:<seat>` label to remove. */
  from: string;
  /** The `lane:<race-engineer>` label to add. */
  to: string;
}

/**
 * Given an issue's current labels and its repo, decide whether any `lane:<seat>`
 * label names a seat without a live slot. Returns the relabel to apply, or null
 * if every `lane:<seat>` label already names a live seat (or the repo's team
 * cannot be resolved — fail-visible, never fail-closed: an unknown repo is a
 * no-op here, not a guess).
 *
 * Known-bad control (the stint's own acceptance example): `lane:engineer` on a
 * client-asthetik issue → refused, relabeled to `lane:race-engineer-ae`.
 * Known-good control: `lane:race-engineer-ae` (already the team RE) → no-op.
 */
export function resolveDeadLaneRelabel(repoFullName: string, labels: readonly string[]): LaneRelabel | null {
  const re = raceEngineerForRepo(repoFullName);
  if (!re) return null;

  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    if (!raw.startsWith(LANE_LABEL_PREFIX)) continue;
    const seat = raw.slice(LANE_LABEL_PREFIX.length).trim().toLowerCase();
    if (seat === "") continue;
    if (LIVE_SLOT_SEATS_SET.has(seat)) continue; // live seat — leave it alone
    // Dead: absent from the live seat set.
    const to = `${LANE_LABEL_PREFIX}${re}`;
    if (raw === to) continue; // already the team RE — no-op
    return { from: raw, to };
  }
  return null;
}
