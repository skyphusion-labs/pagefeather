#!/bin/bash
# Test of the refusals of deploy/wfp/site (issue #35, slice 3): against
# fake-account.py and a stand-in terraform on PATH. A refused command must
# exit 2 and send NO write to the account.
#   deploy/wfp/tests/site-cmd-test.sh [another site]
# Cases:
#   add one       site one exists (workspace and every part): refused
#   add three     only three's bucket is left: refused, the part named
#   add four      four's workspace is left, no part: refused
#   remove nine   nothing of nine exists: refused
#   add Bad_Name  a bad name: refused before any call
#   add probe     the reserved name: refused
#   import one    no SQLITE or DUMP: refused before any call
#   import nine   nothing of nine exists: refused
#   import Bad_Name  a bad name: refused before any call
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SITE=${1:-$HERE/../site}
T=$(mktemp -d)
cat > "$T/state.json" <<'JSON'
{"sites": {
 "one": {"dispatcher": {"etag": "d1", "modified_on": "t1"}, "script": {"etag": "u1", "modified_on": "m1"}, "entry": "{}", "bucket": [], "title": "one"},
 "three": {"bucket": []}},
 "ns_list_shape": "top"}
JSON
python3 -I "$HERE/fake-account.py" "$T/port" "$T/state.json" & pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
mkdir -p "$T/bin"
cat > "$T/bin/terraform" <<'SH'
#!/bin/sh
# A stand-in terraform: the shared output, and the workspaces one and four.
case "$*" in
  init*) exit 0 ;;
  "output -raw kv_namespace_id") printf kv1 ;;
  "workspace list") printf '* default\n  four\n  one\n' ;;
  *) echo "stand-in terraform: $* is not expected in a refused command" >&2; exit 9 ;;
esac
SH
chmod +x "$T/bin/terraform"
export PATH="$T/bin:$PATH" WFP_API="http://127.0.0.1:$(cat "$T/port")" CLOUDFLARE_API_TOKEN=test NAMESPACE=wp-wfp ACCOUNT_ID=test-account
fails=0
run_case() {
	local args=$1 want=$2 rc out
	rm -f "$T/state.json.writes"
	out=$("$SITE" $args 2>&1); rc=$?
	local writes; writes=$(cat "$T/state.json.writes" 2>/dev/null | wc -l | tr -d ' ')
	if [ "$rc" = 2 ] && [ "$writes" = 0 ] && printf '%s' "$out" | grep -q -- "$want"; then echo "PASS site $args: refused, 0 writes"; else echo "FAIL site $args: exit $rc, $writes write(s) (want exit 2, 0 writes, \"$want\")"; fails=$((fails + 1)); fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
# No account: refused before any call, with the variable named (no default account).
ACCOUNT_ID= run_case "add one" "set ACCOUNT_ID"
run_case "add one" "already exists"
run_case "add three" "bucket yes"
run_case "add four" "workspace four"
run_case "remove nine" "no site nine"
run_case "add Bad_Name" "bad site name"
run_case "add probe" "bad site name"
run_case "remove wfp-outbound" "bad site name"
run_case "remove dispatch" "bad site name"
run_case "remove cacheprobe" "bad site name"
run_case "import one" "needs SQLITE"
SQLITE=/dev/null run_case "import nine" "no site nine"
SQLITE=/dev/null run_case "import Bad_Name" "bad site name"
echo "$fails failing case(s)"
exit $fails
