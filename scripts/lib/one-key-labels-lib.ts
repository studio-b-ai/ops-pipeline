/**
 * one-key-labels-lib.ts — stint #679 ("The one key must exist wherever a PR can
 * exist"): the pure core of the box/hold label sensor + actuator.
 *
 * WHY THIS EXISTS: GitHub labels are repo-scoped. The 2026-09-15 "Box is the one key"
 * provisioning covered every repo that existed THAT night; surface-canary was born
 * 2026-09-16T22:45Z (stint #461) with only the GitHub default labels, so when
 * surface-canary#1 needed the box path the label did not exist and Kevin hand-merged
 * (2026-09-18T02:56:50Z). The squasher-fleet-sweep's org-wide `label:box` leg reaches
 * unregistered repos — but a search leg cannot see a label the repo never defined.
 * This worker is the durable sensor: weekly tick + on-demand dispatch enumerates
 * every non-archived org repo missing `box` or `hold` and (--post) creates them with
 * the canonical name/colour/description ops-pipeline carries. Kill condition: any
 * active org repo missing box after the tick → exit 1.
 *
 * Canonical specs are read LIVE from studio-b-ai/ops-pipeline's own labels at worker
 * start (the fleet's source of truth for the one-key vocabulary) with these
 * constants as the documented fallback — never the reverse: a fleet-wide rename or
 * re-colour rides the live read, and a constant here can never silently outvote it.
 */

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

/** Documented fallback specs — verified against ops-pipeline live 2026-09-18. */
export const FALLBACK_BOX: LabelSpec = {
  name: "box",
  color: "0033CC",
  description: "Kevin: merge it",
};
export const FALLBACK_HOLD: LabelSpec = {
  name: "hold",
  color: "B60205",
  description: "Parked by Kevin — the gate never merges while present (ops-pipeline#260 leg 4)",
};

export interface RepoLabelState {
  repo: string;
  archived: boolean;
  /** label names present on the repo (case-sensitive, as GitHub returns them) */
  labels: string[];
}

export type RepoVerdict =
  | { kind: "skipped-archived"; repo: string }
  | { kind: "ok"; repo: string }
  | { kind: "missing"; repo: string; missing: string[] };

/**
 * Classify one repo against the required one-key labels. Archived repos are skipped
 * AND REPORTED as skipped (the stint's negative control: the sensor must prove it
 * saw the archived repo and deliberately passed it by — a silent skip is
 * indistinguishable from a blind instrument, Rule #322).
 */
export function classifyRepo(state: RepoLabelState, required: string[] = ["box", "hold"]): RepoVerdict {
  if (state.archived) return { kind: "skipped-archived", repo: state.repo };
  const missing = required.filter((l) => !state.labels.includes(l));
  if (missing.length === 0) return { kind: "ok", repo: state.repo };
  return { kind: "missing", repo: state.repo, missing };
}

/** The kill condition: any active org repo missing any required label after the tick. */
export function killConditionBreached(verdicts: RepoVerdict[]): string[] {
  return verdicts.filter((v): v is Extract<RepoVerdict, { kind: "missing" }> => v.kind === "missing").map((v) => v.repo);
}
