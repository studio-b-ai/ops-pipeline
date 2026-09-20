#!/usr/bin/env zsh
# harvest-receipt.zsh — fills exactly one receipt cell in
# docs/plans/2026-09-19-box-patch-id-observe-only-build.md's six-controls table, for one control,
# from one workflow run's own observed output. Never infers a verdict from a PR's state (merged /
# closed-unmerged) — only from the run's printed `[box-patch-id observe-only]` line and the
# `box-patch-id-observe` check run's conclusion.
#
# AMENDMENT APPLIED (this build, 2026-09-20): fails loudly on zero grep matches (a missing line is
# a blind instrument, never a pass — Rules #401/#465) and refuses to write a cell whose verdict was
# inferred from PR state. Ships its own negative control: `--assert-negative <control> <run-id>`
# runs the SAME grep against a run that carries no matching line and asserts THIS harvester exits
# non-zero — proving the instrument in both directions (Rule #322) before any real harvest is
# trusted.
set -euo pipefail
local_dir="${0:A:h}"
SCRIPT_NAME="${0:t}"
source "$local_dir/_kit.zsh"

BUILD_DOC="docs/plans/2026-09-19-box-patch-id-observe-only-build.md"
# Absolute, independent of the invoking shell's cwd — a bare relative BUILD_DOC handed to python3's
# plain open() would resolve against wherever this script happened to be run FROM, not the repo.
BUILD_DOC_ABS="$REPO_DIR/$BUILD_DOC"

usage() {
  # zsh resets $0 to the function's own name inside a function (FUNCTION_ARGZERO) — use the
  # top-level-captured $SCRIPT_NAME instead, or every usage line prints "usage: usage ...".
  print -ru2 -- "usage: $SCRIPT_NAME <control 1-6> <run-id> [head-sha] [--dry-run]"
  print -ru2 -- "       $SCRIPT_NAME --assert-negative <control 1-6> <run-id> [--dry-run]"
  exit 2
}

[[ $# -ge 1 ]] || usage

assert_negative=0
if [[ "$1" == "--assert-negative" ]]; then
  assert_negative=1
  shift
fi

for a in "$@"; do [[ "$a" == "--dry-run" ]] && DRY_RUN=1; done
rest=(${(@)@:#--dry-run})

[[ ${#rest} -ge 2 ]] || usage
n="${rest[1]}"
run_id="${rest[2]}"
head_sha="${rest[3]:-}"

case "$n" in
  1|2|3|4|5|6) ;;
  *) print -ru2 -- "control must be 1-6, got: $n"; exit 2 ;;
esac

pattern="[box-patch-id observe-only] control=${n}"

if [[ "$DRY_RUN" == "1" ]]; then
  print -r -- "DRY-RUN would run: gh run view $run_id --repo $REPO --log | grep -F '${pattern}'"
  if (( assert_negative )); then
    print -r -- "DRY-RUN (--assert-negative) would then assert grep found ZERO matches, exiting non-zero if it found any"
  else
    print -r -- "DRY-RUN would fail loudly (exit 1) on zero matches — never a silent pass"
    print -r -- "DRY-RUN would then run: gh api repos/$REPO/commits/<head-sha>/check-runs --jq '.check_runs[] | select(.name==\"box-patch-id-observe\") | .conclusion'"
    print -r -- "DRY-RUN would then rewrite ONLY row '| ${n} |''s fourth cell in $BUILD_DOC_ABS via a python3 table pass (never a blind sed)"
  fi
  exit 0
fi

log_line=$(gh run view "$run_id" --repo "$REPO" --log | grep -F "$pattern" || true)

if (( assert_negative )); then
  if [[ -n "$log_line" ]]; then
    kit_die "--assert-negative expected ZERO matches for run $run_id / control $n but found: $log_line"
  fi
  kit_log "negative control passed: run $run_id carries no '$pattern' line — the harvester correctly detects absence"
  exit 0
fi

if [[ -z "$log_line" ]]; then
  kit_die "zero matches for '$pattern' in run $run_id's log — a missing line is a blind instrument, never a pass (Rules #401/#465). Refusing to write a receipt cell."
fi

verdict=$(print -r -- "$log_line" | sed -n 's/.*verdict=\([^ ]*\).*/\1/p' | head -1)
[[ -n "$verdict" ]] || kit_die "matched line did not carry a verdict=... token: $log_line"

if [[ -z "$head_sha" ]]; then
  head_sha=$(gh run view "$run_id" --repo "$REPO" --json headSha --jq .headSha)
fi
[[ -n "$head_sha" && "$head_sha" != "null" ]] || kit_die "could not resolve a head sha for run $run_id — pass one explicitly as the third argument"

conclusion=$(gh api "repos/$REPO/commits/$head_sha/check-runs" --jq '.check_runs[] | select(.name=="box-patch-id-observe") | .conclusion' | head -1)
[[ -n "$conclusion" ]] || kit_die "no box-patch-id-observe check run found on $head_sha — refusing to infer a receipt from PR state instead"

run_url="https://github.com/${REPO}/actions/runs/${run_id}"
cell="run [${run_id}](${run_url}) \xb7 \`${verdict}\` \xb7 check-run ${conclusion}"

kit_log "would rewrite ONLY row '| ${n} |''s fourth cell in $BUILD_DOC_ABS to: ${cell}"
python3 - "$BUILD_DOC_ABS" "$n" "$cell" <<'PYEOF'
import re, sys
path, n, cell = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
pattern = re.compile(r"^\|\s*" + re.escape(n) + r"\s*\|")
hit = False
for i, line in enumerate(lines):
    if pattern.match(line) and line.count("|") >= 5:
        cells = line.split("|")
        # cells: ["", " n ", " planted ", " verdict ", " receipt ", "\n"]
        cells[4] = f" {cell} "
        lines[i] = "|".join(cells)
        hit = True
        break
if not hit:
    print(f"FAILED: no row starting '| {n} |' found in {path}", file=sys.stderr)
    sys.exit(1)
with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
print(f"OK: rewrote row {n}'s receipt cell")
PYEOF
