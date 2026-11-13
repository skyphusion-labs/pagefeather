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
id() { env -u BUILD_ID_OVERRIDE -u PLUGINS -u IMPORT_CONTENT -u WOO_ACTIVE -u ENGINE "$@" "$HERE/build-id.sh" "$T/wp-content"; }
base=$(id)
check "a plain build: the sha (and -dirty in a dirty tree), no suffix" "$(echo "$base" | grep -cE '^[0-9a-f]{12}(-dirty)?$')" 1
check "WOO_ACTIVE=1 adds -wooprimed" "$(id WOO_ACTIVE=1)" "$base-wooprimed"
check "WOO_ACTIVE=0 adds nothing" "$(id WOO_ACTIVE=0)" "$base"
check "THE GGC-TEST CASE: primed and unprimed builds of one sha differ" "$([ "$(id WOO_ACTIVE=1)" != "$(id)" ] && echo yes || echo no)" yes
c=$(id IMPORT_CONTENT="$T/wp-content" IMPORT_PLUGINS=woocommerce WOO_ACTIVE=1)
check "content inputs and WOO_ACTIVE=1: <sha>-c<8 hex>-wooprimed" "$(echo "$c" | grep -cE "^${base}-c[0-9a-f]{8}-wooprimed$")" 1
check "BUILD_ID_OVERRIDE wins whole" "$(id BUILD_ID_OVERRIDE=x-forced WOO_ACTIVE=1)" x-forced
# #431: the approach-A build carries -a, right after the sha (and -dirty), so the b-dosql and the
# approach-A build of one sha never share an id; the d1 engine and an unset ENGINE add nothing.
check "ENGINE=a adds -a" "$(id ENGINE=a)" "$base-a"
check "ENGINE=a and WOO_ACTIVE=1: <sha>-a-wooprimed" "$(id ENGINE=a WOO_ACTIVE=1)" "$base-a-wooprimed"
check "ENGINE=d1 adds nothing" "$(id ENGINE=d1)" "$base"
check "the a and b-dosql builds of one sha differ" "$([ "$(id ENGINE=a WOO_ACTIVE=1)" != "$(id WOO_ACTIVE=1)" ] && echo yes || echo no)" yes
ca=$(id ENGINE=a IMPORT_CONTENT="$T/wp-content" IMPORT_PLUGINS=woocommerce WOO_ACTIVE=1)
check "the -a marker leaves the -c<8 hex>(-wooprimed) tail that deploy/wfp reads" "$(echo "$ca" | grep -cE "^${base}-a-c[0-9a-f]{8}-wooprimed$")" 1
check "opcache-a.sh builds ENGINE=a with WOO_ACTIVE=1 (its cache is WooCommerce-primed)" "$(grep -c 'ENGINE=a WOO=1 WOO_ACTIVE=1 ./build.sh' "$HERE/opcache-a.sh")" 1
check "build.sh takes its id from build-id.sh" "$(grep -c 'BUILD_ID=$(./build-id.sh "$wp/wp-content")' "$HERE/build.sh")" 1
check "build_dosql passes WOO_ACTIVE to build.sh" "$(grep -c 'WOO_ACTIVE=$woo ./build.sh' "$HERE/../../deploy/wfp/lib.sh")" 1
check "build-id.sh hashes the public tree too (a JS-only change, #385 follow-up)" "$(grep -c 'content-id.py "${1:?usage: build-id.sh <wp-content dir>}" build/public/wp-content' "$HERE/build-id.sh")" 1
check "the recorded content id (#379) hashes the same two trees as the build id" "$(grep -c 'content-id.py build/wordpress/wp-content build/public/wp-content' "$HERE/../../deploy/wfp/lib.sh")" 1
echo "$fails failing case(s)"
[ "$fails" = 0 ]
