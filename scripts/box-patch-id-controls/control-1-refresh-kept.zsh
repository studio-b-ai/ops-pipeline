#!/usr/bin/env zsh
# control-1-refresh-kept.zsh — plant/push/observe/harvest for control 1 (box-patch-id rollout step 4)
#
# Ruling shape: "a live ops-pipeline pull request behind its base, refreshed by a lap" →
# required verdict `kept`, merge pinned to the new head. Expected disposition: MERGE.
#
# AMENDMENT APPLIED (this build, 2026-09-20): the production refresh trigger is
# `mergeStateStatus === "DIRTY" && labels.includes("fleet-internal")` (pr-automerge-gate.ts L545),
# NOT merely `behind_by > 0`. A seat-driven `update-branch` proves only the recipe, never the lap.
# This script therefore:
#   - plants control 1 as a `fleet-internal`-labelled PR, genuinely made DIRTY against main;
#   - NEVER pushes an update-branch itself (`push` asserts DIRTY and stops — no seat refresh);
#   - harvests the receipt only from the SWEEP run that performed the update-branch, never from a
#     seat dispatch of `mode=refresh`.
# If the PR cannot be staged genuinely DIRTY (main hasn't moved under it) or no sweep run id is
# available yet, `harvest` prints the fidelity caveat `partial — recipe only, lap refresh
# unexercised` instead of a verdict — step 5's Rule #471 known-good stays unproven until this
# resolves for real.
set -euo pipefail
local_dir="${0:A:h}"
SCRIPT_NAME="${0:t}"
source "$local_dir/_kit.zsh"

BRANCH="tp/807-control-1-refresh-kept"
CONTROL=1
FLEET_INTERNAL_LABEL="fleet-internal"

usage() {
  # zsh resets $0 to the function's own name inside a function (FUNCTION_ARGZERO) — use the
  # top-level-captured $SCRIPT_NAME instead, or every usage line prints "usage: usage ...".
  print -ru2 -- "usage: $SCRIPT_NAME <plant|push|observe|harvest> [--dry-run] [pr-number] [run-id]"
  exit 2
}

[[ $# -ge 1 ]] || usage
cmd="$1"; shift
for a in "$@"; do [[ "$a" == "--dry-run" ]] && DRY_RUN=1; done
rest=(${(@)@:#--dry-run})

case "$cmd" in
  plant)
    kit_cut "$BRANCH"
    stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    plant_line="- control 1 · ${stamp} · expects kept (fleet-internal DIRTY refresh)"
    print -r -- "would append \"${plant_line}\" to the ## Plant lines region (top) of $PLANTS_DOC"
    kit_write_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" '^## Plant lines' "$plant_line"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 1 plant: expects kept on a fleet-internal DIRTY refresh"
    kit_assert_single_file_diff "$SCRATCH/$BRANCH" "$BRANCH"
    run_cmd git -C "$SCRATCH/$BRANCH" push -u origin "$BRANCH"
    kit_open_pr "$BRANCH" "$CONTROL" kept \
      "a live PR behind its base, made genuinely DIRTY, labelled fleet-internal, refreshed by the lap" \
      merge
    kit_log "label the opened PR fleet-internal by hand (or via the standard fleet-internal labelling route) — this kit does not add non-creation labels"
    ;;

  push)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "push needs a PR number"; exit 2 }
    pr="${rest[1]}"
    # NOTE: "status" is a read-only special parameter in zsh (an alias for $?) — a distinct
    # outvar name is required or run_cmd_capture's typeset -g dies.
    run_cmd_capture merge_state gh pr view "$pr" --repo "$REPO" --json mergeStateStatus --jq .mergeStateStatus
    if [[ "$DRY_RUN" != "1" && "$merge_state" != "DIRTY" ]]; then
      kit_die "PR $pr is mergeStateStatus=$merge_state, not DIRTY — land a benign change on main first so this control is genuinely behind, then retry"
    fi
    print -r -- "no seat push here by design (amendment applied) — this control waits on the SWEEP's own update-branch, never a seat-driven refresh"
    ;;

  observe)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "observe needs a PR number"; exit 2 }
    kit_observe "${rest[1]}" "$CONTROL" observe
    ;;

  harvest)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "harvest needs a PR number, and a sweep run-id if one exists"; exit 2 }
    pr="${rest[1]}"; run_id="${rest[2]:-}"
    if [[ -z "$run_id" ]]; then
      print -r -- "partial — recipe only, lap refresh unexercised"
      exit 0
    fi
    "$local_dir/harvest-receipt.zsh" "$CONTROL" "$run_id" $([[ "$DRY_RUN" == "1" ]] && print -- --dry-run)
    ;;

  *) usage ;;
esac
