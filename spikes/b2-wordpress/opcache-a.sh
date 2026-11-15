#!/bin/bash
# Precompiled OPcache cache for approach A (ENGINE=a, external MySQL), issue #218.
#
# Why this is not just "ENGINE=a ./opcache.sh": opcache.sh boots the Worker
# locally against a real database to compile every page's scripts, and approach
# A's database is MySQL, which this laptop has no local instance of. So the
# cache is generated on the D1 engine instead, which needs no external database
# (local D1 is built in). The compiled PHP bytecode is the SAME for approach A:
# WordPress core, WooCommerce, the mu-plugins and wp-config.php are byte-for-byte
# identical between the two engines. The ONLY file that differs is the wpdb
# drop-in wp-content/db.php (D1 ships php/db.php, approach A ships
# php/hyperdrive-db.php). With opcache.validate_timestamps=0 a stale db.php cache
# entry would run the D1 code against MySQL, so its one compiled entry
# (wp-content/db.php.bin) is removed; approach A recompiles db.php once on a cold
# isolate. Every other engine-specific file has a DIFFERENT name (d1-*.php vs
# hyperdrive-*.php, and the sqlite-database-integration plugin is D1-only), so
# those cache entries are simply never read on approach A (the file is absent).
#
# Result, measured 2026-11-09: cold approach-A isolates load ~795 scripts from
# the cache on the home page instead of recompiling, which removes the cold-boot
# compile peak that otherwise pushes a WooCommerce request past the 128 MiB
# isolate cap (the overflow is V8 heap, invisible to x-wasm-mib). tests/woo.py
# 12/12 with the lean client + LAZY_NODES=on + this cache.
#
# WOO_ACTIVE (default 1): prime with WooCommerce active, as before. deploy/deploy.sh OPCACHE_A=1
# passes its own WOO_ACTIVE. TRACE=1 (#394, OPCACHE_REMOTE): also record the file trace on the
# primed D1 build (file-trace.sh), then cut it to the files the approach-A zips hold
# (trace-filter.py), so build/file-trace.json is the trace opcache-remote.py and site-remote.py read.
#
# Run after nothing in particular; it does its own builds. Then deploy ENGINE=a:
#   ./opcache-a.sh && deploy/wr deploy --env a-paid-lean
set -euo pipefail
cd "$(dirname "$0")"

SRC=build/opcache-a-src.zip
TRACE_SRC=build/file-trace-d1.json
W=${WOO_ACTIVE:-1}
case "$W" in 0|1) ;; *) echo "WOO_ACTIVE must be 0 or 1, not $W"; exit 2 ;; esac
case "${TRACE:-0}" in 0|1) ;; *) echo "TRACE must be 0 or 1, not $TRACE"; exit 2 ;; esac
rm -f "$TRACE_SRC"

echo "== 1/4 build the D1 engine (no external database needed) =="
WOO=1 ./build.sh >/dev/null

echo "== 2/4 generate the OPcache cache on D1 (installs WP, activates Woo, runs e2e + woo.py locally) =="
WOO_ACTIVE=$W ./opcache.sh

cp build/opcache.zip "$SRC"
if [ "${TRACE:-0}" = 1 ]; then
  echo "== 2b/4 record the file trace on the primed D1 build (file-trace.sh) =="
  WOO_ACTIVE=$W ./file-trace.sh
  cp build/file-trace.json "$TRACE_SRC"
fi
echo "   generated $(python3 -c "import zipfile;print(len(zipfile.ZipFile('$SRC').namelist()))" ) compiled scripts"

echo "== 3/4 build approach A (ENGINE=a; this wipes opcache.zip to empty) =="
# WOO_ACTIVE=1: the cache below is primed with WooCommerce, so the build id says -wooprimed (#431).
ENGINE=a WOO=1 WOO_ACTIVE=$W ./build.sh >/dev/null

echo "== 4/4 bundle the cache for approach A, minus the colliding wp-content/db.php =="
python3 - "$SRC" <<'PY'
import sys, zipfile
src = zipfile.ZipFile(sys.argv[1])
out = zipfile.ZipFile('build/opcache.zip', 'w', zipfile.ZIP_DEFLATED)
kept = excluded = 0
for info in src.infolist():
    if info.filename.endswith('/wordpress/wp-content/db.php.bin'):
        excluded += 1
        continue
    out.writestr(info, src.read(info.filename))
    kept += 1
out.close()
assert excluded == 1, f"expected exactly one wp-content/db.php.bin, removed {excluded}"
print(f"   approach-A opcache.zip: kept {kept} scripts, excluded {excluded} (db.php)")
PY
rm -f "$SRC"
if [ "${TRACE:-0}" = 1 ]; then
  echo "== 4b/4 cut the D1 trace to the files the approach-A zips hold =="
  python3 -I trace-filter.py "$TRACE_SRC" build/opcache.zip build/site.zip build/file-trace.json
  rm -f "$TRACE_SRC"
fi
echo "done. The ENGINE=a build/ now carries the precompiled cache. Deploy with:"
echo "  ./deploy-a-lean.sh [--var LAZY_CACHE_MB:2]   (deploys, then redacts the log query strings, or turns logs off)"
