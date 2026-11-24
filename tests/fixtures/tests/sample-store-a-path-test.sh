#!/bin/bash
# Approach A sample-store load path (prealpha ggc.sh catalog gate): offline checks only.
# Proves the loader and site import keep the existing 2,609-product pin and route kind a
# through VARIANT=a /_sqlimport. No account and no live site.
#   tests/fixtures/tests/sample-store-a-path-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd); FX=$(cd "$HERE/.." && pwd); ROOT=$(cd "$FX/../.." && pwd)
LOADER=$FX/load-sample-store.sh
SITE=$ROOT/deploy/wfp/site
ENVF=$FX/sample-store.env
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }

# shellcheck disable=SC1091
. "$ENVF"
check "pin is at least 2000 published products" "$( [ "$SAMPLE_STORE_PRODUCTS" -ge 2000 ] && echo 1 || echo 0 )" 1
check "pin names the R2 fixture key" "$(grep -c 'sample-store/20261112-e84daed3e686.sql.gz' "$ENVF")" 1
check "loader still refuses a bad pin before import" "$(grep -c 'sha256.*nothing loaded' "$LOADER")" 1
check "loader documents the Store API product gate" "$(grep -c 'published products (Store API x-wp-total)' "$LOADER")" 1
check "loader branches on kind a for /_sqlimport counts" "$(grep -c '_sqlimport?counts=1' "$LOADER" | awk '{print ($1>=1)?1:0}')" 1
check "loader skips kind a password replace with a loud line" "$(grep -c 'admin password replace SKIPPED' "$LOADER")" 1
check "site import sets VARIANT=a for kind a" "$(awk '/^import_one\(\)/,/^}/' "$SITE" | grep -c 'IMP_VARIANT=a')" 1
check "site import refuses SQLITE on kind a" "$(awk '/^import_one\(\)/,/^}/' "$SITE" | grep -c 'not SQLITE')" 1
check "kind_a_refuse no longer claims import is refused" "$(grep -c 'site import is allowed for kind a' "$ROOT/deploy/wfp/kind-a.sh")" 1

T=$(mktemp -d "${TMPDIR:-/tmp}/sample-store-a-path.XXXXXX")
trap 'rm -rf "$T"' EXIT
printf 'not the fixture' | gzip -c > "$T/bad.sql.gz"
rc=0
SAMPLE_STORE=$T/bad.sql.gz "$LOADER" alpha >"$T/bad.out" 2>&1 || rc=$?
check "a bad pin still exits 1 before any site import" "$rc:$(grep -c 'nothing loaded' "$T/bad.out" || true)" "1:1"

echo "sample-store-a-path-test: $fails failing"
exit $((fails > 0))
