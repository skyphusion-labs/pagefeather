#!/bin/bash
# Test of kv_wait_writable in deploy/wfp/lib.sh (issue #35) against fake-kv-api.py.
#   deploy/wfp/tests/kv-ready-test.sh [another lib.sh]
# Budget KV_READY_S 4, step 0.3 s. Cases (mode: exit, then what the log must show):
#   ready         0   one PUT, then the DELETE of the test key
#   new-2s        0   several PUTs (404 10013, retried), one 200, then the DELETE (the live case)
#   never         1   retried until the budget, no DELETE
#   forbidden     1   ONE PUT (403 is not retried), no DELETE
#   flaky-500     0   a 500, retried, then 200 and the DELETE
#   delete-fails  1   the test key could not be deleted: said, not ignored
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
run_case() {
	local mode=$1 want_rc=$2 want_puts=$3 want_del=$4 rc puts dels t0 took
	rm -f "$T/port"; : > "$T/log"
	python3 -I "$HERE/fake-kv-api.py" "$T/port" "$T/log" "$mode" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	t0=$SECONDS
	out=$(
		WFP_API="http://127.0.0.1:$(cat "$T/port")" CLOUDFLARE_API_TOKEN=test KV_READY_S=4 KV_READY_STEP=0.3
		export WFP_API CLOUDFLARE_API_TOKEN KV_READY_S KV_READY_STEP
		# shellcheck disable=SC1090
		. "$LIB"
		kv_wait_writable kv123 2>&1
	); rc=$?
	took=$((SECONDS - t0))
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	puts=$(grep -c '^PUT wfp-ready-probe' "$T/log"); dels=$(grep -c '^DELETE wfp-ready-probe' "$T/log")
	local ok=1
	[ "$rc" = "$want_rc" ] || ok=0
	case "$want_puts" in *+) [ "$puts" -ge "${want_puts%+}" ] || ok=0 ;; *) [ "$puts" = "$want_puts" ] || ok=0 ;; esac
	[ "$dels" = "$want_del" ] || ok=0
	if [ $ok = 1 ]; then echo "PASS $mode: exit $rc, $puts PUT(s), $dels DELETE(s), $took s"; else echo "FAIL $mode: exit $rc, $puts PUT(s), $dels DELETE(s) (want exit $want_rc, $want_puts PUT(s), $want_del DELETE(s))"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case ready 0 1 1
run_case new-2s 0 3+ 1
run_case never 1 5+ 0
run_case forbidden 1 1 0
run_case flaky-500 0 2 1
run_case delete-fails 1 1 1
echo "$fails failing case(s)"
exit $fails
