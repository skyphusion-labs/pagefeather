#!/bin/bash
# Test of c1_rollout in deploy/variants/c1.sh (issue #106) against
# fake-containers-api.py.
#   deploy/variants/tests/c1-rollout-test.sh [path to a c1.sh, default the real one]
# Cases (fake API mode: the exit status c1_rollout must give, and the number of
# rollout reads: exact, or at least N with "+"):
#   done-after-3  0, 3      waits through "progressing"
#   already       0, 1      no wait when the rollout is done
#   never         1, 3+     fails at ROLLOUT_TIMEOUT
#   reverted      1, 1      a reverted rollout fails at once
#   late          0, 4      an older completed rollout (version 6) does not count
#   bare-list     0, 3      a bare list answer reads the same
#   api-401       2, 0      the API cannot be read: the caller falls back; the
#                           error is kept once in C1_API_ERRORS (issue #120)
#   no-app        2, 0      no application of that name: the caller falls back
#   live-shape    0, 3      the live API shape (result_info, replaced, version_distribution)
#   new-app       0, 1      version 1 with no rollout at all: placed, no wait
#   v2-empty      0, 4      version 2 with an empty list: waits for its rollout
#   stale-list    0, 3      the version comes from GET /applications/<id>, not the stale list
#   stale-list-empty  0, 4  the stale list version 1 with no rollout yet must not count as placed
#   replaced-then-newer 0, 3  a replaced rollout, then a newer version: waits, then passes
#   replaced-stuck  1, 6    replaced with no newer version: fails after 6 reads, not at the timeout
# And c1_wait with fake-c1-site.py too: api-401 falls back to the fixed wait
# and goes on; reverted fails before the stop; done-after-3 goes on; a stop
# that gets no Store answer (404 HTML) is named and goes on; a stuck stop fails;
# the wait for the first 200 goes through c1_up_watch (issue #103), which with
# no Terraform outputs says so and only waits for the 200.
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
C1SH=${1:-$ROOT/deploy/variants/c1.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
run_case() {
	local mode=$1 want_rc=$2 want_n=$3 want_text=${4:-} port pid rc out n
	rm -f "$T/port" "$T/count"
	python3 -I "$HERE/fake-containers-api.py" "$T/port" "$T/count" "$mode" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	port=$(cat "$T/port")
	out=$(
		ROOT=$ROOT; log() { :; }
		# shellcheck disable=SC1090
		. "$C1SH"
		NAME=t ACCOUNT_ID=acc CLOUDFLARE_API_TOKEN=test-token C1_API=http://127.0.0.1:$port ROLLOUT_POLL_S=0.2 ROLLOUT_TIMEOUT=5
		c1_rollout 2>&1; r=$?
		echo "api errors: ${C1_API_ERRORS:-none}"
		exit $r
	); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	n=$(cat "$T/count" 2>/dev/null || echo 0)
	local ok=1
	[ "$rc" = "$want_rc" ] || ok=0
	case "$want_n" in
		*+) [ "$n" -ge "${want_n%+}" ] || ok=0 ;;
		*) [ "$n" = "$want_n" ] || ok=0 ;;
	esac
	[ -z "$want_text" ] || printf '%s\n' "$out" | grep -qx -- "$want_text" || ok=0
	if [ $ok = 1 ]; then echo "PASS $mode: exit $rc, $n rollout reads"; else echo "FAIL $mode: exit $rc, $n rollout reads (want exit $want_rc, $want_n reads)"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
# c1_wait with both fakes: the containers API and the site (fake-c1-site.py).
# api-401: the fallback (a fixed ROLLOUT_WAIT), then the stop and the first
# 200. reverted: fail before the stop.
wait_case() {
	local mode=$1 want_rc=$2 want_text=$3 not_text=$4 p1 p2 pid1 pid2 rc out
	rm -f "$T/port" "$T/count" "$T/sport"
	python3 -I "$HERE/fake-containers-api.py" "$T/port" "$T/count" "$mode" & pid1=$!
	python3 -I "$HERE/fake-c1-site.py" "$T/sport" "${SITE_MODE:-new}" & pid2=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && [ -s "$T/sport" ] && break; sleep 0.1; done
	p1=$(cat "$T/port"); p2=$(cat "$T/sport")
	out=$(
		ROOT=$ROOT; log() { echo "== $*"; }
		# shellcheck disable=SC1090
		. "$C1SH"
		NAME=t ACCOUNT_ID=acc CLOUDFLARE_API_TOKEN=test-token C1_API=http://127.0.0.1:$p1 ROLLOUT_POLL_S=0.2 ROLLOUT_TIMEOUT=5 ROLLOUT_WAIT=0
		URL=http://127.0.0.1:$p2 SPIKE_TOKEN=test START_TIMEOUT=5
		c1_wait 2>&1
	); rc=$?
	kill "$pid1" "$pid2" 2>/dev/null; wait "$pid1" "$pid2" 2>/dev/null
	local ok=1
	[ "$rc" = "$want_rc" ] || ok=0
	printf '%s' "$out" | grep -q "$want_text" || ok=0
	[ -z "$not_text" ] || ! printf '%s' "$out" | grep -q "$not_text" || ok=0
	if [ $ok = 1 ]; then echo "PASS c1_wait $mode (site ${SITE_MODE:-new}): exit $rc"; else echo "FAIL c1_wait $mode (site ${SITE_MODE:-new}): exit $rc (want $want_rc, text \"$want_text\"${not_text:+, not \"$not_text\"})"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case done-after-3 0 3
run_case already 0 1
run_case never 1 3+
run_case reverted 1 1
run_case late 0 4
run_case bare-list 0 3
run_case api-401 2 0 "api errors: api-error applications HTTP 401"
run_case no-app 2 0
run_case done-after-3 0 3 "api errors: none"
run_case live-shape 0 3
run_case new-app 0 1
run_case v2-empty 0 4
run_case stale-list 0 3
run_case stale-list-empty 0 4
run_case replaced-then-newer 0 3
run_case replaced-stuck 1 6
wait_case api-401 0 "waiting a fixed" ""
wait_case reverted 1 "ended as reverted" "stop:"
wait_case done-after-3 0 "first answer 200" ""
wait_case done-after-3 0 "boot log: no R2 settings" ""
SITE_MODE=stop-no-worker wait_case done-after-3 0 "no answer from the Store object (HTTP 404" "stop: {}"
SITE_MODE=stop-stuck wait_case done-after-3 1 "probably stuck" "first answer 200"
echo "$fails failing case(s)"
exit $fails
