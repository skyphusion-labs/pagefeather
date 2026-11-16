#!/bin/bash
# #789: the bounded gone check (deploy/lib/gone-wait.sh), and its use by deploy/wfp (lib.sh gone and ns_gone, used by
# site.sh down and down.sh). Offline: the API reads are stubbed as SEQUENCES, as a just-deleted script reads present
# for a while, then gone (measured 2026-11-16: five removes passed on a retry 30 to 45 s later).
#   deploy/wfp/tests/gone-wait-test.sh [lib.sh]
# RED on main: OLD=<a site.sh> runs that file's own gone() against the same stub instead (the single read).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/gone-wait-test.XXXXXX"); trap 'rm -rf "${T:?}"' EXIT
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1${3:+  ($3)}"; fails=$((fails + 1)); fi; }
export GONE_WAIT_S=3 GONE_POLL_S=0.2

# A stub that answers the next word of a sequence file on each call; the last one repeats.
cat > "$T/seq.sh" <<'SH'
seq_next() { # seq_next <file>
  local s first; s=$(cat "$1"); first=${s%%,*}
  [ "$first" = "$s" ] || printf '%s' "${s#*,}" > "$1"
  echo "$first"
}
SH

# 1. The helper alone.
( . "$HERE/../../lib/gone-wait.sh"; . "$T/seq.sh"
  probe() { gone_http_state "$(seq_next "$T/a")"; }
  printf '200,200,404' > "$T/a"; wait_gone probe; echo "rc=$? last=$GONE_LAST" ) > "$T/o1" 2>&1
ok "wait_gone: 200, 200, then 404 passes" "$(grep -qx 'rc=0 last=gone' "$T/o1" && echo 1 || echo 0)" "$(cat "$T/o1")"
( . "$HERE/../../lib/gone-wait.sh"; . "$T/seq.sh"
  probe() { gone_http_state "$(seq_next "$T/b")"; }
  printf '200' > "$T/b"; s=$(date +%s); wait_gone probe; rc=$?; echo "rc=$rc last=$GONE_LAST waited=$GONE_WAITED took=$(( $(date +%s) - s ))" ) > "$T/o2" 2>&1
ok "wait_gone: a script that never goes fails at the cap, naming the last state" "$(grep -q '^rc=1 last=200 waited=[34] took=[34]$' "$T/o2" && echo 1 || echo 0)" "$(cat "$T/o2")"
for bad in 000 500 503; do
  ( . "$HERE/../../lib/gone-wait.sh"; . "$T/seq.sh"
    probe() { gone_http_state "$(seq_next "$T/c")"; }
    printf '%s,404' "$bad" > "$T/c"; wait_gone probe; echo "rc=$? last=$GONE_LAST" ) > "$T/o3" 2>&1
  ok "wait_gone: an unreadable $bad is never gone; it is read again, then 404 passes" "$(grep -qx 'rc=0 last=gone' "$T/o3" && echo 1 || echo 0)" "$(cat "$T/o3")"
done
( . "$HERE/../../lib/gone-wait.sh"; . "$T/seq.sh"
  probe() { gone_http_state "$(seq_next "$T/d")"; }
  printf '500' > "$T/d"; wait_gone probe; echo "rc=$? last=$GONE_LAST" ) > "$T/o4" 2>&1
ok "wait_gone: unreadable until the cap fails, never gone" "$(grep -qx 'rc=1 last=500' "$T/o4" && echo 1 || echo 0)" "$(cat "$T/o4")"
( . "$HERE/../../lib/gone-wait.sh"; . "$T/seq.sh"
  probe() { gone_http_state "$(seq_next "$T/e")"; }
  printf '403,404' > "$T/e"; s=$(date +%s); wait_gone probe; echo "rc=$? last=$GONE_LAST took=$(( $(date +%s) - s ))" ) > "$T/o5" 2>&1
