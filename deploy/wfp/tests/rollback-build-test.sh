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
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SITE=${1:-$HERE/../site}
ACCOUNT_ID=test
# shellcheck disable=SC1091
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
FA=$T/app; mkdir -p "$FA/build"
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
echo "deploy $(sed -n 's/export default "\(.*\)";/\1/p' build/build-id.js)" >> "$WRLOG"
[ "${FAIL_DEPLOY:-0}" = 1 ] && { echo "upload refused" >&2; exit 1; }
exit 0
SH
chmod +x "$T/wrangler"
export WRLOG=$T/wr.log
WR=$T/wrangler; NAMESPACE=wp-wfp; SUB=sub; KV_ID=kv
LIVE_B=bbbbbbbbbbbb-wooprimed
valid_site() { return 0; }; has_ws() { return 0; }
tfr() { case "$*" in "site output -json") printf '{"wp_salt":{"value":"s"},"spike_token":{"value":"t"}}' ;; "site output -raw"*) printf x ;; *) return 0 ;; esac; }
site_vars() { REC_HOST=127.0.0.1:9; REC_CD=none; REC_VARS=(-var host=x); }
media_bucket() { echo "wp-wfp-$1-media"; }
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
# The build stand-in: the new build of site B.
build_dosql() { [ "${FAIL_BUILD:-0}" = 1 ] && return 1; setid dddddddddddd-wooprimed; }
run_update() { # run_update <id build/ holds at the start> [env...]
  setid "$1"; shift; : > "$WRLOG"
  ( APP=$FA; WDIR=$(mktemp -d); export NO_SNAPSHOT=1 "$@"; update_one_inner siteb; echo "rc=$?" ) > "$T/out" 2>&1
}
# THE #464 CASE: the clone last built site A (pf394a's build in the measured run), B is updated,
# the verify fails. Before the fix, the rollback uploaded A's build to B.
run_update aaaaaaaaaaaa-wooprimed FORCE_FAIL=verify
check "#464: build/ holds site A's build, B's verify fails: the update fails" "$(grep -c '^rc=1$' "$T/out")" 1
check "  B gets ONE upload (its new build), never A's" "$(tr '\n' ' ' < "$WRLOG")" "deploy dddddddddddd-wooprimed "
check "  A's build is never uploaded" "$(grep -c aaaaaaaaaaaa "$WRLOG")" 0
check "  the log says there is no code rollback artifact" "$(grep -c 'NO code rollback artifact: build/ holds aaaaaaaaaaaa-wooprimed' "$T/out")" 1
check "  the log says to deploy the old build by hand" "$(grep -c "Deploy $LIVE_B by hand" "$T/out")" 1
# The positive control: build/ holds B's live build, so the rollback re-deploys it.
run_update "$LIVE_B" FORCE_FAIL=verify
check "control: build/ holds B's live build: two uploads, the second is B's live build" "$(tr '\n' ' ' < "$WRLOG")" "deploy dddddddddddd-wooprimed deploy $LIVE_B "
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
echo "$fails failing check(s)"
[ "$fails" = 0 ]
