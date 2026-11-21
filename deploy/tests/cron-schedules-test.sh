#!/bin/bash
# #1186: deploy/lib/cron-schedules.sh, against a local stub of the Workers schedules API. Cron off with an empty schedule
# passes; cron off with a schedule left fails LOUDLY; cron on with the schedule passes; cron on with none fails; a failed
# read fails (never silently ok).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
. "$ROOT/deploy/lib/cron-schedules.sh"
T=$(mktemp -d); trap 'kill "$SP" 2>/dev/null; rm -rf "$T"' EXIT
fails=0; ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
cat > "$T/stub.py" <<'PY'
import http.server, json, sys
mode = lambda: open(sys.argv[2]).read().strip()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        m = mode()
        if self.headers.get("Authorization") != "Bearer test-token": self.send_response(403); self.end_headers(); return
        if m == "fail": self.send_response(500); self.end_headers(); self.wfile.write(b"{}"); return
        sch = [] if m == "empty" else [{"cron": "* * * * *", "created_on": "2026-11-21T03:24:50Z"}]
        b = json.dumps({"success": True, "result": {"schedules": sch}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
PORT=$((20000 + RANDOM % 20000)); echo empty > "$T/mode"
python3 -I "$T/stub.py" "$PORT" "$T/mode" & SP=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
export CF_API_BASE="http://127.0.0.1:$PORT" CLOUDFLARE_API_TOKEN=test-token CLOUDFLARE_ACCOUNT_ID=acct
run() { cron_schedules_readback site "$1" > "$T/out" 2>&1; echo $?; }
echo empty > "$T/mode"; ok "cron off, schedules empty: ok (rc 0)" "$([ "$(run off)" = 0 ] && grep -q "no Cron Trigger" "$T/out" && echo 1 || echo 0)"
echo one > "$T/mode";   ok "cron off, a schedule LEFT: fails loudly (rc 1, names #1186 and the schedule)" "$([ "$(run off)" = 1 ] && grep -q "ERROR (#1186)" "$T/out" && grep -q '\* \* \* \* \*' "$T/out" && echo 1 || echo 0)"
echo one > "$T/mode";   ok "cron on, the schedule present: ok (rc 0)" "$([ "$(run on)" = 0 ] && echo 1 || echo 0)"
echo empty > "$T/mode"; ok "cron on, NO schedule: fails loudly (rc 1)" "$([ "$(run on)" = 1 ] && grep -q "ERROR (#1186)" "$T/out" && echo 1 || echo 0)"
echo fail > "$T/mode";  ok "the read fails: fails loudly, never a silent ok (rc 1)" "$([ "$(run off)" = 1 ] && grep -q "could not read" "$T/out" && echo 1 || echo 0)"
ok "the token never appears in the output" "$(! grep -rq test-token "$T/out" && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
