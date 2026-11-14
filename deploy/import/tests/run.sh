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
  # The SSH test makes read-only trees: give write back first.
  chmod -R u+w "${T:?}" 2>/dev/null || true
  if [ -n "${KEEP:-}" ]; then echo "work files: $T"; else rm -rf "${T:?}"; fi
}
trap cleanup EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }

# 1. A mysqldump with the prefix wpx_.
php "$IMP/dump-to-sqlite.php" "$DRV" "$HERE/fixture.sql" "$T/fx.sqlite" > "$T/report.json"
r() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [v := v[k] for k in sys.argv[2:]]; print(json.dumps(v, sort_keys=True))' "$T/report.json" "$@"; }
check "prefix found" "$(r prefix)" '"wpx_"'
check "rows per table" "$(r rows)" '{"custom_log": 1, "wp_blobs": 4, "wp_options": 12, "wp_posts": 4, "wp_usermeta": 5}'
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
python3 "$HERE/test_user_agent.py" 2> "$T/ua.err" || { cat "$T/ua.err"; fails=$((fails + 1)); }
check "dbmove.py sends its own User-Agent" "$(tail -1 "$T/ua.err")" "OK"

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
check "content: mu-plugins listed, not copied" "$([ ! -e "$B/mu-plugins" ] && grep -c 'mu-plugins in the source, NOT copied unless named.*host.php' "$T/content.out")" "1"
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
# 6b. mu-plugins by name, after the build's own (content.sh --mu).
MB="$T/mubuild/wp-content"; mkdir -p "$MB/mu-plugins"; echo "<?php // framework copy" > "$MB/mu-plugins/edge-cache.php"
"$IMP/content.sh" --mu "$T/src/wp-content" "$MB" 2> "$T/mu0.out"
check "mu: none named, none copied" "$(find "$MB/mu-plugins" -type f | sed "s|$MB/mu-plugins/||" | sort | tr '\n' ' ')" "edge-cache.php "
IMPORT_MU_PLUGINS="host.php" "$IMP/content.sh" --mu "$T/src/wp-content" "$MB" 2> "$T/mu1.out"
check "mu: named file copied" "$(cmp -s "$T/src/wp-content/mu-plugins/host.php" "$MB/mu-plugins/host.php" && echo same)" "same"
echo "<?php // the site's" > "$T/src/wp-content/mu-plugins/edge-cache.php"
set +e; IMPORT_MU_PLUGINS="edge-cache.php" "$IMP/content.sh" --mu "$T/src/wp-content" "$MB" 2> "$T/mu2.err"; code=$?; set -e
check "mu: a name the build has is refused, the build copy kept" "$code:$(cat "$MB/mu-plugins/edge-cache.php"):$(grep -c 'the build has its own' "$T/mu2.err" || true)" "1:<?php // framework copy:1"
rm "$T/src/wp-content/mu-plugins/edge-cache.php"
set +e; IMPORT_MU_PLUGINS="nothere.php" "$IMP/content.sh" --mu "$T/src/wp-content" "$MB" 2> /dev/null; code=$?; set -e
check "mu: a missing name refused" "$code" "1"
for bad in "../x" "a/b" ".."; do
  set +e; IMPORT_MU_PLUGINS="$bad" "$IMP/content.sh" --mu "$T/src/wp-content" "$MB" 2> /dev/null; code=$?; set -e
  check "mu: name '$bad' refused" "$code" "1"
done
mkdir -p "$T/src/wp-content/mu-plugins/linked"; ln -s /etc "$T/src/wp-content/mu-plugins/linked/etc"
set +e; IMPORT_MU_PLUGINS="linked" "$IMP/content.sh" --mu "$T/src/wp-content" "$MB" 2> /dev/null; code=$?; set -e
check "mu: symbolic link refused, nothing copied" "$code:$([ -e "$MB/mu-plugins/linked" ] && echo copied || echo none)" "1:none"
rm "$T/src/wp-content/mu-plugins/linked/etc"; rmdir "$T/src/wp-content/mu-plugins/linked"

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

