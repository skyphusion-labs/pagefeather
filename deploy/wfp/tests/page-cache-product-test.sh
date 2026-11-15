#!/bin/bash
# deploy/wfp lib.sh page_cache_product_var (C2 of #628): PAGE_CACHE_PRODUCT_TTL renders as a var only
# when set, as an integer from 5 to 600. Unset renders nothing (the site is byte for byte as before).
# It is a measurement flag (site_settings.py MEASUREMENT): never recorded, ON only for the run.
# Run: bash deploy/wfp/tests/page-cache-product-test.sh   (macOS /bin/bash 3.2 too)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB="$HERE/../lib.sh"
fail=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
r() { ( . "$LIB" >/dev/null 2>&1; page_cache_product_var ) 2>/dev/null; }
rc() { ( . "$LIB" >/dev/null 2>&1; page_cache_product_var >/dev/null 2>&1 ); echo $?; }

ok "the renderer exists" "$( ( . "$LIB" >/dev/null 2>&1; type page_cache_product_var >/dev/null 2>&1 ) && echo 1 || echo 0)"
ok "unset renders nothing" "$( [ -z "$(unset PAGE_CACHE_PRODUCT_TTL; r)" ] && [ "$(unset PAGE_CACHE_PRODUCT_TTL; rc)" = 0 ] && echo 1 || echo 0)"
ok "30 renders the var" "$( [ "$(PAGE_CACHE_PRODUCT_TTL=30 r)" = 'PAGE_CACHE_PRODUCT_TTL = "30"' ] && echo 1 || echo 0)"
ok "a leading zero is read as decimal" "$( [ "$(PAGE_CACHE_PRODUCT_TTL=030 r)" = 'PAGE_CACHE_PRODUCT_TTL = "30"' ] && echo 1 || echo 0)"
for bad in 0 4 601 abc 30s -5; do
  ok "$bad is refused" "$( [ "$(PAGE_CACHE_PRODUCT_TTL=$bad rc)" != 0 ] && echo 1 || echo 0)"
done
ok "it is a measurement flag in site_settings.py" "$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings; sys.exit(0 if "PAGE_CACHE_PRODUCT_TTL" in site_settings.MEASUREMENT else 1)' "$HERE/.." && echo 1 || echo 0)"
ok "render_user calls it" "$(grep -Eq 'page_cache_product_var\) \|\| return 1' "$LIB" && echo 1 || echo 0)"
[ "$fail" = 0 ] && echo "page-cache-product-test: all pass" || { echo "page-cache-product-test: FAILED"; exit 1; }
