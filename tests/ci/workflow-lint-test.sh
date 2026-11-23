#!/usr/bin/env bash
# Tests of tests/ci/workflow-lint.sh (#1396): a workflow file that does not parse must fail by NAME (file and line),
# not run 0 jobs in silence (#1395 at 91f595fb: an unquoted "m: " in a step name).
#   bash tests/ci/workflow-lint-test.sh        (needs actionlint on PATH or in $ACTIONLINT)
# Cases (fixed fixtures, not the repo's files): valid workflows lint clean (exit 0); a planted file of #1395's shape fails (exit 1) and the output
# names that file and its line; no actionlint is "could not measure" (exit 2), never a pass; a directory with no
# workflow is exit 2 too.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); LINT="$HERE/workflow-lint.sh"
fails=0
show() { while IFS= read -r l; do printf '      %s\n' "$l"; done <<< "$1"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/wflint.XXXXXX"); trap 'rm -rf "$T"' EXIT

# The tool's own tests use FIXED fixtures, not the repo's workflows: whether the repo's files are valid is the lint step's
# job (it runs first in workflow-lint.yml), and a broken repo file must not hide the tool's own verdict (#1397 live proof).
good() { cat > "$1" <<'Y'
name: good
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: "a quoted name: with a colon"
        run: echo ok
Y
}
mkdir -p "$T/good"; good "$T/good/one.yml"; good "$T/good/two.yml"
out=$(bash "$LINT" "$T/good" 2>&1); rc=$?
check "valid workflows lint clean" "$rc" 0
show "$out"

mkdir -p "$T/bad"; good "$T/bad/one.yml"; good "$T/bad/two.yml"
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
show "$out"
check "the good files beside it are not blamed" "$(echo "$out" | grep -E '\.yml:[0-9]+:' | grep -vc 'planted\.yml')" 0

out=$(ACTIONLINT=/nonexistent/actionlint PATH=/usr/bin:/bin bash "$LINT" "$T/good" 2>&1); rc=$?
check "no actionlint: could not measure (2), never a pass" "$rc" 2

mkdir -p "$T/empty"
out=$(bash "$LINT" "$T/empty" 2>&1); rc=$?
check "a directory with no workflow: could not measure (2)" "$rc" 2

echo "$fails failing check(s)"
[ "$fails" = 0 ]
