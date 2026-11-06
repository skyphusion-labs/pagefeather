#!/bin/bash
# Test of update_all in deploy/wfp/lib.sh (issue #35 slice 5): run an updater
# over the sites in order, STOP at the first failure, leave the rest.
#   deploy/wfp/tests/update-all-test.sh [another lib.sh]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
# shellcheck disable=SC1090
. "$LIB"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
# A stub updater: it appends each site it is called with to a log, and fails
# for the site named in FAIL_SITE.
: > "$T/called"
stub() { echo "$1" >> "$T/called"; [ "$1" != "${FAIL_SITE:-}" ]; }

: > "$T/called"; out=$(update_all stub one two three); rc=$?
ok "all succeed: rc 0" "$([ "$rc" = 0 ] && echo 1 || echo 0)"
ok "all succeed: all three called in order" "$([ "$(tr '\n' ' ' < "$T/called")" = 'one two three ' ] && echo 1 || echo 0)"
ok "all succeed: summary lists the three updated" "$(printf '%s' "$out" | grep -q 'updated: one two three;' && echo 1 || echo 0)"

: > "$T/called"; out=$(FAIL_SITE=two update_all stub one two three); rc=$?
ok "fail on two: rc 1" "$([ "$rc" = 1 ] && echo 1 || echo 0)"
ok "fail on two: three is NOT reached" "$([ "$(tr '\n' ' ' < "$T/called")" = 'one two ' ] && echo 1 || echo 0)"
ok "fail on two: summary names updated one, failed two, not reached three" "$(printf '%s' "$out" | grep -q 'updated: one; failed: two; not reached: three' && echo 1 || echo 0)"

: > "$T/called"; out=$(FAIL_SITE=one update_all stub one two three); rc=$?
ok "fail on the first: rc 1, nothing after it reached" "$([ "$rc" = 1 ] && [ "$(tr '\n' ' ' < "$T/called")" = 'one ' ] && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
