#!/bin/bash
# Test of opcache-check.py, the floor of a shipped OPcache dump (#313). Synthetic zips; no build.
#   spikes/b2-wordpress/tests/opcache-check-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd); CHK="$HERE/../opcache-check.py"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
mkzip() { # mkzip <file> <core files> <woo files>
  python3 - "$@" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], "w")
for i in range(int(sys.argv[2])): z.writestr("h/wordpress/wp-includes/f%d.php.bin" % i, "x")
for i in range(int(sys.argv[3])): z.writestr("h/wordpress/wp-content/plugins/woocommerce/f%d.php.bin" % i, "x")
z.close()
PY
}
mkzip "$T/unprimed.zip" 620 0      # the fresh-clone dump of 2026-11-12
mkzip "$T/primed.zip" 625 1506     # the primed store dump of 2026-11-12
mkzip "$T/tiny.zip" 50 0
run() { python3 "$CHK" "$@" > "$T/out" 2>&1; echo $?; }
check "a store build (WOO_ACTIVE=1) with no WooCommerce scripts fails" "$(run "$T/unprimed.zip" 1)" 1
check "  and says why" "$(grep -c 'store pages were not primed' "$T/out")" 1
check "a store build with the WooCommerce scripts passes" "$(run "$T/primed.zip" 1)" 0
check "a non-store build (WOO_ACTIVE=0) with no WooCommerce passes" "$(run "$T/unprimed.zip" 0)" 0
check "a dump under the total floor fails, whatever WOO_ACTIVE" "$(run "$T/tiny.zip" 0)" 1
check "the floors are settable" "$(OPCACHE_WOO_MIN=2000 run "$T/primed.zip" 1)" 1
check "a bad WOO_ACTIVE is a usage error" "$(run "$T/primed.zip" yes)" 2
[ "$fails" = 0 ] && echo "0 failing case(s)" || { echo "$fails failing case(s)"; exit 1; }
