#!/bin/bash
# Guards of run.sh and opcache.sh, each on its real failure path. No database
# server needed: the default env (local D1). Usage: tests/devserver-guards.sh [port]
#   1 a port held by another process: run.sh refuses it and leaves it running
#   2 a failing opcache.sh: its dev server does not stay on the port
#   3 a reload after PHP booted: the dump answers 409, and opcache.sh says why
#   4 a full opcache.sh run: an opcache.zip with files, and the port free after
# It builds (WOO=0) and leaves a plain build. Exits 1 on any FAIL.
set -u
cd "$(dirname "$0")/.." || exit 9
P=${1:-8801}; export PORT=$P
OUT=$(mktemp -d)
fails=0
check() { if [ "$2" = 0 ]; then echo "PASS $1"; else echo "FAIL $1  ($3)"; fails=$((fails + 1)); fi; }
lis() { lsof -t -nP -iTCP:$P -sTCP:LISTEN 2>/dev/null | sort -u | head -1; }
[ -z "$(lis)" ] || { echo "port $P is busy before the test (pid $(lis)): pick another port"; exit 1; }
WOO=0 ./build.sh > "$OUT/build.log" 2>&1 || { echo "build failed: $OUT/build.log"; exit 1; }

python3 -m http.server "$P" --bind 127.0.0.1 > "$OUT/foreign.log" 2>&1 &
F=$!; sleep 1
./run.sh _ping > "$OUT/run-foreign.txt" 2>&1; rc=$?
grep -q "port $P is in use by pid $F" "$OUT/run-foreign.txt"; named=$?
check "1 run.sh refuses a port held by another process, and names it" $(( rc == 1 && named == 0 ? 0 : 1 )) "exit $rc, $(head -c 160 "$OUT/run-foreign.txt")"
kill -0 "$F" 2>/dev/null; check "1 the other process is left running" $? "pid $F gone"
kill "$F" 2>/dev/null; wait "$F" 2>/dev/null; sleep 1

env -u ADMIN_PASSWORD -u SPIKE_TOKEN WOO_ACTIVE=1 ./opcache.sh > "$OUT/opcache-fail.log" 2>&1; rc=$?
sleep 2
check "2 opcache.sh fails (WooCommerce is not in a WOO=0 build)" $(( rc != 0 ? 0 : 1 )) "exit $rc"
[ -z "$(lis)" ] && [ ! -f ".dev-$P.pid" ]; check "2 after the failure: no server on the port, no pid file" $? "listener $(lis), $(ls .dev-$P.pid 2>/dev/null)"

./run.sh _ping > /dev/null 2>&1
curl -s -o /dev/null -X POST "localhost:$P/_install"
curl -s -o /dev/null "localhost:$P/?nocache=guard"
before=$(curl -s -o /dev/null -w '%{http_code}' "localhost:$P/_opcache-dump")
touch build/site.zip; sleep 8
after=$(curl -s -o "$OUT/dump.bin" -w '%{http_code}' "localhost:$P/_opcache-dump")
check "3 a reload (build/site.zip touched) after PHP booted: dump 200 then 409" "$([ "$before $after" = "200 409" ] && echo 0 || echo 1)" "$before then $after"
./run.sh --stop; sleep 1
[ -z "$(lis)" ]; check "3 run.sh --stop frees the port" $? "listener $(lis)"

env -u ADMIN_PASSWORD -u SPIKE_TOKEN ./opcache.sh > "$OUT/opcache.log" 2>&1; rc=$?
files=$(python3 -c "import zipfile; print(len(zipfile.ZipFile('build/opcache.zip').namelist()))" 2>/dev/null || echo 0)
check "4 opcache.sh succeeds with an opcache.zip that has files" $(( rc == 0 && files > 0 ? 0 : 1 )) "exit $rc, $files files, $(tail -1 "$OUT/opcache.log")"
sleep 2; [ -z "$(lis)" ]; check "4 the port is free after" $? "listener $(lis)"

echo "FAILS $fails (logs in $OUT)"
exit $(( fails ? 1 : 0 ))
