/**
 * squasher-fleet-not-the-door.ts — ops#294 (Mechanic item 2, 2026-09-04).
 *
 * Pure decision/format core for the fleet sweep's per-repo enumeration receipt
 * line, mirroring label-authority.ts's pure-core/I/O-glue split: this file has
 * no imports and is fully unit tested; the caller — the bash "List target
 * (repo, PR, mode) entries" step in .github/workflows/squasher-fleet-sweep.yml
 * — is thin I/O glue (one targeted `gh pr view` label check) that is not
 * independently unit tested, matching that same repo convention.
 *
 * The defect (issue body, item 2): a `pr_number`-scoped "evaluate NOW" dispatch
 * against a PR that carries `queued` in a repo whose fleet-registry entry has
 * `train: false` printed the SAME blind `queued(train)=0` receipt line as a PR
 * carrying no label at all — a #464/#465-class blind-green. That repo's
 * `queued` door is the restart train (heritage-restart-train.yml), not this
 * sweep; three wrong claims got made off that line on 2026-09-04 before the
 * merger's own receipt comment on studiob#655 settled the actual mechanism
 * (see the issue's later comments — studiob#655 was squash-merged by the
 * restart train, rung 3, not this sweep). This is a message-clarity fix only:
 * the exit code stays 0 either way, and every other dispatch shape (the
 * scheduled whole-fleet cron, any train:true repo, a pr_number without
 * `queued`) prints the exact pre-existing line, unchanged.
 */

export interface FleetSweepReceiptInput {
  /** e.g. "studio-b-ai/studiob" */
  repo: string;
  /** bugsquasher-labeled open PR count for this repo this cycle */
  bugsquasherCount: number;
  /** queued-labeled open PR count for this repo this cycle (always 0 when !train) */
  trainCount: number;
  /** this repo's squasher-fleet.json `train` field */
  train: boolean;
  /** the `pr_number` dispatch input, or null on a scheduled/whole-fleet sweep */
  onlyPr: string | null;
  /**
   * Whether `onlyPr` itself carries the `queued` label. Only meaningful — and
   * only ever probed by the caller — when `onlyPr` is set and `train` is
   * false. The scheduled cron and every train:true repo never compute this
   * (train:true repos already answer via `trainCount`), so callers pass
   * `false` there as a safe default.
   */
  onlyPrCarriesQueuedLabel: boolean;
}

/** The restart train's own dispatch affordance, named so the line is directly actionable. */
const RESTART_TRAIN_WORKFLOW = "heritage-restart-train.yml";

/**
 * Formats the one per-repo receipt line this cycle's enumeration prints for
 * `repo`. Returns the "not this sweep's door" line when a pr_number dispatch
 * targets a `queued` PR in a train:false repo; the ordinary bugsquasher/
 * queued(train) count line — byte-identical to the pre-existing `echo` —
 * every other time.
 */
export function formatFleetSweepReceiptLine(input: FleetSweepReceiptInput): string {
  const isEvaluateNowOnATrainFalseQueuedPr =
    input.onlyPr !== null && !input.train && input.onlyPrCarriesQueuedLabel;

  if (isEvaluateNowOnATrainFalseQueuedPr) {
    return (
      `queued PR ${input.repo}#${input.onlyPr} is not this sweep's to merge ` +
      `(fleet registry train:false) — its door is the restart train: dispatch ` +
      `${RESTART_TRAIN_WORKFLOW} (workflow_dispatch, dry_run=false)`
    );
  }

  return `${input.repo}: bugsquasher=${input.bugsquasherCount} queued(train)=${input.trainCount}`;
}
