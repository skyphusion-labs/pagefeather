#!/bin/bash
# Test of lib.sh down_empty_bucket, the `site remove` step that empties the media
# bucket with a teardown key made for it. A failed empty must remove the key again
# before it stops, so no live R2 key is left in the account or the state. Stub
# tfr, api_code and the empty script. No account, no network.
#   deploy/wfp/tests/down-key-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# shellcheck source=../lib.sh
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }

# Stubs. The tfr log is the whole record of what terraform was asked to do.
tfr() { echo "$*" >> "$T/tfr.log"; case "$*" in *"output -raw"*) printf 'stub' ;; esac; return 0; }
api_code() { echo "${BUCKET_CODE:-200}"; }
printf '#!/bin/sh\nexit %s\n' 1 > "$T/empty-fails"; chmod +x "$T/empty-fails"
printf '#!/bin/sh\nexit 0\n' > "$T/empty-ok"; chmod +x "$T/empty-ok"
# shellcheck disable=SC2034 # read by down_empty_bucket in lib.sh
VARS=(-var name=one)
applies() { grep -c "apply .* -var teardown=$1 -target=cloudflare_account_token.teardown" "$T/tfr.log" 2>/dev/null || true; }

: > "$T/tfr.log"
rc=0; R2_EMPTY="$T/empty-fails" down_empty_bucket one > "$T/out" 2>&1 || rc=$?
check "a failed empty returns its failure" "$rc" "1"
check "a failed empty made the teardown key once" "$(applies true)" "1"
check "a failed empty removed the teardown key again" "$(applies false)" "1"
check "the key is removed AFTER it was made" "$(grep -n 'teardown=' "$T/tfr.log" | sed -E 's/^([0-9]+):.*teardown=(true|false).*/\2/' | tr '\n' ' ')" "true false "

: > "$T/tfr.log"
rc=0; R2_EMPTY="$T/empty-ok" down_empty_bucket one > "$T/out" 2>&1 || rc=$?
check "a good empty returns 0" "$rc" "0"
check "a good empty leaves the key for the destroy that follows" "$(applies false)" "0"

: > "$T/tfr.log"
rc=0; BUCKET_CODE=404 R2_EMPTY="$T/empty-fails" down_empty_bucket one > "$T/out" 2>&1 || rc=$?
check "no bucket: nothing to empty, no key made" "$rc:$(applies true)" "0:0"

check "site.sh down empties through down_empty_bucket" "$(grep -c '^ *down_empty_bucket "\$s"$' "$HERE/../site.sh")" "1"
check "site.sh no longer runs r2-empty.sh outside it" "$(grep -c 'r2-empty.sh' "$HERE/../site.sh")" "0"

echo "$fails failing check(s)"
exit $fails
