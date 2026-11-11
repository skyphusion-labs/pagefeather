#!/bin/bash
# Test of lib.sh bundle_size_check: a b-dosql bundle over BUNDLE_MAX_MIB (default 62) stops BEFORE an
# upload, and a missing part is an error, never a small bundle. Sparse files; no build, no account.
#   deploy/wfp/tests/bundle-size-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# shellcheck disable=SC1091
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
mk() { # mk <dir> <site MiB> <opcache MiB> <wasm MiB> <js MiB>
  mkdir -p "$1/build" "$1/vendor"
  truncate -s "${2}m" "$1/build/site.zip"; truncate -s "${3}m" "$1/build/opcache.zip"
  truncate -s "${4}m" "$1/vendor/php_8_3.wasm"; truncate -s "${5}m" "$1/vendor/php_8_3.js"
}
mk "$T/ok" 20 22 18 1
out=$(bundle_size_check "$T/ok" 2>&1); rc=$?
check "61 MiB passes the 62 MiB gate" "$rc:$(printf '%s' "$out" | grep -c '61.00 MiB of the 62 MiB gate')" "0:1"
mk "$T/over" 24 22 18 1
out=$(bundle_size_check "$T/over" 2>&1); rc=$?
check "65 MiB stops, naming the gate" "$rc:$(printf '%s' "$out" | grep -c 'over the 62 MiB gate')" "1:1"
out=$(BUNDLE_MAX_MIB=66 bundle_size_check "$T/over" 2>&1); rc=$?
check "BUNDLE_MAX_MIB raises the gate" "$rc" "0"
mk "$T/miss" 1 1 1 1; rm "$T/miss/build/opcache.zip"
out=$(bundle_size_check "$T/miss" 2>&1); rc=$?
check "a missing part is an error" "$rc:$(printf '%s' "$out" | grep -c 'missing build/opcache.zip')" "1:1"
check "build_dosql runs the gate" "$(sed -n '/^build_dosql()/,/^}/p' "$HERE/../lib.sh" | grep -c 'bundle_size_check')" "1"
check "site.sh up checks before its upload" "$(grep -B1 'npx wrangler deploy --config "$CONF" --dispatch-namespace' "$HERE/../site.sh" | grep -c 'bundle_size_check')" "1"
check "site update checks before its upload" "$(grep -c 'bundle_size_check ||' "$HERE/../site")" "1"
echo "$fails failing case(s)"
exit $fails
