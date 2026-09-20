#!/usr/bin/env zsh
# _kit.zsh — shared helpers for the box-patch-id control kit (ops-pipeline#190 rollout step 4)
#
# Sourced by every control-N-*.zsh and harvest-receipt.zsh script in this directory. Never invoked
# directly (it has no argv handling of its own).
#
# ── NO-BOX / NO-MERGE GUARD (Rule #97, Rule #279 exception 1) ────────────────────────────────────
# This kit NEVER applies or removes the `box` label and NEVER merges a pull request, by hand or by
# API. Every probe PR this kit opens waits on Kevin's own box (the single human merge key). The one
# sanctioned exception is control 4's base-edit PR: the seat MAY label it `bugsquasher` so it lands
# through the squasher-fleet sweep — a sanctioned automated route, per Rule #279 exception 1, never a hand merge. Every
# `git`/`gh` call in this kit routes through `run_cmd`, which refuses (exit 1) any command carrying
# `--add-label box`, `--remove-label box`, `pr merge`, or a REST `/merge` PUT — see `kit_forbid_check`.
#
# ── DRY-RUN CONTRACT ───────────────────────────────────────────────────────────────────────────
# DRY_RUN defaults to "1": every `run_cmd` call prints the exact command it would run and does not
# execute it. Pass `--dry-run` explicitly (already the default) or set `DRY_RUN=0` in the caller's
# environment to fire for real. This build (ops-pipeline#190 rollout step 4, control-kit PR) tests
# every script ONLY in dry-run mode — the seat fires the probe PRs live in a later sitting.
set -euo pipefail

: ${REPO:="studio-b-ai/ops-pipeline"}
: ${REPO_DIR:="/Users/kevin/dev/studio-b/ops-pipeline"}
: ${DRY_RUN:="1"}
: ${SCRATCH:="${TMPDIR:-/tmp}/box-patch-id-controls"}

# The plants doc this kit's plant/push steps edit. Built by a sibling unit of rollout step 4 (plan
# section H) — this kit only ever names the path, it does not create the file.
PLANTS_DOC="docs/plants/2026-09-21-box-patch-id-control-kit.md"

kit_log() {
  print -ru2 -- "[kit] $*"
}

kit_die() {
  print -ru2 -- "REFUSED: $*"
  exit 1
}

# kit_forbid_check <cmd...> — refuses any command shaped like a box/unbox or a merge.
kit_forbid_check() {
  local cmd="$*"
  case "$cmd" in
    *"--add-label box"*|*"--remove-label box"*)
      kit_die "this kit never applies or removes the box label. cmd: $cmd" ;;
    *"pr merge"*)
      kit_die "this kit never merges a pull request (gh pr merge). cmd: $cmd" ;;
    *"/merge"*"-X PUT"*|*"-X PUT"*"/merge"*)
      kit_die "this kit never merges a pull request (REST /merge PUT). cmd: $cmd" ;;
  esac
}

# run_cmd <cmd...> — the ONLY sanctioned way a control script shells out to git/gh.
# Dry-run (default): prints "DRY-RUN would run: <cmd>" and returns 0, no output captured.
# Live (DRY_RUN=0): logs then executes, returning the command's own exit code and stdout.
run_cmd() {
  kit_forbid_check "$@"
  if [[ "$DRY_RUN" == "1" ]]; then
    print -r -- "DRY-RUN would run: $*"
    return 0
  fi
  kit_log "running: $*"
  "$@"
}

# run_cmd_capture <var-name> <cmd...> — like run_cmd, but for reads whose output the caller needs.
# In dry-run mode, sets <var-name> to a clearly-fake placeholder and prints what would have run,
# so downstream dry-run logic still has a string to branch on without ever touching the network.
run_cmd_capture() {
  local __outvar="$1"; shift
  kit_forbid_check "$@"
  if [[ "$DRY_RUN" == "1" ]]; then
    print -r -- "DRY-RUN would run (capturing output): $*"
    typeset -g "${__outvar}=DRY-RUN-PLACEHOLDER"
    return 0
  fi
  kit_log "running (capturing): $*"
  typeset -g "${__outvar}=$("$@")"
}

