#!/bin/bash
# Offline tests of deploy/import (issue #31). No Worker, no network.
#   deploy/import/tests/run.sh
# Needs php (pdo_sqlite), python3, sqlite3, and the SQLite driver checkout at
# SQLITE_DI_REF in spikes/b2-wordpress/build/cache/sqlite-database-integration
# (as in CI).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMP=$(cd "$HERE/.." && pwd)
DRV=$(cd "$IMP/../.." && pwd)/spikes/b2-wordpress/build/cache/sqlite-database-integration
[ -f "$DRV/packages/mysql-on-sqlite/src/load.php" ] || { echo "no driver at $DRV" >&2; exit 2; }
T=$(mktemp -d "${TMPDIR:-/tmp}/wp-import-test.XXXXXX")
S3PID=""
# KEEP=1 keeps the work files to look at them.
cleanup() {
  if [ -n "$S3PID" ]; then kill "$S3PID" 2>/dev/null || true; wait "$S3PID" 2>/dev/null || true; fi
  if [ -n "${KEEP:-}" ]; then echo "work files: $T"; else rm -rf "${T:?}"; fi
}
trap cleanup EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }

# 1. A mysqldump with the prefix wpx_.
php "$IMP/dump-to-sqlite.php" "$DRV" "$HERE/fixture.sql" "$T/fx.sqlite" > "$T/report.json"
r() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [v := v[k] for k in sys.argv[2:]]; print(json.dumps(v, sort_keys=True))' "$T/report.json" "$@"; }
check "prefix found" "$(r prefix)" '"wpx_"'
check "rows per table" "$(r rows)" '{"custom_log": 1, "wp_blobs": 4, "wp_options": 12, "wp_posts": 4, "wp_usermeta": 4}'
check "prefixed keys changed" "$(r keys_changed)" '{"options": 1, "usermeta": 2}'
check "table without prefix kept" "$(r without_prefix)" '["custom_log"]'
check "active plugins read" "$(r site active_plugins)" '["akismet/akismet.php", "woocommerce/woocommerce.php"]'
q() { sqlite3 "$T/fx.sqlite" "$1"; }
check "row with id 0 kept" "$(q 'SELECT post_title FROM wp_posts WHERE ID = 0')" "Zero"
check "blob bytes" "$(q 'SELECT hex(data) FROM wp_blobs WHERE id = 1')" "005C27221A"
check "empty blob is not NULL" "$(q 'SELECT data IS NULL FROM wp_blobs WHERE id = 4')" "0"
check "UTF-8 bytes" "$(q "SELECT hex(option_value) FROM wp_options WHERE option_name = 'emoji'")" "436166C3A920F09F9880"
check "semicolon at line end in a string" "$(q "SELECT hex(option_value) FROM wp_options WHERE option_name = 'line_end_semicolon'")" "656E6473207769746820612073656D69636F6C6F6E3B0A616E642061206E65776C696E653B"
check "raw newline after a semicolon in a string" "$(q "SELECT hex(option_value) FROM wp_options WHERE option_name = 'raw_newline'")" "$(printf 'a raw newline after a semicolon;\nis still one string' | xxd -p | tr -d '\n' | tr a-f A-F)"
check "user_roles renamed" "$(q "SELECT count(*) FROM wp_options WHERE option_name = 'wp_user_roles'")" "1"
check "meta key not starting with the prefix kept" "$(q "SELECT count(*) FROM wp_usermeta WHERE meta_key = 'not_wpx_key'")" "1"

# 2. Refusals.
set +e
php "$IMP/dump-to-sqlite.php" "$DRV" "$HERE/fixture-binary.sql" "$T/fb.sqlite" > /dev/null 2> "$T/fb.err"; code=$?
set -e
check "_binary: exit 1" "$code" "1"
check "_binary: says --hex-blob" "$(grep -c -- '--hex-blob' "$T/fb.err" || true)" "1"
set +e
php "$IMP/dump-to-sqlite.php" "$DRV" "$HERE/fixture-multisite.sql" "$T/fm.sqlite" > /dev/null 2> "$T/fm.err"; code=$?
set -e
check "multisite: exit 1" "$code" "1"
check "multisite: says so" "$(grep -c 'multisite' "$T/fm.err" || true)" "1"

