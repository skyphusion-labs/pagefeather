#!/usr/bin/env bash
# #768 bar (c), offline: php/wc-route-defer.php's map is of the WooCommerce the build pins. If build.sh's WOO_VERSION
# changes, this fails until the map is measured again (the live half: tests/wc-route-defer-e2e.sh asserts every
# mapped callback is found on the running WooCommerce, deferred N/N).
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
P="$HERE/php/wc-route-defer.php"
woo=$(sed -n 's/^WOO_VERSION=//p' "$HERE/build.sh" | head -1)
mapped=$(sed -n "s/.*const MAPPED_WOO = '\([0-9.]*\)';.*/\1/p" "$P")
ok "the map is of the pinned WooCommerce (MAPPED_WOO $mapped, build.sh WOO_VERSION $woo)" "$([ -n "$woo" ] && [ "$mapped" = "$woo" ] && echo 1 || echo 0)"
n=$(sed -n '/const DEFER = array(/,/);/p' "$P" | grep -c "::")
u=$(sed -n '/const DEFER = array(/,/);/p' "$P" | grep "::" | sort -u | wc -l | tr -d ' ')
ok "13 mapped callbacks, each once" "$([ "$n" = 13 ] && [ "$u" = 13 ] && echo 1 || echo 0)"
ok "no settings or fields callback is deferred (Checkout, ProductCollection, ShippingController, WCAdminUser stay eager)" "$(sed -n '/const DEFER = array(/,/);/p' "$P" | grep -qE 'register_settings|ProductCollection|register_user_data' && echo 0 || echo 1)"
ok "the scope is the editor screens and admin-ajax, not REST (#963)" "$(grep -q "in_array( \$pagenow, array( 'post-new.php', 'post.php' ), true )" "$P" && grep -A2 "if ( wp_doing_ajax() )" "$P" | grep -q "return true;" && grep -q "defined( 'REST_REQUEST' ) && REST_REQUEST" "$P" && echo 1 || echo 0)"
ok "build.sh ships it" "$(grep -q 'php/wc-route-defer.php' "$HERE/build.sh" && echo 1 || echo 0)"
ok "index.js passes x-pf-wc-defer to PHP only with the spike token" "$(grep -q "delete headers\['x-pf-wc-defer'\]" "$HERE/index.js" && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $((fails > 0))
