#!/usr/bin/env zsh
# control-6-no-net-diff.zsh — plant/push/observe/harvest for control 6 (box-patch-id rollout step 4)
#
# Ruling shape: "a seat pushes a commit leaving the net diff unchanged" → required verdict
# `stripped`. Expected disposition: CLOSED UNMERGED.
#
# THIS IS THE CONTROL THE REFRESH-SHAS LEG EXISTS FOR (finding 4.0.1 of the step-4 plan): commit B
# adds line Y, commit C removes line Y, both pushed together after the box — the net `-U0` diff
# versus the base is byte-identical, so the patch-id is UNCHANGED, but the new head sha is absent
# from `recorded.refreshShas`. A `kept` verdict here means the refresh-shas leg (label-authority.ts
# / box-patch-id-observe.ts, built by a sibling unit of this same rollout step) was skipped —
# patch-id equality ALONE is not sufficient, per ruling §3.
set -euo pipefail
local_dir="${0:A:h}"
SCRIPT_NAME="${0:t}"
source "$local_dir/_kit.zsh"

BRANCH="tp/807-control-6-no-net-diff"
CONTROL=6
LINE_X="- control 6 line X (planted, never removed)"
LINE_Y="- control 6 line Y (added then removed after the box, net diff unchanged)"

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
    print -r -- "would append line X to the ## Plant lines region (top) of $PLANTS_DOC"
    kit_write_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" '^## Plant lines' "$LINE_X"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 6 plant: add line X"
    kit_assert_single_file_diff "$SCRATCH/$BRANCH" "$BRANCH"
    run_cmd git -C "$SCRATCH/$BRANCH" push -u origin "$BRANCH"
    kit_open_pr "$BRANCH" "$CONTROL" stripped \
      "line X planted; after the box, commit B adds line Y then commit C removes it — net diff unchanged, new head absent from refreshShas" \
      close-unmerged
    ;;

  push)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "push needs a PR number"; exit 2 }
    pr="${rest[1]}"
    kit_assert_single_shot "$pr" "${rest[2]:-DRY-RUN-PLACEHOLDER}"
    print -r -- "would commit B: add line Y to $PLANTS_DOC"
    kit_write_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" '^## Plant lines' "$LINE_Y"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 6 push (1/2): add line Y, after the box"
    print -r -- "would commit C: remove line Y from $PLANTS_DOC (net diff now byte-identical to pre-box)"
    kit_remove_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" "control 6 line Y"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 6 push (2/2): remove line Y — net diff unchanged"
    kit_assert_single_file_diff "$SCRATCH/$BRANCH" "$BRANCH"
    run_cmd git -C "$SCRATCH/$BRANCH" push origin "$BRANCH"
    ;;

  observe)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "observe needs a PR number"; exit 2 }
    kit_observe "${rest[1]}" "$CONTROL" observe
    ;;

  harvest)
    [[ ${#rest} -ge 2 ]] || { print -ru2 -- "harvest needs a PR number and a run-id"; exit 2 }
    "$local_dir/harvest-receipt.zsh" "$CONTROL" "${rest[2]}" $([[ "$DRY_RUN" == "1" ]] && print -- --dry-run)
    ;;

  *) usage ;;
esac
