#!/bin/bash
# Does a row with id 0 keep id 0 through /_sqlimport? (issue #31, condition 6)
#
#   URL=https://<variant a site> SPIKE_TOKEN=... tests/a/id-zero.sh
#
# Run it on a variant a site on MariaDB (MYSQL=vultr) and on one on PlanetScale
# (a2). It touches only the table wp_idzero_test (made, then dropped), and
# never sends replace=1, so the site's own tables are not changed.
#
# 1. The import as deploy/import.sh makes it (mysql-prepare.py, with the
#    sql_mode hint of the server's flavour): rows (0, 'zero') and (5, 'five')
#    must read back as 2 rows with the lowest id 0.
# 2. Red control, the same with NO_HINT=1: the server must renumber id 0 (the
#    lowest id is then 1). If it does not, test 1 proves nothing.
# Exit 0 only when both hold. Prints one JSON line with the results.
set -euo pipefail
: "${URL:?set URL}" "${SPIKE_TOKEN:?set SPIKE_TOKEN}"
export SPIKE_TOKEN
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMP="$ROOT/deploy/import"
W=$(mktemp -d "${TMPDIR:-/tmp}/id-zero.XXXXXX"); trap 'rm -rf "${W:?}"' EXIT
cat > "$W/dump.sql" <<'SQL'
DROP TABLE IF EXISTS `wp_idzero_test`;
CREATE TABLE `wp_idzero_test` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `v` varchar(10) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4;
INSERT INTO `wp_idzero_test` VALUES (0,'zero'),(5,'five');
SQL
python3 "$IMP/sqlimport.py" info "$URL" > "$W/info.json"
FLAVOUR=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["flavour"])' "$W/info.json")
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$W/info.json")
run() { # label -> "rows:min_pk"
  python3 "$IMP/mysql-prepare.py" "$W/dump.sql" "$W/$1.jsonl" --prefix wp_ --flavour "$FLAVOUR" --max-statement 65536 > /dev/null
  python3 "$IMP/sqlimport.py" load "$URL" "$W/$1.jsonl" > /dev/null
  python3 "$IMP/sqlimport.py" counts "$URL" | python3 -c 'import json,sys; t=json.load(sys.stdin)["tables"]["wp_idzero_test"]; print("%s:%s" % (t["rows"], t["min_pk"]))'
}
with=$(run hint)
without=$(NO_HINT=1 run nohint)
# shellcheck disable=SC2016 # backticks are SQL here
printf '%s\n' '{"sql":"DROP TABLE IF EXISTS `wp_idzero_test`"}' > "$W/drop.jsonl"
python3 "$IMP/sqlimport.py" load "$URL" "$W/drop.jsonl" > /dev/null
ok=no; [ "$with" = "2:0" ] && [ "$without" = "2:1" ] && ok=yes
printf '{"url": "%s", "version": "%s", "flavour": "%s", "with_hint": "%s", "without_hint": "%s", "want": "2:0 and 2:1", "pass": "%s", "utc": "%s"}\n' \
  "$URL" "$VERSION" "$FLAVOUR" "$with" "$without" "$ok" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ "$ok" = yes ]
