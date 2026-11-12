#!/bin/bash
# Test of lib.sh ensure_search_index and remove_search_index (#330) against fake-vectorize.py.
#   deploy/wfp/tests/search-index-test.sh [another lib.sh]
# Cases (exit, writes):
#   ensure absent       0, 1 POST with the bge-large preset   the index is made
#   ensure present      0, 0                                   an existing index is kept
#   ensure refused      1, 1                                   a refused create stops
#   remove present      0, 1 DELETE                            then it reads 404
#   remove absent       0, 0                                   nothing to remove
#   remove sticks       1, 1                                   a delete that does not take stops
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d); trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$T"' EXIT
echo '{"indexes": []}' > "$T/state.json"
python3 -I "$HERE/fake-vectorize.py" "$T/port" "$T/state.json" & pid=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
fails=0
run_case() { # run_case <label> <fn> <site> <state json> <want rc> <want writes> [want text]
	local label=$1 fn=$2 s=$3 state=$4 want_rc=$5 want_w=$6 want_text=${7:-} rc out w
	echo "$state" > "$T/state.json"; rm -f "$T/state.json.writes"
	out=$(
		WFP_API="http://127.0.0.1:$(cat "$T/port")" CLOUDFLARE_API_TOKEN=test ACCOUNT_ID=test-account
		export WFP_API CLOUDFLARE_API_TOKEN ACCOUNT_ID
		# shellcheck disable=SC1090
		. "$LIB"
		"$fn" "$s" 2>&1
	); rc=$?
	w=$(wc -l < "$T/state.json.writes" 2>/dev/null | tr -d ' '); w=${w:-0}
	local ok=1
	[ "$rc" = "$want_rc" ] && [ "$w" = "$want_w" ] || ok=0
	[ -z "$want_text" ] || { grep -q -- "$want_text" <<< "$out$(cat "$T/state.json.writes" 2>/dev/null)" || ok=0; }
	if [ $ok = 1 ]; then echo "PASS $label: exit $rc, $w write(s)"; else echo "FAIL $label: exit $rc, $w write(s) (want exit $want_rc, $want_w${want_text:+, \"$want_text\"})"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case "ensure absent" ensure_search_index one '{"indexes": []}' 0 1 '"preset": "@cf/baai/bge-large-en-v1.5"'
run_case "ensure absent (the name)" ensure_search_index one '{"indexes": []}' 0 1 '"name": "wp-wfp-one-search"'
run_case "ensure present" ensure_search_index one '{"indexes": ["wp-wfp-one-search"]}' 0 0 "exists"
run_case "ensure refused" ensure_search_index one '{"indexes": [], "create_status": 403}' 1 1 "create answered 403"
run_case "remove present" remove_search_index one '{"indexes": ["wp-wfp-one-search", "wp-wfp-two-search"]}' 0 1 "is gone (API 404)"
run_case "remove absent" remove_search_index one '{"indexes": ["wp-wfp-two-search"]}' 0 0 "none"
run_case "remove sticks" remove_search_index one '{"indexes": ["wp-wfp-one-search"], "delete_sticks": true}' 1 1 "NOT gone"
# Another site's index is never touched: after "remove present", two's is still there.
echo '{"indexes": ["wp-wfp-one-search", "wp-wfp-two-search"]}' > "$T/state.json"
( WFP_API="http://127.0.0.1:$(cat "$T/port")" CLOUDFLARE_API_TOKEN=test ACCOUNT_ID=test-account; export WFP_API CLOUDFLARE_API_TOKEN ACCOUNT_ID
  # shellcheck disable=SC1090
  . "$LIB"; remove_search_index one >/dev/null 2>&1 )
if python3 -I -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1]))["indexes"] == ["wp-wfp-two-search"] else 1)' "$T/state.json"; then echo "PASS remove leaves another site index"; else echo "FAIL remove leaves another site index"; fails=$((fails + 1)); fi
echo "$fails failing case(s)"
exit $fails
