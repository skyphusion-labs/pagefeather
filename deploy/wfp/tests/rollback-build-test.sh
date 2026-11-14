#!/bin/bash
# Test of #464: a site update never rolls a site back to ANOTHER site's build, and a failed build
# stops the update before any upload. It runs the real update_one_inner from deploy/wfp/site (cut out
# of the file, so the shipped code is what runs) against stand-ins for the account, terraform and
# wrangler. No account, no build.
#   deploy/wfp/tests/rollback-build-test.sh [another site file]
# Cases:
#   save_live_build and rollback_build_ok (lib.sh) on their own
#   build_dosql fails when build.sh fails, with set -e off, and opcache.sh does not run
#   THE #464 CASE: build/ holds site A's build, site B is updated, the verify fails:
#     B is NOT re-deployed with A's build (one upload only), and the log says so
#   the positive control: build/ holds B's live build: the rollback re-deploys it (two uploads,
#     the second one with B's live build id)
#   a failed build: the update returns 1 and wrangler is never called
#   THE #466 CASE: build/ holds site A's build, B's verify fails, B's own artifact is in B's bucket:
#     B rolls back to that artifact (its own build id AND its own code), never A's
#   the artifact wins over build/; an artifact that holds another build is refused (#465 guard);
#     a good update stores its artifact and prunes all but it and the build before it
# The bucket is a stand-in S3 (fake-s3.py) and rollback_artifact.py is the real one.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SITE=${1:-$HERE/../site}
ACCOUNT_ID=test
# shellcheck disable=SC1091
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d)
FA=$T/app; mkdir -p "$FA/build" "$FA/vendor"; echo "// current tree" > "$FA/index.js"; echo "// loader" > "$FA/vendor/php_8_3.js"
python3 -I "$HERE/fake-s3.py" "$T/port" & S3PID=$!
trap 'kill $S3PID 2>/dev/null; wait $S3PID 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
export WFP_S3_ENDPOINT="http://127.0.0.1:$(cat "$T/port")" WFP_S3_KEY_ID=test-key WFP_S3_SECRET=test-secret CLOUDFLARE_ACCOUNT_ID=test
setid() { printf 'export default "%s";\n' "$1" > "$FA/build/build-id.js"; }

# save_live_build and rollback_build_ok.
APP=$FA
setid aaaaaaaaaaaa-wooprimed; mkdir -p "$T/d1"
why=$(save_live_build bbbbbbbbbbbb "$T/d1"); rc=$?
check "save_live_build: build/ holds another build: refused" "$rc" 1
check "  nothing is copied" "$([ -e "$T/d1/build" ] && echo copied || echo none)" none
check "  the reason names both builds" "$(printf '%s' "$why" | grep -c 'aaaaaaaaaaaa-wooprimed.*bbbbbbbbbbbb')" 1
mkdir -p "$T/d2"; got=$(save_live_build aaaaaaaaaaaa-wooprimed "$T/d2"); rc=$?
check "save_live_build: build/ is the live build: saved" "$rc:$got" "0:aaaaaaaaaaaa-wooprimed"
check "  the copy holds that build id" "$(sed -n 's/export default "\(.*\)";/\1/p' "$T/d2/build/build-id.js")" aaaaaaaaaaaa-wooprimed
save_live_build "" "$T/d1" >/dev/null; check "save_live_build: no live build recorded: refused" "$?" 1
setid cccccccccccc-dirty; save_live_build cccccccccccc-dirty "$T/d1" >/dev/null; check "save_live_build: a -dirty live id: refused" "$?" 1
rm -f "$FA/build/build-id.js"; save_live_build x "$T/d1" >/dev/null; check "save_live_build: no build/: refused" "$?" 1
rollback_build_ok a a; check "rollback_build_ok: equal" "$?" 0
rollback_build_ok a b; check "rollback_build_ok: different" "$?" 1
rollback_build_ok "" ""; check "rollback_build_ok: both empty" "$?" 1
rollback_build_ok unknown unknown; check "rollback_build_ok: unknown" "$?" 1

