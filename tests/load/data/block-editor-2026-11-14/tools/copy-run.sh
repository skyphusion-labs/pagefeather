#!/bin/bash
# pf394a (b-dosql, current rows) -> MySQL database on wpref-mysql, rows only into M1's NATIVE tables.
# The #479 M3 export (m3-dump.py, /_mysqlexport at 2000 a page, complete before AND after), then a direct
# mysql load from this Mac inside the firewall window (no plain-A loader, no Hyperdrive), then the counts.
#   copy-run.sh <pf394a env: SITE, SPIKE_TOKEN> <mysql defaults file: [client] host user password> <database>
# Run it from a copy of this kit in a mode 700 directory: dump.sql and load.sql hold store data and are
# deleted at the end. The source cron must be held first (/_hold), or wp_actionscheduler_logs moves.
set -uo pipefail
envf=${1:?pf394a env}; cnf=${2:?mysql defaults file}; db=${3:?database}
K=$(cd "$(dirname "$0")" && pwd); cd "$K"; umask 077
# mysql on PATH, or set MYSQL to the client binary (Homebrew mysql-client is fine).
MYSQL="${MYSQL:-$(command -v mysql || true)}"
[ -n "$MYSQL" ] || { echo "mysql not on PATH; set MYSQL to the client binary"; exit 1; }
set -a; . "$envf"; set +a
export SRC_TOKEN=$SPIKE_TOKEN
echo "start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 -I m3-dump.py "$SITE" ddl ref-tables.txt dump.sql report.json || { echo "export INCOMPLETE, nothing loaded"; exit 1; }
cat prelude.sql dump.sql > load.sql || exit 1
"$MYSQL" --defaults-extra-file="$cnf" --ssl-mode=REQUIRED --max-allowed-packet=256M "$db" < load.sql
lrc=$?
echo "load rc $lrc $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rm -f dump.sql load.sql
[ "$lrc" -eq 0 ] || { echo "LOAD FAILED (dump and load files removed)"; exit 1; }
python3 -I count-check.py report.json "$cnf" "$db"; crc=$?
echo "end $(date -u +%Y-%m-%dT%H:%M:%SZ) check rc $crc (dump and load files removed)"
exit $crc
