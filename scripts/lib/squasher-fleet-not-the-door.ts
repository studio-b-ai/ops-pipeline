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
 * against a PR that carries the ready label in a repo whose fleet-registry entry has
 * `train: false` printed the SAME blind `queued(train)=0` receipt line as a PR
 * carrying no label at all — a #464/#465-class blind-green. That repo's
 * ready-label door is the restart train (heritage-restart-train.yml), not this
 * sweep; three wrong claims got made off that line on 2026-09-04 before the
 * merger's own receipt comment on studiob#655 settled the actual mechanism
 * (see the issue's later comments — studiob#655 was squash-merged by the
 * restart train, rung 3, not this sweep). This is a message-clarity fix only:
 * the exit code stays 0 either way, and every other dispatch shape (the
 * scheduled whole-fleet cron, any train:true repo, a pr_number without
 * the ready label) prints the exact pre-existing line, unchanged.
 *
 * 2026-09-15 ("Box is the one key"; 05:5xZ no alias): the ready label is `box`, full stop,
 * and it is this sweep's to merge in EVERY repo except the one the restart train owns
 * (studio-b-ai/studiob). The caller's `train` input now means exactly "this sweep owns
 * box here" — true for every repo but studiob, whatever squasher-fleet.json's legacy
 * `train` field says. `queued`/`train:ready` are retired labels, not aliases.
 */

export interface FleetSweepReceiptInput {
  /** e.g. "studio-b-ai/studiob" */
  repo: string;
  /** bugsquasher-labeled open PR count for this repo this cycle */
  bugsquasherCount: number;
  /** `box`-labeled open PR count for this repo this cycle (always 0 when !train — studiob) */
  trainCount: number;
  /** whether this sweep owns `box` in this repo (false only for studio-b-ai/studiob — the restart train's) */
  train: boolean;
  /** the `pr_number` dispatch input, or null on a scheduled/whole-fleet sweep */
  onlyPr: string | null;
  /**
   * Whether `onlyPr` itself carries the ready label (`box`). Only meaningful — and
   * only ever probed by the caller — when `onlyPr` is set and `train` is
   * false. The scheduled cron and every train:true repo never compute this
   * (train:true repos already answer via `trainCount`), so callers pass
   * `false` there as a safe default.
   */
  onlyPrCarriesReadyLabel: boolean;
}

/** The restart train's own dispatch affordance, named so the line is directly actionable. */
const RESTART_TRAIN_WORKFLOW = "heritage-restart-train.yml";

/**
 * Formats the one per-repo receipt line this cycle's enumeration prints for
 * `repo`. Returns the "not this sweep's door" line when a pr_number dispatch
 * targets a ready-labeled PR in a train:false repo; the ordinary bugsquasher/
 * box(train) count line every other time.
 */
export function formatFleetSweepReceiptLine(input: FleetSweepReceiptInput): string {
  const isEvaluateNowOnATrainFalseReadyPr =
    input.onlyPr !== null && !input.train && input.onlyPrCarriesReadyLabel;

  if (isEvaluateNowOnATrainFalseReadyPr) {
    return (
      `box PR ${input.repo}#${input.onlyPr} is not this sweep's to merge ` +
      `(the restart train owns studiob) — its door is the restart train: dispatch ` +
      `${RESTART_TRAIN_WORKFLOW} (workflow_dispatch, dry_run=false)`
    );
  }

  return `${input.repo}: bugsquasher=${input.bugsquasherCount} box=${input.trainCount}`;
}
