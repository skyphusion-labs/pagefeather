#!/bin/bash
# The CI guard (#580, widened by #581) must refuse every process substitution
# outside a comment in the operator scripts, including the argument form
# `cmd <(...)`. It reads the guard line from .github/workflows/ci.yml and runs
# that same pattern, so a guard that only matches the redirect form is red.
#   tests/ci/no-process-sub-test.sh
# Needs bash and grep. Exits 0 only when every case holds.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WF="$ROOT/.github/workflows/ci.yml"
fails=0
work=$(mktemp -d "${TMPDIR:-/tmp}/no-process-sub.XXXXXX")
trap 'rm -rf "$work"' EXIT
check() {
  if [ "$2" = "$3" ]; then printf '%s\n' "PASS $1"; else printf '%s\n' "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi
}

guard=$(grep -F 'hits=$(grep -nE' "$WF" || true)
n=$(printf '%s\n' "$guard" | grep -c . || true)
check "ci.yml has one process-substitution guard" "$n" "1"
if [ "$n" != "1" ]; then
  printf '%s\n' "$fails failing case(s)"
  exit "$fails"
fi

pat=$(printf '%s\n' "$guard" | sed -n "s/.*grep -nE '\\([^']*\\)'.*/\\1/p")
cfilter=$(printf '%s\n' "$guard" | sed -n "s/.*grep -vE '\\([^']*\\)'.*/\\1/p")
check "the guard pattern was read" "$([ -n "$pat" ] && echo yes || echo no)" "yes"
check "the comment filter was read" "$([ -n "$cfilter" ] && echo yes || echo no)" "yes"
printf '%s\n' "guard pattern: $pat"
if [ -z "$pat" ] || [ -z "$cfilter" ]; then
  printf '%s\n' "$fails failing case(s)"
  exit "$fails"
fi

case "$guard" in
  *'spikes/b2-wordpress/*.sh'*'deploy/wfp/*.sh'*'deploy/wfp/site'*) cov=yes ;;
  *) cov=no ;;
esac
check "the guard covers the operator scripts" "$cov" "yes"

# A tree the guard's globs match. deploy/wfp/site is a file, as in this repo.
tree() {
  d=$1
  mkdir -p "$d/spikes/b2-wordpress" "$d/deploy/wfp"
  printf '%s\n' '#!/bin/bash' 'echo ok' > "$d/spikes/b2-wordpress/ok.sh"
  printf '%s\n' '#!/bin/bash' 'echo ok' > "$d/deploy/wfp/site"
}

# Same pipeline as the CI step. Prints hits and exits 1 when any remain.
run_guard() {
  d=$1
  (
    cd "$d" || exit 99
    hits=$(grep -nE "$pat" spikes/b2-wordpress/*.sh deploy/wfp/*.sh deploy/wfp/site | grep -vE "$cfilter" || true)
    if [ -n "$hits" ]; then
      printf '%s\n' "$hits"
      exit 1
    fi
    exit 0
  )
}

cmd="$work/cmd"
tree "$cmd"
# The code line is the argument form. The comment must not be reported.
printf '%s\n' '#!/bin/bash' '# COMMENTKEEP <(echo no)' 'cmd <(echo CODEHIT)' > "$cmd/deploy/wfp/bad.sh"
cmd_out=$(run_guard "$cmd")
cmd_rc=$?
check "guard rejects a cmd process substitution" "$([ "$cmd_rc" -ne 0 ] && echo yes || echo no)" "yes"
check "guard names the cmd process-substitution line" "$(printf '%s\n' "$cmd_out" | grep -c 'CODEHIT' || true)" "1"
check "guard ignores a process substitution in a comment" "$(printf '%s\n' "$cmd_out" | grep -c 'COMMENTKEEP' || true)" "0"
if [ -n "$cmd_out" ]; then printf '%s\n' "$cmd_out" | sed 's/^/    /'; fi

red="$work/red"
tree "$red"
printf '%s\n' '#!/bin/bash' 'read -r x < <(echo REDIRECTHIT)' > "$red/deploy/wfp/old.sh"
red_out=$(run_guard "$red")
red_rc=$?
check "guard still rejects the redirect form" "$([ "$red_rc" -ne 0 ] && echo yes || echo no)" "yes"
check "guard names the redirect line" "$(printf '%s\n' "$red_out" | grep -c 'REDIRECTHIT' || true)" "1"

com="$work/com"
tree "$com"
printf '%s\n' '#!/bin/bash' '    # comment only <(echo COMMENTONLY)' > "$com/deploy/wfp/note.sh"
printf '%s\n' '#!/bin/bash' '    # Command substitution, not `read < <(...)`: kept' > "$com/spikes/b2-wordpress/e2e.sh"
com_out=$(run_guard "$com")
com_rc=$?
check "guard allows a process substitution in a comment" "$com_rc" "0"
check "a comment-only tree prints nothing" "$com_out" ""

repo_out=$(run_guard "$ROOT")
repo_rc=$?
check "guard passes on this tree" "$repo_rc" "0"
if [ -n "$repo_out" ]; then printf '%s\n' "$repo_out" | sed 's/^/    /'; fi

printf '%s\n' "$fails failing case(s)"
exit "$fails"
