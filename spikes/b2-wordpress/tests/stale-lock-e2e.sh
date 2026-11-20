#!/bin/bash
# #1060: a stuck PHP run must never get a second runtime booted beside it; the requests queued behind it shed with a
# retryable 503 instead. On WordPress in local workerd (dosql-local), with the fixture pf1060-hang.php:
#   1. A holds the PHP lock on a request that stalls (an HTTP call to a local server that never answers);
#   2. B, C and D queue behind it. Past 60 s (the stale line) with no progress, each answers 503, and NO new runtime
#      boots (no boot line after A's). Red before #1060: the first stale waiter booted a new runtime and ran beside A;
#   3. after A ends, a request answers 200 again.
#   tests/stale-lock-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh; saves and restores build/)
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8787} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/stale-lock.XXXXXX"); export PERSIST_TO=$STATE/db
[ -d build ] || { echo "stale-lock: no build/ (run build.sh first)"; exit 1; }
cp -a build "$STATE/build.saved" || { echo "stale-lock: could not save build/"; exit 1; }
HANG_PORT=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 -I -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(8)
held = []
end = time.time() + float(sys.argv[2])
s.settimeout(1)
while time.time() < end:
    try: c, _ = s.accept(); held.append(c)
    except socket.timeout: pass
' "$HANG_PORT" 95 &
HANG=$!
trap 'kill $HANG 2>/dev/null; ./run.sh --stop > /dev/null 2>&1; rm -rf build && mv "$STATE/build.saved" build || echo "stale-lock: build/ was NOT restored"; rm -rf "$STATE"' EXIT
IMPORT_CONTENT="$PWD/tests/fixtures/stale-lock" IMPORT_MU_PLUGINS=pf1060-hang.php ./build.sh > "$STATE/build.log" 2>&1 || { echo "stale-lock: build failed"; tail -5 "$STATE/build.log"; exit 1; }
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="HTTP_ALLOW_HOSTS:127.0.0.1" ./run.sh _ping > /dev/null || { echo "stale-lock: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -m 300 -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "stale-lock: /_install failed"; exit 1; }
curl -s -m 60 -o /dev/null -H "x-spike-token: $TOK" "$B/?pf1060=ok" # the runtime is booted and warm
boots0=$(grep -c '"m":"boot"' dev.log)
OUT=$STATE/out; mkdir -p "$OUT"
probe() { curl -s -m 200 -o "$OUT/$1.body" -w '%{http_code} %{time_total}' -H "x-spike-token: $TOK" "$B/$2" > "$OUT/$1.st"; }
probe A "?pf1060=hang&port=$HANG_PORT" &
sleep 2
for n in B C D; do probe $n "?pf1060=ok&n=$n" & sleep 1; done
wait %2 %3 %4 2>/dev/null
sleep 1
for n in B C D; do while [ ! -s "$OUT/$n.st" ]; do sleep 1; done; done
boots1=$(grep -c '"m":"boot"' dev.log)
fails=0
for n in B C D; do
  read -r code t < "$OUT/$n.st"
  echo "stale-lock: $n queued behind the stalled run: $code after ${t}s"
  [ "$code" = 503 ] || { echo "stale-lock: FAIL $n was not shed (a second runtime ran beside the stalled one?)"; fails=1; }
done
echo "stale-lock: new boots while A was stalled: $((boots1 - boots0))"
[ "$((boots1 - boots0))" = 0 ] || { echo "stale-lock: FAIL a second runtime booted beside the live one"; fails=1; }
grep -q '"why":"stuck"' dev.log && echo "stale-lock: the shed lines say stuck" || { echo "stale-lock: FAIL no shed line with why stuck"; fails=1; }
kill $HANG 2>/dev/null
while [ ! -s "$OUT/A.st" ]; do sleep 1; done
read -r code t < "$OUT/A.st"; echo "stale-lock: A ended: $code after ${t}s"
e=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "x-spike-token: $TOK" "$B/?pf1060=ok&n=E")
echo "stale-lock: E after A ended: $e"
[ "$e" = 200 ] || { echo "stale-lock: FAIL the site did not recover after A"; fails=1; }
[ "$fails" = 0 ] || { echo "stale-lock: FAIL"; exit 1; }
echo "stale-lock: ok: the queue behind a stalled run shed with 503, no second runtime, and the site recovered"