ok "wait_gone: a refused credential (403) fails at once, not after the cap" "$(grep -qx 'rc=1 last=403 took=0' "$T/o5" && echo 1 || echo 0)" "$(cat "$T/o5")"
for v in "GONE_WAIT_S=0" "GONE_WAIT_S=601" "GONE_WAIT_S=x" "GONE_POLL_S=0" "GONE_POLL_S=-1"; do
  ( . "$HERE/../../lib/gone-wait.sh"; export "${v?}"; wait_gone true; echo "rc=$?" ) > "$T/o6" 2>&1
  ok "wait_gone: $v is refused (rc 2)" "$(grep -qx 'rc=2' "$T/o6" && echo 1 || echo 0)" "$(cat "$T/o6")"
done

# 2. deploy/wfp: lib.sh gone (a dispatcher, the cron-only copy, the probe and the shared pieces) and ns_gone (a user
#    Worker in the namespace), each against a stubbed API that still shows the script twice.
run_lib() { # run_lib <what to call> -> its output and rc
  # shellcheck source=/dev/null
  ( . "$LIB" >/dev/null 2>&1; . "$T/seq.sh"
    api_code() { seq_next "$T/api"; }
    ns_script_state() { seq_next "$T/ns"; }
    if [ -n "${OLD:-}" ]; then eval "$(sed -n '/^gone() {/,/^}/p' "$OLD")"; fi
    "$@"; echo "rc=$?" ) 2>&1
}
printf '200,200,404' > "$T/api"
out=$(run_lib gone "dispatcher wp-x" "/workers/scripts/wp-x")
ok "lib.sh gone: a dispatcher that reads 200 twice, then 404, passes (red on main: one read)" "$(printf '%s' "$out" | grep -q 'dispatcher wp-x is gone (API 404); after 3 reads over' && printf '%s' "$out" | grep -qx 'rc=0' && echo 1 || echo 0)" "$out"
printf '200' > "$T/api"
out=$(run_lib gone "dispatcher wp-y" "/workers/scripts/wp-y")
ok "lib.sh gone: one that never goes stops at the cap with its last state" "$(printf '%s' "$out" | grep -q 'dispatcher wp-y is NOT gone (API 200) after [34] s: stopping' && ! printf '%s' "$out" | grep -qx 'rc=0' && echo 1 || echo 0)" "$out"
if [ -z "${OLD:-}" ]; then
  printf 'present,unknown,gone' > "$T/ns"
  out=$(run_lib ns_gone "user Worker site-x" site-x)
  ok "lib.sh ns_gone: present, unknown, then gone passes" "$(printf '%s' "$out" | grep -q 'user Worker site-x is gone (not in the namespace list' && printf '%s' "$out" | grep -qx 'rc=0' && echo 1 || echo 0)" "$out"
  printf 'unknown' > "$T/ns"
  out=$(run_lib ns_gone "user Worker site-y" site-y)
  ok "lib.sh ns_gone: an unreadable list is never gone; it stops at the cap, naming it" "$(printf '%s' "$out" | grep -q 'user Worker site-y is NOT known to be gone (unknown) after [34] s: stopping' && echo 1 || echo 0)" "$out"

  # 3. The wiring: one helper, no single read left.
  W=$HERE/..
  ok "site.sh and down.sh define no gone() of their own (lib.sh's, one helper)" "$(! grep -q '^gone()' "$W/site.sh" "$W/down.sh" && echo 1 || echo 0)"
  ok "site.sh down checks the user Worker with ns_gone (not one ns_script_state read)" "$(grep -q 'ns_gone "user Worker \$U" "\$U"' "$W/site.sh" && ! grep -q 'st=\$(ns_script_state' "$W/site.sh" && echo 1 || echo 0)"
  ok "down.sh checks site-cacheprobe with ns_gone" "$(grep -q '^ns_gone site-cacheprobe site-cacheprobe$' "$W/down.sh" && ! grep -q 'ns_script_state' "$W/down.sh" && echo 1 || echo 0)"
  ok "deploy/destroy.sh uses the same helper (wait_gone)" "$(grep -q 'wait_gone worker_gone_state' "$W/../destroy.sh" && echo 1 || echo 0)"
fi
echo "gone-wait-test: $fails failing"
exit $fails