# 3. The site address.
python3 "$IMP/search-replace.py" "$T/fx.sqlite" https://old.example.com https://wp.acct.workers.dev > "$T/replace.json"
check "serialized widget" "$(q "SELECT option_value FROM wp_options WHERE option_name = 'widget_text'")" 'a:1:{i:2;a:1:{s:4:"text";s:47:"See https://wp.acct.workers.dev/about for more.";}}'
check "home" "$(q "SELECT option_value FROM wp_options WHERE option_name = 'home'")" "https://wp.acct.workers.dev"
check "guid kept" "$(q 'SELECT guid FROM wp_posts WHERE ID = 1')" "https://old.example.com/?p=1"
python3 "$HERE/test_search_replace.py" 2> "$T/unit.err" || { cat "$T/unit.err"; fails=$((fails + 1)); }
check "search-replace unit tests" "$(tail -1 "$T/unit.err")" "OK"

# 4. To a dbmove dump and back to counts.
python3 "$IMP/dbmove-file.py" from-sqlite "$T/fx.sqlite" "$T/fx.jsonl" > /dev/null
python3 "$IMP/dbmove-file.py" counts "$T/fx.jsonl" > "$T/counts.json"
check "dump rows match the SQLite rows" "$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["rows"]; r=json.load(open(sys.argv[2]))["rows"]; print(all(c.get(k)==v for k,v in r.items()))' "$T/counts.json" "$T/report.json")" "True"
check "blob in the dump" "$(grep -cF -e "\"\$b\":\"AFwnIho=\"" "$T/fx.jsonl" || true)" "1"

# 5. A wp-content archive: extracted only when it is safe.
python3 -I - "$T" <<'PY'
import io, os, sys, tarfile
t = sys.argv[1]
def add(tar, name, data=b"x", **kw):
    i = tarfile.TarInfo(name); i.size = len(data)
    for k, v in kw.items(): setattr(i, k, v)
    tar.addfile(i, io.BytesIO(data) if i.isfile() else None)
with tarfile.open(os.path.join(t, "good.tar.gz"), "w:gz") as tar:
    for n, d in [("wp-content/themes/child/style.css", b"/* Theme Name: Child */"), ("wp-content/themes/child/functions.php", b"<?php"),
                 ("wp-content/plugins/shop/shop.php", b"<?php"), ("wp-content/plugins/hello.php", b"<?php"),
                 ("wp-content/plugins/sqlite-database-integration/load.php", b"<?php // source copy"),
                 ("wp-content/uploads/2026/01/a b.jpg", b"\xff\xd8jpeg"), ("wp-content/uploads/2026/01/doc.pdf", b"%PDF-1"),
                 ("wp-content/uploads/.htaccess", b"deny"), ("wp-content/uploads/shell.php", b"<?php"),
                 ("wp-content/mu-plugins/host.php", b"<?php"), ("wp-content/object-cache.php", b"<?php"),
                 ("._wp-content", b"\x00\x05\x16\x07"), ("wp-content/plugins/._hello.php", b"\x00\x05\x16\x07")]:
        add(tar, n, d, mode=0o4755 if n.endswith("functions.php") else 0o644)
bad = {"symlink": dict(type=tarfile.SYMTYPE, linkname="/etc/passwd"), "hardlink": dict(type=tarfile.LNKTYPE, linkname="wp-content/x")}
for name, kw in bad.items():
    with tarfile.open(os.path.join(t, name + ".tar"), "w") as tar:
        add(tar, "wp-content/a.txt"); add(tar, "wp-content/plugins/evil", b"", **kw)
for name, path in {"dotdot": "wp-content/../../evil.txt", "absolute": "/tmp/evil.txt"}.items():
    with tarfile.open(os.path.join(t, name + ".tar"), "w") as tar:
        add(tar, path)
PY
python3 -I "$IMP/untar.py" "$T/good.tar.gz" "$T/src" > "$T/untar.json"
check "archive: files" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["files"])' "$T/untar.json")" "11"
check "archive: top wp-content/ stripped" "$([ -f "$T/src/wp-content/plugins/hello.php" ] && echo yes)" "yes"
check "archive: macOS ._ files skipped" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["skipped_macos"])' "$T/untar.json"):$(find "$T/src" -name '._*' | wc -l | tr -d ' ')" "2:0"
check "archive: setuid bit dropped" "$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o7777))' "$T/src/wp-content/themes/child/functions.php")" "0o755"
for b in symlink hardlink dotdot absolute; do
  set +e; python3 -I "$IMP/untar.py" "$T/$b.tar" "$T/out-$b" > /dev/null 2> "$T/untar-$b.err"; code=$?; set -e
  check "archive: $b refused" "$code:$(find "$T/out-$b" -type f 2>/dev/null | wc -l | tr -d ' ')" "1:0"
