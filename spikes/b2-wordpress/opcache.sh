#!/bin/bash
# Precompile PHP for the Worker. Boots the Worker locally (wrangler dev) with an
# empty OPcache, runs e2e.sh (and tests/woo.py) so real pages, login, admin
# and the store compile their
# scripts, then saves the OPcache file cache to build/opcache.zip.
# The same PHP build runs locally and on Cloudflare, so the files match.
# Run after ./build.sh, then deploy.
set -euo pipefail
cd "$(dirname "$0")"
python3 -c "import zipfile; zipfile.ZipFile('build/opcache.zip', 'w').close()"
# No recycle for memory while priming (index.js, PHP_RECYCLE): one runtime must
# compile everything, or the dump holds only what compiled after a recycle.
DEV_VARS="PHP_RECYCLE:off${DEV_VARS:+ $DEV_VARS}" ./run.sh _ping > /dev/null
# Stop the server this run started, however the script ends (run.sh records it).
# Before this, a failed step exited under set -e before the kill, and the server
# stayed on the port for the next run.
trap './run.sh --stop' EXIT
P=${PORT:-8797}
SERVER=$(cut -d' ' -f1 ".dev-$P.pid")
# The isolate before any page (the dump answers 409 with its id): the dump at the
# end must come from the same one. A reload by wrangler dev makes a new isolate.
hdr() { grep -i "^$1:" "$2" | tr -d '\r' | awk '{print $2}'; }
curl -s -D build/opcache.headers.start -o /dev/null localhost:$P/_opcache-dump
ISO0=$(hdr x-isolate build/opcache.headers.start)
[ -n "$ISO0" ] || { echo "/_opcache-dump gave no x-isolate before the pages: no OPcache files saved"; exit 1; }
curl -sf -X POST localhost:${PORT:-8797}/_install > /dev/null   # "already" when installed
# WOO_ACTIVE=1: activate WooCommerce (its files are in every build, WOO=1).
if [ "${WOO_ACTIVE:-0}" = 1 ]; then
  curl -sf -X POST "localhost:${PORT:-8797}/_activate?plugin=woocommerce/woocommerce.php" | grep -q '\\"active\\":true' || { echo "WooCommerce did not activate"; exit 1; }
fi
./e2e.sh > build/opcache-e2e.log 2>&1 || { echo "e2e failed; no OPcache files saved. Last lines of build/opcache-e2e.log:"; tail -15 build/opcache-e2e.log; exit 1; }
# WooCommerce pages too, when it is active (tests/woo.py buys a product).
if curl -sf "localhost:${PORT:-8797}/?rest_route=/wc/store/v1/cart" > /dev/null; then
  B=http://localhost:${PORT:-8797} ADMIN_PASSWORD=local-spike-password python3 tests/woo.py > /dev/null || { echo "woo.py failed; no OPcache files saved"; exit 1; }
fi
# Plugins from the suite in this build (PLUGINS, see build.sh): activate and
# exercise each one so its scripts compile too.
if [ -n "${PLUGINS:-}" ]; then
  B=http://localhost:${PORT:-8797} ADMIN_PASSWORD=local-spike-password python3 ../../tests/plugins/plugins.py $PLUGINS > build/opcache-plugins.jsonl || { echo "plugins.py failed; no OPcache files saved"; exit 1; }
fi
# The dump must come from the server that ran the pages above.
now=$(lsof -t -nP -iTCP:"$P" -sTCP:LISTEN 2>/dev/null | sort -u | head -1)
[ "$now" = "$SERVER" ] || { echo "the server on port $P changed during the run (pid $SERVER, now ${now:-none}): no OPcache files saved"; exit 1; }
code=$(curl -s -D build/opcache.headers -o build/opcache.zip.new -w '%{http_code}' localhost:$P/_opcache-dump)
iso=$(hdr x-isolate build/opcache.headers); drops=$(hdr x-runtime-drops build/opcache.headers)
[ "$iso" = "$ISO0" ] || { echo "/_opcache-dump came from another isolate ($ISO0 at the start, now ${iso:-none}): wrangler dev reloaded the worker during the run (a file it watches changed). No OPcache files saved."; exit 1; }
if [ "$code" = 409 ]; then
  echo "/_opcache-dump: 409 not booted ($drops runtime drops). The runtime was dropped after the pages ran: recycled (memory or a crash, see x-runtime-recycled) or a failed request. No OPcache files saved. Last lines of dev.log:"
  grep -v '^\s*$' dev.log | tail -5 | cut -c1-200
  exit 1
fi
[ "$code" = 200 ] || { echo "/_opcache-dump answered $code: no OPcache files saved"; exit 1; }
# A runtime dropped during the run took the files it compiled: the dump would
# hold only what compiled after the drop.
[ "$drops" = 0 ] || { echo "/_opcache-dump: $drops runtime drops during priming (a recycle, a crash or a failed request): the OPcache would hold only what compiled after the last one. No OPcache files saved."; exit 1; }
files=$(python3 -c "import zipfile, sys; print(len(zipfile.ZipFile(sys.argv[1]).namelist()))" build/opcache.zip.new)
[ "$files" -gt 0 ] || { echo "/_opcache-dump gave an empty zip: no OPcache files saved"; exit 1; }
mv build/opcache.zip.new build/opcache.zip
echo "opcache.zip $(wc -c < build/opcache.zip) bytes, $files files, isolate $iso, 0 runtime drops, $(grep -i '^x-files' build/opcache.headers | tr -d '\r')"