# build_dosql: a failed build.sh stops the build, also where set -e is off.
B=$T/bapp; mkdir -p "$B/node_modules" "$B/vendor" "$B/build"
printf '#!/bin/bash\necho prepared\n' > "$B/prepare.sh"
printf '#!/bin/bash\necho "fetch refused an unpinned slug" >&2; echo partial; exit 1\n' > "$B/build.sh"
printf '#!/bin/bash\ntouch build/opcache-ran; echo ok\n' > "$B/opcache.sh"
chmod +x "$B/prepare.sh" "$B/build.sh" "$B/opcache.sh"
r=$( (APP=$B; unset WOO_ACTIVE PLUGINS IMPORT_PLUGINS; if build_dosql > /dev/null 2>&1; then echo 0; else echo 1; fi) )
check "build_dosql fails when build.sh fails, with set -e off" "$r" 1
check "  and opcache.sh did not run on the half-built tree" "$([ -e "$B/build/opcache-ran" ] && echo ran || echo no)" no

# The update itself: update_one_inner, cut out of the site file, with stand-ins.
eval "$(sed -n '/^update_one_inner() {/,/^}/p' "$SITE")"
type update_one_inner >/dev/null 2>&1 || { echo "FAIL update_one_inner was not found in $SITE"; exit 1; }
cat > "$T/wrangler" <<'SH'
#!/bin/bash
# A stand-in wrangler: logs the build id each deploy uploads; FAIL_DEPLOY=1 fails it.
echo "deploy $(sed -n 's/export default "\(.*\)";/\1/p' build/build-id.js) $(head -1 index.js)" >> "$WRLOG"
[ "${FAIL_DEPLOY:-0}" = 1 ] && { echo "upload refused" >&2; exit 1; }
exit 0
SH
chmod +x "$T/wrangler"
export WRLOG=$T/wr.log
WR=$T/wrangler; NAMESPACE=wp-wfp; SUB=sub; KV_ID=kv
LIVE_B=bbbbbbbbbbbb-wooprimed
valid_site() { return 0; }; has_ws() { return 0; }
tfr() { case "$*" in
    "site output -json") printf '{"wp_salt":{"value":"s"},"spike_token":{"value":"t"}}' ;;
    "site output -raw spike_token") printf SECRET-SPIKE-TOKEN ;;
    "site output -raw"*) printf x ;;
    "site apply"*) # the stand-in site map entry: an apply records its data_hold (#515)
      echo "$*" >> "$T/tfr.log"; local a; for a in "$@"; do case "$a" in data_hold=*) printf '%s' "${a#data_hold=}" > "$T/hold" ;; esac; done ;;
    *) return 0 ;; esac; }
entry_data_hold() { cat "$T/hold" 2>/dev/null; }
# The stand-in snapshot.py (#515): dbsnapshot stores, dbrestore exits STUB_RESTORE (0 by default).
cat > "$T/snap.py" <<'PY2'
import json, os, sys
open(os.environ["SNAPLOG"], "a").write(sys.argv[1] + "\n")
if sys.argv[1] == "dbrestore" and os.environ.get("STUB_RESTORE", "0") != "0":
    print(json.dumps({"ok": False, "stage": "import", "part": 6, "parts": 17, "status": 502, "attempts": 3})); sys.exit(1)
