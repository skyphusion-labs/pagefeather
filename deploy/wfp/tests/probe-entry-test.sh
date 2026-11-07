#!/bin/bash
# Test of probe_entry in deploy/wfp/lib.sh (issue #35): the site map entry for
# an attacker probe, and the CROSS_OUTBOUND option.
#   deploy/wfp/tests/probe-entry-test.sh [another lib.sh]
# - default (unset): outbound true; the script, cpuMs and subRequests pass through
# - CROSS_OUTBOUND=1: outbound true (unchanged)
# - CROSS_OUTBOUND=0: outbound false
# - the JSON parses, and the only field that the option changes is outbound
# Exits 0 only when every check holds. Needs bash, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
# shellcheck disable=SC1090
. "$LIB"
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
field() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1]))' "$1"; }

d=$(unset CROSS_OUTBOUND; probe_entry site-crossa 1000 2)
ok "default: parses and outbound true" "$([ "$(printf '%s' "$d" | field outbound)" = True ] && echo 1 || echo 0)"
ok "default: script, cpuMs, subRequests pass through" "$([ "$(printf '%s' "$d" | field script)" = site-crossa ] && [ "$(printf '%s' "$d" | field cpuMs)" = 1000 ] && [ "$(printf '%s' "$d" | field subRequests)" = 2 ] && echo 1 || echo 0)"
o1=$(CROSS_OUTBOUND=1 bash -c ". \"$LIB\"; probe_entry s 1 1")
ok "CROSS_OUTBOUND=1: outbound true" "$([ "$(printf '%s' "$o1" | field outbound)" = True ] && echo 1 || echo 0)"
o0=$(CROSS_OUTBOUND=0 bash -c ". \"$LIB\"; probe_entry s 1 1")
ok "CROSS_OUTBOUND=0: outbound false" "$([ "$(printf '%s' "$o0" | field outbound)" = False ] && echo 1 || echo 0)"
# The option changes ONLY the outbound field.
da=$(unset CROSS_OUTBOUND; probe_entry s 5 7); db=$(CROSS_OUTBOUND=0 bash -c ". \"$LIB\"; probe_entry s 5 7")
diffk=$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); b=json.loads(sys.argv[2]); print(",".join(sorted(k for k in a if a[k]!=b.get(k))))' "$da" "$db")
ok "the option changes only the outbound field (changed: ${diffk:-none})" "$([ "$diffk" = outbound ] && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