# 9. Variant a: mysql-prepare.py (the statements /_sqlimport runs).
cp "$IMP/../../spikes/b2-wordpress/sql-import.js" "$T/sql-import.mjs"
python3 "$IMP/mysql-prepare.py" "$HERE/fixture.sql" "$T/my.jsonl" --prefix wpx_ --to-prefix wp_ --flavour mysql --max-statement 1048576 --old https://old.example.com --new https://wp.acct.workers.dev > "$T/my.json"
j() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [v := v[k] for k in sys.argv[2:]]; print(json.dumps(v, sort_keys=True))' "$T/my.json" "$@"; }
check "mysql: rows per table" "$(j rows)" '{"wp_blobs": 4, "wp_options": 12, "wp_posts": 4, "wp_usermeta": 5}'
check "mysql: table without the prefix skipped" "$(j skipped_tables)" '{"custom_log": 3}'
check "mysql: keys renamed" "$(j changed user_roles):$(j changed usermeta_keys)" "1:2"
check "mysql: every statement passes the endpoint check" "$(node "$HERE/sqlimport-file.mjs" "$T/sql-import.mjs" "$T/my.jsonl" | tail -1)" "14 statements, 0 refused"
sq() { python3 -c 'import json,sys; print(sum(1 for l in open(sys.argv[1]) if sys.argv[2] in json.loads(l)["sql"]))' "$T/my.jsonl" "$1"; }
# shellcheck disable=SC2016 # backticks are SQL here
check "mysql: table names renamed" "$(sq 'INTO `wpx_'):$(sq 'TABLE `wpx_'):$(sq 'INTO `wp_options`')" "0:0:2"
check "mysql: prefix in content kept" "$(sq 'see the wpx_options table and wpx_user_roles')" "1"
check "mysql: user_roles key" "$(sq "'wp_user_roles'"):$(sq "'wpx_user_roles'")" "1:0"
check "mysql: meta key not starting with the prefix kept" "$(sq "'not_wpx_key'")" "1"
check "mysql: SET_VAR hint on every INSERT" "$(sq 'INSERT /*+ SET_VAR(sql_mode='"'"'NO_AUTO_VALUE_ON_ZERO'"'"') */ INTO'):$(sq 'INSERT')" "6:6"
check "mysql: address changed, guid kept" "$(sq 'https://wp.acct.workers.dev/hello/'):$(sq 'https://old.example.com/?p=1')" "1:1"
check "mysql: row with id 0 kept as 0" "$(sq "(0,0,'0000-00-00 00:00:00','row with id zero'")" "1"
python3 "$IMP/mysql-prepare.py" "$HERE/fixture.sql" "$T/maria.jsonl" --prefix wpx_ --to-prefix wp_ --flavour mariadb --max-statement 1048576 > /dev/null
check "mariadb: SET STATEMENT on every INSERT" "$(python3 -c 'import json,sys; L=[json.loads(l)["sql"] for l in open(sys.argv[1])]; print(sum(s.startswith("SET STATEMENT sql_mode='"'"'NO_AUTO_VALUE_ON_ZERO'"'"' FOR INSERT INTO") for s in L), sum("INSERT" in s for s in L))' "$T/maria.jsonl")" "6 6"
check "mariadb: passes the endpoint check" "$(node "$HERE/sqlimport-file.mjs" "$T/sql-import.mjs" "$T/maria.jsonl" | tail -1)" "14 statements, 0 refused"
NO_HINT=1 python3 "$IMP/mysql-prepare.py" "$HERE/fixture.sql" "$T/nohint.jsonl" --prefix wpx_ --to-prefix wp_ --flavour mysql --max-statement 1048576 > /dev/null
check "mysql: NO_HINT=1 leaves the hint out (red control)" "$(grep -c 'NO_AUTO_VALUE_ON_ZERO' "$T/nohint.jsonl" || true)" "0"
python3 "$IMP/mysql-prepare.py" "$HERE/fixture.sql" "$T/split.jsonl" --prefix wpx_ --to-prefix wp_ --flavour mysql --max-statement 4096 > "$T/split.json"
check "mysql: INSERTs split at --max-statement" "$(python3 -c 'import json,sys; L=[json.loads(l)["sql"].encode() for l in open(sys.argv[1])]; print(max(len(s) for s in L) <= 4096, sum(s.startswith(b"INSERT") for s in L) > 5, json.load(open(sys.argv[2]))["rows"]["wp_options"])' "$T/split.jsonl" "$T/split.json")" "True True 12"
# shellcheck disable=SC2016 # backticks are SQL here
printf '%s\n' 'CREATE TABLE `wp_b` (' '  `id` int NOT NULL,' '  `data` longblob' ');' "INSERT INTO \`wp_b\` VALUES (1,_binary 'ab');" > "$T/binary.sql"
set +e; python3 "$IMP/mysql-prepare.py" "$T/binary.sql" "$T/b.jsonl" --prefix wp_ --to-prefix wp_ --flavour mysql --max-statement 1048576 > /dev/null 2> "$T/b.err"; code=$?; set -e
check "mysql: _binary refused with --hex-blob advice" "$code:$(grep -c -- '--hex-blob' "$T/b.err" || true)" "1:1"
# #487: the TARGET site's prefix, not a fixed wp_ (a store of the one-click manager is wp_<name>_).
# The fixture has 4 tables with the prefix wpx_ (custom_log has none and is skipped).
python3 "$IMP/mysql-prepare.py" "$HERE/fixture.sql" "$T/ggc.jsonl" --prefix wpx_ --to-prefix wp_ggc_ --flavour mysql --max-statement 1048576 > "$T/ggc.json"
gq() { python3 -c 'import json,sys; print(sum(1 for l in open(sys.argv[1]) if sys.argv[2] in json.loads(l)["sql"]))' "$T/ggc.jsonl" "$1"; }
# shellcheck disable=SC2016 # backticks are SQL here
check "mysql --to-prefix wp_ggc_: tables become wp_ggc_, none stays wp_ or wpx_" "$(gq 'INTO `wp_ggc_options`'):$(gq 'TABLE `wp_ggc_'):$(gq 'INTO `wp_options`'):$(gq 'INTO `wpx_')" "2:4:0:0"
check "mysql --to-prefix wp_ggc_: user_roles key follows the target prefix" "$(gq "'wp_ggc_user_roles'"):$(gq "'wp_user_roles'")" "1:0"
check "mysql --to-prefix wp_ggc_: rows per table under the new names" "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["rows"], sort_keys=True))' "$T/ggc.json")" '{"wp_ggc_blobs": 4, "wp_ggc_options": 12, "wp_ggc_posts": 4, "wp_ggc_usermeta": 5}'
set +e; python3 "$IMP/mysql-prepare.py" "$HERE/fixture.sql" "$T/badp.jsonl" --prefix wpx_ --to-prefix 'wp-bad' --flavour mysql --max-statement 1048576 > /dev/null 2>&1; code=$?; set -e
check "mysql --to-prefix: a bad prefix is refused" "$code" "1"
node "$HERE/sqlimport-check.mjs" "$T/sql-import.mjs" > "$T/check.out" || true
check "sql-import.js checkStatement cases" "$(tail -1 "$T/check.out")" "all passed"
node "$HERE/sqlimport-endpoint.mjs" "$T/sql-import.mjs" > "$T/endpoint.out" || true
check "sql-import.js endpoint rules" "$(tail -1 "$T/endpoint.out")" "all passed"
node "$HERE/sqlimport-prefix.mjs" "$T/sql-import.mjs" > "$T/prefix.out" || true
check "sql-import.js keeps to the site prefix on a shared database (#487)" "$(tail -1 "$T/prefix.out")" "all passed"
python3 "$HERE/test_sqlimport_client.py" 2> "$T/client.err" || { cat "$T/client.err"; fails=$((fails + 1)); }
check "sqlimport.py: CREATE preflight before replace" "$(tail -1 "$T/client.err")" "OK"

# 10. SSH input: remote-export.sh on a stand-in server (a fake ssh runs it
# here), with a read-only WordPress tree, HOME and TMPDIR.
# A space in the path: the SSH command line must quote it (printf %q).
R="$T/server x"; mkdir -p "$R/wp/wp-content/uploads/2026/01" "$R/wp/wp-content/cache" "$R/wp/wp-content/plugins/shop" "$R/home" "$R/stub" "$R/log"
cat > "$R/wp/wp-config.php" <<'PHP'
<?php
define( 'DB_NAME', 'site_db' );
define( 'DB_USER', 'reader' );
define( 'DB_PASSWORD', 'p"a\'s\\w$rd\n-not-a-newline' );
define( 'DB_HOST', 'db.local:3307' );
PHP
printf 'jpeg' > "$R/wp/wp-content/uploads/2026/01/a.jpg"; printf 'big' > "$R/wp/wp-content/cache/big.bin"; printf '<?php' > "$R/wp/wp-content/plugins/shop/shop.php"
# mysqldump stand-in: logs its arguments and its defaults file (the log is
# outside the read-only tree), then prints the fixture dump.
cat > "$R/stub/mysqldump" <<SH
#!/bin/bash
printf '%s\n' "\$@" > "$R/log/argv"
for a in "\$@"; do case "\$a" in --defaults-extra-file=*) cat "\${a#*=}" > "$R/log/defaults" ;; esac; done
cat "$HERE/fixture.sql"
SH
# SSH_CMD is split on spaces (for ssh options), so the fake ssh has a path with none.
FSSH="$T/fake-ssh"
# shellcheck disable=SC2016 # the fake ssh script, not shell to expand here
printf '#!/bin/bash\nhost=$1; shift\nexec bash -c "$*"\n' > "$FSSH"
chmod +x "$R/stub/mysqldump" "$FSSH"
# The server PATH: the stubs, php, and the base system only (this computer
# may have a real wp in the same directory as php).
ln -s "$(command -v php)" "$R/stub/php"
SRVPATH="$R/stub:/usr/bin:/bin"
chmod -R a-w "$R/wp" "$R/home"
touch "$R/log/before"; sleep 1
srv() { HOME="$R/home" TMPDIR="$R/home" PATH="$SRVPATH" "$FSSH" server "bash -s -- $(printf '%q ' "$@")" < "$IMP/remote-export.sh"; }
srv "$R/wp" db > "$T/ssh.sql"
check "ssh db: the dump comes through" "$(cmp -s "$T/ssh.sql" "$HERE/fixture.sql" && echo same)" "same"
# shellcheck disable=SC2016 # a literal $ in the password
check "ssh db: no password in the arguments" "$(grep -c 'w\$rd' "$R/log/argv" || true)" "0"
check "ssh db: arguments" "$(tr '\n' ' ' < "$R/log/argv" | sed 's/--defaults-extra-file=[^ ]*/--defaults-extra-file=FD/')" "--defaults-extra-file=FD --hex-blob --single-transaction --skip-lock-tables --no-tablespaces site_db "
# shellcheck disable=SC2016 # a literal $ in the password
check "ssh db: password decoded as PHP does (single quotes)" "$(sed -n 's/^password=//p' "$R/log/defaults")" '"p\"a'"'"'s\\w$rd\\n-not-a-newline"'
check "ssh db: host and port from DB_HOST" "$(grep -E '^(host|port)=' "$R/log/defaults" | tr '\n' ' ')" 'host="db.local" port=3307 '
srv "$R/wp" content > "$T/ssh.tgz" 2> "$T/ssh-tar.err"
check "ssh content: uploads and plugins in, cache out" "$(tar -tzf "$T/ssh.tgz" | grep -E 'a.jpg|shop.php|big.bin' | sort | tr '\n' ' ')" "wp-content/plugins/shop/shop.php wp-content/uploads/2026/01/a.jpg "
check "ssh: nothing on the server changed" "$(find "$R/wp" "$R/home" -newer "$R/log/before" | wc -l | tr -d ' '):$(find "$R/home" -mindepth 1 | wc -l | tr -d ' ')" "0:0"
# A WP-CLI stand-in: it logs its calls and answers "config get" with the
# values PHP would decode from that wp-config.php. Only the values come from
# WP-CLI: its own "db export" would pass --no-tablespaces as --tablespaces=,
# which mariadb-dump refuses (measured on the #83 test source).
python3 - "$R" <<'PY'
import os, sys
r = sys.argv[1]
vals = {"DB_NAME": "site_db", "DB_USER": "reader", "DB_PASSWORD": 'p"a\'s\\w$rd\\n-not-a-newline', "DB_HOST": "db.local:3307"}
lines = ["#!/bin/bash", 'printf "%s\\n" "$*" >> ' + repr(r + "/log/wp-argv"), 'case "$*" in']
for k, v in vals.items():
    lines.append("  *'config get %s'*) printf '%%s' %s ;;" % (k, "'" + v.replace("'", "'\\''") + "'"))
