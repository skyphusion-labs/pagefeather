#!/bin/bash
# Test of #273: the temporary R2 credential that empties a site's bucket (site down, site remove)
# and puts an import's uploads (site import), in place of an account token (which needs API
# Tokens edit, refused on a minted token with 1001). It runs the real deploy/wfp/r2_temp.py,
# deploy/variants/r2-empty.sh and deploy/import/media.sh against fake-r2-temp.py, a stand-in API
# and S3 that, as R2 does for a temporary credential, refuses a request with no session token or
# for another bucket, and can expire a credential. No account.
#   deploy/wfp/tests/r2-temp-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d)
python3 -I "$HERE/fake-r2-temp.py" "$T/port" & SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
EP="http://127.0.0.1:$(cat "$T/port")"
export WFP_API="$EP/api" CLOUDFLARE_API_TOKEN=deploy-token-not-a-secret CLOUDFLARE_ACCOUNT_ID=test
RT="$REPO/deploy/wfp/r2_temp.py" EMPTY="$REPO/deploy/variants/r2-empty.sh" MEDIA="$REPO/deploy/import/media.sh"
st() { python3 -I -c 'import json, sys, urllib.request; d = json.load(urllib.request.urlopen(sys.argv[1] + "/_state")); print(eval(sys.argv[2]))' "$EP" "$1"; }
ctl() { python3 -I -c 'import sys, urllib.request; urllib.request.urlopen(urllib.request.Request(sys.argv[1], data=sys.argv[2].encode(), method=sys.argv[3]))' "$EP$1" "${2:-}" "${3:-POST}"; }
mode() { python3 -I -c 'import os, stat, sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))' "$1"; }

# 1. The mint.
cf=$T/cred; out=$(python3 -I "$RT" mint wp-wfp-a-media 3600 "$cf" 2>&1); rc=$?
check "mint: exit 0" "$rc" 0
check "  the file is mode 600" "$(mode "$cf")" 0o600
check "  it holds R2_KEY_ID, R2_SECRET and R2_SESSION_TOKEN" "$(grep -cE '^(R2_KEY_ID|R2_SECRET|R2_SESSION_TOKEN)=' "$cf")" 3
check "  no value is printed" "$(printf '%s' "$out" | grep -cE 'tmpkey|tmpsecret|sessiontoken')" 0
# It logs when the credential expires: the time before the mint plus the TTL, so never late.
exp=$(printf '%s' "$out" | sed -n 's/.*expires \([0-9TZ:-]*\) UTC or later.*/\1/p')
check "  it logs the expiry, about now + 3600 s (got $exp)" "$(python3 -I -c 'import calendar, sys, time; e = calendar.timegm(time.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ")); print(int(abs(e - (time.time() + 3600)) <= 15))' "$exp" 2>/dev/null || echo 0)" 1
check "  the request: the bucket, the deploy token as parent, object-read-write, the TTL" "$(st 'json.dumps(d["mints"][0], sort_keys=True)')" '{"bucket": "wp-wfp-a-media", "parentAccessKeyId": "tok-parent", "permission": "object-read-write", "ttlSeconds": 3600}'
ctl /_refuse_mint; python3 -I "$RT" mint wp-wfp-a-media 3600 "$T/refused" > /dev/null 2> "$T/refused.err"; rc=$?
check "a refused mint: exit 1, no file, and it says what the token needs" "$rc:$([ -e "$T/refused" ] && echo file || echo none):$(grep -c 'R2 Storage Write' "$T/refused.err")" "1:none:1"
python3 -I "$RT" mint "Bad_Bucket" 3600 "$T/x" 2> /dev/null; check "a bad bucket name: exit 2" "$?" 2
python3 -I "$RT" mint wp-wfp-a-media 999999 "$T/x" 2> /dev/null; check "a TTL over 7 days: exit 2" "$?" 2

