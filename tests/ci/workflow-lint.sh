#!/usr/bin/env bash
# Lint every GitHub Actions workflow (#1396). A workflow file that does not parse runs NO jobs and nothing names the cause
# (#1395 at 91f595fb). actionlint parses each file, checks the workflow schema and expressions, and prints
# <file>:<line>:<col>: <error> for each problem.
#   bash tests/ci/workflow-lint.sh [workflows-dir]     (default .github/workflows)
# actionlint comes from $ACTIONLINT or PATH (CI installs a pinned, checksummed release; see workflow-lint.yml).
# Its shellcheck and pyflakes passes are OFF: this gate is about the workflow files loading and being valid, not the style
# of the shell inside them (those findings are tracked separately; see #1396).
# Exit 0: every file is valid. 1: a finding (each one named). 2: could not measure (no actionlint, or no workflow file).
set -u
DIR=${1:-.github/workflows}
AL=${ACTIONLINT:-$(command -v actionlint || true)}
if [ -z "$AL" ] || [ ! -x "$AL" ]; then echo "workflow-lint: could not measure: actionlint not found (set ACTIONLINT or put it on PATH)" >&2; exit 2; fi
files=()
for f in "$DIR"/*.yml "$DIR"/*.yaml; do [ -f "$f" ] && files+=("$f"); done
if [ "${#files[@]}" = 0 ]; then echo "workflow-lint: could not measure: no workflow file in $DIR" >&2; exit 2; fi
echo "workflow-lint: $("$AL" -version | head -1), ${#files[@]} file(s) in $DIR"
"$AL" -no-color -shellcheck= -pyflakes= "${files[@]}"; rc=$?
case $rc in
  0) echo "workflow-lint: PASS, ${#files[@]} file(s), no finding"; exit 0 ;;
  1) echo "workflow-lint: FAIL, the finding(s) above name the file and line" >&2; exit 1 ;;
  *) echo "workflow-lint: could not measure: actionlint exited $rc" >&2; exit 2 ;;
esac