lines += ["  *) echo \"wp stand-in: unexpected call: $*\" >&2; exit 9 ;;", "esac"]
open(os.path.join(r, "stub", "wp"), "w").write("\n".join(lines) + "\n")
os.chmod(os.path.join(r, "stub", "wp"), 0o755)
PY
cp "$R/log/defaults" "$R/log/defaults-php"
srv "$R/wp" db > "$T/ssh-wp.sql"
check "ssh db: WP-CLI path, the dump comes through" "$(cmp -s "$T/ssh-wp.sql" "$HERE/fixture.sql" && echo same)" "same"
check "ssh db: WP-CLI path, only config get is asked" "$(grep -vc 'config get DB_' "$R/log/wp-argv" || true)" "0"
check "ssh db: WP-CLI path, the same dump arguments" "$(tr '\n' ' ' < "$R/log/argv" | sed 's/--defaults-extra-file=[^ ]*/--defaults-extra-file=FD/')" "--defaults-extra-file=FD --hex-blob --single-transaction --skip-lock-tables --no-tablespaces site_db "
check "ssh db: WP-CLI path, the same [client] section as the PHP path" "$(cmp -s "$R/log/defaults" "$R/log/defaults-php" && echo same)" "same"
rm "$R/stub/wp"
set +e; srv "$R/home" db > /dev/null 2> "$T/ssh.err"; code=$?; set -e
check "ssh db: no wp-config.php is an error" "$code:$(grep -c 'no wp-config.php' "$T/ssh.err" || true)" "2:1"
# The import.sh wiring, as far as DRY_RUN (b-dosql).
set +e
HOME="$R/home" PATH="$SRVPATH" SSH=server SSH_WP="$R/wp" SSH_CMD="$FSSH" URL=https://wp.acct.workers.dev SPIKE_TOKEN=x DRY_RUN=1 ALLOW_MISSING=1 WORK="$T/sshwork" "$IMP/../import.sh" > "$T/ssh-import.out" 2>&1; code=$?
set -e
check "import.sh SSH=: dump and archive read, dry run reached" "$code:$(grep -c '^ssh: dump\|^ssh: wp-content archive\|^prefix wpx_\|^DRY_RUN' "$T/ssh-import.out")" "0:4"
chmod -R u+w "$R/wp" "$R/home"