print(json.dumps({"ok": True}))
PY2
export WFP_SNAPSHOT=$T/snap.py SNAPLOG=$T/snap.log
site_vars() { REC_HOST=127.0.0.1:9; REC_CD=none; REC_VARS=(-var host=x); }
media_bucket() { echo "${BKT:-wp-wfp}-$1-media"; }
entry_build() { echo "$LIVE_B"; }
entry_config_hash() { echo h-live; }
use_recorded_inputs() { return 0; }
store_api_code() { echo 404; }
update_inputs_check() { return 0; }
tree_clean_check() { return 0; }
render_user() { echo "name = \"site-$1\""; }
config_hash() { echo h-new; }
search_on() { return 1; }
bundle_size_check() { return 0; }
wait_build() { return 0; }
curl() { printf 200; }   # the front page check; the S3 calls run the real curl (a subprocess)
record_build_inputs() { return 0; }
# #558: the settings record and the live drop check (config-hash-test.sh covers them).
keep_settings() { SETTINGS_RECORDED=1; return 0; }; settings_dropcheck() { return 0; }; record_settings() { return 0; }
# The build stand-in: the new build of site B.
build_dosql() { [ "${FAIL_BUILD:-0}" = 1 ] && return 1; setid dddddddddddd-wooprimed; }
# The temp dirs of the update cases go under $TT, so the test can see that none is left (#513:
# run_update made WDIR and never removed it, one empty dir per case). WDIR has an explicit template
# there. The update's own mktemp -d calls follow TMPDIR with GNU mktemp (the CI runner), so there
# the check covers them too; macOS mktemp -d without a template ignores TMPDIR, so on a Mac it
# covers WDIR only.
TT=$T/tmp; mkdir -p "$TT"
run_update() { # run_update <id build/ holds at the start> [env...]
  setid "$1"; shift; : > "$WRLOG"
  ( export TMPDIR=$TT; APP=$FA; WDIR=$(mktemp -d "$TT/wdir.XXXXXX"); export NO_SNAPSHOT=1 "$@"; rc=0; update_one_inner siteb || rc=$?
    rm -rf "$WDIR"; echo "rc=$rc" ) > "$T/out" 2>&1   # as update_one removes its work dir
}
# THE #464 CASE: the clone last built site A (pf394a's build in the measured run), B is updated,
# the verify fails. Before the fix, the rollback uploaded A's build to B.
run_update aaaaaaaaaaaa-wooprimed FORCE_FAIL=verify BKT=c464
check "#464: build/ holds site A's build, B's verify fails: the update fails" "$(grep -c '^rc=1$' "$T/out")" 1
check "  B gets ONE upload (its new build), never A's" "$(tr '\n' ' ' < "$WRLOG")" "deploy dddddddddddd-wooprimed // current tree "
check "  A's build is never uploaded" "$(grep -c aaaaaaaaaaaa "$WRLOG")" 0
check "  the log says there is no code rollback artifact" "$(grep -c 'NO code rollback artifact: build/ holds aaaaaaaaaaaa-wooprimed' "$T/out")" 1
check "  the log says to deploy the old build by hand" "$(grep -c "Deploy $LIVE_B by hand" "$T/out")" 1
# The positive control: build/ holds B's live build, so the rollback re-deploys it.
run_update "$LIVE_B" FORCE_FAIL=verify BKT=ctl
check "control: build/ holds B's live build: two uploads, the second is B's live build" "$(tr '\n' ' ' < "$WRLOG")" "deploy dddddddddddd-wooprimed // current tree deploy $LIVE_B // current tree "
check "  the log says it re-deployed it" "$(grep -c "re-deployed $LIVE_B" "$T/out")" 1
# A failed build: nothing is uploaded.
run_update "$LIVE_B" FAIL_BUILD=1
check "a failed build: the update fails" "$(grep -c '^rc=1$' "$T/out")" 1
check "  wrangler is never called" "$(wc -l < "$WRLOG" | tr -d ' ')" 0
check "  the log says nothing was uploaded" "$(grep -c 'the build failed; nothing was uploaded' "$T/out")" 1
# A failed upload: no rollback, nothing else uploaded.
run_update "$LIVE_B" FAIL_DEPLOY=1
check "a failed upload: the update fails after one upload attempt" "$(grep -c '^rc=1$' "$T/out"):$(wc -l < "$WRLOG" | tr -d ' ')" "1:1"
check "  and the upload log is shown" "$(grep -c 'upload refused' "$T/out")" 1

