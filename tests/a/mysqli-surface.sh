#!/bin/bash
# The surface of the userland mysqli (issue #29) in our php-wasm, with a stub
# bridge: tests/a/mysqli-surface-route.php. It does not test MySQL; see the route.
# Usage: tests/a/mysqli-surface.sh [port]   (local wrangler dev, default env)
# The route and hyperdrive-mysqli.php go into the built tree only; the plain
# build is restored at the end.
set -u
cd "$(dirname "$0")/../../spikes/b2-wordpress" || exit 9
P=${1:-8801}
OUT=$(mktemp -d)
pkill -u "$(id -un)" -f "wrangler dev --port $P"; sleep 1
WOO=0 ./build.sh > "$OUT/build.log" 2>&1 || { echo "build failed: $OUT/build.log"; exit 1; }
cp ../../tests/a/mysqli-surface-route.php build/wordpress/wp-content/mu-plugins/zz-mysqli-surface.php
cp php/hyperdrive-mysqli.php build/wordpress/wp-content/hyperdrive-mysqli.php
(cd build && zip -qr -9 site.zip wordpress)
(wrangler dev --port "$P" --log-level warn > "$OUT/dev.log" 2>&1 &)
for i in $(seq 1 90); do curl -s -m 2 -o /dev/null "localhost:$P/_ping" && break; sleep 1; done
curl -s -o /dev/null -X POST "localhost:$P/_install"
curl -s -m 120 "localhost:$P/?mysqlisurface=1&nocache=1" > "$OUT/surface.ndjson"
pkill -u "$(id -un)" -f "wrangler dev --port $P"
./build.sh > "$OUT/restore.log" 2>&1 || echo "restore build failed: $OUT/restore.log"
python3 - "$OUT/surface.ndjson" <<'PY'
import json, sys
lines = [l for l in open(sys.argv[1]) if l.strip()]
fails = 0
for l in lines:
    try:
        o = json.loads(l)
    except Exception:
        print("NOT JSON " + l[:300].rstrip()); fails += 1; continue
    print(("PASS " if o["ok"] else "FAIL ") + o["check"] + ("" if o["ok"] else "  " + json.dumps(o["got"])[:200]))
    fails += 0 if o["ok"] else 1
print("checks %d, FAILS %d" % (len(lines), fails))
sys.exit(1 if fails or not lines else 0)
PY
