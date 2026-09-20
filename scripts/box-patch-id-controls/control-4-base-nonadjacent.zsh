#!/usr/bin/env zsh
# control-4-base-nonadjacent.zsh — plant/push/observe/harvest for control 4 (box-patch-id rollout
# step 4)
#
# Ruling shape: "a change landed on the base in a non-adjacent region of the same file" → required
# verdict `kept`, and a merge on the box. This is the SECOND known-good (Rule #471, alongside
# control 1) — paired with control 2's `stripped`, it proves the instrument in both directions
# (Rule #322). Both assignments are stated here explicitly, not left implicit in a receipt table.
#
# AMENDMENTS APPLIED (this build, 2026-09-20):
#   - the base edit lands via the seat labelling the base-edit PR `bugsquasher` — a sanctioned
#     sanctioned squasher-fleet sweep (Rule #279 exception 1), never a hand merge; see `_kit.zsh`'s header;
#   - `push` refuses to land the base edit while ANY sibling probe PR (from this same row 807
#     build) still carries an unharvested box, via `kit_no_unharvested_box_elsewhere`;
#   - the two regions must be >= 40 lines apart AND separated by at least one unmodified `##`
#     section, so their `-U0` hunks can never merge into one.
set -euo pipefail
local_dir="${0:A:h}"
SCRIPT_NAME="${0:t}"
source "$local_dir/_kit.zsh"

BRANCH="tp/807-control-4-base-nonadjacent"
BASE_EDIT_BRANCH="tp/807-control-4-base-edit"
CONTROL=4
MIN_LINE_GAP=40

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
    plant_line="- control 4 probe · $(date -u +%Y-%m-%dT%H:%M:%SZ) · expects kept (base edit lands in a non-adjacent region)"
    print -r -- "would append \"${plant_line}\" to the FIRST (top) region of $PLANTS_DOC"
    kit_write_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" '^## Plant lines' "$plant_line"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 4 plant: add a line to the plants doc's first region"
    kit_assert_single_file_diff "$SCRATCH/$BRANCH" "$BRANCH"
    run_cmd git -C "$SCRATCH/$BRANCH" push -u origin "$BRANCH"
    kit_open_pr "$BRANCH" "$CONTROL" kept \
      "the probe PR — no head push planned; a sibling PR edits a non-adjacent region of the same file" \
      merge
    ;;

  push)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "push needs the probe PR number"; exit 2 }
    probe_pr="${rest[1]}"

    kit_no_unharvested_box_elsewhere "$probe_pr"

    if [[ "$DRY_RUN" == "1" ]]; then
      print -r -- "DRY-RUN would assert the plants-doc regions are >= ${MIN_LINE_GAP} lines apart and separated by an unmodified ## section"
    else
      first_region_line=$(grep -n '^## Plant lines' "$SCRATCH/$BRANCH/$PLANTS_DOC" | head -1 | cut -d: -f1)
      last_region_line=$(grep -n '^## Base-edit region' "$SCRATCH/$BRANCH/$PLANTS_DOC" | head -1 | cut -d: -f1)
      if [[ -z "$first_region_line" || -z "$last_region_line" ]]; then
        kit_die "could not locate both '## Plant lines' and '## Base-edit region' headings in $PLANTS_DOC"
      fi
      gap=$(( last_region_line - first_region_line ))
      if (( gap < MIN_LINE_GAP )); then
        kit_die "regions are only ${gap} lines apart, need >= ${MIN_LINE_GAP}"
      fi
    fi

    kit_log "opening the base-edit PR ($BASE_EDIT_BRANCH), labelled bugsquasher (lands via the squasher-fleet sweep, not a hand merge)"
    kit_cut "$BASE_EDIT_BRANCH"
    base_edit_line="- control 4 base edit · $(date -u +%Y-%m-%dT%H:%M:%SZ) · non-adjacent region"
    print -r -- "would append \"${base_edit_line}\" to the LAST (Base-edit region) section of $PLANTS_DOC"
    kit_write_line "$SCRATCH/$BASE_EDIT_BRANCH" "$PLANTS_DOC" '^## Base-edit region' "$base_edit_line"
    run_cmd git -C "$SCRATCH/$BASE_EDIT_BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BASE_EDIT_BRANCH" commit -m "control 4 push: base edit, non-adjacent region of the plants doc"
    kit_assert_single_file_diff "$SCRATCH/$BASE_EDIT_BRANCH" "$BASE_EDIT_BRANCH"
    run_cmd git -C "$SCRATCH/$BASE_EDIT_BRANCH" push -u origin "$BASE_EDIT_BRANCH"
    run_cmd gh pr create --repo "$REPO" --base main --head "$BASE_EDIT_BRANCH" \
      --title "control 4 base edit: non-adjacent region (box-patch-id rollout step 4)" \
      --body "docs-only change, ops-pipeline#190 rollout step 4 control 4. Labelled bugsquasher — lands via the squasher-fleet sweep, not a hand merge (Rule #279 exception 1)." \
      --label bugsquasher

    base_edit_pr_placeholder="DRY-RUN-PLACEHOLDER"
    run_cmd gh workflow run squasher-fleet-sweep.yml --repo "$REPO" \
      -f "repo=$REPO" -f "pr_number=$base_edit_pr_placeholder"
    kit_log "the base-edit PR lands via the squasher-fleet sweep, never a hand merge"

    kit_observe "$probe_pr" "$CONTROL" observe
    ;;

  observe)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "observe needs the probe PR number"; exit 2 }
    kit_observe "${rest[1]}" "$CONTROL" observe
    ;;

  harvest)
    [[ ${#rest} -ge 2 ]] || { print -ru2 -- "harvest needs the probe PR number and a run-id"; exit 2 }
    "$local_dir/harvest-receipt.zsh" "$CONTROL" "${rest[2]}" $([[ "$DRY_RUN" == "1" ]] && print -- --dry-run)
    ;;

  *) usage ;;
esac
