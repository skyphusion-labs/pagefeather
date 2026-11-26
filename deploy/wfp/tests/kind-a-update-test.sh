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
    empty) printf '%s\n' '{"success":true,"result":{"placement":{}}}' ; printf '200'; return 0 ;;
    smart) printf '%s\n' '{"success":true,"result":{"placement":{"mode":"smart"}}}' ; printf '200'; return 0 ;;
    region) printf '%s\n' '{"success":true,"result":{"placement":{"mode":"targeted","region":"azure:westus2"}}}' ; printf '200'; return 0 ;;
    host) printf '%s\n' '{"success":true,"result":{"placement":{"host":"db.example.org:3307"}}}' ; printf '200'; return 0 ;;
    badhost) printf '%s\n' '{"success":true,"result":{"placement":{"host":"not_a_host:3306"}}}' ; printf '200'; return 0 ;;
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
ok "update calls kind_a_placement" "$(printf '%s\n' "$body" | grep -c 'kind_a_placement "$s"' | grep -qx 1 && echo 1 || echo 0)"
ok "site saves the operator MYSQL_HOST for one run" "$(grep -F -c 'WFP_MYSQL_HOST_RUN=${MYSQL_HOST-}' "$SITE" | grep -qx 1 && echo 1 || echo 0)"
ok "site saves the operator MYSQL_PORT for one run" "$(grep -F -c 'WFP_MYSQL_PORT_RUN=${MYSQL_PORT-}' "$SITE" | grep -qx 1 && echo 1 || echo 0)"
ok "kind a update localizes MYSQL_HOST and MYSQL_PORT" "$(printf '%s\n' "$body" | grep -F -c 'local -x MYSQL_HOST="${WFP_MYSQL_HOST_RUN-}" MYSQL_PORT="${WFP_MYSQL_PORT_RUN-}"' | grep -qx 1 && echo 1 || echo 0)"
ok "update loads the recorded placement before that call" "$(printf '%s\n' "$body" | grep -c 'kind_a_placement_recorded' | grep -qx 1 && echo 1 || echo 0)"
ok "recorded placement is read after keep_settings" "$(
  k=$(printf '%s\n' "$body" | grep -n 'keep_settings "\$bucket"' | head -1 | cut -d: -f1)
  p=$(printf '%s\n' "$body" | grep -n 'kind_a_placement_recorded' | head -1 | cut -d: -f1)
  [ -n "$k" ] && [ -n "$p" ] && [ "$k" -lt "$p" ] && echo 1 || echo 0
)"
ok "kind a verify and rollback call kind_a_wait_build" "$(printf '%s\n' "$body" | grep -c 'kind_a_wait_build' | grep -qx 2 && echo 1 || echo 0)"
ok "b-dosql verify and rollback still call wait_build" "$(printf '%s\n' "$body" | grep -c '[^_]wait_build "' | grep -qx 2 && echo 1 || echo 0)"
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
# A live body of {} or {"mode":"targeted"} has no region (#1310). It is not a region.
# A recorded placement is used then. The log must not call that value a live region.
unset PLACEMENT
unset KIND_A_RECORDED_PLACEMENT
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
unset PLACEMENT
unset KIND_A_RECORDED_PLACEMENT
API_MODE=empty
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live placement {} with no record: refused, PLACEMENT stays empty (rc $rc)" "$(
  [ "$rc" = 2 ] && [ -z "${PLACEMENT:-}" ] && grep -q 'placement empty' "$log" && grep -q 'needs PLACEMENT' "$log" && echo 1 || echo 0
)"
API_MODE=none
KIND_A_RECORDED_PLACEMENT=azure:westus2
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live mode targeted and a recorded region: recorded, not called live (rc $rc, ${PLACEMENT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = azure:westus2 ] && grep -q '(recorded settings)' "$log" && grep -q 'no region' "$log" && ! grep -q '(live script settings)' "$log" && echo 1 || echo 0
)"
API_MODE=empty
unset PLACEMENT
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live placement {} and a recorded region: recorded (rc $rc, ${PLACEMENT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = azure:westus2 ] && grep -q '(recorded settings)' "$log" && grep -q 'placement empty' "$log" && ! grep -q '(live script settings)' "$log" && echo 1 || echo 0
)"
API_MODE=region
KIND_A_RECORDED_PLACEMENT=aws:us-east-1
unset PLACEMENT
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "a real live region wins over the record (rc $rc, ${PLACEMENT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = azure:westus2 ] && grep -q '(live script settings)' "$log" && echo 1 || echo 0
)"
API_MODE=fail
KIND_A_RECORDED_PLACEMENT=azure:westus2
unset PLACEMENT
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "unreadable live settings use the record (rc $rc, ${PLACEMENT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = azure:westus2 ] && grep -q '(recorded settings)' "$log" && grep -q 'cannot be read' "$log" && echo 1 || echo 0
)"
API_MODE=none
KIND_A_RECORDED_PLACEMENT=nope
unset PLACEMENT
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "a bad recorded placement is refused (rc $rc)" "$(
  [ "$rc" = 2 ] && [ -z "${PLACEMENT:-}" ] && echo 1 || echo 0
)"
# A live host string is placement host. Recorded host needs MYSQL_HOST.
unset PLACEMENT
unset KIND_A_RECORDED_PLACEMENT
unset MYSQL_HOST
unset MYSQL_PORT
API_MODE=host
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live placement host db.example.org:3307 is kept (rc $rc, ${PLACEMENT:-empty}, ${MYSQL_HOST:-empty}:${MYSQL_PORT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = host ] && [ "${MYSQL_HOST:-}" = db.example.org ] && [ "${MYSQL_PORT:-}" = 3307 ] && grep -q 'live script settings' "$log" && echo 1 || echo 0
)"
unset PLACEMENT
unset MYSQL_HOST
unset MYSQL_PORT
API_MODE=empty
KIND_A_RECORDED_PLACEMENT=host
MYSQL_HOST=db.example.org
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live placement {} and recorded host with MYSQL_HOST: recorded (rc $rc, ${PLACEMENT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = host ] && [ "${MYSQL_HOST:-}" = db.example.org ] && grep -q '(recorded settings)' "$log" && ! grep -q '(live script settings)' "$log" && echo 1 || echo 0
)"
unset PLACEMENT
API_MODE=none
KIND_A_RECORDED_PLACEMENT=host
MYSQL_HOST=db.example.org
MYSQL_PORT=3306
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live mode targeted and recorded host with MYSQL_HOST: recorded (rc $rc, ${PLACEMENT:-empty})" "$(
  [ "$rc" = 0 ] && [ "${PLACEMENT:-}" = host ] && [ "${MYSQL_HOST:-}" = db.example.org ] && grep -q '(recorded settings)' "$log" && grep -q 'no region' "$log" && ! grep -q '(live script settings)' "$log" && echo 1 || echo 0
)"
unset PLACEMENT
unset MYSQL_HOST
unset MYSQL_PORT
API_MODE=empty
KIND_A_RECORDED_PLACEMENT=host
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "live placement {} and recorded host without MYSQL_HOST: refused (rc $rc)" "$(
  [ "$rc" = 2 ] && [ -z "${PLACEMENT:-}" ] && grep -q 'recorded placement is host' "$log" && grep -q 'MYSQL_HOST' "$log" && grep -q 'MYSQL_PORT' "$log" && echo 1 || echo 0
)"
# A refused live host must put the operator values back. It must not clear them.
unset PLACEMENT
unset KIND_A_RECORDED_PLACEMENT
API_MODE=badhost
MYSQL_HOST=keep.example
MYSQL_PORT=3311
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "refused live host restores MYSQL_HOST (rc $rc, ${MYSQL_HOST:-empty}:${MYSQL_PORT:-empty})" "$(
  [ "$rc" = 2 ] && [ "${MYSQL_HOST:-}" = keep.example ] && [ "${MYSQL_PORT:-}" = 3311 ] && [ -z "${PLACEMENT:-}" ] && grep -q 'not a host name' "$log" && echo 1 || echo 0
)"
unset MYSQL_HOST
unset MYSQL_PORT
unset PLACEMENT
kind_a_placement shop >"$log" 2>&1; rc=$?
ok "refused live host leaves an unset MYSQL_HOST unset (rc $rc)" "$(
  [ "$rc" = 2 ] && [ "${MYSQL_HOST+x}" != x ] && [ "${MYSQL_PORT+x}" != x ] && echo 1 || echo 0
)"
# update --all runs many sites in one shell. Site 1's live host must not stick.
# The harness uses the same local -x the site script uses around kind_a_placement.
unset PLACEMENT
unset KIND_A_RECORDED_PLACEMENT
unset MYSQL_HOST
unset MYSQL_PORT
API_MODE=host
kind_a_placement site1 >"$log" 2>&1; rc=$?
ok "live host on site 1 sets MYSQL_HOST in this shell (rc $rc, ${MYSQL_HOST:-empty})" "$(
  [ "$rc" = 0 ] && [ "${MYSQL_HOST:-}" = db.example.org ] && [ "${MYSQL_PORT:-}" = 3307 ] && echo 1 || echo 0
)"
# The operator set no host. site saves that at start, before any site runs.
WFP_MYSQL_HOST_RUN=
WFP_MYSQL_PORT_RUN=
WFP_PLACEMENT_RUN=
API_MODE=empty
KIND_A_RECORDED_PLACEMENT=host
scoped_kind_a() {
  local -x MYSQL_HOST="${WFP_MYSQL_HOST_RUN-}" MYSQL_PORT="${WFP_MYSQL_PORT_RUN-}"
  local PLACEMENT="${WFP_PLACEMENT_RUN-}"
  scoped_rc=0
  kind_a_placement "$1" >"$log" 2>&1 || scoped_rc=$?
  scoped_host=${MYSQL_HOST-}
  scoped_port=${MYSQL_PORT-}
  scoped_placement=${PLACEMENT-}
}
scoped_kind_a site2
ok "site 2 does not keep site 1 host when the operator set none (rc $scoped_rc, ${scoped_host:-empty})" "$(
  [ "$scoped_rc" = 2 ] && [ -z "${scoped_host:-}" ] && [ -z "${scoped_port:-}" ] && [ -z "${scoped_placement:-}" ] && [ "${MYSQL_HOST:-}" = db.example.org ] && grep -q 'recorded placement is host' "$log" && echo 1 || echo 0
)"
WFP_MYSQL_HOST_RUN=operator.example
WFP_MYSQL_PORT_RUN=3310
scoped_kind_a site2
ok "site 2 keeps the operator host, not site 1 (rc $scoped_rc, ${scoped_host:-empty}:${scoped_port:-empty})" "$(
  [ "$scoped_rc" = 0 ] && [ "$scoped_host" = operator.example ] && [ "$scoped_port" = 3310 ] && [ "$scoped_placement" = host ] && [ "${MYSQL_HOST:-}" = db.example.org ] && grep -q '(recorded settings)' "$log" && ! grep -q '(live script settings)' "$log" && echo 1 || echo 0
)"
unset KIND_A_RECORDED_PLACEMENT
unset MYSQL_HOST
unset MYSQL_PORT
recf=$(mktemp)
printf '%s\n' '{"v":1,"settings":{},"placement":"azure:westus2"}' > "$recf"
got=$(kind_a_placement_recorded "$recf")
ok "settings record placement reads back" "$([ "$got" = azure:westus2 ] && echo 1 || echo 0)"
printf '%s\n' '{"v":1,"settings":{}}' > "$recf"
got=$(kind_a_placement_recorded "$recf")
ok "settings record with no placement key is empty" "$([ -z "$got" ] && echo 1 || echo 0)"
kind_a_stamp_placement "$recf" azure:westus2
got=$(kind_a_placement_recorded "$recf")
ok "stamp writes placement onto the settings record" "$([ "$got" = azure:westus2 ] && echo 1 || echo 0)"
rm -f "$recf"
recfn=$(awk '/^record_settings\(\)/,/^}/' "$WFP/lib.sh")
ok "record_settings stamps kind a placement" "$(printf '%s\n' "$recfn" | grep -c 'kind_a_stamp_placement' | grep -qx 1 && echo 1 || echo 0)"
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