# 8. c1: the container's seed step (spikes/c1-woo-container/container/seed.sh)
# against the same stand-in. PUT a seed, then load it as entrypoint.sh does.
C1C=$(cd "$IMP/../../spikes/c1-woo-container/container" && pwd)
mkdir -p "$T/bin" "$T/run"
command -v sha256sum >/dev/null || { printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' > "$T/bin/sha256sum"; chmod +x "$T/bin/sha256sum"; }
seed_run() { # data-dir sha [replica-path] -> exit code; output in $T/seed.out
  mkdir -p "$1"
  set +e
  PATH="$T/bin:$PATH" SEED_DATA="$1" SEED_RUN="$T/run" SEED_COUNTS="$C1C/seed-counts.php" SEED_OUT="$1/counts.json" \
    SEED_SHA256="$2" REPLICA_PATH="${3:-import-x}" R2_ENDPOINT="$EP" R2_BUCKET=replica LITESTREAM_ACCESS_KEY_ID=test LITESTREAM_SECRET_ACCESS_KEY=test \
    sh -c '. "$1"; seed_load' _ "$C1C/seed.sh" > "$T/seed.out" 2>&1
  local rc=$?
  set -e
  return $rc
}
curl -sS -o /dev/null -K <(printf 'user = "test:test"\n') --aws-sigv4 "aws:amz:auto:s3" -T "$T/fx.sqlite" "$EP/replica/import-x.seed.sqlite"
SHA=$(shasum -a 256 "$T/fx.sqlite" | cut -d' ' -f1)
seed_run "$T/d1" "$SHA" && rc=0 || rc=$?
check "c1 seed: loaded" "$rc:$(cmp -s "$T/fx.sqlite" "$T/d1/wordpress.sqlite" && echo same)" "0:same"
check "c1 seed: counts match the seed" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rows"] == json.loads(sys.argv[2])["rows"])' "$T/d1/counts.json" "$(php "$C1C/seed-counts.php" "$T/fx.sqlite" "$SHA" import-x)")" "True"
check "c1 seed: no key file left" "$(find "$T/run" -type f | wc -l | tr -d ' ')" "0"
seed_run "$T/d2" "0000000000000000000000000000000000000000000000000000000000000000" && rc=0 || rc=$?
check "c1 seed: wrong SHA-256 stops, no database" "$rc:$(find "$T/d2" -type f | wc -l | tr -d ' ')" "1:0"
seed_run "$T/d3" "$SHA" import-missing && rc=0 || rc=$?
check "c1 seed: missing object stops, no database" "$rc:$(find "$T/d3" -type f | wc -l | tr -d ' ')" "1:0"
check "c1 seed: missing object says download failed" "$(grep -c 'seed: download failed' "$T/seed.out" || true)" "1"
mkdir -p "$T/d4"; echo existing > "$T/d4/wordpress.sqlite"
seed_run "$T/d4" "$SHA" && rc=0 || rc=$?
check "c1 seed: a restored database wins" "$rc:$(cat "$T/d4/wordpress.sqlite")" "0:existing"
seed_run "$T/d5" "" && rc=0 || rc=$?
check "c1 seed: no SEED_SHA256, nothing loaded" "$rc:$(find "$T/d5" -type f | wc -l | tr -d ' ')" "0:0"


# 11. SQLITE input: a database that is already SQLite made by the driver.
php "$IMP/dump-to-sqlite.php" "$DRV" "$HERE/fixture.sql" "$T/src.sqlite" > "$T/src-dump-report.json"
sqlite3 "$T/src.sqlite" 'PRAGMA wal_checkpoint(TRUNCATE);' > /dev/null
SRC_SHA=$(shasum -a 256 "$T/src.sqlite" | cut -d' ' -f1)
php "$IMP/sqlite-source.php" "$DRV" "$T/src.sqlite" "$T/sq.sqlite" > "$T/sq-report.json"
sq() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [v := v[k] for k in sys.argv[2:]]; print(json.dumps(v, sort_keys=True))' "$T/sq-report.json" "$@"; }
dr() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [v := v[k] for k in sys.argv[2:]]; print(json.dumps(v, sort_keys=True))' "$T/src-dump-report.json" "$@"; }
check "sqlite: source is sqlite" "$(sq source)" '"sqlite"'
check "sqlite: driver version read" "$(sq driver_version)" '"3.1.3"'
check "sqlite: rows equal the dump path" "$(sq rows)" "$(dr rows)"
check "sqlite: site facts equal the dump path" "$(sq site)" "$(dr site)"
check "sqlite: table without prefix listed" "$(sq without_prefix)" '["custom_log"]'
check "sqlite: source file unchanged" "$(shasum -a 256 "$T/src.sqlite" | cut -d' ' -f1)" "$SRC_SHA"
check "sqlite: copy is ok" "$(sqlite3 "$T/sq.sqlite" 'PRAGMA integrity_check;')" "ok"
check "sqlite: blob bytes in the copy" "$(sqlite3 "$T/sq.sqlite" 'SELECT hex(data) FROM wp_blobs WHERE id = 1')" "005C27221A"
set +e
php "$IMP/sqlite-source.php" "$DRV" "$T/src.sqlite" "$T/sq.sqlite" > /dev/null 2>&1; code=$?
set -e
check "sqlite: refuses to write over the output" "$code" "2"
# Each refusal: exit 1, a message that names the cause, and no output file.
refuse() { # refuse <label> <file> <grep pattern>
  rm -f "$T/rf.sqlite"
  set +e; php "$IMP/sqlite-source.php" "$DRV" "$2" "$T/rf.sqlite" > /dev/null 2> "$T/rf.err"; local c=$?; set -e
  check "sqlite: $1 refused" "$c:$(grep -c -- "$3" "$T/rf.err" || true):$([ -e "$T/rf.sqlite" ] && echo out || echo none)" "1:1:none"
}
cp "$T/src.sqlite" "$T/newer.sqlite"
sqlite3 "$T/newer.sqlite" "UPDATE _wp_sqlite_global_variables SET value = '9.9.9' WHERE name = '_wp_sqlite_driver_version';"
refuse "a newer driver" "$T/newer.sqlite" "newer than the pinned driver"
cp "$T/src.sqlite" "$T/older.sqlite"
sqlite3 "$T/older.sqlite" "UPDATE _wp_sqlite_global_variables SET value = '2.0.0' WHERE name = '_wp_sqlite_driver_version';"
rm -f "$T/older-out.sqlite"
php "$IMP/sqlite-source.php" "$DRV" "$T/older.sqlite" "$T/older-out.sqlite" > /dev/null 2>&1 && code=0 || code=$?
check "sqlite: an older driver's file is accepted" "$code" "0"
sqlite3 "$T/plain.sqlite" "CREATE TABLE wp_options(x); CREATE TABLE wp_posts(x); CREATE TABLE wp_usermeta(x);"
refuse "a file the driver did not make" "$T/plain.sqlite" "not made by the SQLite driver"
cp "$T/src.sqlite" "$T/prefix.sqlite"
sqlite3 "$T/prefix.sqlite" "ALTER TABLE wp_options RENAME TO wpx_options; ALTER TABLE wp_posts RENAME TO wpx_posts; ALTER TABLE wp_usermeta RENAME TO wpx_usermeta;"
refuse "a prefix other than wp_" "$T/prefix.sqlite" "through a MySQL dump"
cp "$T/src.sqlite" "$T/multi.sqlite"
sqlite3 "$T/multi.sqlite" "CREATE TABLE wp_blogs(blog_id INTEGER);"
refuse "a multisite network" "$T/multi.sqlite" "multisite"
cp "$T/src.sqlite" "$T/wal.sqlite"
python3 - "$T/wal.sqlite" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("INSERT INTO custom_log VALUES (99, 'in the wal only')"); c.commit()
import os; os._exit(0)  # leave the WAL as it is: no checkpoint on close
PY
refuse "a WAL that is not empty" "$T/wal.sqlite" "WAL file that is not empty"
printf 'not a database' > "$T/junk.sqlite"
rm -f "$T/rf.sqlite"; set +e; php "$IMP/sqlite-source.php" "$DRV" "$T/junk.sqlite" "$T/rf.sqlite" > /dev/null 2>&1; code=$?; set -e
check "sqlite: a file that is not a database fails" "$([ "$code" != 0 ] && echo fails):$([ -e "$T/rf.sqlite" ] && echo out || echo none)" "fails:none"
# import.sh refuses the mixed inputs before anything runs.
set +e
SQLITE="$T/src.sqlite" DUMP="$HERE/fixture.sql" URL=x "$IMP/../import.sh" > /dev/null 2> "$T/mix.err"; code=$?
set -e
check "import.sh: SQLITE with DUMP refused" "$code:$(grep -c 'SQLITE replaces DUMP' "$T/mix.err" || true)" "2:1"
set +e
SQLITE="$T/src.sqlite" VARIANT=c1 URL=x "$IMP/../import.sh" > /dev/null 2> "$T/c1.err"; code=$?
set -e
check "import.sh: SQLITE with VARIANT=c1 refused" "$code:$(grep -c 'b-dosql only' "$T/c1.err" || true)" "2:1"

# Pending order emails (issue #364): cancel-emails.py marks the source's pending
# woocommerce-emails actions canceled, never deletes, logs each, and keeps them on --keep.
mkas() { # mkas <file>: Action Scheduler tables with 3 pending emails, 1 sent email, 1 pending lookup
  rm -f "$1"
  sqlite3 "$1" "CREATE TABLE wp_actionscheduler_actions (action_id INTEGER PRIMARY KEY, hook TEXT, status TEXT, group_id INTEGER);
    CREATE TABLE wp_actionscheduler_groups (group_id INTEGER PRIMARY KEY, slug TEXT);
    CREATE TABLE wp_actionscheduler_logs (log_id INTEGER PRIMARY KEY, action_id INTEGER, message TEXT, log_date_gmt TEXT, log_date_local TEXT);
    INSERT INTO wp_actionscheduler_groups VALUES (3, 'woocommerce-db-updates'), (6, 'woocommerce-emails');
    INSERT INTO wp_actionscheduler_actions VALUES
      (1, 'woocommerce_send_queued_transactional_email', 'pending', 6),
      (2, 'woocommerce_send_queued_transactional_email', 'pending', 6),
      (3, 'woocommerce_send_queued_transactional_email', 'complete', 6),
      (4, 'woocommerce_run_product_attribute_lookup_update_callback', 'pending', 3),
      (5, 'woocommerce_send_queued_transactional_email', 'pending', 6);"
}
asq() { sqlite3 "$1" "$2"; }
mkas "$T/as.sqlite"
check "emails: the default cancels the pending emails" "$(python3 "$IMP/cancel-emails.py" "$T/as.sqlite" | tail -1)" "pending emails: 3 canceled"
check "emails: statuses after" "$(asq "$T/as.sqlite" "SELECT group_concat(action_id || ':' || status, ' ') FROM (SELECT * FROM wp_actionscheduler_actions ORDER BY action_id)")" "1:canceled 2:canceled 3:complete 4:pending 5:canceled"
check "emails: nothing deleted" "$(asq "$T/as.sqlite" "SELECT COUNT(*) FROM wp_actionscheduler_actions")" "5"
check "emails: one log row per canceled action" "$(asq "$T/as.sqlite" "SELECT group_concat(action_id, ' ') FROM (SELECT action_id FROM wp_actionscheduler_logs WHERE message LIKE '%#364%' ORDER BY action_id)")" "1 2 5"
check "emails: a second run finds none" "$(python3 "$IMP/cancel-emails.py" "$T/as.sqlite" | tail -1)" "pending emails: 0 canceled"
mkas "$T/as.sqlite"
check "emails: --keep (IMPORT_KEEP_PENDING_EMAILS=1) keeps them" "$(python3 "$IMP/cancel-emails.py" "$T/as.sqlite" --keep | tail -1):$(asq "$T/as.sqlite" "SELECT COUNT(*) FROM wp_actionscheduler_actions WHERE status = 'pending'")" "pending emails: 3 kept (IMPORT_KEEP_PENDING_EMAILS=1):4"
check "emails: --dry-run changes nothing" "$(python3 "$IMP/cancel-emails.py" "$T/as.sqlite" --dry-run | tail -1):$(asq "$T/as.sqlite" "SELECT COUNT(*) FROM wp_actionscheduler_actions WHERE status = 'pending'"):$(asq "$T/as.sqlite" "SELECT COUNT(*) FROM wp_actionscheduler_logs")" "pending emails: 3 would be canceled:4:0"
rm -f "$T/noas.sqlite"; sqlite3 "$T/noas.sqlite" "CREATE TABLE wp_options (option_id INTEGER PRIMARY KEY)"
check "emails: a site with no Action Scheduler" "$(python3 "$IMP/cancel-emails.py" "$T/noas.sqlite" | tail -1)" "pending emails: 0 (no Action Scheduler tables)"
set +e; python3 "$IMP/cancel-emails.py" "$T/as.sqlite" --bogus > /dev/null 2>&1; code=$?; set -e
check "emails: an unknown flag is refused" "$code" "2"
# import.sh runs the step on the local copy after the address change and before the load, and passes the opt-out.
ia=$(grep -n 'search-replace.py" "$WORK/site.sqlite"' "$IMP/../import.sh" | cut -d: -f1)
ib=$(grep -n 'cancel-emails.py" "$WORK/site.sqlite"' "$IMP/../import.sh" | cut -d: -f1)
ic=$(grep -n 'dbmove-file.py" from-sqlite' "$IMP/../import.sh" | cut -d: -f1)
check "import.sh: the email step is between the address change and the load" "$([ -n "$ib" ] && [ "$ia" -lt "$ib" ] && [ "$ib" -lt "$ic" ] && echo ordered)" "ordered"
check "import.sh: the opt-out reaches the step" "$(grep -c 'IMPORT_KEEP_PENDING_EMAILS:-0}" = 1 ] && echo --keep' "$IMP/../import.sh")" "1"

