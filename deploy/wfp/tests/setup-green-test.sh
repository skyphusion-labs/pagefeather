#!/bin/bash
# Test of site_title_ok in deploy/wfp/lib.sh and the distinct seed key in
# snapshot.py (issue #35): cross.sh must refuse a verdict unless both sites
# answer their own title, and a site listing its OWN bucket must never look
# like seeing another site's object.
#   deploy/wfp/tests/setup-green-test.sh [another lib.sh]
# Against fake-account.py (serves /site/<dispatcher>/ with a title from state).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d)
cat > "$T/state.json" <<'JSON'
{"sites": {
 "one": {"dispatcher": {"etag": "d"}, "script": {"etag": "u"}, "entry": "{}", "bucket": [], "title": "WfP site one"},
 "two": {"dispatcher": {"etag": "d"}, "script": {"etag": "u"}, "entry": "{}", "bucket": [], "title": "WfP site two"},
 "broken": {"dispatcher": {"etag": "d"}, "script": {"etag": "u"}, "entry": "{}", "bucket": [], "title": "There is nothing here yet"},
 "slow": {"dispatcher": {"etag": "d"}, "script": {"etag": "u"}, "entry": "{}", "bucket": [], "title": "WfP site slow", "page_status": 503}},
 "ns_list_shape": "top"}
JSON
python3 -I "$HERE/fake-account.py" "$T/port" "$T/state.json" & pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
P=$(cat "$T/port")
# shellcheck disable=SC1090
. "$LIB"
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

site_title_ok "http://127.0.0.1:$P/site/wp-one/" "WfP site one" && r=1 || r=0
ok "a site answering its own title is green" "$r"
site_title_ok "http://127.0.0.1:$P/site/wp-one/" "WfP site two" && r=1 || r=0
ok "the wrong title is not green" "$([ "$r" = 0 ] && echo 1 || echo 0)"
site_title_ok "http://127.0.0.1:$P/site/wp-broken/" "WfP site broken" && r=1 || r=0
ok "a platform placeholder title is not green" "$([ "$r" = 0 ] && echo 1 || echo 0)"
site_title_ok "http://127.0.0.1:$P/site/wp-missing/" "WfP site missing" && r=1 || r=0
ok "a 404 (missing site) is not green" "$([ "$r" = 0 ] && echo 1 || echo 0)"
site_title_ok "http://127.0.0.1:$P/site/wp-slow/" "WfP site slow" && r=1 || r=0
ok "the right title but a 503 is not green (the status matters)" "$([ "$r" = 0 ] && echo 1 || echo 0)"

# The seed writes a DISTINCT per-site key: site one's own bucket never holds
# site two's key, so A listing its own bucket cannot look like seeing B's.
k1=$(python3 -c 'import re,sys; s=open(sys.argv[1]).read(); m="_snapshots/seed-%s.txt" in s; print(1 if m else 0)' "$HERE/../snapshot.py")
k2=$(python3 -c 'import re,sys; s=open(sys.argv[1]).read(); print(1 if "wfp-isolation/seed.txt" in s else 0)' "$HERE/../snapshot.py")
ok "snapshot.py seed writes a per-site key _snapshots/seed-<site>.txt" "$k1"
ok "snapshot.py no longer writes the shared key wfp-isolation/seed.txt" "$([ "$k2" = 0 ] && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