# 4. Kind a verify. /_build is the b-dosql object. A body that already says the new
# id must not pass. /_cron-build is the user Worker build. /_evict is not called.
SRV=$(mktemp -d)
cat > "$SRV/srv.py" << 'PY'
import http.server, json, sys, urllib.parse
port_file, hits_file, mode = sys.argv[1], sys.argv[2], sys.argv[3]
hits = {"evict": 0, "build": 0, "cron": 0}

def save():
    open(hits_file, "w").write(json.dumps(hits))

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        p = urllib.parse.urlsplit(self.path).path
        ok = self.headers.get("x-spike-token") == "tok"
        if p == "/_evict":
            hits["evict"] += 1
            body = {"evicting": True}
        elif p == "/_build":
            hits["build"] += 1
            body = {"build": "newbuild"}
        elif p == "/_cron-build":
            hits["cron"] += 1
            body = {"worker": "newbuild" if mode == "cron-new" else "oldbuild"}
        else:
            body = {}
        save()
        raw = json.dumps(body).encode()
        self.send_response(200 if ok else 403)
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

save()
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
PY
curl_cfg() {
  local text=$1 h
  shift
  h=$(printf '%s\n' "$text" | sed -n 's/^header = "//; s/"$//p')
  curl -s -H "$h" "$@"
}
start_srv() {
  rm -f "$SRV/port" "$SRV/hits"
  python3 -I "$SRV/srv.py" "$SRV/port" "$SRV/hits" "$1" >/dev/null 2>&1 &
  echo $! > "$SRV/pid"
  local i
  for i in $(seq 1 50); do [ -s "$SRV/port" ] && return 0; sleep 0.05; done
  return 1
}
stop_srv() {
  if [ -s "$SRV/pid" ]; then kill "$(cat "$SRV/pid")" 2>/dev/null || true; wait "$(cat "$SRV/pid")" 2>/dev/null || true; fi
  rm -f "$SRV/pid"
}
if start_srv cron-old; then
  BUILD_WAIT=2 BUILD_POLL_S=0.2 BUILD_EVICT_AFTER=0 kind_a_wait_build "http://127.0.0.1:$(cat "$SRV/port")" tok newbuild >"$SRV/out" 2>&1
  rc=$?
  hits=$(cat "$SRV/hits" 2>/dev/null || true)
  ok "worker build stays old: verify fails even when /_build says new (rc $rc)" "$([ "$rc" = 1 ] && echo 1 || echo 0)"
  ok "that failure does not call /_evict" "$(printf '%s' "$hits" | grep -q '"evict": 0' && echo 1 || echo 0)"
else
  ok "verify fake server started (old)" 0
fi
stop_srv
if start_srv cron-new; then
  BUILD_WAIT=4 BUILD_POLL_S=0.2 kind_a_wait_build "http://127.0.0.1:$(cat "$SRV/port")" tok newbuild >"$SRV/out" 2>&1
  rc=$?
  hits=$(cat "$SRV/hits" 2>/dev/null || true)
  ok "worker /_cron-build new: verify passes without /_evict (rc $rc)" "$(
    [ "$rc" = 0 ] && printf '%s' "$hits" | grep -q '"evict": 0' && printf '%s' "$hits" | grep -q '"cron": [1-9]' && echo 1 || echo 0
  )"
else
  ok "verify fake server started (new)" 0
fi
stop_srv
rm -rf "$SRV"

[ "$fails" = 0 ] && echo "kind-a-update: all checks pass" || echo "kind-a-update: $fails failing check(s)"
exit $((fails > 0))
