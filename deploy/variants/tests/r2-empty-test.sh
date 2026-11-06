#!/bin/bash
# Test of deploy/variants/r2-empty.sh (issue #115) against fake-r2.py.
#   deploy/variants/tests/r2-empty-test.sh [another r2-empty.sh]
# Cases (fake: objects, list 403 for s, delete 403 for s; the result):
#   no refusal               5 objects, 0, 0      empty, 5 deleted
#   delete 403 for 2 s       5, 0, 2              empty: the delete is retried (the issue #115 case)
#   list 403 for 2 s         5, 2, 0              empty: the list is retried (as before)
#   delete 403 past budget   5, 0, 60 (budget 3)  exit 1, "refused (403) for 3 s"
#   delete 500               5, 0, 0, delete-500  exit 1 at once, not retried
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
SH=${1:-$ROOT/deploy/variants/r2-empty.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
run_case() {
	local name=$1 want_rc=$2 want_text=$3 budget=$4; shift 4
	local port pid rc out t0
	rm -f "$T/port"
	python3 -I "$HERE/fake-r2.py" "$T/port" "$@" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	port=$(cat "$T/port")
	t0=$SECONDS
	out=$(R2_KEY_ID=k R2_SECRET=s R2_RETRY_S=$budget R2_RETRY_STEP=0.3 bash "$SH" "http://127.0.0.1:$port" b 2>&1); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	if [ "$rc" = "$want_rc" ] && printf '%s' "$out" | grep -q "$want_text"; then
		echo "PASS $name: exit $rc after $((SECONDS - t0)) s"
	else
		echo "FAIL $name: exit $rc (want $want_rc, text \"$want_text\")"; fails=$((fails + 1))
	fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case "no refusal" 0 "b: empty (5 objects deleted)" 10 5 0 0
run_case "delete 403 for 2 s (issue #115)" 0 "b: empty (5 objects deleted)" 10 5 0 2
run_case "list 403 for 2 s" 0 "b: empty (5 objects deleted)" 10 5 2 0
run_case "delete 403 past the budget" 1 "refused (403) for 3 s" 3 5 0 60
run_case "delete 500 is not retried" 1 "failed (500)" 10 5 0 0 delete-500
echo "$fails failing case(s)"
exit $fails
