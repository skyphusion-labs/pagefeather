#!/bin/bash
# Test of ns_script_state in deploy/wfp/lib.sh (issue #35) against fake-ns-api.py.
#   deploy/wfp/tests/ns-state-test.sh [another lib.sh]
# Cases (mode: the state it must give):
#   ghost         gone     (the live readings: GET 200 with a null script id; the list without it)
#   ghost-nested  gone     (the same, list items as {"script": {"id"}})
#   present       present
#   absent        gone     (GET 404)
#   list-lags     present  (the list still has it: not gone yet)
#   list-500      unknown  (cannot tell: down.sh stops)
#   one-500       unknown
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
for c in ghost:gone ghost-nested:gone present:present absent:gone list-lags:present list-500:unknown one-500:unknown; do
	mode=${c%%:*}; want=${c#*:}
	rm -f "$T/port"
	python3 -I "$HERE/fake-ns-api.py" "$T/port" "$mode" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	got=$(
		WFP_API="http://127.0.0.1:$(cat "$T/port")" NAMESPACE=wp-wfp CLOUDFLARE_API_TOKEN=test
		export WFP_API NAMESPACE CLOUDFLARE_API_TOKEN
		# shellcheck disable=SC1090
		. "$LIB"
		ns_script_state site-one
	)
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	if [ "$got" = "$want" ]; then echo "PASS $mode: $got"; else echo "FAIL $mode: $got (want $want)"; fails=$((fails + 1)); fi
done
echo "$fails failing case(s)"
exit $fails
