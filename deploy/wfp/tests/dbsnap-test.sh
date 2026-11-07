#!/bin/bash
# Test of snapshot.py dbsnapshot and dbrestore (issue #35 slice 5) against
# fake-dbsnap.py (the site export/import and its R2 bucket in one server).
#   deploy/wfp/tests/dbsnap-test.sh [another snapshot.py]
# Cases (mode: dbsnapshot result):
#   ok                 exit 0, ok true, rows 3; then dbrestore exit 0
#   export-empty       exit 1, stage export (an empty export is never stored)
#   export-500         exit 1, stage export
#   readback-truncate  exit 1, stage readback (stored bytes != sent: not trusted)
#   put-500            exit 1, stage put (the PUT failure is named, not read as a bad readback)
#   import-error       dbrestore exit 1, stage import
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SNAP=${1:-$HERE/../snapshot.py}
# shellcheck disable=SC1090
. "$HERE/../lib.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
start() { rm -f "$T/port"; python3 -I "$HERE/fake-dbsnap.py" "$T/port" "$1" >/dev/null 2>&1 & echo $!; for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done; }
snap() { WFP_S3_ENDPOINT="$1" WFP_S3_KEY_ID=k WFP_S3_SECRET=s python3 -I "$SNAP" dbsnapshot "$1" tok b "$2"; }
restore() { WFP_S3_ENDPOINT="$1" WFP_S3_KEY_ID=k WFP_S3_SECRET=s python3 -I "$SNAP" dbrestore "$1" tok b "$2"; }

for c in ok:0:true export-empty:1:export export-500:1:export readback-truncate:1:readback put-500:1:put; do
  mode=${c%%:*}; rest=${c#*:}; rc=${rest%%:*}; want=${rest#*:}
  pid=$(start "$mode"); U="http://127.0.0.1:$(cat "$T/port")"
  out=$(snap "$U" "k1.ndjson"); got=$?
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  if [ "$got" = "$rc" ] && printf '%s' "$out" | grep -q "$want"; then echo "PASS dbsnapshot $mode"; else echo "FAIL dbsnapshot $mode: exit $got, $out (want exit $rc, \"$want\")"; fails=$((fails + 1)); fi
done
# dbrestore: ok, then import-error.
pid=$(start ok); U="http://127.0.0.1:$(cat "$T/port")"; snap "$U" "k1.ndjson" >/dev/null; r=$(restore "$U" "k1.ndjson"); rr=$?
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
ok "dbrestore ok: exit 0 ($r)" "$([ "$rr" = 0 ] && echo 1 || echo 0)"
pid=$(start import-error); U="http://127.0.0.1:$(cat "$T/port")"; snap "$U" "k1.ndjson" >/dev/null; r=$(restore "$U" "k1.ndjson"); rr=$?
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
ok "dbrestore import-error: exit 1, stage import ($r)" "$([ "$rr" = 1 ] && printf '%s' "$r" | grep -q import && echo 1 || echo 0)"
# row_count (lib.sh) reads /_dbexport and counts the rows (the fake ok mode has 3).
pid=$(start ok); U="http://127.0.0.1:$(cat "$T/port")"; rc_rows=$(row_count "$U" t)
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
ok "row_count reads /_dbexport (got $rc_rows, want 3)" "$([ "$rc_rows" = 3 ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $fails
