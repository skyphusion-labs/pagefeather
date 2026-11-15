#!/bin/bash
# deploy/wfp lib.sh page_cache_product_var (#628): the edge TTL of WooCommerce product, shop and
# category pages. The lead's ruling (2026-11-15, after the C2 verdict): a STORE renders 30 by
# default; a site that is not a store renders nothing (its pages keep 120 s); PAGE_CACHE_PRODUCT_TTL
# overrides it (an integer from 5 to 600, anything else refused); and it is a RECORDED site setting
# (site_settings.py SETTINGS, lib.sh SITE_SETTINGS), so an update keeps an override.
# A store is what the build primes: woo_active_for_build (WOO_ACTIVE, or woocommerce in IMPORT_PLUGINS
# or PLUGINS). Run: bash deploy/wfp/tests/page-cache-product-test.sh   (macOS /bin/bash 3.2 too)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB="$HERE/../lib.sh"
fail=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
# r [VAR=value ...]: the renderer's output with only these inputs set; rc likewise its exit status.
r() { ( unset PAGE_CACHE_PRODUCT_TTL WOO_ACTIVE IMPORT_PLUGINS PLUGINS; for kv in "$@"; do export "$kv"; done; . "$LIB" >/dev/null 2>&1; page_cache_product_var ) 2>/dev/null; }
rc() { ( unset PAGE_CACHE_PRODUCT_TTL WOO_ACTIVE IMPORT_PLUGINS PLUGINS; for kv in "$@"; do export "$kv"; done; . "$LIB" >/dev/null 2>&1; page_cache_product_var >/dev/null 2>&1 ); echo $?; }
V30='PAGE_CACHE_PRODUCT_TTL = "30"'

ok "the renderer exists" "$( ( . "$LIB" >/dev/null 2>&1; type page_cache_product_var >/dev/null 2>&1 ) && echo 1 || echo 0)"
ok "a store (WOO_ACTIVE=1) renders 30 with no flag" "$( [ "$(r WOO_ACTIVE=1)" = "$V30" ] && echo 1 || echo 0)"
ok "a store by IMPORT_PLUGINS renders 30" "$( [ "$(r 'IMPORT_PLUGINS=classic-editor woocommerce')" = "$V30" ] && echo 1 || echo 0)"
ok "a store by PLUGINS renders 30" "$( [ "$(r PLUGINS=woocommerce)" = "$V30" ] && echo 1 || echo 0)"
ok "not a store (no WooCommerce) renders nothing" "$( [ -z "$(r)" ] && [ "$(rc)" = 0 ] && echo 1 || echo 0)"
ok "WOO_ACTIVE=0 renders nothing, even with woocommerce in PLUGINS" "$( [ -z "$(r WOO_ACTIVE=0 PLUGINS=woocommerce)" ] && echo 1 || echo 0)"
ok "the override wins on a store" "$( [ "$(r WOO_ACTIVE=1 PAGE_CACHE_PRODUCT_TTL=60)" = 'PAGE_CACHE_PRODUCT_TTL = "60"' ] && echo 1 || echo 0)"
ok "the override renders on a non-store too (it only touches product pages)" "$( [ "$(r PAGE_CACHE_PRODUCT_TTL=45)" = 'PAGE_CACHE_PRODUCT_TTL = "45"' ] && echo 1 || echo 0)"
ok "a leading zero is read as decimal" "$( [ "$(r PAGE_CACHE_PRODUCT_TTL=030)" = "$V30" ] && echo 1 || echo 0)"
for bad in 0 4 601 abc 30s -5; do
  ok "$bad is refused, on a store too" "$( [ "$(rc PAGE_CACHE_PRODUCT_TTL=$bad)" != 0 ] && [ "$(rc WOO_ACTIVE=1 PAGE_CACHE_PRODUCT_TTL=$bad)" != 0 ] && echo 1 || echo 0)"
done
ok "a bad WOO_ACTIVE is refused, not read as a non-store" "$( [ "$(rc WOO_ACTIVE=yes)" != 0 ] && echo 1 || echo 0)"
ok "it is a RECORDED setting in site_settings.py, and not a measurement flag" "$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s; sys.exit(0 if "PAGE_CACHE_PRODUCT_TTL" in s.SETTINGS and "PAGE_CACHE_PRODUCT_TTL" in s.DROPPABLE_VARS and "PAGE_CACHE_PRODUCT_TTL" not in s.MEASUREMENT else 1)' "$HERE/.." && echo 1 || echo 0)"
ok "it is in lib.sh SITE_SETTINGS" "$( (. "$LIB" >/dev/null 2>&1; echo " $SITE_SETTINGS ") | grep -q " PAGE_CACHE_PRODUCT_TTL " && echo 1 || echo 0)"
[ "$fail" = 0 ] && echo "page-cache-product-test: all pass" || { echo "page-cache-product-test: FAILED"; exit 1; }
