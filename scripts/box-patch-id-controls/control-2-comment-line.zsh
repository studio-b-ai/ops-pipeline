#!/usr/bin/env zsh
# control-2-comment-line.zsh — plant/push/observe/harvest for control 2 (box-patch-id rollout step 4)
#
# Ruling shape: "one changed comment line pushed to a keyed head" → required verdict `stripped`,
# naming the changed path. Expected disposition: CLOSED UNMERGED.
#
# This is the FIRST known-bad (Rule #464) and, paired with control 4's known-good, the pair that
# proves the instrument in both directions (Rule #322) — see the step-4 section of
# docs/plans/2026-09-19-box-patch-id-observe-only-build.md.
set -euo pipefail
local_dir="${0:A:h}"
SCRIPT_NAME="${0:t}"
source "$local_dir/_kit.zsh"

BRANCH="tp/807-control-2-comment-line"
CONTROL=2
MARKER_STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MARKER_LINE="<!-- control-2 marker: ${MARKER_STAMP} -->"

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
    print -r -- "would append \"${MARKER_LINE}\" to the ## Plant lines region (top) of $PLANTS_DOC"
    kit_write_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" '^## Plant lines' "$MARKER_LINE"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 2 plant: add the control-2 marker comment line"
    kit_assert_single_file_diff "$SCRATCH/$BRANCH" "$BRANCH"
    run_cmd git -C "$SCRATCH/$BRANCH" push -u origin "$BRANCH"
    kit_open_pr "$BRANCH" "$CONTROL" stripped \
      "one HTML-comment marker line, keyed to the head that will be boxed" \
      close-unmerged
    ;;

  push)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "push needs a PR number"; exit 2 }
    pr="${rest[1]}"
    kit_assert_single_shot "$pr" "${rest[2]:-DRY-RUN-PLACEHOLDER}"
    new_marker_line="<!-- control-2 marker: $(date -u +%Y-%m-%dT%H:%M:%SZ) (changed after the box) -->"
    print -r -- "would rewrite ONLY the control-2 marker comment's text (same line, new stamp/body) — nothing else in $PLANTS_DOC"
    kit_replace_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" '<!-- control-2 marker:' "$new_marker_line"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 2 push: change the marker comment's text, after the box"
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