# kit_monotonic_start — captures a monotonic epoch-seconds start (Rule #382: an instant poll-exit,
# or a read taken before a measured lag, is a failed instrument, never a result).
kit_monotonic_start() {
  date -u +%s
}

# kit_assert_elapsed <start-epoch> <what> — fails loud if no time has passed since <start-epoch>.
kit_assert_elapsed() {
  local start="$1" what="$2" now elapsed
  now=$(date -u +%s)
  elapsed=$(( now - start ))
  if (( elapsed <= 0 )); then
    kit_die "${what}: elapsed=${elapsed}s — an instant poll-exit is a failed instrument (Rule #382)"
  fi
  kit_log "${what}: elapsed=${elapsed}s"
}

# kit_cut <branch> — fetch origin/main fresh (Rule #460), force the branch ref to it, add a
# worktree under $SCRATCH so the probe's own checkout never touches this kit's checkout.
kit_cut() {
  local branch="$1"
  run_cmd git -C "$REPO_DIR" fetch origin main
  run_cmd git -C "$REPO_DIR" branch -f "$branch" origin/main
  run_cmd git -C "$REPO_DIR" worktree add "$SCRATCH/$branch" "$branch"
}

# kit_assert_single_file_diff <worktree-dir> <branch> — every probe branch's diff against
# origin/main must touch exactly one file, and it must never be a .gitattributes path anywhere in
# the tree (the ruling refuses to mint there).
kit_assert_single_file_diff() {
  local dir="$1" branch="$2" files n
  if [[ "$DRY_RUN" == "1" ]]; then
    print -r -- "DRY-RUN would assert: git -C $dir diff --name-only origin/main...$branch is exactly one file, none named .gitattributes"
    return 0
  fi
  files=$(git -C "$dir" diff --name-only "origin/main...$branch")
  n=$(print -r -- "$files" | grep -c . || true)
  if (( n != 1 )); then
    kit_die "branch $branch touches $n files, expected exactly 1: $files"
  fi
  if print -r -- "$files" | grep -Eq '(^|/)\.gitattributes$'; then
    kit_die "branch $branch touches a .gitattributes path — refused, the ruling never mints there"
  fi
}

# kit_open_pr <branch> <control-n> <expected-word> <shape> <merge-disposition>
# <merge-disposition> is "merge" (1, 4) or "close-unmerged" (2, 3, 5, 6).
kit_open_pr() {
  local branch="$1" n="$2" expected_word="$3" shape="$4" disposition="$5"
  local body_file="$SCRATCH/${branch}.pr-body.md"
  mkdir -p "${body_file:h}"
  {
    print -r -- "## Control ${n} — box-patch-id rollout step 4"
    print -r -- ""
    print -r -- "**Plants:** ${shape}"
    print -r -- ""
    print -r -- "**Required verdict:** \`${expected_word}\`"
    print -r -- ""
    print -r -- "This PR waits on Kevin's box — the seat never applies it."
    print -r -- ""
    if [[ "$disposition" == "merge" ]]; then
      print -r -- "**Expected disposition:** MERGE, once boxed and observed."
    else
      print -r -- "**Expected disposition:** CLOSED UNMERGED once the receipt is harvested."
    fi
    print -r -- ""
    print -r -- "See \`docs/plants/2026-09-21-box-patch-id-control-kit.md\` for the full plants table and runbook."
  } > "$body_file"
  run_cmd gh pr create --repo "$REPO" --base main --head "$branch" \
    --title "control ${n}: ${shape} (box-patch-id rollout step 4)" \
    --body-file "$body_file"
}

