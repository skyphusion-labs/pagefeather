#!/usr/bin/env bash
# #1502: kind a site update is allowed (rebuild and re-upload, no MySQL step).
# restore and schedule still refuse. import stays allowed.
# Offline. A stub api() serves the live script settings. Nothing is uploaded.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
WFP=$(cd "$HERE/.." && pwd)
SITE="$WFP/site"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }

# shellcheck source=../kind-a.sh
. "$WFP/kind-a.sh"
user_script() { echo "site-$1"; }
NAMESPACE=wp-wfp
API_MODE=region
api() {
  case "$API_MODE" in
    fail) return 1 ;;
    http) printf 'no\n500'; return 0 ;;
    none) printf '%s\n' '{"success":true,"result":{"placement":{"mode":"targeted"}}}' ; printf '200'; return 0 ;;
    smart) printf '%s\n' '{"success":true,"result":{"placement":{"mode":"smart"}}}' ; printf '200'; return 0 ;;
    region) printf '%s\n' '{"success":true,"result":{"placement":{"mode":"targeted","region":"azure:westus2"}}}' ; printf '200'; return 0 ;;
    *) echo "bad API_MODE $API_MODE" >&2; return 1 ;;
  esac
}

# 1. restore and schedule still refuse. update does not call the refusal.
REC_KIND=a
kind_a_refuse shop >/dev/null 2>&1; rc=$?
ok "kind a: kind_a_refuse exits 2" "$([ "$rc" = 2 ] && echo 1 || echo 0)"
REC_KIND=b-dosql
kind_a_refuse shop >/dev/null 2>&1; rc=$?
ok "b-dosql: kind_a_refuse exits 0" "$([ "$rc" = 0 ] && echo 1 || echo 0)"
unset REC_KIND
kind_a_refuse shop >/dev/null 2>&1; rc=$?
ok "unset kind: kind_a_refuse exits 0" "$([ "$rc" = 0 ] && echo 1 || echo 0)"

body=$(awk '/^update_one_inner\(\)/,/^}/' "$SITE")
ok "update does not call kind_a_refuse" "$(printf '%s\n' "$body" | grep -c 'kind_a_refuse' | grep -qx 0 && echo 1 || echo 0)"
ok "update calls kind_a_placement" "$(printf '%s\n' "$body" | grep -c 'kind_a_placement' | grep -qx 1 && echo 1 || echo 0)"
ok "update calls kind_a_demo_lock" "$(printf '%s\n' "$body" | grep -c 'kind_a_demo_lock' | grep -qx 1 && echo 1 || echo 0)"
ok "update rebuilds with build_a" "$(printf '%s\n' "$body" | grep -c 'build_a ||' | grep -qx 1 && echo 1 || echo 0)"
ok "b-dosql update still calls build_dosql" "$(printf '%s\n' "$body" | grep -c '^  build_dosql || {' | grep -qx 1 && echo 1 || echo 0)"
ok "kind a skips the data snapshot before dbsnapshot" "$(
  skip=$(printf '%s\n' "$body" | grep -n 'kind a: no data snapshot' | head -1 | cut -d: -f1)
  snap=$(printf '%s\n' "$body" | grep -n 'dbsnapshot' | head -1 | cut -d: -f1)
  [ -n "$skip" ] && [ -n "$snap" ] && [ "$skip" -lt "$snap" ] && echo 1 || echo 0
)"
restore=$(awk '/^restore_one\(\)/,/^}/' "$SITE")
schedule=$(awk '/^schedule_one\(\)/,/^}/' "$SITE")
import=$(awk '/^import_one\(\)/,/^}/' "$SITE")
ok "restore still calls kind_a_refuse" "$(printf '%s\n' "$restore" | grep -c 'kind_a_refuse' | grep -qx 1 && echo 1 || echo 0)"
ok "schedule still calls kind_a_refuse" "$(printf '%s\n' "$schedule" | grep -c 'kind_a_refuse' | grep -qx 1 && echo 1 || echo 0)"
ok "import does not call kind_a_refuse" "$(printf '%s\n' "$import" | grep -c 'kind_a_refuse' | grep -qx 0 && echo 1 || echo 0)"

# 2. Placement. A bad live answer must refuse. A region must be kept.
unset PLACEMENT
API_MODE=fail
kind_a_placement shop >/dev/null 2>&1; rc=$?
ok "unreadable live settings: refused (rc $rc)" "$([ "$rc" = 2 ] && echo 1 || echo 0)"
API_MODE=http
kind_a_placement shop >/dev/null 2>&1; rc=$?
ok "live settings HTTP 500: refused (rc $rc)" "$([ "$rc" = 2 ] && echo 1 || echo 0)"
API_MODE=none
log=$(mktemp)
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live settings with no region: refused, PLACEMENT stays empty (rc $rc)" "$(
  [ "$rc" = 2 ] && [ -z "${PLACEMENT:-}" ] && grep -q 'needs PLACEMENT' "$log" && echo 1 || echo 0
)"
API_MODE=region
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live settings region azure:westus2 is kept (rc $rc, ${PLACEMENT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = azure:westus2 ] && grep -q 'live script settings' "$log" && echo 1 || echo 0
)"
API_MODE=fail
PLACEMENT=azure:westus2
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "this run's PLACEMENT wins and does not read the live settings (rc $rc)" "$(
  [ "$rc" = 0 ] && [ "$PLACEMENT" = azure:westus2 ] && grep -q 'this run' "$log" && echo 1 || echo 0
)"
PLACEMENT=nope
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "a bad PLACEMENT is refused (rc $rc)" "$([ "$rc" = 2 ] && echo 1 || echo 0)"
unset PLACEMENT
API_MODE=smart
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live settings mode smart is kept (rc $rc, ${PLACEMENT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = smart ] && echo 1 || echo 0
)"
rm -f "$log"

# 3. A demo-sites file forces DEMO_LOCK. No file does not.
DEMO=$(mktemp -d)
mkdir -p "$DEMO/demo-sites"
: > "$DEMO/demo-sites/ggc"
(
  WFP=$DEMO
  unset DEMO_LOCK
  kind_a_demo_lock ggc >/dev/null
  [ "${DEMO_LOCK:-}" = on ] || exit 1
  unset DEMO_LOCK
  kind_a_demo_lock other >/dev/null
  [ -z "${DEMO_LOCK:-}" ] || exit 1
  DEMO_LOCK=on
  kind_a_demo_lock other >/dev/null
  [ "$DEMO_LOCK" = on ] || exit 1
) && demo_rc=0 || demo_rc=$?
rm -rf "$DEMO"
ok "demo-sites/ggc forces DEMO_LOCK; another name does not" "$([ "$demo_rc" = 0 ] && echo 1 || echo 0)"

[ "$fails" = 0 ] && echo "kind-a-update: all checks pass" || echo "kind-a-update: $fails failing check(s)"
exit $((fails > 0))
