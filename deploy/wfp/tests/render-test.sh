#!/bin/bash
# Test of the rendered configs of deploy/wfp (issue #35), offline.
#   deploy/wfp/tests/render-test.sh [another lib.sh]
# - The dispatcher copies are ONE config (condition a): two sites' configs
#   differ in exactly one line, the name; no placeholder is left; both parse as
#   TOML and bind the site map, the namespace twice and the outbound Worker.
# - The user Worker config: its name, origin and bucket; the b-dosql Durable
#   Object and migration; the Workers Cache on; no workers.dev name.
# - valid_site: the names it takes and refuses.
# Exits 0 only when every check holds. Needs bash, python3 (tomllib).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
# shellcheck disable=SC1090
. "$LIB"
# A python3 with tomllib (3.11 or later); fail, never skip, without one.
PY=""
for p in "${PY_TOML:-}" python3 python3.14 python3.13 python3.12 python3.11; do
	[ -n "$p" ] && command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tomllib' 2>/dev/null && { PY=$p; break; }
done
[ -n "$PY" ] || { echo "FAIL no python3 with tomllib (3.11 or later) on PATH"; exit 1; }
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
render_dispatcher one kv123 > "$T/one.toml"
render_dispatcher two kv123 > "$T/two.toml"
render_dispatcher probe kv123 > "$T/probe.toml"
d=$(diff "$T/one.toml" "$T/two.toml" | grep -c '^[<>]')
ok "two sites' dispatcher configs differ in exactly one line each way (got $d)" "$([ "$d" = 2 ] && echo 1 || echo 0)"
ok "and that line is the name" "$(diff "$T/one.toml" "$T/two.toml" | grep '^[<>]' | grep -cv '^[<>] name = "wp-\(one\|two\)"$' | grep -qx 0 && echo 1 || echo 0)"
ok "no placeholder is left" "$(grep -q '@[A-Z_]*@' "$T/one.toml" "$T/probe.toml" && echo 0 || echo 1)"
ok "the dispatcher config parses and binds the map, the namespace twice and the outbound Worker" "$("$PY" -c '
import sys, tomllib
c = tomllib.load(open(sys.argv[1], "rb"))
ns = c["dispatch_namespaces"]
good = (c["name"] == "wp-one" and c["workers_dev"] is True and c["kv_namespaces"] == [{"binding": "SITES", "id": "kv123"}]
        and [n["binding"] for n in ns] == ["DISPATCHER", "DISPATCHER_OUT"] and all(n["namespace"] == "wp-wfp" for n in ns)
        and ns[1]["outbound"] == {"service": "wp-wfp-outbound", "parameters": ["SITE"]} and "outbound" not in ns[0])
print(1 if good else 0)' "$T/one.toml")"
render_user one https://wp-one.sub.workers.dev > "$T/user.toml"
ok "the user Worker config" "$("$PY" -c '
import sys, tomllib
c = tomllib.load(open(sys.argv[1], "rb"))
v = c["vars"]
good = (c["name"] == "site-one" and "workers_dev" not in c and c["cache"] == {"enabled": True}
        and c["exports"]["Pages"]["cache"] == {"enabled": True} and c["exports"]["default"]["cache"] == {"enabled": False}
        and v["SITE_ORIGIN"] == "https://wp-one.sub.workers.dev" and v["PHP_IN_DO"] == "on" and v["DB_IN_DO"] == "on"
        and c["r2_buckets"] == [{"binding": "MEDIA", "bucket_name": "wp-wfp-one-media"}]
        and c["durable_objects"]["bindings"] == [{"name": "PHP_RUNTIME", "class_name": "PhpRuntime"}]
        and c["migrations"] == [{"tag": "v1", "new_sqlite_classes": ["PhpRuntime"]}] and c["main"] == "index.js")
print(1 if good else 0)' "$T/user.toml")"
okn=1
for n in one two a-b a1 x23456789012345678901234567890; do valid_site "$n" || { okn=0; echo "  valid_site refused $n"; }; done
for n in "" -a a- A a_b a.b probe x234567890123456789012345678901; do valid_site "$n" && { okn=0; echo "  valid_site took '$n'"; }; done
ok "valid_site takes 1 to 30 of [a-z0-9-] with no end hyphen, not probe" "$okn"
echo "$fails failing check(s)"
exit $fails
