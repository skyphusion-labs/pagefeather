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
unset KIND_A_RECORDED_PLACEMENT
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
