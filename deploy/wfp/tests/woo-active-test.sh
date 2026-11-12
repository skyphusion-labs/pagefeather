#!/bin/bash
# Test of lib.sh woo_active_for_build (#313): the OPcache priming follows the build inputs only, and
# build_dosql and opcache.sh are wired to it (a fresh local state per run). No build, no account.
#   deploy/wfp/tests/woo-active-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
# shellcheck disable=SC1091
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
w() { (unset WOO_ACTIVE IMPORT_PLUGINS PLUGINS; for kv in "$@"; do export "$kv"; done; woo_active_for_build 2>/dev/null; echo "rc$?") | tr '\n' ' '; }
check "no plugin set: 0" "$(w)" "0 rc0 "
check "woocommerce in IMPORT_PLUGINS (the ggc set): 1" "$(w 'IMPORT_PLUGINS=mcp-adapter skyphusion-ai woocommerce')" "1 rc0 "
check "woocommerce in PLUGINS: 1" "$(w 'PLUGINS=woocommerce')" "1 rc0 "
check "a plugin set without woocommerce: 0" "$(w 'IMPORT_PLUGINS=mcp-adapter skyphusion-ai')" "0 rc0 "
check "a name that only CONTAINS woocommerce is not it: 0" "$(w 'PLUGINS=woocommerce-gateway-stripe')" "0 rc0 "
check "explicit WOO_ACTIVE=0 wins over the plugin set" "$(w WOO_ACTIVE=0 'IMPORT_PLUGINS=woocommerce')" "0 rc0 "
check "explicit WOO_ACTIVE=1 wins" "$(w WOO_ACTIVE=1)" "1 rc0 "
check "a bad WOO_ACTIVE is refused" "$(w WOO_ACTIVE=yes)" "rc2 "
# The wiring: build_dosql passes the derived value; opcache.sh primes from a fresh state, refuses
# a WOO_ACTIVE=1 run whose Store API did not answer, and runs the floor before it keeps the dump.
check "build_dosql passes WOO_ACTIVE to opcache.sh" "$(grep -c 'WOO_ACTIVE=\$woo DEV_ENV=dosql-local ./opcache.sh' "$ROOT/deploy/wfp/lib.sh")" 1
check "run.sh passes PERSIST_TO to wrangler dev" "$(grep -c -- '--persist-to "\$PERSIST_TO"' "$ROOT/spikes/b2-wordpress/run.sh")" 1
check "opcache.sh primes from a fresh mktemp state" "$(grep -c '^export PERSIST_TO=\$STATE' "$ROOT/spikes/b2-wordpress/opcache.sh")" 1
check "opcache.sh fails a WOO_ACTIVE=1 run with no Store API" "$(grep -c 'WOO_ACTIVE=1 but the WooCommerce Store API did not answer' "$ROOT/spikes/b2-wordpress/opcache.sh")" 1
check "opcache.sh runs the floor before it keeps the dump" "$(grep -B1 '^mv build/opcache.zip.new build/opcache.zip' "$ROOT/spikes/b2-wordpress/opcache.sh" | grep -c 'opcache-check.py')" 1
# build_dosql stops when opcache.sh fails, also where set -e is off ("site update --all" calls the
# updater inside an if). A fake app: the build and the size check pass, only opcache.sh fails.
FA=$(mktemp -d); trap 'rm -rf "$FA"' EXIT
mkdir -p "$FA/node_modules" "$FA/vendor" "$FA/build"
: > "$FA/vendor/php_8_3.js"; : > "$FA/vendor/php_8_3.wasm"; : > "$FA/build/site.zip"; : > "$FA/build/opcache.zip"
printf '#!/bin/bash\necho build-id fake\n' > "$FA/build.sh"
printf '#!/bin/bash\necho "WOO_ACTIVE=$WOO_ACTIVE" > build/seen; echo priming failed; exit 1\n' > "$FA/opcache.sh"
chmod +x "$FA/build.sh" "$FA/opcache.sh"
r=$( (APP=$FA; unset WOO_ACTIVE; PLUGINS=woocommerce; if build_dosql > /dev/null 2>&1; then echo 0; else echo 1; fi) )
check "build_dosql fails when opcache.sh fails, with set -e off" "$r" 1
check "  and opcache.sh got the derived WOO_ACTIVE" "$(cat "$FA/build/seen" 2>/dev/null)" "WOO_ACTIVE=1"
printf '#!/bin/bash\necho "opcache.zip 1 bytes"; exit 0\n' > "$FA/opcache.sh"
r=$( (APP=$FA; unset WOO_ACTIVE PLUGINS; if build_dosql > /dev/null 2>&1; then echo 0; else echo 1; fi) )
check "build_dosql passes when opcache.sh passes" "$r" 0
[ "$fails" = 0 ] && echo "0 failing case(s)" || { echo "$fails failing case(s)"; exit 1; }
