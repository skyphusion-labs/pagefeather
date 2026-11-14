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
#   #515, on the big export in parts of 400 KB, a 502 at part 6 of a pass:
#     once             exit 0 in ONE pass: part 6 sent again, 40000 rows in the database
#     applied          exit 0 in ONE pass: /_dbcounts says part 6 is in, so it is NOT sent again
#                      (40000 rows, none twice)
#     once, no counts  exit 0 in TWO passes: it cannot tell, so it starts over from part 0
#     always           exit 1 after 3 passes, naming part 6 and 502
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
# #515: a transient 502 at part 6 (fake-dbsnap.py big-502* modes). Parts of 400 KB: about 10.
r515() { # r515 <mode>: restore the big snapshot; sets R (output), RR (exit), NP (POSTs), ROWS (in the db)
  local pid; pid=$(start "$1"); U="http://127.0.0.1:$(cat "$T/port")"; snap "$U" "big.ndjson" >/dev/null
  R=$(DBIMPORT_PART_BYTES=400000 DBIMPORT_RETRY_DELAYS=0,0,0 DBRESTORE_RESTART_S=0 restore "$U" "big.ndjson" 2> "$T/r515.err"); RR=$?
  NP=$(curl -s "$U/_parts" | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)))')
  ROWS=$(curl -s "$U/_dbcounts" | python3 -I -c 'import json,sys
try: print(sum(json.load(sys.stdin)["rows"].values()))
except Exception: print("n/a")')
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  NPARTS=$(printf '%s' "$R" | python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read()).get("parts", 0))')
}
r515 big-502once
ok "#515 502 once at part 6: exit 0 in one pass, part 6 sent again ($NP posts for $NPARTS parts), 40000 rows ($R)" "$([ "$RR" = 0 ] && [ "$NPARTS" -ge 8 ] && [ "$NP" = $((NPARTS + 1)) ] && [ "$ROWS" = 40000 ] && printf '%s' "$R" | grep -q '"attempts": 1' && echo 1 || echo 0)"
r515 big-502applied
ok "#515 applied then 502 at part 6: exit 0 in one pass, part 6 NOT sent again ($NP posts for $NPARTS parts), 40000 rows, none twice ($ROWS)" "$([ "$RR" = 0 ] && [ "$NP" = "$NPARTS" ] && [ "$ROWS" = 40000 ] && grep -q 'part 6 was applied' "$T/r515.err" && echo 1 || echo 0)"
r515 big-502once-nocounts
ok "#515 502 once and no /_dbcounts: exit 0 in TWO passes, the second from part 0 ($NP posts = 7 + $NPARTS) ($R)" "$([ "$RR" = 0 ] && [ "$NP" = $((NPARTS + 7)) ] && printf '%s' "$R" | grep -q '"attempts": 2' && echo 1 || echo 0)"
r515 big-502always
ok "#515 502 always at part 6: exit 1 after 3 passes, naming part 6 and 502 ($R)" "$([ "$RR" = 1 ] && printf '%s' "$R" | grep -q '"attempts": 3' && printf '%s' "$R" | grep -q '"part": 6' && printf '%s' "$R" | grep -q '"status": 502' && echo 1 || echo 0)"
# #517 follow-up (pf512 live run, 2026-11-14): the failed part holds the FIRST rows of a table, so
# that table has no rows before it. The site counts it 0; the check must read that as "before".
t517() { # t517 <mode>: restore the site-shaped two-table dump in 4 KB parts; sets R, RR, NP, ROWS, NPARTS
  local pid; pid=$(start "$1"); U="http://127.0.0.1:$(cat "$T/port")"; snap "$U" "t.ndjson" >/dev/null
  R=$(DBIMPORT_PART_BYTES=4096 DBIMPORT_RETRY_DELAYS=0,0,0 DBRESTORE_RESTART_S=0 restore "$U" "t.ndjson" 2> "$T/t517.err"); RR=$?
  NP=$(curl -s "$U/_parts" | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)))')
  ROWS=$(curl -s "$U/_dbcounts")
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  NPARTS=$(printf '%s' "$R" | python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read()).get("parts", 0))')
}
t517 tables-502once
ok "#517: 502 at the part that STARTS a table (not applied): exit 0 in ONE pass, the part sent again ($NP posts for $NPARTS parts) ($R)" "$([ "$RR" = 0 ] && printf '%s' "$R" | grep -q '"attempts": 1' && [ "$NP" = $((NPARTS + 1)) ] && grep -q '^dbrestore: part 6 was not applied (/_dbcounts): sending it again$' "$T/t517.err" && echo 1 || echo 0)"
ok "  every row is in, none twice ($ROWS)" "$(printf '%s' "$ROWS" | python3 -I -c 'import json,sys; r=json.load(sys.stdin)["rows"]; print(int(r.get("wp_b")==102 and r.get("wp_a",0) > 0))')"
t517 tables-502applied
ok "#517: the same part applied, then 502: not sent again ($NP posts for $NPARTS parts)" "$([ "$RR" = 0 ] && [ "$NP" = "$NPARTS" ] && grep -q '^dbrestore: part 6 was applied before the 502 answer' "$T/t517.err" && echo 1 || echo 0)"
t517 tables-502once-livewrite
ok "#517: a live write to the part's table after the 502: neither count, so a full restart, and it says why ($R)" "$([ "$RR" = 0 ] && printf '%s' "$R" | grep -q '"attempts": 2' && echo 1 || echo 0)"
ok "  the log names the table with its live, before and after counts" "$(grep -c '^dbrestore: part 6: /_dbcounts holds neither the counts before nor after it: wp_b live 1, before 0, after 34$' "$T/t517.err")"
ok "  the restart line carries the reason" "$(grep -c 'failed at part 6 (502; the part.s tables hold neither the counts before it nor after it): starting again' "$T/t517.err")"
# #533: a scheduled snapshot is gzipped (_snapshots/auto/*.ndjson.gz); dbrestore gunzips it. A body
# that starts like gzip and is not: stage gunzip, nothing sent.
pid=$(start ok); U="http://127.0.0.1:$(cat "$T/port")"
curl -s "$U/_dbexport" | gzip -c > "$T/auto.gz"
curl -s -o /dev/null --aws-sigv4 aws:amz:auto:s3 -u k:s -X PUT --data-binary @"$T/auto.gz" "$U/b/_snapshots/auto/20261114T071700Z.ndjson.gz"
r=$(restore "$U" "auto/20261114T071700Z.ndjson.gz"); rr=$?
p=$(curl -s "$U/_parts")
printf '\037\213not gzip at all' > "$T/bad.gz"
curl -s -o /dev/null --aws-sigv4 aws:amz:auto:s3 -u k:s -X PUT --data-binary @"$T/bad.gz" "$U/b/_snapshots/auto/bad.ndjson.gz"
r2=$(restore "$U" "auto/bad.ndjson.gz"); rr2=$?
p2=$(curl -s "$U/_parts")
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
ok "dbrestore of a gzipped scheduled snapshot: exit 0, the 3 rows sent ($r; parts $p)" "$([ "$rr" = 0 ] && printf '%s' "$p" | python3 -I -c 'import json,sys; p=json.load(sys.stdin); print(int(len(p)==1 and p[0][1]==3))' | grep -qx 1 && echo 1 || echo 0)"
ok "dbrestore of a body that only starts like gzip: exit 1, stage gunzip, nothing more sent ($r2)" "$([ "$rr2" = 1 ] && printf '%s' "$r2" | grep -q '"stage": "gunzip"' && [ "$p2" = "$p" ] && echo 1 || echo 0)"
# row_count (lib.sh) reads /_dbexport and counts the rows (the fake ok mode has 3).
pid=$(start ok); U="http://127.0.0.1:$(cat "$T/port")"; rc_rows=$(row_count "$U" t)
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
ok "row_count reads /_dbexport (got $rc_rows, want 3)" "$([ "$rc_rows" = 3 ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $fails
