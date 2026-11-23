#!/usr/bin/env bash
# Masked assignment guard (#1398). In a workflow run: script, `export X=$(cmd)` (or local, declare, readonly, typeset,
# with or without flags or quotes) takes the builtin's exit status, not cmd's, so `set -e` never sees cmd fail (SC2155).
# Write `X=$(cmd); export X` instead.
#   bash tests/ci/workflow-masked-assign.sh [workflows-dir]     (default .github/workflows)
# Exit 0: none. 1: each one named <file>:<line>. 2: could not measure (no workflow file).
set -u
DIR=${1:-.github/workflows}
files=()
for f in "$DIR"/*.yml "$DIR"/*.yaml; do [ -f "$f" ] && files+=("$f"); done
[ "${#files[@]}" = 0 ] && { echo "workflow-masked-assign: could not measure: no workflow file in $DIR" >&2; exit 2; }
re='^[[:space:]]*(export|local|declare|readonly|typeset)([[:space:]]+-[A-Za-z]+)*[[:space:]]+[A-Za-z_][A-Za-z0-9_]*="?\$\('
hits=$(grep -nE "$re" "${files[@]}" /dev/null || true)
if [ -n "$hits" ]; then
  echo "$hits" | while IFS= read -r h; do echo "${h%%:*}:$(echo "$h" | cut -d: -f2): masked assignment (write X=\$(cmd); export X): $(echo "$h" | cut -d: -f3- | sed 's/^[[:space:]]*//')"; done
  echo "workflow-masked-assign: FAIL, $(echo "$hits" | wc -l | tr -d ' ') masked assignment(s)" >&2; exit 1
fi
echo "workflow-masked-assign: PASS, ${#files[@]} file(s), none"