# Variant a (issue #364): mysql-prepare.py --emails. The ids come from the SQLite copy of the
# same dump (step 2, the real dump-to-sqlite.php); the statements carry status 'canceled' and one
# log row for each. fixture-emails.sql: pending emails 1 2 7, sent 3, failed 5, other group 4.
php "$IMP/dump-to-sqlite.php" "$DRV" "$HERE/fixture-emails.sql" "$T/em.sqlite" > /dev/null
check "a emails: the SQLite copy lists the pending emails" "$(python3 -c 'import importlib.util as u,sqlite3,sys; s=u.spec_from_file_location("ce",sys.argv[1]); m=u.module_from_spec(s); s.loader.exec_module(m); print(m.pending_email_ids(sqlite3.connect(sys.argv[2])))' "$IMP/cancel-emails.py" "$T/em.sqlite")" "[1, 2, 7]"
emp() { python3 "$IMP/mysql-prepare.py" "$HERE/fixture-emails.sql" "$T/$1.jsonl" --prefix wpx_ --to-prefix wp_ --flavour mysql --max-statement 1048576 "${@:2}" > "$T/$1.json"; }
# status of each action in the statements, and the action ids of the added log rows
ems() { python3 - "$T/$1.jsonl" <<'PY2'
import json, re, sys
L = [json.loads(l)["sql"] for l in open(sys.argv[1])]
acts = [m for s in L if "INTO `wp_actionscheduler_actions`" in s for m in re.findall(r"\((\d+),'[^']*','(\w+)'", s)]
logs = [m for s in L if "INTO `wp_actionscheduler_logs`" in s for m in re.findall(r"\(NULL,(\d+),'([^']*)'", s)]
print(" ".join(a + ":" + b for a, b in acts) + " | " + " ".join(a for a, msg in logs if "#364" in msg))
PY2
}
emj() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); [v := v[k] for k in sys.argv[2:]]; print(json.dumps(v, sort_keys=True))' "$T/$1.json" "${@:2}"; }
emp em --emails "$T/em.sqlite"
check "a emails: the pending emails become canceled, the others stay" "$(ems em)" "1:canceled 2:canceled 3:complete 4:pending 5:failed 7:canceled | 1 2 7"
check "a emails: the report" "$(emj em emails)" '{"action_scheduler": true, "canceled": 3, "kept": false, "logged": 3, "pending": 3}'
check "a emails: nothing deleted, the log rows counted for the row check" "$(emj em rows)" '{"wp_actionscheduler_actions": 6, "wp_actionscheduler_groups": 2, "wp_actionscheduler_logs": 4, "wp_options": 4}'
check "a emails: a string that says pending is not a status" "$(python3 -c 'import json,sys; print(sum(json.loads(l)["sql"].count('"'"'["pending"]'"'"') for l in open(sys.argv[1])))' "$T/em.jsonl")" "2"
check "a emails: the log rows come after every CREATE TABLE" "$(python3 -c 'import json,sys; L=[json.loads(l)["sql"] for l in open(sys.argv[1])]; c=max(i for i,s in enumerate(L) if s.startswith("CREATE TABLE")); g=[i for i,s in enumerate(L) if "#364" in s]; print(len(g), all(i > c for i in g))' "$T/em.jsonl")" "1 True"
check "a emails: every statement passes the endpoint check" "$(node "$HERE/sqlimport-file.mjs" "$T/sql-import.mjs" "$T/em.jsonl" | tail -1)" "17 statements, 0 refused"
emp emkeep --emails "$T/em.sqlite" --keep-emails
check "a emails: --keep-emails (IMPORT_KEEP_PENDING_EMAILS=1) keeps them" "$(ems emkeep):$(emj emkeep emails pending):$(emj emkeep emails canceled):$(emj emkeep rows wp_actionscheduler_logs)" "1:pending 2:pending 3:complete 4:pending 5:failed 7:pending | :3:0:1"
emp emoff
check "a emails: without --emails nothing changes" "$(ems emoff):$(emj emoff emails)" "1:pending 2:pending 3:complete 4:pending 5:failed 7:pending | :null"
python3 "$IMP/mysql-prepare.py" "$HERE/fixture.sql" "$T/emnone.jsonl" --prefix wpx_ --to-prefix wp_ --flavour mysql --max-statement 1048576 --emails "$T/fx.sqlite" > "$T/emnone.json"
check "a emails: a site with no Action Scheduler" "$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["emails"]["action_scheduler"], r["emails"]["pending"], r["statements"])' "$T/emnone.json")" "False 0 14"
mkas "$T/as.sqlite"
set +e; python3 "$IMP/mysql-prepare.py" "$HERE/fixture-emails.sql" "$T/emx.jsonl" --prefix wpx_ --to-prefix wp_ --flavour mysql --max-statement 1048576 --emails "$T/as.sqlite" > /dev/null 2> "$T/emx.err"; code=$?; set -e
check "a emails: a copy that is not of this dump is refused" "$code:$(grep -c 'not pending in the dump' "$T/emx.err" || true)" "1:1"
set +e; python3 "$IMP/mysql-prepare.py" "$HERE/fixture-emails.sql" "$T/emx.jsonl" --prefix wpx_ --to-prefix wp_ --flavour mysql --max-statement 1048576 --keep-emails > /dev/null 2>&1; code=$?; set -e
check "a emails: --keep-emails without --emails is refused" "$code" "1"
# shellcheck disable=SC2016 # the pattern is the literal shell text of mysql.sh
check "mysql.sh: passes the SQLite copy and the opt-out" "$(grep -c -- '--emails "$WORK/site.sqlite" $(\[ "${IMPORT_KEEP_PENDING_EMAILS:-0}" = 1 \] && echo --keep-emails)' "$IMP/mysql.sh")" "1"

[ "$fails" = 0 ] || { echo "$fails failed"; exit 1; }
echo "all passed"
