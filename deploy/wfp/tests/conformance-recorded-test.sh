#!/bin/bash
# #1002: a site update checks the conformance gate (#764) on the RECORDED build inputs AND the RECORDED
# settings (#558), so a plain remount of a conformance throwaway is not refused for settings the site
# already has. Before the fix, the gate ran before keep_settings merged the recorded Turnstile values:
# `site update cf759a` was refused with "conformance needs TURNSTILE_LOGIN=off" (2026-11-20).
# It runs the real update_one_inner from deploy/wfp/site (cut out of the file, so the shipped code runs)
# against stand-ins. A stand-in after the gate prints PAST-GATE and stops the update, so no case reaches
# a snapshot, a build or an upload.
#   deploy/wfp/tests/conformance-recorded-test.sh [another site file]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SITE=${1:-$HERE/../site}
ACCOUNT_ID=test
# shellcheck disable=SC1091
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
eval "$(sed -n '/^update_one_inner() {/,/^}/p' "$SITE")"
type update_one_inner >/dev/null 2>&1 || { echo "FAIL update_one_inner was not found in $SITE"; exit 1; }
T=$(mktemp -d "${TMPDIR:-/tmp}/conformance-recorded-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
SUB=sub; KV_ID=kv; NAMESPACE=wp-wfp
valid_site() { return 0; }; has_ws() { return 0; }; obs_refuse_full() { return 0; }; fault_inject_var() { return 0; }
tfr() { case "$*" in "site output -raw"*) printf x ;; *) return 0 ;; esac; }
site_vars() { REC_HOST=127.0.0.1:9; REC_CD=false; REC_VARS=(-var host=x); }
media_bucket() { echo "wp-wfp-$1-media"; }
entry_build() { echo bbbbbbbbbbbb-c1a2b3c4d-wooprimed; }
entry_config_hash() { echo h-live; }
entry_data_hold() { :; }
remote_pack_defaults() { :; }
# The recorded build inputs of a conformance throwaway (the content line's marker mu-plugin).
use_recorded_inputs() { IMPORT_MU_PLUGINS=pf-conformance-throwaway.php; IMPORT_PLUGINS=woocommerce-cleanup; REC_TREE=""; return 0; }
# The recorded settings: what site_settings.py merge sets for a site whose record holds the conformance
# Turnstile values (REC_TS=1), or holds none (REC_TS=0). A run's own value wins, as merge does.
keep_settings() {
  SETTINGS_RECORDED=1
  if [ "${REC_TS:-0}" = 1 ]; then
    TURNSTILE_LOGIN=${TURNSTILE_LOGIN:-off}; TURNSTILE_LOSTPASSWORD=${TURNSTILE_LOSTPASSWORD:-off}
    TURNSTILE_SITEKEY=${TURNSTILE_SITEKEY:-1x00000000000000000000AA}
  fi
  return 0
}
# The first step after the gate: the sentinel. It stops the update before any snapshot or build.
woo_active_for_build() { echo PAST-GATE >&2; return 2; }
run() { # run [env...]: the update's output in $T/out
  (
    unset TURNSTILE_LOGIN TURNSTILE_LOSTPASSWORD TURNSTILE_SITEKEY TURNSTILE_SECRET THROWAWAY CONFORMANCE
    export "$@"; WDIR=$T/w; mkdir -p "$WDIR"; update_one_inner pf1002t; echo "rc=$?" ) > "$T/out" 2>&1
}
SEC=TURNSTILE_SECRET=1x0000000000000000000000000000000AA
# THE #1002 CASE: the record holds the Turnstile values; the run passes only the secret (never recorded,
# #558) and the throwaway statement. Before the fix: refused with "needs TURNSTILE_LOGIN=off".
run REC_TS=1 CONFORMANCE=on THROWAWAY=1 "$SEC"
check "#1002: recorded Turnstile settings, a plain remount: passes the gate" "$(grep -c PAST-GATE "$T/out")" 1
check "  and is not refused for TURNSTILE_LOGIN" "$(grep -c 'needs TURNSTILE_LOGIN=off' "$T/out")" 0
# The gate still holds on the merged values.
run REC_TS=0 CONFORMANCE=on THROWAWAY=1 "$SEC"
check "no recorded Turnstile settings and none passed: refused before the next step" "$(grep -c PAST-GATE "$T/out"):$(grep -c 'needs TURNSTILE_LOGIN=off' "$T/out"):$(grep -c '^rc=2$' "$T/out")" "0:1:1"
run REC_TS=1 CONFORMANCE=on "$SEC"
check "recorded settings but no THROWAWAY=1: refused" "$(grep -c PAST-GATE "$T/out"):$(grep -c 'needs THROWAWAY=1' "$T/out")" "0:1"
run REC_TS=1 CONFORMANCE=on THROWAWAY=1
check "recorded settings but no Turnstile secret in the run: refused" "$(grep -c PAST-GATE "$T/out"):$(grep -c 'always-pass TURNSTILE_SECRET' "$T/out")" "0:1"
run REC_TS=1 CONFORMANCE=on THROWAWAY=1 "$SEC" TURNSTILE_LOGIN=on
check "the run turns TURNSTILE_LOGIN on over the record: refused" "$(grep -c PAST-GATE "$T/out"):$(grep -c 'needs TURNSTILE_LOGIN=off' "$T/out")" "0:1"
# Order in the shipped file: the recorded-inputs gate is after keep_settings and before the snapshot
# and the build.
body=$(awk '/^update_one_inner\(\)/,/^}/' "$SITE")
n_keep=$(printf '%s\n' "$body" | grep -n 'keep_settings "\$bucket"' | head -1 | cut -d: -f1)
n_gate=$(printf '%s\n' "$body" | grep -n 'conformance_var "\$s" || { echo' | head -1 | cut -d: -f1)
n_snap=$(printf '%s\n' "$body" | grep -n 'dbsnapshot' | head -1 | cut -d: -f1)
n_build=$(printf '%s\n' "$body" | grep -n '^ *build_dosql ||' | head -1 | cut -d: -f1)
check "order: keep_settings < gate < snapshot < build ($n_keep < $n_gate < $n_snap < $n_build)" \
  "$([ -n "$n_keep" ] && [ -n "$n_gate" ] && [ -n "$n_snap" ] && [ -n "$n_build" ] && [ "$n_keep" -lt "$n_gate" ] && [ "$n_gate" -lt "$n_snap" ] && [ "$n_snap" -lt "$n_build" ] && echo 1 || echo 0)" 1
echo "$fails failing case(s)"
[ "$fails" = 0 ]
