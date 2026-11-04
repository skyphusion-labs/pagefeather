#!/bin/bash
# Precompile PHP for the Worker. Boots the Worker locally (wrangler dev) with an
# empty OPcache, runs e2e.sh so real pages, login and admin compile their
# scripts, then saves the OPcache file cache to build/opcache.zip.
# The same PHP build runs locally and on Cloudflare, so the files match.
# Run after ./build.sh, then deploy.
set -euo pipefail
cd "$(dirname "$0")"
python3 -c "import zipfile; zipfile.ZipFile('build/opcache.zip', 'w').close()"
./run.sh _ping > /dev/null
curl -sf -X POST localhost:8797/_install > /dev/null   # "already" when installed
./e2e.sh > /dev/null || { echo "e2e failed; no OPcache files saved"; pkill -f 'wrangler dev --port 8797'; exit 1; }
curl -sf -D build/opcache.headers -o build/opcache.zip.new localhost:8797/_opcache-dump
pkill -f 'wrangler dev --port 8797' || true
mv build/opcache.zip.new build/opcache.zip
echo "opcache.zip $(wc -c < build/opcache.zip) bytes, $(grep -i '^x-files' build/opcache.headers | tr -d '\r')"
