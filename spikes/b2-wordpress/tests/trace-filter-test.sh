#!/usr/bin/env bash
# trace-filter.py (#394, approach A): a file trace recorded on the D1 build, cut to the files the
# approach-A zips hold, so opcache-remote.py and site-remote.py accept it. Offline, with small
# synthetic zips and the REAL pack scripts. The control first: the unfiltered D1 trace is REFUSED
# by opcache-remote.py ("is not in"). That is the refusal the filter exists for.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/trace-filter-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
OC=opcache:/internal/shared/opcache/
mk() { # mk <dir>: an approach-A build/ (db.php.bin removed, hyperdrive-*.php present) and a D1 trace
  rm -rf "$1"; mkdir -p "$1/build/public"
  python3 -I - "$1/build" <<'PY'
import json, os, sys, zipfile
b = sys.argv[1]
with zipfile.ZipFile(os.path.join(b, 'opcache.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    for n in ('sys1/wordpress/index.php.bin', 'sys1/wordpress/wp-load.php.bin', 'sys1/wordpress/wp-admin/post-new.php.bin'):
        z.writestr(n, b'compiled ' + n.encode())
with zipfile.ZipFile(os.path.join(b, 'site.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    for n in ('index.php', 'wp-load.php', 'wp-content/db.php', 'wp-content/hyperdrive-mysqli.php', 'wp-admin/post-new.php'):
        z.writestr(n, '<?php // ' + n)
open(os.path.join(b, 'build-id.js'), 'w').write('export default "t394a-1";\n')
OC = 'opcache:/internal/shared/opcache/'
boot = {'boot': True, 'reads': [[OC + 'sys1/wordpress/index.php.bin', 9], [OC + 'sys1/wordpress/wp-content/db.php.bin', 7],
                               ['site:/index.php', 3], ['site:/wp-content/db.php', 5], ['site:/wp-content/d1-pdo.php', 4],
                               ['site-open:/wp-content/d1-dialect.php', 4], ['site-open:/index.php', 3], ['memfs:/tmp/x', 1]]}
warm = {'boot': False, 'reads': [[OC + 'sys1/wordpress/wp-admin/post-new.php.bin', 8], ['site:/wp-content/plugins/sqlite-database-integration/load.php', 6],
                                 ['site:/wp-admin/post-new.php', 2]]}
json.dump({'on': True, 'dropped': 0, 'requests': [boot, warm]}, open(os.path.join(b, 'file-trace.json'), 'w'))
PY
}
mk "$T/a"
# Control: the D1 trace as it is. opcache-remote.py must refuse it, or this test proves nothing.
python3 -I opcache-remote.py "$T/a/build/opcache.zip" "$T/a/build/file-trace.json" "$T/a/build/build-id.js" > "$T/ctl.out" 2>&1; rc=$?
ok "control: opcache-remote.py refuses the unfiltered D1 trace (rc $rc)" "$([ $rc != 0 ] && grep -q 'is not in' "$T/ctl.out" && echo 1 || echo 0)"

# The filter.
python3 -I trace-filter.py "$T/a/build/file-trace.json" "$T/a/build/opcache.zip" "$T/a/build/site.zip" "$T/a/f.json" > "$T/f.out" 2>&1; rc=$?
ok "trace-filter.py exits 0 (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
keys() { python3 -I -c 'import json, sys; print("\n".join(k for r in json.load(open(sys.argv[1]))["requests"] for k, _ in r["reads"]))' "$1" 2>/dev/null; }
K=$(keys "$T/a/f.json")
ok "it drops the D1-only OPcache entry (db.php.bin)" "$([ -n "$K" ] && ! grep -q wp-content/db.php.bin <<<"$K" && echo 1 || echo 0)"
ok "it drops the D1-only site reads and opens (d1-pdo.php, d1-dialect.php, the sqlite plugin)" "$([ -n "$K" ] && ! grep -qE "d1-pdo|d1-dialect|sqlite-database-integration" <<<"$K" && echo 1 || echo 0)"
ok "it keeps every read the A zips hold, in order" "$([ "$(grep -E '^(opcache|site)' <<<"$K" | tr '\n' ' ')" = "${OC}sys1/wordpress/index.php.bin site:/index.php site:/wp-content/db.php site-open:/index.php ${OC}sys1/wordpress/wp-admin/post-new.php.bin site:/wp-admin/post-new.php " ] && echo 1 || echo 0)"
ok "it keeps keys that are not bundle files (memfs:)" "$(grep -qx 'memfs:/tmp/x' <<<"$K" && echo 1 || echo 0)"
ok "it keeps on, the boot flags and the request count" "$(python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); print(int(d["on"] is True and [r["boot"] for r in d["requests"]] == [True, False]))' "$T/a/f.json" 2>/dev/null)"
ok "it reports what it dropped" "$(grep -qE 'dropped 1 OPcache and 3 site' "$T/f.out" && echo 1 || echo 0)"

# The real pack scripts accept the filtered trace, and every file of the A zips is in a pack.
cp "$T/a/f.json" "$T/a/build/file-trace.json"
python3 -I opcache-remote.py "$T/a/build/opcache.zip" "$T/a/build/file-trace.json" "$T/a/build/build-id.js" > "$T/oc.out" 2>&1; rc=$?
ok "opcache-remote.py accepts the filtered trace (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
python3 -I site-remote.py "$T/a/build/site.zip" "$T/a/build/file-trace.json" "$T/a/build/build-id.js" > "$T/st.out" 2>&1; rc=$?
ok "site-remote.py accepts the filtered trace (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
idx() { sed -e 's/^export default //' -e 's/;$//' "$1"; }
ok "every OPcache file of the A build is in a pack (3)" "$(idx "$T/a/build/opcache-remote-index.js" | python3 -I -c 'import json, sys; print(int(len(json.load(sys.stdin)["files"]) == 3))' 2>/dev/null)"
ok "every site file of the A build is in a pack, hyperdrive-mysqli.php too (5)" "$(idx "$T/a/build/site-remote-index.js" | python3 -I -c 'import json, sys; f = json.load(sys.stdin)["files"]; print(int(len(f) == 5 and "wp-content/hyperdrive-mysqli.php" in f))' 2>/dev/null)"

# Refusals: a trace not recorded with FILE_TRACE=on, a trace with no boot request, bad arguments.
mk "$T/b"
python3 -I -c 'import json, sys; p = sys.argv[1]; d = json.load(open(p)); d["on"] = False; json.dump(d, open(p, "w"))' "$T/b/build/file-trace.json"
python3 -I trace-filter.py "$T/b/build/file-trace.json" "$T/b/build/opcache.zip" "$T/b/build/site.zip" "$T/b/f.json" > "$T/b.out" 2>&1; rc=$?
ok "refuses a trace recorded without FILE_TRACE=on (rc $rc)" "$([ $rc = 2 ] && grep -q "FILE_TRACE=on" "$T/b.out" && [ ! -e "$T/b/f.json" ] && echo 1 || echo 0)"
mk "$T/c"
python3 -I -c 'import json, sys; p = sys.argv[1]; d = json.load(open(p)); d["requests"] = [r for r in d["requests"] if not r["boot"]]; json.dump(d, open(p, "w"))' "$T/c/build/file-trace.json"
python3 -I trace-filter.py "$T/c/build/file-trace.json" "$T/c/build/opcache.zip" "$T/c/build/site.zip" "$T/c/f.json" > "$T/c.out" 2>&1; rc=$?
ok "refuses a trace with no booting request (rc $rc)" "$([ $rc = 2 ] && grep -q "no booting request" "$T/c.out" && [ ! -e "$T/c/f.json" ] && echo 1 || echo 0)"
python3 -I trace-filter.py "$T/a/f.json" > "$T/u.out" 2>&1; rc=$?
ok "refuses missing arguments (rc $rc)" "$([ $rc = 2 ] && grep -q usage "$T/u.out" && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