done

# 6. Theme and plugins into a build tree.
B="$T/build/wp-content"; mkdir -p "$B/themes" "$B/plugins/sqlite-database-integration" "$B/plugins/shop"
echo "<?php // build copy" > "$B/plugins/sqlite-database-integration/load.php"; echo old > "$B/plugins/shop/old.txt"
IMPORT_THEMES="child" IMPORT_PLUGINS="shop hello.php sqlite-database-integration" "$IMP/content.sh" "$T/src/wp-content" "$B" 2> "$T/content.out"
check "content: theme copied" "$([ -f "$B/themes/child/style.css" ] && echo yes)" "yes"
check "content: plugin replaced (no old file)" "$([ -f "$B/plugins/shop/shop.php" ] && [ ! -e "$B/plugins/shop/old.txt" ] && echo yes)" "yes"
check "content: one-file plugin" "$([ -f "$B/plugins/hello.php" ] && echo yes)" "yes"
check "content: sqlite-database-integration kept" "$(cat "$B/plugins/sqlite-database-integration/load.php")" "<?php // build copy"
check "content: drop-in not copied" "$([ ! -e "$B/object-cache.php" ] && grep -c 'drop-ins in the source, NOT copied (the build has its own): object-cache.php' "$T/content.out")" "1"
check "content: mu-plugins listed, not copied" "$([ ! -e "$B/mu-plugins" ] && grep -c 'mu-plugins in the source, NOT copied.*host.php' "$T/content.out")" "1"
ln -s /etc "$T/src/wp-content/plugins/shop/etc"
set +e; IMPORT_PLUGINS="shop" "$IMP/content.sh" "$T/src/wp-content" "$B" 2> /dev/null; code=$?; set -e
check "content: symbolic link refused" "$code" "1"
rm "$T/src/wp-content/plugins/shop/etc"
# The bad names point at paths that exist, so only the name check refuses them.
mkdir -p "$T/src/wp-content/x" "$T/src/wp-content/plugins/shop/sub"
for bad in "../x" "shop/sub" ".."; do
  set +e; IMPORT_PLUGINS="$bad" "$IMP/content.sh" "$T/src/wp-content" "$B" 2> /dev/null; code=$?; set -e
  check "content: name '$bad' refused" "$code" "1"
done

# 7. Uploads: the list, then the upload loop against a stand-in for S3.
"$IMP/media.sh" --list "$T/src/wp-content" > "$T/media.list" 2> "$T/media.skipped"
check "media: keys" "$(cut -f1,3 "$T/media.list" | tr '\t\n' ' ;')" "uploads/2026/01/a%20b.jpg image/jpeg;uploads/2026/01/doc.pdf application/pdf;"
check "media: skipped" "$(cat "$T/media.skipped")" "# skipped php=1 dot=1 long=0"
python3 -I "$HERE/fake-s3.py" "$T/s3.port" "$T/s3.log" & S3PID=$!
for _ in $(seq 1 50); do [ -s "$T/s3.port" ] && break; sleep 0.1; done
EP="http://127.0.0.1:$(cat "$T/s3.port")"
R2_KEY_ID=test R2_SECRET=test "$IMP/media.sh" "$EP" bucket "$T/src/wp-content" > "$T/media1.out"
check "media: first run" "$(tail -1 "$T/media1.out")" "media: 2 sent, 0 already there, 0 failed"
R2_KEY_ID=test R2_SECRET=test "$IMP/media.sh" "$EP" bucket "$T/src/wp-content" > "$T/media2.out"
check "media: second run sends nothing" "$(tail -1 "$T/media2.out")" "media: 0 sent, 2 already there, 0 failed"
check "media: stored key, size and type" "$(python3 -c 'import json,sys; print(sorted((o["key"],o["size"],o["type"]) for o in map(json.loads, open(sys.argv[1]))))' "$T/s3.log")" "[('uploads/2026/01/a b.jpg', 6, 'image/jpeg'), ('uploads/2026/01/doc.pdf', 6, 'application/pdf')]"

[ "$fails" = 0 ] || { echo "$fails failed"; exit 1; }
echo "all passed"
