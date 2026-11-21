#!/bin/bash
# The b-dosql build id (issue #35 slice 5, #285, #377), printed on stdout. build.sh writes it into
# build/build-id.js, and deploy/wfp/site update skips an upload whose id equals the live one.
#   build-id.sh <wp-content dir>
# The id is the git sha of this tree, then:
#   -dirty      the tree has uncommitted changes, so it is never mistaken for a committed build;
#   -a          ENGINE=a: the approach-A build (PHP in the Worker, MySQL through Hyperdrive), so it
#               is never mistaken for the b-dosql build of the same sha (#431);
#   -e<8 hex>   PF_ENGINE_JS and PF_ENGINE_WASM: another engine (the lean engine, #592), the sha256 of
#               the two files, so a lean and an npm build of one sha never share an id and an update
#               that would drop the engine is not skipped as "already at build" (#642). npm: nothing;
#   -c<8 hex>   the content inputs (PLUGINS, IMPORT_*), content-id.py, when any is set;
#   -wpcli      WP_CLI_ENDPOINT=on: site.zip holds wp-cli.phar (#1258). Without this, an update
#               that only turns the endpoint on would skip the upload as "already at build".
#               It sits before -c and -wooprimed, so those tails stay what deploy/wfp reads.
#   -wooprimed  WOO_ACTIVE=1: the OPcache will be primed with WooCommerce (#377). Without this, a
#               primed and an unprimed build of one sha had one id, and site update skipped the
#               primed one as "already at build" (ggc-test, 2026-11-12).
# BUILD_ID_OVERRIDE forces the whole id (the activation measurement, issue #35).
set -euo pipefail
cd "$(dirname "$0")"
if [ -n "${BUILD_ID_OVERRIDE:-}" ]; then echo "$BUILD_ID_OVERRIDE"; exit 0; fi
id=$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
[ -z "$(git status --porcelain 2>/dev/null)" ] || id="$id-dirty"
[ "${ENGINE:-d1}" != a ] || id="$id-a"
# #771: the engine as prepare.sh resolves it (engine.sh): the default lean engine is named by its -e tag too.
# shellcheck source=engine.sh
. ./engine.sh
engine_resolve || exit 2
# #827: the tag comes from engine_tag, the one computation prepare.sh and build.sh also use.
e=$(engine_tag) || exit 2
[ "$e" = npm ] || id="$id-$e"
# #1258: before -c and -wooprimed, so the content tail deploy/wfp matches is unchanged.
[ "${WP_CLI_ENDPOINT:-}" != on ] || id="$id-wpcli"
# The static files build.sh moved to build/public count too (a JS-only content change, #385 follow-up).
c=$(python3 -I content-id.py "${1:?usage: build-id.sh <wp-content dir>}" build/public/wp-content)
[ -z "$c" ] || id="$id-$c"
[ "${WOO_ACTIVE:-0}" != 1 ] || id="$id-wooprimed"
echo "$id"
