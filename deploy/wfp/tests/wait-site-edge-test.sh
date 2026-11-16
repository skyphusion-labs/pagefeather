#!/bin/bash
# wait_site must not treat a Cloudflare edge 403 or 401 as the site (#783).
#   deploy/wfp/tests/wait-site-edge-test.sh [another lib.sh]
# The site's spike gate (spikes/b2-wordpress/index.js) answers an untokened /_*
# with status 403 and the body forbidden. An edge body "error code: <n>" is not
# that answer: wait_site keeps waiting to SITE_WAIT, then fails and names the code.
# A FAKE clock, as in wait-site-test.sh: each wait_sleep moves SITE_WAIT_STEP (1 s)
# and never sleeps, and the stub answers by request count. SITE_WAIT 4 s, so a
# not-up stub is probed at t 0,1,2,3,4 (5 requests) and then fails.
# Also: after the dispatcher deploy, site add (site.sh up) must see the script
# on the account before it waits. fake-script-api.py is that GET.
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
run_case() {
	local mode=$1 want_rc=$2 want_n=$3 want_text=${4:-} want_text2=${5:-} rc n out
	rm -f "$T/port" "$T/count"
	python3 -I "$HERE/fake-site.py" "$T/port" "$T/count" "$mode" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	out=$(
		SITE_WAIT=4 SITE_WAIT_STEP=1 CLOUDFLARE_API_TOKEN=test WFP_DISPATCH_GRACE=1
		export SITE_WAIT SITE_WAIT_STEP CLOUDFLARE_API_TOKEN WFP_DISPATCH_GRACE
		# shellcheck disable=SC1090
		. "$LIB"
		FAKE_NOW=0
		# shellcheck disable=SC2329 # lib.sh wait_site calls these two
		wait_now() { echo "$FAKE_NOW"; }
		# shellcheck disable=SC2329
		wait_sleep() { FAKE_NOW=$((FAKE_NOW + $1)); }
		wait_site "http://127.0.0.1:$(cat "$T/port")" 2>&1
	); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	n=$(cat "$T/count" 2>/dev/null || echo 0)
	local ok=1
	[ "$rc" = "$want_rc" ] || ok=0
	[ "$n" = "$want_n" ] || ok=0
	[ -z "$want_text" ] || printf '%s' "$out" | grep -q -- "$want_text" || ok=0
	[ -z "$want_text2" ] || printf '%s' "$out" | grep -q -- "$want_text2" || ok=0
	if [ $ok = 1 ]; then echo "PASS $mode: exit $rc, $n request(s)"; else echo "FAIL $mode: exit $rc, $n request(s) (want exit $want_rc, $want_n${want_text:+, \"$want_text\"}${want_text2:+, \"$want_text2\"})"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case edge-1104 1 5 "edge error code: 1104" "did not answer in 4 s"
run_case edge-1104-nl 1 5 "edge error code: 1104" "did not answer in 4 s"
run_case edge-401 1 5 "edge error code: 1104" "did not answer in 4 s"
run_case site 0 1 "answered HTTP 403"
run_case gate-401 0 1 "answered HTTP 401"
run_case edge-then-site 0 3 "answered HTTP 403 after 2 s"

run_disp() {
	local mode=$1 want_rc=$2 want_text=$3 rc out
	rm -f "$T/port"
	python3 -I "$HERE/fake-script-api.py" "$T/port" "$mode" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	out=$(
		WFP_API="http://127.0.0.1:$(cat "$T/port")" CLOUDFLARE_API_TOKEN=test
		export WFP_API CLOUDFLARE_API_TOKEN
		# shellcheck disable=SC1090
		. "$LIB"
		dispatcher_script_present wp-one 2>&1
	); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	local ok=1
	[ "$rc" = "$want_rc" ] || ok=0
	printf '%s' "$out" | grep -q -- "$want_text" || ok=0
	if [ $ok = 1 ]; then echo "PASS dispatcher $mode: exit $rc"; else echo "FAIL dispatcher $mode: exit $rc (want exit $want_rc, \"$want_text\")"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_disp present 0 "dispatcher wp-one is on the account (API 200)"
run_disp absent 1 "not waiting for the site"

# Each wrangler_deploy in site.sh up must be followed by its own check, before wait_site.
# A check that only follows the second deploy does not pair with the first.
order=$(awk '
	/wrangler_deploy / { deploys++; pending = 1 }
	/dispatcher_script_present "\$D"/ { checks++; if (pending) { paired++; pending = 0 }; last = NR }
	/wait_site "\$ORIGIN"/ && !w { w = NR }
	END { print (deploys >= 2 && checks >= 2 && paired >= 2 && last < w) ? 1 : 0 }
' "$HERE/../site.sh")
if [ "$order" = 1 ]; then echo "PASS site.sh checks the dispatcher script after deploy and before wait_site"; else echo "FAIL site.sh does not check the dispatcher script after both deploys and before wait_site (got $order)"; fails=$((fails + 1)); fi
echo "$fails failing case(s)"
exit $fails
