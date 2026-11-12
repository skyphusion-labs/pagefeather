#!/bin/bash
# deploy/wfp/site update refuses a build the live site cannot run (#377, lib.sh update_inputs_check).
# The case that made it: a plain `site update ggc-test` on 2026-11-12 shipped stock WordPress with an
# OPcache without WooCommerce (615 files) over the store's build, and every request answered 503.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ACCOUNT_ID=test
. "$HERE/../lib.sh"
fails=0
want() { # want <name> <expected exit> <live> <code> <woo> <content>
  local got; update_inputs_check "$3" "$4" "$5" "$6" 2>/dev/null; got=$?
  if [ "$got" = "$2" ]; then echo "  ok   $1"; else echo "  FAIL $1: exit $got, want $2"; fails=$((fails + 1)); fi
}
want "THE GGC-TEST CASE: WooCommerce live (200), the build would not prime it: refused" 2 e96c4e2f3b01-wooprimed 200 0 0
want "a live build made with content inputs, a run with none: refused" 2 e3b63c8eddbb-c1a2b3c4d 404 0 0
want "the same with -dirty before the content id: refused" 2 e3b63c8eddbb-dirty-c1a2b3c4d 404 0 0
ALLOW_PLAIN_BUILD=1 want "the same with ALLOW_PLAIN_BUILD=1: allowed" 0 e3b63c8eddbb-c1a2b3c4d 404 0 0
want "THE RESTORE: content inputs, WooCommerce primed, live 200: allowed" 0 e3b63c8eddbb-c1a2b3c4d 200 1 1
WOO_ACTIVE=1 want "a broken live site (503) with an explicit WOO_ACTIVE: allowed" 0 e3b63c8eddbb 503 1 1
want "a broken live site (503) with no explicit WOO_ACTIVE: refused (cannot tell)" 2 e3b63c8eddbb 503 1 1
want "no answer (000) and no explicit WOO_ACTIVE: refused" 2 e3b63c8eddbb 000 0 0
want "a plain site without WooCommerce (404), plain build: allowed" 0 e3b63c8eddbb 404 0 0
WOO_ACTIVE=0 want "WooCommerce live (200) and an explicit WOO_ACTIVE=0: still refused" 2 abc 200 0 0

# The inputs, read the way the update reads them.
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
check "no content input" "$(env -u PLUGINS -u IMPORT_CONTENT bash -c ". '$HERE/../lib.sh'; content_inputs_set")" 0
check "IMPORT_CONTENT is a content input" "$(IMPORT_CONTENT=/x bash -c ". '$HERE/../lib.sh'; content_inputs_set")" 1
check "woocommerce in IMPORT_PLUGINS primes it" "$(IMPORT_PLUGINS='mcp-adapter skyphusion-ai woocommerce' bash -c "unset WOO_ACTIVE; . '$HERE/../lib.sh'; woo_active_for_build")" 1
check "a store API with no server answers 000" "$(store_api_code http://127.0.0.1:9)" 000

# The refusal runs in update_one before the snapshot, the build and the upload.
S="$HERE/../site"
l_check=$(grep -n 'update_inputs_check "${rollback' "$S" | head -1 | cut -d: -f1)
l_snap=$(grep -n 'snapshot the data to' "$S" | head -1 | cut -d: -f1)
l_build=$(grep -n '^  build_dosql$' "$S" | head -1 | cut -d: -f1)
check "the refusal is in update_one" "$([ -n "$l_check" ] && echo yes || echo no)" yes
check "the refusal comes before the snapshot and the build" "$([ -n "$l_check" ] && [ "$l_check" -lt "$l_snap" ] && [ "$l_check" -lt "$l_build" ] && echo yes || echo no)" yes

echo "$fails failing case(s)"
[ "$fails" = 0 ]
