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
./run.sh _ping > /dev/null
curl -sf -X POST localhost:8797/_install > /dev/null   # "already" when installed
./e2e.sh > /dev/null || { echo "e2e failed; no OPcache files saved"; pkill -f 'wrangler dev --port 8797'; exit 1; }
# WooCommerce pages too, when it is active (tests/woo.py buys a product).
if curl -sf "localhost:8797/?rest_route=/wc/store/v1/cart" > /dev/null; then
  B=http://localhost:8797 ADMIN_PASSWORD=local-spike-password python3 tests/woo.py > /dev/null || { echo "woo.py failed; no OPcache files saved"; pkill -f 'wrangler dev --port 8797'; exit 1; }
fi
# Plugins from the suite in this build (PLUGINS, see build.sh): activate and
# exercise each one so its scripts compile too.
if [ -n "${PLUGINS:-}" ]; then
  B=http://localhost:8797 ADMIN_PASSWORD=local-spike-password python3 ../../tests/plugins/plugins.py $PLUGINS > build/opcache-plugins.jsonl || { echo "plugins.py failed; no OPcache files saved"; pkill -f 'wrangler dev --port 8797'; exit 1; }
fi
curl -sf -D build/opcache.headers -o build/opcache.zip.new localhost:8797/_opcache-dump
pkill -f 'wrangler dev --port 8797' || true
mv build/opcache.zip.new build/opcache.zip
echo "opcache.zip $(wc -c < build/opcache.zip) bytes, $(grep -i '^x-files' build/opcache.headers | tr -d '\r')"