# #466: the site's own artifact in its own bucket.
keys() { python3 -I -c 'import sys, urllib.request; print(urllib.request.urlopen(sys.argv[1] + "/_keys").read().decode(), end="")' "$WFP_S3_ENDPOINT"; }
art() { # art <bucket> <key id> <build id it holds> <marker>: store an artifact with the real pack and put
  local d; d=$(mktemp -d "$T/art.XXXX"); mkdir -p "$d/build" "$d/vendor"
  printf 'export default "%s";\n' "$3" > "$d/build/build-id.js"; echo "// $4" > "$d/index.js"; echo "// loader $4" > "$d/vendor/php_8_3.js"
  python3 -I "$WFP/rollback_artifact.py" pack "$d" "$3" "$d.tgz" >/dev/null || echo "FAIL art pack"
  python3 -I "$WFP/rollback_artifact.py" put "$1" "$2" "$d.tgz" >/dev/null 2>&1 || {
    # A key that names another build (the guard case): stored raw, as a tampered object would be.
    python3 -I -c 'import sys, urllib.request; urllib.request.urlopen(urllib.request.Request(sys.argv[1], data=open(sys.argv[2], "rb").read(), method="PUT"))' "$WFP_S3_ENDPOINT/$1/_build/artifact/$2.tar.gz" "$d.tgz"; }
}
art c466-siteb-media "$LIVE_B" "$LIVE_B" "B live code"
art c466-sitea-media aaaaaaaaaaaa-wooprimed aaaaaaaaaaaa-wooprimed "A code"
run_update aaaaaaaaaaaa-wooprimed FORCE_FAIL=verify BKT=c466
check "#466: build/ holds A's build, B's verify fails, B's artifact is in B's bucket: the update fails" "$(grep -c '^rc=1$' "$T/out")" 1
check "  B rolls back to B's own artifact: its live build id AND its own code" "$(tr '\n' ' ' < "$WRLOG")" "deploy dddddddddddd-wooprimed // current tree deploy $LIVE_B // B live code "
check "  A's build and A's code are never uploaded" "$(grep -c 'aaaaaaaaaaaa\|A code' "$WRLOG")" 0
check "  the log names the artifact as the rollback code" "$(grep -c "the site's own artifact c466-siteb-media/_build/artifact/$LIVE_B.tar.gz" "$T/out")" 1
check "  the log says it re-deployed it" "$(grep -c "re-deployed $LIVE_B" "$T/out")" 1
check "  build/ is left as it was (the new build)" "$(sed -n 's/export default "\(.*\)";/\1/p' "$FA/build/build-id.js")" dddddddddddd-wooprimed
art pref-siteb-media "$LIVE_B" "$LIVE_B" "B artifact"
run_update "$LIVE_B" FORCE_FAIL=verify BKT=pref
check "#466: the artifact wins over a matching build/ (the live build's own sources)" "$(tail -1 "$WRLOG")" "deploy $LIVE_B // B artifact"
art grd-siteb-media "$LIVE_B" aaaaaaaaaaaa-wooprimed "A code"
run_update aaaaaaaaaaaa-wooprimed FORCE_FAIL=verify BKT=grd
check "#465 guard: B's key holds A's build: ONE upload only, A's code never" "$(tr '\n' ' ' < "$WRLOG")" "deploy dddddddddddd-wooprimed // current tree "
check "  the log says the artifact was refused" "$(grep -c "refused: grd-siteb-media/_build/artifact/$LIVE_B.tar.gz holds build aaaaaaaaaaaa-wooprimed" "$T/out")" 1
check "  and to deploy the old build by hand" "$(grep -c "Deploy $LIVE_B by hand" "$T/out")" 1
art ok-siteb-media "$LIVE_B" "$LIVE_B" "B live code"
art ok-siteb-media 999999999999 999999999999 "older"
run_update aaaaaaaaaaaa-wooprimed BKT=ok
check "#466: a good update succeeds" "$(grep -c '^rc=0$' "$T/out")" 1
check "  it stores its artifact and prunes all but it and the build before it" "$(keys | grep '^/ok-siteb-media/' | tr '\n' ' ')" "/ok-siteb-media/_build/artifact/$LIVE_B.tar.gz /ok-siteb-media/_build/artifact/dddddddddddd-wooprimed.tar.gz "
check "  another site's bucket is untouched" "$(keys | grep -c '^/c466-sitea-media/')" 1
out=$(T2=$(mktemp -d "$T/g.XXXX"); python3 -I "$WFP/rollback_artifact.py" get ok-siteb-media dddddddddddd-wooprimed "$T2" >/dev/null && head -1 "$T2/index.js")
check "  the stored artifact holds the tree that was deployed" "$out" "// current tree"
check "site add stores the artifact of the build it deployed" "$(grep -c '^  write_rollback_artifact "$(media_bucket "$s")"' "$SITE")" 1
# #515: the rollback's data restore FAILS. The update exits 3 (not 1), marks the entry, and prints
# the recovery; the next update refuses before it changes anything; site restore clears the hold.
rm -f "$T/hold" "$T/tfr.log"; : > "$T/snap.log"
run_update "$LIVE_B" FORCE_FAIL=verify NO_SNAPSHOT=0 STUB_RESTORE=1
check "#515: a failed data restore in a rollback exits 3, not 1" "$(grep -c '^rc=3$' "$T/out")" 1
check "  it snapshotted, then tried the restore" "$(tr '\n' ' ' < "$T/snap.log")" "dbsnapshot dbrestore "
check "  the code rollback still ran (B's live build re-deployed)" "$(tail -1 "$WRLOG")" "deploy $LIVE_B // current tree"
key=$(cat "$T/hold" 2>/dev/null)
check "  the entry is marked with the snapshot key" "$([[ $key == siteb/$LIVE_B-*.ndjson ]] && echo marked || echo "[$key]")" marked
check "  the log says the hold is recorded (read back)" "$(grep -c "the hold is recorded (data_hold=$key, read back)" "$T/out")" 1
check "  it prints the restore command" "$(grep -c '  restore it:  deploy/wfp/site restore siteb ' "$T/out")" 1
check "  and the by-hand dbrestore with the bucket and key" "$(grep -c "snapshot.py dbrestore https://127.0.0.1:9 .* ${BKT:-wp-wfp}-siteb-media $key" "$T/out")" 1
check "  no secret is printed (the spike token)" "$(grep -c 'SECRET-SPIKE-TOKEN' "$T/out")" 0
: > "$T/snap.log"
run_update "$LIVE_B" NO_SNAPSHOT=0
check "#515: the next update REFUSES (exit 2) while the hold is set" "$(grep -c '^rc=2$' "$T/out")" 1
check "  nothing was uploaded and no snapshot was taken (the partial data is never the new truth)" "$(wc -l < "$WRLOG" | tr -d ' '):$(wc -l < "$T/snap.log" | tr -d ' ')" "0:0"
check "  it names the hold and the restore command" "$(grep -c "update REFUSED.*_snapshots/$key" "$T/out"):$(grep -c 'restore it:  deploy/wfp/site restore siteb' "$T/out")" "1:1"
# A restore that works in the rollback: the ordinary failed update (1), no hold.
rm -f "$T/hold"; run_update "$LIVE_B" FORCE_FAIL=verify NO_SNAPSHOT=0
check "control: the restore works: exit 1 (a failed update, rolled back) and no hold" "$(grep -c '^rc=1$' "$T/out"):$(cat "$T/hold" 2>/dev/null)" "1:"
# site restore (restore_one, cut out of the site file).
eval "$(sed -n '/^restore_one() {/,/^}/p' "$SITE")"
row_count() { echo 97696; }
printf '%s' "$key" > "$T/hold"; : > "$T/snap.log"
( export STUB_RESTORE=1; restore_one siteb; echo "rc=$?" ) > "$T/rs.out" 2>&1
check "site restore: a restore that fails exits 1 and keeps the hold" "$(grep -c '^rc=1$' "$T/rs.out"):$(cat "$T/hold")" "1:$key"
( restore_one siteb; echo "rc=$?" ) > "$T/rs.out" 2>&1
check "site restore: restores the held snapshot, clears the hold (read back), exit 0" "$(grep -c '^rc=0$' "$T/rs.out"):$(cat "$T/hold"):$(grep -c 'the hold is cleared (read back)' "$T/rs.out")" "1::1"
check "  it restored the key the hold named" "$(grep -c "restore the data from ${BKT:-wp-wfp}-siteb-media/_snapshots/$key" "$T/rs.out")" 1
( restore_one siteb; echo "rc=$?" ) > "$T/rs.out" 2>&1
check "site restore: no hold and no key: refused (2)" "$(grep -c '^rc=2$' "$T/rs.out")" 1
# update --all keeps the failed site's code: 3 reaches the caller.
three() { [ "$1" = b ] && return 3; return 0; }
update_all three a b c > "$T/ua.out" 2>&1; check "update --all returns the failed site's code (3) and stops there" "$?:$(grep -c 'not reached: c' "$T/ua.out")" "3:1"
# #513: no update case leaves a temp dir behind (the saved build, the rollback mirror, the work dirs).
check "every update case removed its temp dirs" "$(find "$TT" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" 0
echo "$fails failing check(s)"
[ "$fails" = 0 ]