# 2. r2-empty.sh with the credential file empties ITS bucket; another bucket is not reachable.
for k in a b c; do ctl "/_seed/wp-wfp-a-media/uploads/$k.jpg" x PUT; done; ctl /_seed/wp-wfp-b-media/uploads/keep.jpg x PUT
R2_CRED_FILE=$cf "$EMPTY" "$EP" wp-wfp-a-media > "$T/e.out" 2>&1; rc=$?
check "r2-empty.sh with R2_CRED_FILE: exit 0, 3 deleted" "$rc:$(grep -c 'empty (3 objects deleted)' "$T/e.out")" "0:1"
check "  bucket a is empty and b keeps its object" "$(st '" ".join(d["objects"])')" "/wp-wfp-b-media/uploads/keep.jpg"
R2_CRED_FILE=$cf R2_RETRY_S=1 R2_RETRY_STEP=1 "$EMPTY" "$EP" wp-wfp-b-media > "$T/e2.out" 2>&1; rc=$?
check "  the same credential on bucket b is refused (exit 1), b untouched" "$rc:$(st 'len(d["objects"])')" "1:1"
# The session token is what makes it work: the same key with no token is refused.
# shellcheck disable=SC1090
( . "$cf"; R2_KEY_ID=$R2_KEY_ID R2_SECRET=$R2_SECRET R2_RETRY_S=1 R2_RETRY_STEP=1 "$EMPTY" "$EP" wp-wfp-a-media ) > "$T/e3.out" 2>&1; rc=$?
check "control: the key with NO session token is refused (the header is what the fake checks)" "$rc" 1
check "no script puts the session token in curl's arguments (only in the -K config)" "$(grep -h 'x-amz-security-token' "$EMPTY" "$MEDIA" | grep -vc "printf 'header = \"x-amz-security-token: %s")" 0

# 3. A credential that expires mid-run: one fresh mint, and the run finishes.
for k in 1 2 3 4 5 6; do ctl "/_seed/wp-wfp-a-media/uploads/e$k.jpg" x PUT; done
python3 -I "$RT" mint wp-wfp-a-media 900 "$cf" > /dev/null; m0=$(st 'len(d["mints"])')
ctl "/_expire_after?n=3"
touch -t 202601010000 "$cf"   # an old file, so the refresh may mint (R2_REFRESH_MIN_S)
R2_CRED_FILE=$cf R2_CRED_REFRESH="python3 -I '$RT' mint wp-wfp-a-media 900 '$cf'" R2_RETRY_S=20 R2_RETRY_STEP=1 "$EMPTY" "$EP" wp-wfp-a-media > "$T/e4.out" 2>&1; rc=$?
check "#273: an expiry mid-empty: exit 0, every object deleted" "$rc:$(grep -c 'empty (6 objects deleted)' "$T/e4.out"):$(st 'len([o for o in d["objects"] if "wp-wfp-a-media" in o])')" "0:1:0"
check "  exactly one fresh credential was minted" "$(( $(st 'len(d["mints"])') - m0 ))" 1
check "  the log says so" "$(grep -c 'minting a fresh credential' "$T/e4.out")" 1
# Without R2_CRED_REFRESH the same expiry fails (the refresh is what saves the run).
for k in 1 2 3; do ctl "/_seed/wp-wfp-a-media/uploads/f$k.jpg" x PUT; done
python3 -I "$RT" mint wp-wfp-a-media 900 "$cf" > /dev/null; ctl "/_expire_after?n=1"
R2_CRED_FILE=$cf R2_RETRY_S=2 R2_RETRY_STEP=1 "$EMPTY" "$EP" wp-wfp-a-media > "$T/e5.out" 2>&1; rc=$?
check "control: the same expiry with no R2_CRED_REFRESH fails" "$rc" 1

# 4. media.sh (site import) with the credential file, 8 parallel jobs, and an expiry mid-run.
SRC=$T/wp-content; mkdir -p "$SRC/uploads/2026"
for k in $(seq 1 24); do echo "img $k" > "$SRC/uploads/2026/p$k.jpg"; done
python3 -I "$RT" mint wp-wfp-c-media 900 "$cf" > /dev/null; m0=$(st 'len(d["mints"])'); touch -t 202601010000 "$cf"
ctl "/_expire_after?n=10"
R2_CRED_FILE=$cf R2_CRED_REFRESH="python3 -I '$RT' mint wp-wfp-c-media 900 '$cf'" R2_RETRY_S=20 R2_RETRY_STEP=1 JOBS=8 "$MEDIA" "$EP" wp-wfp-c-media "$SRC" > "$T/m.out" 2>&1; rc=$?
check "media.sh with R2_CRED_FILE and an expiry mid-run: exit 0, 24 sent, 0 failed" "$rc:$(grep -c '^media: 24 sent, 0 already there, 0 failed$' "$T/m.out")" "0:1"
mn=$(( $(st 'len(d["mints"])') - m0 ))
check "  the 8 parallel jobs minted ONE fresh credential (the lock and the min age)" "$mn" 1
R2_CRED_FILE=$cf "$MEDIA" "$EP" wp-wfp-c-media "$SRC" > "$T/m2.out" 2>&1
check "  the check run: 0 sent, 24 there" "$(grep -c '^media: 0 sent, 24 already there, 0 failed$' "$T/m2.out")" 1
check "  the lock is gone after" "$([ -e "$cf.lock" ] && echo left || echo gone)" gone

