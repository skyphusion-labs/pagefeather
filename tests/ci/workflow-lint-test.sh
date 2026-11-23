#!/usr/bin/env bash
# Tests of tests/ci/workflow-lint.sh (#1396): a workflow file that does not parse must fail by NAME (file and line),
# not run 0 jobs in silence (#1395 at 91f595fb: an unquoted "m: " in a step name).
#   bash tests/ci/workflow-lint-test.sh        (needs actionlint on PATH or in $ACTIONLINT)
# Cases: the repo's own workflows lint clean (exit 0); a planted file of #1395's shape fails (exit 1) and the output
# names that file and its line; no actionlint is "could not measure" (exit 2), never a pass; a directory with no
# workflow is exit 2 too.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd); LINT="$HERE/workflow-lint.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/wflint.XXXXXX"); trap 'rm -rf "$T"' EXIT

out=$(bash "$LINT" "$ROOT/.github/workflows" 2>&1); rc=$?
check "the repo's own workflows lint clean" "$rc" 0
echo "$out" | sed 's/^/      /' | tail -3

mkdir -p "$T/bad"; cp "$ROOT"/.github/workflows/*.yml "$T/bad/"
cat > "$T/bad/planted.yml" <<'Y'
name: planted
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: one m: php-run line
        run: echo hi
Y
out=$(bash "$LINT" "$T/bad" 2>&1); rc=$?
check "a planted #1395-shape file fails" "$rc" 1
check "the failure names the planted file and its line (7)" "$(echo "$out" | grep -cE 'planted\.yml:7:')" 1
check "the good files beside it are not blamed" "$(echo "$out" | grep -E '\.yml:[0-9]+:' | grep -vc 'planted\.yml')" 0

out=$(ACTIONLINT=/nonexistent/actionlint PATH=/usr/bin:/bin bash "$LINT" "$ROOT/.github/workflows" 2>&1); rc=$?
check "no actionlint: could not measure (2), never a pass" "$rc" 2

mkdir -p "$T/empty"
out=$(bash "$LINT" "$T/empty" 2>&1); rc=$?
check "a directory with no workflow: could not measure (2)" "$rc" 2

echo "$fails failing check(s)"
[ "$fails" = 0 ]
