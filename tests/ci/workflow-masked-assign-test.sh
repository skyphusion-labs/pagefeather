#!/usr/bin/env bash
# Tests of tests/ci/workflow-masked-assign.sh (#1398): no workflow run: script may write `export X=$(cmd)` (or local,
# declare, readonly, typeset), because the builtin's own status replaces cmd's and `set -e` never sees cmd fail (SC2155).
#   bash tests/ci/workflow-masked-assign-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd); G="$HERE/workflow-masked-assign.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/wfmask.XXXXXX"); trap 'rm -rf "$T"' EXIT

# Why it matters, measured: a planted failing mktemp under set -euo pipefail.
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/mktemp"; chmod +x "$T/bin/mktemp"
masked=$(PATH="$T/bin:$PATH" bash -c 'set -euo pipefail; export P=$(mktemp -d); echo "went on with P=[$P]"' 2>&1); m=$?
split=$(PATH="$T/bin:$PATH" bash -c 'set -euo pipefail; P=$(mktemp -d); export P; echo "went on with P=[$P]"' 2>&1); s=$?
check "masked form: a failing mktemp is NOT caught (the step goes on, P empty)" "$m:$masked" "0:went on with P=[]"
check "split form: a failing mktemp stops the step" "$s" 1
check "split form: nothing after the failing mktemp ran" "$(echo "$split" | grep -c "went on")" 0

out=$(bash "$G" "$ROOT/.github/workflows" 2>&1); rc=$?
check "the repo's workflows have no masked assignment" "$rc" 0
echo "$out" | sed 's/^/      /' | tail -3

mkdir -p "$T/w"
cat > "$T/w/a.yml" <<'Y'
jobs:
  j:
    steps:
      - run: |
          set -euo pipefail
          export A=$(mktemp -d)
          local B="$(date)"
          declare -r C=$(pwd)
          D=$(mktemp -d); export D
          export E="plain"
Y
out=$(bash "$G" "$T/w" 2>&1); rc=$?
check "planted: masked assignments fail" "$rc" 1
check "planted: each one is named by file and line (6, 7, 8)" "$(echo "$out" | grep -oE 'a\.yml:[0-9]+' | tr '\n' ' ')" "a.yml:6 a.yml:7 a.yml:8 "
check "planted: the split form and a plain export are not flagged" "$(echo "$out" | grep -cE 'a\.yml:(9|10):')" 0

mkdir -p "$T/empty"; bash "$G" "$T/empty" > /dev/null 2>&1; rc=$?
check "no workflow file: could not measure (2)" "$rc" 2

echo "$fails failing check(s)"
[ "$fails" = 0 ]