# #545: the same case, STRESS_ROUNDS times (30) with STRESS_JOBS (16) jobs and 32 files: every
# round mints ONE credential, for bucket c. A round that does not prints the mint log and the
# refresh lines of that run, so a CI flake names its cause.
sbad=0
for r in $(seq 1 "${STRESS_ROUNDS:-30}"); do
  S=$T/stress$r; mkdir -p "$S/uploads/2026"; for k in $(seq 1 32); do echo "s $r $k" > "$S/uploads/2026/s$k.jpg"; done
  python3 -I "$RT" mint wp-wfp-c-media 900 "$cf" > /dev/null; m0=$(st 'len(d["mints"])'); touch -t 202601010000 "$cf"
  ctl "/_expire_after?n=10"
  : > "$T/trace$r"
  R2_CRED_FILE=$cf R2_CRED_REFRESH="bash '$HERE/r2-mint-trace.sh' '$T/trace$r' '$RT' wp-wfp-c-media '$cf'" R2_RETRY_S=20 R2_RETRY_STEP=1 JOBS=${STRESS_JOBS:-16} "$MEDIA" "$EP" wp-wfp-c-media "$S" > "$T/s$r.out" 2>&1; rc=$?
  mn=$(( $(st 'len(d["mints"])') - m0 ))
  if [ "$rc" != 0 ] || [ "$mn" != 1 ]; then
    sbad=$((sbad + 1))
    echo "  stress round $r: exit $rc, $mn mints; the mints of this round (time, bucket): $(st "d['mint_log'][$m0:]")"
    { grep -E '^r2|^fail ' "$T/s$r.out" | head -8; echo "    (the last lines)"; tail -4 "$T/s$r.out"; } | sed 's/^/    /'
    echo "    the mint trace (start/end, pid, time, lock dir, cred mtime):"; sed 's/^/      /' "$T/trace$r"
  fi
done
check "#545 stress: ${STRESS_ROUNDS:-30} rounds of ${STRESS_JOBS:-16} jobs, each exit 0 with ONE fresh credential" "$sbad" 0
# DATA (#545 draft only): does the lock primitive exclude on this machine?
echo "  lock-race: $(python3 -I "$HERE/lock-race.py" mkdir 16 200)"
echo "  lock-race: $(python3 -I "$HERE/lock-race.py" flock 16 200)"

# r2_refresh itself, cut out of the real script: two refusals in a row mint once (the min age),
# and a refusal after R2_REFRESH_MIN_S mints again.
for scr in "$EMPTY" "$MEDIA"; do
  ( eval "$(sed -n '/^r2_refresh() {/,/^}/p' "$scr")"
    f=$T/rf; : > "$T/rf.log"; echo x > "$f"; touch -t 202601010000 "$f"
    export R2_CRED_FILE=$f R2_CRED_REFRESH="echo minted >> '$T/rf.log'; touch '$f'"
    r2_refresh 2>/dev/null; r2_refresh 2>/dev/null; a=$(wc -l < "$T/rf.log" | tr -d ' ')
    touch -t 202601010000 "$f"; r2_refresh 2>/dev/null; b=$(wc -l < "$T/rf.log" | tr -d ' ')
    echo "$a:$b" ) > "$T/rf.out"
  check "r2_refresh ($(basename "$scr")): two refusals in a row mint once; an old file mints again" "$(cat "$T/rf.out")" "1:2"
done
check "r2-empty.sh and media.sh carry the same credential block" "$(sed -n '/^# The key (#273)/,/^r2_key_set ||/p' "$EMPTY" | shasum)" "$(sed -n '/^# The key (#273)/,/^r2_key_set ||/p' "$MEDIA" | shasum)"

# 5. The wiring: no account token is made anywhere in deploy/wfp.
check "deploy/wfp/terraform/site has no cloudflare_account_token" "$(cat "$REPO"/deploy/wfp/terraform/site/*.tf | grep -c 'cloudflare_account_token')" 0
check "  and still has the media bucket (the grep above reads the right files)" "$(grep -c 'resource "cloudflare_r2_bucket" "media"' "$REPO"/deploy/wfp/terraform/site/main.tf)" 1
check "deploy/wfp passes no -var teardown or media_import" "$(grep -rhE -- '-var "?(teardown|media_import)' "$REPO/deploy/wfp/site" "$REPO/deploy/wfp/site.sh" "$REPO/deploy/wfp/lib.sh" | wc -l | tr -d ' ')" 0
check "site import mints with r2_temp_mint and passes R2_CRED_FILE" "$(grep -c 'r2_temp_mint "\$B" "\$ttl" "\$cf"' "$REPO/deploy/wfp/site"):$(grep -c 'R2_CRED_FILE="\$cf"' "$REPO/deploy/wfp/site")" "1:1"
echo "$fails failing check(s)"
[ "$fails" = 0 ]
