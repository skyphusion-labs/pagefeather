#!/bin/bash
# Test of wait_site in deploy/wfp/lib.sh (issue #35) against fake-site.py.
#   deploy/wfp/tests/wait-site-test.sh [another lib.sh]
# SITE_WAIT 4 s, step 0.3 s. Cases (mode: exit, requests: exact or at least N+):
#   site          0  1     the site at once (its own 403)
#   site-200      0  1
#   platform-404  0  2+    a bare 404 first: waited for the site
#   not-deployed  0  2+    the dispatcher's not-deployed first (the live case): waited
#   no-site       0  2+    the dispatcher's no-site first: waited
#   cold-503      0  2+
#   bad-entry     1  1     a configuration fault: at once, not retried
#   dispatch      1  1
#   never         1  5+    not-deployed until the bound; the last answer is printed
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
run_case() {
	local mode=$1 want_rc=$2 want_n=$3 want_text=${4:-} rc n out
	rm -f "$T/port" "$T/count"
	python3 -I "$HERE/fake-site.py" "$T/port" "$T/count" "$mode" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	out=$(
		SITE_WAIT=4 SITE_WAIT_STEP=0.3 CLOUDFLARE_API_TOKEN=test
		export SITE_WAIT SITE_WAIT_STEP CLOUDFLARE_API_TOKEN
		# shellcheck disable=SC1090
		. "$LIB"
		wait_site "http://127.0.0.1:$(cat "$T/port")" 2>&1
	); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	n=$(cat "$T/count" 2>/dev/null || echo 0)
	local ok=1
	[ "$rc" = "$want_rc" ] || ok=0
	case "$want_n" in *+) [ "$n" -ge "${want_n%+}" ] || ok=0 ;; *) [ "$n" = "$want_n" ] || ok=0 ;; esac
	[ -z "$want_text" ] || printf '%s' "$out" | grep -q -- "$want_text" || ok=0
	if [ $ok = 1 ]; then echo "PASS $mode: exit $rc, $n request(s)"; else echo "FAIL $mode: exit $rc, $n request(s) (want exit $want_rc, $want_n${want_text:+, \"$want_text\"})"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case site 0 1 "answered HTTP 403"
run_case site-200 0 1
run_case platform-404 0 2+ "answered HTTP 403"
run_case not-deployed 0 2+ "answered HTTP 403"
run_case no-site 0 2+ "answered HTTP 403"
run_case cold-503 0 2+
run_case bad-entry 1 1 "configuration fault"
run_case dispatch 1 1 "configuration fault"
run_case never 1 5+ "x-wfp-error not-deployed"
echo "$fails failing case(s)"
exit $fails