# kit_wait_for_box <pr-number> — polls every 60s up to 24h (1440 polls) from a monotonic start.
# Hard-fails if the box shows up inside a single poll interval (Rule #382).
kit_wait_for_box() {
  local pr="$1" start i=0 max_polls=1440
  start=$(kit_monotonic_start)
  if [[ "$DRY_RUN" == "1" ]]; then
    print -r -- "DRY-RUN would poll: gh pr view $pr --repo $REPO --json labels --jq '.labels[].name' every 60s up to 24h from a monotonic start"
    return 0
  fi
  while (( i < max_polls )); do
    if gh pr view "$pr" --repo "$REPO" --json labels --jq '.labels[].name' | grep -qx box; then
      kit_assert_elapsed "$start" "box observed on PR $pr"
      return 0
    fi
    sleep 60
    (( i += 1 ))
  done
  kit_die "box never observed on PR $pr within 24h"
}

# kit_assert_single_shot <pr-number> <recorded-head-sha> — refuses to push when the PR's head has
# already moved since the box was recorded. One box, one shot.
kit_assert_single_shot() {
  local pr="$1" recorded_head="$2" current_head
  if [[ "$DRY_RUN" == "1" ]]; then
    print -r -- "DRY-RUN would assert: gh pr view $pr --repo $REPO --json headRefOid --jq .headRefOid equals recorded head $recorded_head"
    return 0
  fi
  current_head=$(gh pr view "$pr" --repo "$REPO" --json headRefOid --jq .headRefOid)
  if [[ "$current_head" != "$recorded_head" ]]; then
    kit_die "PR $pr head moved since the box was recorded ($recorded_head -> $current_head) — one box, one shot"
  fi
}

# kit_no_unharvested_box_elsewhere <exclude-pr-number> — control 4's base edit moves main under
# every open probe branch on the same file; refuse to land it while a sibling probe carries an
# unharvested box (amendment: sequence control 4 so it cannot confound its siblings).
kit_no_unharvested_box_elsewhere() {
  local exclude_pr="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    print -r -- "DRY-RUN would assert: gh pr list --repo $REPO --search \"807\" --json number,labels shows no OTHER open PR (excluding #$exclude_pr) already carrying box"
    return 0
  fi
  local boxed
  boxed=$(gh pr list --repo "$REPO" --search "807" --state open --json number,labels \
    --jq "[.[] | select(.number != ${exclude_pr}) | select(.labels[].name == \"box\") | .number]")
  if [[ "$boxed" != "[]" ]]; then
    kit_die "sibling probe PR(s) already carry an unharvested box: $boxed — land control 4 only when none do"
  fi
}

# kit_write_line <dir> <relpath> <heading-regex> <line> — inserts <line> as a new line immediately
# after the first line matching <heading-regex> in <dir>/<relpath> (skipping one blank separator
# line right after the heading, if present, so the insert lands in the section body, not between
# the heading and its blank line). No-op in dry-run — the caller already printed its own "would
# append" message and this function must never touch disk while DRY_RUN=1. Dies loudly in live mode
# if the heading is not found or the file does not exist — a missing anchor is a blind write, never
# a silent no-op (Rules #401/#465).
kit_write_line() {
  # NOTE 1: a single "local a=$1 b=$2 c=$a/$b" evaluates every RHS against the OUTER (unset) scope
  # before any assignment lands — zsh does not do this sequentially within one local statement, so
  # $a/$b reads as unset under `set -u`. Each dependent assignment needs its own local statement.
  # NOTE 2: never name a local `path` (lowercase) — zsh ties the special array `path` to the scalar
  # `$PATH`, so `local path="..."` inside a function overwrites `$PATH` for the rest of that
  # function's scope, and every subsequent command lookup (python3 included) fails with "command
  # not found" even though PATH is fine everywhere else. Use `target_path` instead.
  local dir="$1" relpath="$2" heading_re="$3" line="$4"
  local target_path="$dir/$relpath"
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi
  [[ -f "$target_path" ]] || kit_die "kit_write_line: $target_path does not exist — the plants doc must already exist with its heading structure (built by a sibling unit, plan section H)"
  python3 - "$target_path" "$heading_re" "$line" <<'PYEOF'
import re, sys
path, heading_re, line = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
pat = re.compile(heading_re)
idx = next((i for i, l in enumerate(lines) if pat.search(l)), None)
if idx is None:
    print(f"FAILED: no line matching {heading_re!r} found in {path}", file=sys.stderr)
    sys.exit(1)
insert_at = idx + 1
if insert_at < len(lines) and lines[insert_at].strip() == "":
    insert_at += 1
lines.insert(insert_at, line.rstrip("\n") + "\n")
with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
print(f"OK: inserted after line {idx + 1} of {path}")
PYEOF
}

