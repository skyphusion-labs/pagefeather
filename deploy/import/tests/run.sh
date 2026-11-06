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

echo "work files: $T"
[ "$fails" = 0 ] || { echo "$fails failed"; exit 1; }
echo "all passed"
