#!/usr/bin/env zsh
# control-3-whitespace.zsh — plant/push/observe/harvest for control 3 (box-patch-id rollout step 4)
#
# Ruling shape: "one added line re-indented, whitespace only" → required verdict `stripped`.
# Expected disposition: CLOSED UNMERGED. This is the THIRD known-bad (Rule #464) this kit plants
# (amendment applied: the assignment is stated here explicitly, never left implicit in a receipt
# table) — see the step-4 section of docs/plans/2026-09-19-box-patch-id-observe-only-build.md.
#
# The recipe tolerates context and line-number drift; it must never tolerate the changed line's
# own bytes. Re-indenting 2 spaces -> 4 spaces changes the `-U0` diff text even though the line's
# trimmed content is identical.
set -euo pipefail
local_dir="${0:A:h}"
SCRIPT_NAME="${0:t}"
source "$local_dir/_kit.zsh"

BRANCH="tp/807-control-3-whitespace"
CONTROL=3
# Fixed (non-timestamped) marker text: plant and push run as separate script invocations, and push
# must be able to find the exact bullet plant wrote without either process sharing state.
BULLET_TEXT="control 3 whitespace probe bullet"

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
    plant_line="  - ${BULLET_TEXT}"
    print -r -- "would append a two-space-indented bullet to the ## Plant lines region (top) of $PLANTS_DOC"
    kit_write_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" '^## Plant lines' "$plant_line"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 3 plant: add a two-space-indented bullet"
    kit_assert_single_file_diff "$SCRATCH/$BRANCH" "$BRANCH"
    run_cmd git -C "$SCRATCH/$BRANCH" push -u origin "$BRANCH"
    kit_open_pr "$BRANCH" "$CONTROL" stripped \
      "one two-space-indented bullet, keyed to the head that will be boxed" \
      close-unmerged
    ;;

  push)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "push needs a PR number"; exit 2 }
    pr="${rest[1]}"
    kit_assert_single_shot "$pr" "${rest[2]:-DRY-RUN-PLACEHOLDER}"
    reindented_line="    - ${BULLET_TEXT}"
    print -r -- "would re-indent that ONE bullet from two spaces to four — no other byte in $PLANTS_DOC changes"
    kit_replace_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" "${BULLET_TEXT}" "$reindented_line"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 3 push: re-indent the planted bullet 2sp -> 4sp, after the box"
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
