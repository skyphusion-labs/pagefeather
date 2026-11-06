#!/bin/bash
# Test of c1_check in deploy/variants/c1.sh (issue #99) against fake-c1-site.py.
#   deploy/variants/tests/c1-check-test.sh [path to a c1.sh, default the real one]
# Cases (mode of the fake site, the result c1_check must give):
#   new           pass on try 1, the FPM ping probed
#   old-then-new  pass on try 2: the previous container (php -S) answered
#                 first, c1_check stopped it once (seen 2026-11-06, arm 3b:
#                 the FPM ping was probed before and failed a good deploy)
#   old-forever   fail: never the PHP-FPM image
#   php-stuck     fail: /_fpm-ping does not answer
# c1_up is replaced by a 5 s version: the real one waits up to 300 s here.
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
C1SH=${1:-$ROOT/deploy/variants/c1.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
run_case() {
	local mode=$1 want=$2 port pid rc out
	rm -f "$T/port"
	python3 -I "$HERE/fake-c1-site.py" "$T/port" "$mode" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	port=$(cat "$T/port")
	out=$(
		ROOT=$ROOT; log() { :; }
		# shellcheck disable=SC1090
		. "$C1SH"
		c1_up() { local t0=$SECONDS; while [ $((SECONDS - t0)) -lt 5 ]; do [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL/")" = 200 ] && return 0; sleep 1; done; return 1; }
		URL=http://127.0.0.1:$port SPIKE_TOKEN=test OBJECT_CACHE=apcu CHECK_WAIT=5
		c1_check 2>&1
	); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	local got=pass; [ $rc = 0 ] || got=fail
	if [ "$got" = "$want" ]; then echo "PASS $mode: $got"; else echo "FAIL $mode: $got, want $want"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case new pass
run_case old-then-new pass
run_case old-forever fail
run_case php-stuck fail
echo "$fails failing case(s)"
exit $fails
