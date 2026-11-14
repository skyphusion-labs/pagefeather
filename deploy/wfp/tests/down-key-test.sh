#!/bin/bash
# Test of lib.sh down_empty_bucket, the `site remove` step that empties the media bucket. Since
# #273 it empties with a temporary R2 credential for that one bucket, minted from the deploy token
# (r2_temp.py), so no token is made in the account or the state, and the deploy token needs no API
# Tokens permission. Stub tfr, api_code, the mint and the empty script. No account, no network.
# (r2-temp-test.sh runs the real mint and r2-empty.sh against a stand-in API and S3.)
#   deploy/wfp/tests/down-key-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# shellcheck source=../lib.sh
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }

# Stubs. The tfr log is the whole record of what terraform was asked to do.
tfr() { echo "$*" >> "$T/tfr.log"; case "$*" in *"output -raw r2_endpoint"*) printf 'https://r2.test' ;; esac; return 0; }
api_code() { echo "${BUCKET_CODE:-200}"; }
r2_temp_mint() { echo "$1 $2" >> "$T/mint.log"; [ "${MINT_FAIL:-0}" = 1 ] && return 1; printf "R2_KEY_ID=k\nR2_SECRET=s\nR2_SESSION_TOKEN=t\n" > "$3"; }
# The empty stand-in records what it was given, then exits with EMPTY_RC.
cat > "$T/empty" <<'SH'
#!/bin/bash
{ echo "args $*"; [ -r "${R2_CRED_FILE:-/nonexistent}" ] && echo "cred readable $R2_CRED_FILE"; echo "refresh ${R2_CRED_REFRESH:-none}"; } > "$EMPTY_LOG"
exit "${EMPTY_RC:-0}"
SH
chmod +x "$T/empty"
export EMPTY_LOG=$T/empty.log
run() { : > "$T/tfr.log"; : > "$T/mint.log"; rm -f "$EMPTY_LOG"; rc=0; R2_EMPTY="$T/empty" down_empty_bucket one > "$T/out" 2>&1 || rc=$?; }
cred() { sed -n 's/^cred readable //p' "$EMPTY_LOG" 2>/dev/null; }

run
check "a good empty returns 0" "$rc" 0
check "  it minted one credential for the site's bucket, 3600 s" "$(cat "$T/mint.log")" "wp-wfp-one-media 3600"
check "  terraform was asked to apply nothing (no account token)" "$(grep -c 'apply' "$T/tfr.log")" 0
check "  the empty got the bucket and the endpoint" "$(sed -n 's/^args //p' "$EMPTY_LOG")" "https://r2.test wp-wfp-one-media"
f=$(cred); check "  the empty could read the credential file" "$([ -n "$f" ] && echo yes || echo no)" yes
check "  its refresh mints again for the same bucket into the same file" "$(grep -c "^refresh python3 -I .*r2_temp.py mint wp-wfp-one-media 3600 $f$" "$EMPTY_LOG")" 1
check "  the credential file is removed after" "$([ -e "$f" ] && echo left || echo gone)" gone

EMPTY_RC=3 run
check "a failed empty returns its failure" "$rc" 3
f=$(cred); check "  the credential file is removed after a failure too" "$([ -n "$f" ] && [ ! -e "$f" ] && echo gone || echo left)" gone
check "  the log says when the credential expires" "$(grep -c 'expires within 3600 s' "$T/out")" 1

MINT_FAIL=1 run
check "a refused mint returns 1 and the empty does not run" "$rc:$([ -e "$EMPTY_LOG" ] && echo ran || echo not-run)" "1:not-run"

R2_TEMP_TTL=900 run
check "R2_TEMP_TTL sets the TTL" "$(cat "$T/mint.log")" "wp-wfp-one-media 900"

BUCKET_CODE=404 run
check "no bucket: nothing to empty, no mint" "$rc:$(wc -l < "$T/mint.log" | tr -d ' ')" "0:0"

check "site.sh down empties through down_empty_bucket" "$(grep -c '^ *down_empty_bucket "\$s"$' "$HERE/../site.sh")" "1"
check "site.sh no longer runs r2-empty.sh outside it" "$(grep -c 'r2-empty.sh' "$HERE/../site.sh")" "0"
check "site.sh destroys pass no teardown variable" "$(grep -c -- '-var teardown' "$HERE/../site.sh")" "0"

echo "$fails failing check(s)"
exit $fails
