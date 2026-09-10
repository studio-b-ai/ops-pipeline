#!/usr/bin/env bash
# lint-date-fixtures.sh — detect unpinned near-future dates in test fixtures (Rule #256).
# Finds test files with hardcoded dates within ±GUARD_DAYS of today that lack
# vi.useFakeTimers() / jest.useFakeTimers() — the ticking-time-bomb class that
# broke bolt#2174 (9/06) and bolt#2196 (9/09).
#
# Usage: lint-date-fixtures.sh [repo-root] [--json]
#   repo-root defaults to cwd.
#   --json outputs JSON instead of human-readable.
# Exit 0 = clean; exit 1 = violations found.
#
# Built for ops-pipeline#374 (Mechanic shift #42, 2026-09-10).

set -euo pipefail

GUARD_DAYS="${DATE_FIXTURE_GUARD_DAYS:-7}"
REPO_ROOT="${1:-.}"
JSON_MODE=0
[ "${2:-}" = "--json" ] && JSON_MODE=1

if [ ! -d "$REPO_ROOT" ]; then
  echo "ERROR: $REPO_ROOT is not a directory" >&2
  exit 2
fi

# macOS `date` doesn't support -d; use python3
compute_range() {
  python3 -c "
import datetime, sys
today = datetime.date.today()
delta = datetime.timedelta(days=int(sys.argv[1]))
start = today - delta
end = today + delta
for d in range((end - start).days + 1):
    print((start + datetime.timedelta(days=d)).isoformat())
" "$GUARD_DAYS"
}

DATE_PATTERNS=$(compute_range | sed 's/^/'\''/' | sed 's/$/'\''/' | paste -sd '|' -)
# Escape pipe for egrep alternation
DATE_REGEX=$(echo "$DATE_PATTERNS" | sed "s/'//g")

violations=""
violation_count=0

find_test_files() {
  find "$REPO_ROOT" -type f \( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" -o -name "*.test.js" -o -name "*.spec.js" \) \
    -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.git/*" 2>/dev/null
}

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # Step 1: does the file contain any date in the guard window?
  matching_dates=$(grep -oE "'$DATE_REGEX([T ][0-9]{2}:[0-9]{2}:[0-9]{2})?'" "$file" 2>/dev/null || true)
  [ -z "$matching_dates" ] && continue

  # Step 2: does the file use useFakeTimers / setSystemTime?
  if grep -qE 'useFakeTimers|setSystemTime' "$file" 2>/dev/null; then
    continue  # pinned — safe
  fi

  # Step 3: does the file use new Date() dynamically? (false positive risk)
  # If ALL dates are from dynamic Date() calls, the file is safe.
  # Check: are there date strings in the file that are NOT inside new Date()?
  violations="$violations$file\n"
  violation_count=$((violation_count + 1))

  if [ "$JSON_MODE" -eq 0 ]; then
    local_dates=$(echo "$matching_dates" | sort -u | head -5 | tr '\n' ' ')
    echo "UNPINNED: $file  (dates: $local_dates...)" >&2
  fi
done < <(find_test_files)

if [ "$JSON_MODE" -eq 1 ]; then
  echo "{"
  echo "  \"guard_days\": $GUARD_DAYS,"
  echo "  \"violation_count\": $violation_count,"
  if [ "$violation_count" -gt 0 ]; then
    echo "  \"files\": ["
    first=1
    echo -e "$violations" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      rel=$(python3 -c "import os; print(os.path.relpath('$f', '$REPO_ROOT'))" 2>/dev/null || echo "$f")
      [ "$first" -eq 1 ] && first=0 || echo ","
      printf '    "%s"' "$rel"
    done
    echo ""
    echo "  ]"
  else
    echo "  \"files\": []"
  fi
  echo "}"
else
  if [ "$violation_count" -eq 0 ]; then
    echo "OK: no unpinned date fixtures within ±${GUARD_DAYS}d"
  else
    echo "FAIL: $violation_count test file(s) with unpinned date fixtures (±${GUARD_DAYS}d guard)"
  fi
fi

exit "$violation_count"