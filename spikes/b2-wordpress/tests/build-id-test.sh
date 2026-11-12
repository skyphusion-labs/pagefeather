#!/bin/bash
# build-id.sh (#377): a primed and an unprimed build of one sha must have different ids, or
# deploy/wfp/site update skips the primed one as "already at build" (ggc-test, 2026-11-12).
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/wp-content/plugins/woocommerce" "$T/wp-content/themes" "$T/wp-content/mu-plugins"
echo x > "$T/wp-content/plugins/woocommerce/woocommerce.php"
id() { env -u BUILD_ID_OVERRIDE -u PLUGINS -u IMPORT_CONTENT -u WOO_ACTIVE "$@" "$HERE/build-id.sh" "$T/wp-content"; }
base=$(id)
check "a plain build: the sha (and -dirty in a dirty tree), no suffix" "$(echo "$base" | grep -cE '^[0-9a-f]{12}(-dirty)?$')" 1
check "WOO_ACTIVE=1 adds -wooprimed" "$(id WOO_ACTIVE=1)" "$base-wooprimed"
check "WOO_ACTIVE=0 adds nothing" "$(id WOO_ACTIVE=0)" "$base"
check "THE GGC-TEST CASE: primed and unprimed builds of one sha differ" "$([ "$(id WOO_ACTIVE=1)" != "$(id)" ] && echo yes || echo no)" yes
c=$(id IMPORT_CONTENT="$T/wp-content" IMPORT_PLUGINS=woocommerce WOO_ACTIVE=1)
check "content inputs and WOO_ACTIVE=1: <sha>-c<8 hex>-wooprimed" "$(echo "$c" | grep -cE "^${base}-c[0-9a-f]{8}-wooprimed$")" 1
check "BUILD_ID_OVERRIDE wins whole" "$(id BUILD_ID_OVERRIDE=x-forced WOO_ACTIVE=1)" x-forced
check "build.sh takes its id from build-id.sh" "$(grep -c 'BUILD_ID=$(./build-id.sh "$wp/wp-content")' "$HERE/build.sh")" 1
check "build_dosql passes WOO_ACTIVE to build.sh" "$(grep -c 'WOO_ACTIVE=$woo ./build.sh' "$HERE/../../deploy/wfp/lib.sh")" 1
echo "$fails failing case(s)"
[ "$fails" = 0 ]