# kit_replace_line <dir> <relpath> <match-regex> <new-line> — replaces the FIRST line matching
# <match-regex> with <new-line> verbatim (e.g. control 2's marker-text rewrite, control 3's
# re-indent). No-op in dry-run. Dies loudly in live mode if no line matches — never a silent no-op.
kit_replace_line() {
  # See kit_write_line's NOTE 2 — never name a local `path` (zsh ties it to $PATH).
  local dir="$1" relpath="$2" match_re="$3" new_line="$4"
  local target_path="$dir/$relpath"
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi
  [[ -f "$target_path" ]] || kit_die "kit_replace_line: $target_path does not exist"
  python3 - "$target_path" "$match_re" "$new_line" <<'PYEOF'
import re, sys
path, match_re, new_line = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
pat = re.compile(match_re)
idx = next((i for i, l in enumerate(lines) if pat.search(l)), None)
if idx is None:
    print(f"FAILED: no line matching {match_re!r} found in {path}", file=sys.stderr)
    sys.exit(1)
lines[idx] = new_line.rstrip("\n") + "\n"
with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
print(f"OK: replaced line {idx + 1} of {path}")
PYEOF
}

# kit_remove_line <dir> <relpath> <match-regex> — removes the FIRST line matching <match-regex>
# (control 6's commit-C strip of its own commit-B line). No-op in dry-run. Dies loudly in live mode
# if no line matches — a missing target is a blind removal, never a silent no-op.
kit_remove_line() {
  # See kit_write_line's NOTE 2 — never name a local `path` (zsh ties it to $PATH).
  local dir="$1" relpath="$2" match_re="$3"
  local target_path="$dir/$relpath"
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi
  [[ -f "$target_path" ]] || kit_die "kit_remove_line: $target_path does not exist"
  python3 - "$target_path" "$match_re" <<'PYEOF'
import re, sys
path, match_re = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
pat = re.compile(match_re)
idx = next((i for i, l in enumerate(lines) if pat.search(l)), None)
if idx is None:
    print(f"FAILED: no line matching {match_re!r} found in {path}", file=sys.stderr)
    sys.exit(1)
del lines[idx]
with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
print(f"OK: removed line {idx + 1} of {path}")
PYEOF
}

# kit_observe <pr-number> <control-n> [mode] [head-sha-override]
# Dispatches box-patch-id-observe.yml (built by a sibling unit of rollout step 4) and resolves the
# firing run id. In dry-run mode this only prints the two gh calls it would make.
kit_observe() {
  local pr="$1" n="$2" mode="${3:-observe}" override="${4:-}"
  local args=(--repo "$REPO" -f "repo=$REPO" -f "pr_number=$pr" -f "control=$n" -f "mode=$mode")
  if [[ -n "$override" ]]; then
    args+=(-f "head_sha_override=$override")
  fi
  run_cmd gh workflow run box-patch-id-observe.yml "${args[@]}"
  if [[ "$DRY_RUN" == "1" ]]; then
    print -r -- "DRY-RUN would resolve run id via: gh run list --repo $REPO --workflow box-patch-id-observe.yml --limit 1 --json databaseId,createdAt"
    return 0
  fi
  sleep 5
  run_cmd gh run list --repo "$REPO" --workflow box-patch-id-observe.yml --limit 1 --json databaseId,createdAt
}
