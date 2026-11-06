#!/bin/bash
# Test of c1_up_watch in deploy/variants/c1.sh and c1-bootwatch.py (issue
# #103) against fake-boot-site.py.
#   deploy/variants/tests/c1-bootwatch-test.sh [a tree with deploy/variants, default this one]
# With BOOT_LOG_WAIT 2 s, STALL_S 2 s, START_TIMEOUT 8 s. Cases (fake mode: the
# exit status, a text that must be in the output, a text that must not be):
#   growing          0  the new lines and the seconds     not the secret
#   slow             0  a start that is slower than STALL_S but makes progress passes
#   stalled          1  "no new boot log line", at STALL_S, not at START_TIMEOUT
#   none             1  "no boot log", at BOOT_LOG_WAIT
#   old-only         1  "no boot log": an earlier start's log does not count, and is not printed
#   old-and-stalled  1  the stall of this start's log, not the growth of the old one
#   r2-403           0  "cannot list": no stall check, the 200 still counts
#   r2-403-stuck     1  "no 200" at START_TIMEOUT
#   no R2 settings   0  "no R2 settings": only the wait for a 200
#   late-place       0  no container for 3 s (past BOOT_LOG_WAIT), then a healthy start (issue #120)
#   never-placed     1  at START_TIMEOUT, "started no container", not the #93 recovery
#   info-500         1  /_store-info cannot be read: "cannot read", then at BOOT_LOG_WAIT as before
#   no token         1  the same, with no SPIKE_TOKEN (the fake answers 403)
# In every case a "cannot list" or "no R2 settings" note appears at most once.
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=${1:-$(cd "$HERE/../../.." && pwd)}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
run_case() {
	local mode=$1 want_rc=$2 want_text=$3 not_text=$4 max_s=$5 ep=${6-set} port pid rc out t0 stop
	rm -f "$T/port"
	stop=$(date +%s)
	python3 -I "$HERE/fake-boot-site.py" "$T/port" "$mode" "$stop" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	port=$(cat "$T/port")
	t0=$SECONDS
	out=$(
		ROOT=$TREE; log() { :; }
		# shellcheck disable=SC1090
		. "$TREE/deploy/variants/c1.sh"
		URL=http://127.0.0.1:$port SPIKE_TOKEN=${CASE_TOKEN-test}
		[ "$ep" = set ] && C1_R2_EP=$URL C1_R2_BUCKET=b C1_R2_KEY_ID=k C1_R2_SECRET=sekrit-not-shown
		export C1_R2_EP C1_R2_BUCKET C1_R2_KEY_ID C1_R2_SECRET
		POLL_S=0.2 PROBE_TIMEOUT=5 START_TIMEOUT=8 BOOT_LOG_WAIT=2 STALL_S=2 c1_up_watch "$stop" 2>&1
	); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	local took=$((SECONDS - t0)) ok=1
	[ "$rc" = "$want_rc" ] || ok=0
	printf '%s' "$out" | grep -q -- "$want_text" || ok=0
	[ -z "$not_text" ] || ! printf '%s' "$out" | grep -q -- "$not_text" || ok=0
	[ "$took" -le "$max_s" ] || ok=0
	# A note says so once, not on every poll.
	[ "$(printf '%s\n' "$out" | grep -c -e 'cannot list' -e 'no R2 settings')" -le 1 ] || ok=0
	[ "$(printf '%s\n' "$out" | grep -c 'cannot read .*_store-info')" -le 1 ] || ok=0
	# Every failure names the probe answers (issue #120).
	[ "$rc" = 0 ] || printf '%s' "$out" | grep -q 'probes [0-9]* (' || ok=0
	if [ $ok = 1 ]; then echo "PASS $mode: exit $rc after $took s"; else echo "FAIL $mode: exit $rc after $took s (want $want_rc in at most $max_s s, text \"$want_text\"${not_text:+, not \"$not_text\"})"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case growing 0 "boot: .* c1: step 2 of store.boot-" "sekrit" 6
run_case slow 0 "boot: .* c1: step 4 of" "no new boot log line" 8
run_case stalled 1 "stopped at:" "after 8 s" 6
run_case none 1 "no boot log b/store.boot-<epoch>.log" "after 8 s" 5
run_case old-only 1 "no boot log" "boot: " 5
run_case old-and-stalled 1 "the start stopped at:" "step 4 of" 6
run_case r2-403 0 "cannot list b/store.boot-\* (HTTP 403)" "no 200 from" 6
run_case r2-403-stuck 1 "no 200 from http://127.0.0.1:[0-9]*/ after 8 s" "no new boot log line" 11
run_case growing 0 "boot log: no R2 settings" "boot: " 6 unset
run_case late-place 0 "boot: .* c1: step 2 of store.boot-" "BOOT_LOG_WAIT" 8
run_case never-placed 1 "the platform started no container" "Recover (issue #93)" 11
run_case info-500 1 "cannot read http://127.0.0.1:[0-9]*/_store-info" "after 8 s" 5
CASE_TOKEN="" run_case none 1 "cannot read http://127.0.0.1:[0-9]*/_store-info" "after 8 s" 5
echo "$fails failing case(s)"
exit $fails
