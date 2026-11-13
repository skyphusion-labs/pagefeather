#!/bin/bash
# The b-dosql build id (issue #35 slice 5, #285, #377), printed on stdout. build.sh writes it into
# build/build-id.js, and deploy/wfp/site update skips an upload whose id equals the live one.
#   build-id.sh <wp-content dir>
# The id is the git sha of this tree, then:
#   -dirty      the tree has uncommitted changes, so it is never mistaken for a committed build;
#   -c<8 hex>   the content inputs (PLUGINS, IMPORT_*), content-id.py, when any is set;
#   -wooprimed  WOO_ACTIVE=1: the OPcache will be primed with WooCommerce (#377). Without this, a
#               primed and an unprimed build of one sha had one id, and site update skipped the
#               primed one as "already at build" (ggc-test, 2026-11-12).
# BUILD_ID_OVERRIDE forces the whole id (the activation measurement, issue #35).
set -euo pipefail
cd "$(dirname "$0")"
if [ -n "${BUILD_ID_OVERRIDE:-}" ]; then echo "$BUILD_ID_OVERRIDE"; exit 0; fi
id=$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
[ -z "$(git status --porcelain 2>/dev/null)" ] || id="$id-dirty"
# The static files build.sh moved to build/public count too (a JS-only content change, #385 follow-up).
c=$(python3 -I content-id.py "${1:?usage: build-id.sh <wp-content dir>}" build/public/wp-content)
[ -z "$c" ] || id="$id-$c"
[ "${WOO_ACTIVE:-0}" != 1 ] || id="$id-wooprimed"
echo "$id"
