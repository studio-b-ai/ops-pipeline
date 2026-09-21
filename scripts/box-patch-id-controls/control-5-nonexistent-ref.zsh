#!/usr/bin/env zsh
# control-5-nonexistent-ref.zsh — plant/push/observe/harvest for control 5 (box-patch-id rollout
# step 4)
#
# Ruling shape: "the diff pointed at a nonexistent ref" → required verdict
# `box-patch-id-uncomputable`. Expected disposition: CLOSED UNMERGED. Seat-alone, no Kevin key —
# this probe PR is never boxed.
#
# AMENDMENT APPLIED (this build, 2026-09-20): the plan-as-written fires the OBSERVE path
# (`observeBoxPatchId`), whose own predicate order returns `box-patch-id-missing` first when no
# recorded check run exists — and this probe is never boxed, so no `box-patch-id` check run is ever
# recorded. That yields the wrong verdict word. The fix fires the MINT path instead:
#   - `push` computes an absent-but-well-formed 40-hex sha via `git hash-object --stdin` on a
#     throwaway string (a blob oid, so `merge-base origin/main $SHA` dies — a fine seat-only plant);
#   - `observe`/`harvest` dispatch `box-patch-id-observe.yml` with `mode=mint-dry` (NOT plain
#     `observe`) and `head_sha_override=$SHA` — a mode this kit's sibling unit (plan section E,
#     `scripts/box-patch-id-observe.ts`, out of this PR's scope) must implement: call
#     `mintBoxPatchId` directly with the override as `headSha`, post the `box-patch-id-observe`
#     check run on the PR's REAL `headRefOid` (GitHub rejects a head_sha that doesn't exist), and
#     surface `verdict.reason` from the refusal branch verbatim as the printed word.
#   - DEPENDENCY: until the sibling unit ships `mode=mint-dry`, firing this control for real fails
#     closed (unknown mode) rather than silently falling back to plain `observe`. This script only
#     ever emits the `mint-dry` dispatch — it does not implement a local fallback.
#   - FIDELITY CAVEAT (must ride every receipt cell for this control): it fires through this
#     dispatch, never through a `box` LabeledEvent, because the probe PR is deliberately never
#     boxed.
set -euo pipefail
local_dir="${0:A:h}"
SCRIPT_NAME="${0:t}"
source "$local_dir/_kit.zsh"

BRANCH="tp/807-control-5-nonexistent-ref"
CONTROL=5

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
    plant_line="- control 5 probe · $(date -u +%Y-%m-%dT%H:%M:%SZ) · benign, never boxed"
    print -r -- "would append \"${plant_line}\" to $PLANTS_DOC (this PR is never boxed)"
    kit_write_line "$SCRATCH/$BRANCH" "$PLANTS_DOC" '^## Plant lines' "$plant_line"
    run_cmd git -C "$SCRATCH/$BRANCH" add "$PLANTS_DOC"
    run_cmd git -C "$SCRATCH/$BRANCH" commit -m "control 5 plant: benign one-line probe, never boxed"
    kit_assert_single_file_diff "$SCRATCH/$BRANCH" "$BRANCH"
    run_cmd git -C "$SCRATCH/$BRANCH" push -u origin "$BRANCH"
    kit_open_pr "$BRANCH" "$CONTROL" box-patch-id-uncomputable \
      "a benign one-line probe PR, never boxed — the mint is exercised via dispatch, not a LabeledEvent" \
      close-unmerged
    ;;

  push)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "push needs the probe PR number"; exit 2 }
    pr="${rest[1]}"
    if [[ "$DRY_RUN" == "1" ]]; then
      print -r -- "DRY-RUN would run: printf 'control-5 <utc-epoch>' | git -C $REPO_DIR hash-object --stdin"
      sha="DRY-RUN-PLACEHOLDER-SHA"
    else
      sha=$(printf 'control-5 %s' "$(date -u +%s)" | git -C "$REPO_DIR" hash-object --stdin)
      kit_log "computed absent-but-well-formed blob oid: $sha (merge-base against it will die — that is the point)"
    fi
    override_file="$SCRATCH/${BRANCH}.override-sha"
    mkdir -p "${override_file:h}"
    print -r -- "$sha" > "$override_file"
    print -r -- "override sha for control 5 (PR $pr): $sha (written to $override_file)"
    ;;

  observe)
    [[ ${#rest} -ge 1 ]] || { print -ru2 -- "observe needs the probe PR number"; exit 2 }
    pr="${rest[1]}"
    sha="${rest[2]:-}"
    if [[ -z "$sha" && -f "$SCRATCH/${BRANCH}.override-sha" ]]; then
      sha=$(<"$SCRATCH/${BRANCH}.override-sha")
    fi
    [[ -n "$sha" ]] || kit_die "no override sha given and none found at $SCRATCH/${BRANCH}.override-sha — run push first"
    kit_observe "$pr" "$CONTROL" mint-dry "$sha"
    ;;

  harvest)
    [[ ${#rest} -ge 2 ]] || { print -ru2 -- "harvest needs the probe PR number and a run-id"; exit 2 }
    kit_log "fidelity caveat: control 5 fires through the mint-dry dispatch, not a box LabeledEvent — carry this line into the receipt cell"
    "$local_dir/harvest-receipt.zsh" "$CONTROL" "${rest[2]}" $([[ "$DRY_RUN" == "1" ]] && print -- --dry-run)
    ;;

  *) usage ;;
esac
