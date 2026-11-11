#!/bin/bash
# Test of snapshot.py dbsnapshot and dbrestore (issue #35 slice 5) against
# fake-dbsnap.py (the site export/import and its R2 bucket in one server).
#   deploy/wfp/tests/dbsnap-test.sh [another snapshot.py]
# Cases (mode: dbsnapshot result):
#   ok                 exit 0, ok true, rows 3; then dbrestore exit 0
#   big                exit 0, ok true, rows 40000: a store-sized body (about 4 MB) stores
#   export-empty       exit 1, stage export (an empty export is never stored)
#   export-500         exit 1, stage export
#   readback-truncate  exit 1, stage readback (stored bytes != sent: not trusted)
#   put-500            exit 1, stage put (the PUT failure is named, not read as a bad readback)
#   import-error       dbrestore exit 1, stage import
#   big restore        dbrestore exit 0 in parts under the 2 MiB cap: replace=1 first,
#                      append=1 after, every line sent once (#287: one request was 413)
#   one huge line      dbrestore exit 1, stage split, and nothing is sent
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

for c in ok:0:true big:0:'"rows": 40000' export-empty:1:export export-500:1:export readback-truncate:1:readback put-500:1:put; do
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
# #287: a store-sized snapshot restores in parts, each under the site's 2 MiB cap.
pid=$(start big); U="http://127.0.0.1:$(cat "$T/port")"; snap "$U" "big.ndjson" >/dev/null; r=$(restore "$U" "big.ndjson"); rr=$?
p=$(curl -s "$U/_parts"); kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
v=$(printf '%s' "$p" | python3 -I -c 'import json,sys; p=json.load(sys.stdin); print(len(p), p[0][0] if p else "", all(q=="append=1" for q,_,_ in p[1:]), sum(l for _,l,_ in p), max(b for _,_,b in p) if p else 0)')
set -- $v
ok "dbrestore big: exit 0 in $1 parts, first $2, the rest append ($3), 40000 lines, largest part $5 bytes ($r)" "$([ "$rr" = 0 ] && [ "$1" -ge 2 ] && [ "$2" = replace=1 ] && [ "$3" = True ] && [ "$4" = 40000 ] && [ "$5" -le 2097152 ] && echo 1 || echo 0)"
# CONTROL: the same body in ONE request is refused by the fake, as by the site.
pid=$(start big); U="http://127.0.0.1:$(cat "$T/port")"; c=$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @<(curl -s "$U/_dbexport") "$U/_dbimport?replace=1"); kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
ok "CONTROL: one request of the big snapshot is 413 (got $c)" "$([ "$c" = 413 ] && echo 1 || echo 0)"
# A statement over the part limit is refused before anything is sent.
pid=$(start ok); U="http://127.0.0.1:$(cat "$T/port")"; snap "$U" "k1.ndjson" >/dev/null; r=$(DBIMPORT_PART_BYTES=10 restore "$U" "k1.ndjson"); rr=$?
p=$(curl -s "$U/_parts"); kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
ok "dbrestore one huge line: exit 1, stage split, nothing sent ($r; parts $p)" "$([ "$rr" = 1 ] && printf '%s' "$r" | grep -q split && [ "$p" = "[]" ] && echo 1 || echo 0)"
# row_count (lib.sh) reads /_dbexport and counts the rows (the fake ok mode has 3).
pid=$(start ok); U="http://127.0.0.1:$(cat "$T/port")"; rc_rows=$(row_count "$U" t)
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
ok "row_count reads /_dbexport (got $rc_rows, want 3)" "$([ "$rc_rows" = 3 ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $fails
