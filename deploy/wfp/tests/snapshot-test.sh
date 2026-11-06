#!/bin/bash
# Test of deploy/wfp/snapshot.py and lib.sh site_footprint (issue #35, slice 3)
# against fake-account.py.
#   deploy/wfp/tests/snapshot-test.sh [another snapshot.py [another lib.sh]]
# - Two snapshots of an unchanged account diff clean (with the namespace list
#   in both shapes: top-level fields and a nested "script").
# - A change to ONE part of site one fails the diff and names that part: the
#   dispatcher etag, its modified_on, the user Worker's modified_on, the map
#   entry, a bucket object added, a bucket ETag, the title.
# - An unreadable part fails as "cannot compare", never as unchanged: a
#   namespace list with no hash and no modified_on, a bucket list refused,
#   a site that is absent.
# - site_footprint: a full site, an absent site, a part left.
# Exits 0 only when every check holds. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SNAP=${1:-$HERE/../snapshot.py}
LIB=${2:-$HERE/../lib.sh}
T=$(mktemp -d)
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
cat > "$T/base.json" <<'JSON'
{"sites": {
 "one": {"dispatcher": {"etag": "d1", "modified_on": "t1"}, "script": {"etag": "u1", "modified_on": "m1"}, "entry": "{\"script\": \"site-one\"}", "bucket": [["wfp-isolation/seed.txt", "\"e1\"", "20"]], "title": "WfP site one"},
 "two": {"dispatcher": {"etag": "d1", "modified_on": "t2"}, "script": {"etag": "u2", "modified_on": "m2"}, "entry": "{\"script\": \"site-two\"}", "bucket": [["wfp-isolation/seed.txt", "\"e2\"", "20"]], "title": "WfP site two"}},
 "ns_list_shape": "top"}
JSON
cp "$T/base.json" "$T/state.json"
python3 -I "$HERE/fake-account.py" "$T/port" "$T/state.json" & pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
P=$(cat "$T/port")
export WFP_API="http://127.0.0.1:$P" WFP_S3_ENDPOINT="http://127.0.0.1:$P/s3" WFP_S3_KEY_ID=k WFP_S3_SECRET=s WFP_SITE_URL="http://127.0.0.1:$P/site/{name}"
export CLOUDFLARE_API_TOKEN=test CLOUDFLARE_ACCOUNT_ID=acc NAMESPACE=wp-wfp KV_ID=kv1 SUB=sub
take() { python3 -I "$SNAP" take "$T/$1.json" one two > /dev/null 2>&1; }
dif() { python3 -I "$SNAP" diff "$T/$1.json" "$T/$2.json" > "$T/d.txt" 2>&1; }
# set <python expression on s>: change the state from the base.
set_state() { python3 -c 'import json, sys; s = json.load(open(sys.argv[1])); exec(sys.argv[3]); json.dump(s, open(sys.argv[2], "w"))' "$T/base.json" "$T/state.json" "$1"; }

take a; take b
dif a b; ok "an unchanged account diffs clean" "$([ $? = 0 ] && grep -q '^unchanged one bucket$' "$T/d.txt" && echo 1 || echo 0)"
set_state 's["ns_list_shape"] = "nested"'; take n
dif a n; ok "the nested namespace list shape reads the same" "$([ $? = 0 ] && echo 1 || echo 0)"
for c in \
	'dispatcher|s["sites"]["one"]["dispatcher"]["etag"] = "d9"' \
	'dispatcher|s["sites"]["one"]["dispatcher"]["modified_on"] = "t9"' \
	'user_script|s["sites"]["one"]["script"]["modified_on"] = "m9"' \
	'entry|s["sites"]["one"]["entry"] = "{\"script\": \"site-two\"}"' \
	'bucket|s["sites"]["one"]["bucket"].append(["x", "\"e9\"", "1"])' \
	'bucket|s["sites"]["one"]["bucket"][0][1] = "\"e9\""' \
	'title|s["sites"]["one"]["title"] = "Hacked"'; do
	part=${c%%|*}; expr=${c#*|}
	set_state "$expr"; take c
	dif a c; rc=$?
	ok "a change to one $part ($expr) is found and named" "$([ $rc = 1 ] && grep -q "^FAIL one $part CHANGED" "$T/d.txt" && ! grep -q '^FAIL two' "$T/d.txt" && echo 1 || echo 0)"
done
for c in 'user_script|s["ns_list_shape"] = "bare"' 'bucket|s["s3_status"] = 403' 'dispatcher|del s["sites"]["two"]'; do
	part=${c%%|*}; expr=${c#*|}
	set_state "$expr"; take c
	dif a c; rc=$?
	ok "an unreadable part ($expr) fails as cannot compare" "$([ $rc = 1 ] && grep -q "cannot compare" "$T/d.txt" && echo 1 || echo 0)"
done
cp "$T/base.json" "$T/state.json"
fp() { (. "$LIB"; site_footprint "$1") 2>/dev/null; }
f1=$(fp one); f3=$(fp three)
ok "site_footprint of a full site" "$( (. "$LIB"; footprint_present "$f1") && echo 1 || echo 0)"
ok "site_footprint of an absent site" "$( (. "$LIB"; footprint_absent "$f3") && echo 1 || echo 0)"
set_state 's["sites"]["three"] = {"bucket": []}'
f3b=$(fp three)
ok "a site with only its bucket left is neither absent nor present" "$( (. "$LIB"; ! footprint_absent "$f3b" && ! footprint_present "$f3b") && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
