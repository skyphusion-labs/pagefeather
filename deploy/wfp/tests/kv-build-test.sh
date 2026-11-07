#!/bin/bash
# Test of kv_build.py and lib.sh entry_build (issue #35 slice 5): read the
# "build" field of a site map entry. This is the update_one path the all-sites
# stub test never exercised (a syntax-level bug reached a live run, 2026-11-06).
#   deploy/wfp/tests/kv-build-test.sh [another lib.sh]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
WFP=$(cd "$HERE/.." && pwd)
T=$(mktemp -d)
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
kb() { printf '%s' "$1" | python3 "$WFP/kv_build.py"; }

# kv_build.py directly (real double-quotes; a literal trailing code line).
ok "a real entry with a trailing code line -> the build" "$([ "$(kb '{"script":"site-one","build":"bld-1"}
200')" = bld-1 ] && echo 1 || echo 0)"
ok "a 404 error body -> empty" "$([ -z "$(kb '{"success":false}
404')" ] && echo 1 || echo 0)"
ok "no build field -> empty" "$([ -z "$(kb '{"script":"site-one"}
200')" ] && echo 1 || echo 0)"
ok "not JSON -> empty" "$([ -z "$(kb 'nonsense
200')" ] && echo 1 || echo 0)"
ok "empty -> empty" "$([ -z "$(kb '')" ] && echo 1 || echo 0)"

# entry_build end to end against the fake account. WFP_API must be set BEFORE
# lib.sh is sourced (api reads it at source time).
cat > "$T/state.json" <<'JSON'
{"sites": {"one": {"dispatcher": {"etag": "d"}, "script": {"etag": "u"}, "entry": "{\"script\": \"site-one\", \"build\": \"bld-xyz\", \"outbound\": true}", "bucket": [], "title": "WfP site one"},
           "two": {"dispatcher": {"etag": "d"}, "script": {"etag": "u"}, "entry": "{\"script\": \"site-two\", \"outbound\": true}", "bucket": [], "title": "WfP site two"}},
 "ns_list_shape": "top"}
JSON
python3 -I "$HERE/fake-account.py" "$T/port" "$T/state.json" >/dev/null 2>&1 & pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
b1=$(WFP_API="http://127.0.0.1:$(cat "$T/port")" CLOUDFLARE_API_TOKEN=t KV_ID=kv1 SUB=sub bash -c '. "'"$LIB"'"; entry_build one')
b2=$(WFP_API="http://127.0.0.1:$(cat "$T/port")" CLOUDFLARE_API_TOKEN=t KV_ID=kv1 SUB=sub bash -c '. "'"$LIB"'"; entry_build two')
ok "entry_build one -> its recorded build (got [$b1])" "$([ "$b1" = bld-xyz ] && echo 1 || echo 0)"
ok "entry_build two (no build field) -> empty (got [$b2])" "$([ -z "$b2" ] && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
