#!/bin/bash
# deploy/tests/cron-version-readback-test.sh (#1152): deploy/lib/cron-version.sh's cron_version_readback asks the site's
# /_cron-build (spike token) whether approach A's cron Durable Object moved to the new build, for up to
# CRON_VERSION_WAIT_S. It WARNS (never fails the deploy) when the object is still on another build, says ok when it
# matches, and is silent where there is no cron object. A local stub server plays the site.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/cron-version-test.XXXXXX")
trap '[ -n "${SP:-}" ] && kill $SP 2>/dev/null; rm -rf "$T"' EXIT
PORT=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
# The stub: answers /_cron-build with the next line of $T/answers each call (the last one repeats); 403 without the token.
cat > "$T/stub.py" <<'PY'
import http.server, os, sys
T = sys.argv[2]; calls = [0]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _log(self):
        open(os.path.join(T, "log"), "a").write("%s %s\n" % (self.command, self.path.split("?")[0]))
    def do_GET(self):
        self._log()
        if self.headers.get("x-spike-token") != "tok":
            self.send_response(403); self.end_headers(); return
        lines = open(os.path.join(T, "answers")).read().splitlines()
        body = lines[min(calls[0], len(lines) - 1)].encode(); calls[0] += 1
        open(os.path.join(T, "calls"), "w").write(str(calls[0]))
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        self._log()
        if self.headers.get("x-spike-token") != "tok":
            self.send_response(403); self.end_headers(); return
        status = 200
        marker = os.path.join(T, "wake-status")
        if os.path.exists(marker):
            status = int(open(marker).read().strip() or "200")
        body = b'{"ok":true,"pulled":true}' if status == 200 else b'{"ok":false}'
        self.send_response(status); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 -I "$T/stub.py" "$PORT" "$T" & SP=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
. "$ROOT/deploy/lib/cron-version.sh"
# run [wait s] [A_CRON] [VARIANT]
run() { rm -f "$T/log"; CRON_VERSION_WAIT_S=${1:-3} CRON_VERSION_EVERY_S=1 A_CRON=${2:-1} VARIANT=${3:-a} cron_version_readback "http://127.0.0.1:$PORT" tok > "$T/out" 2>&1; echo $? > "$T/rc"; }

echo '{"worker":"new","cron":"new","alarm":"new","state":"ok","same":true}' > "$T/answers"; run
ok "the same build: ok, rc 0 ($(cat "$T/out"))" "$(grep -q 'ok' "$T/out" && [ "$(cat "$T/rc")" = 0 ] && ! grep -q WARNING "$T/out" && echo 1 || echo 0)"

printf '%s\n' '{"worker":"new","cron":"old","alarm":"old","state":"object-stale","same":false}' > "$T/answers"; run
ok "still on the old build after the wait: a WARNING naming both builds, and rc 0 (never fails the deploy)" "$(grep -q 'WARNING' "$T/out" && grep -q 'old' "$T/out" && grep -q 'new' "$T/out" && grep -q '1152' "$T/out" && [ "$(cat "$T/rc")" = 0 ] && echo 1 || echo 0)"

printf '%s\n' '{"worker":"new","cron":"old","alarm":"old","state":"object-stale","same":false}' '{"worker":"new","cron":"new","alarm":"new","state":"ok","same":true}' > "$T/answers"; run 5
ok "it moves on the second read: ok, no warning" "$(grep -q 'ok' "$T/out" && ! grep -q WARNING "$T/out" && echo 1 || echo 0)"

printf '%s\n' '{"worker":"new","cron":"new","alarm":"new","state":"ok","same":true}' > "$T/answers"; rm -f "$T/calls"; run 3 0
ok "A_CRON off: no read at all" "$([ ! -f "$T/calls" ] && [ ! -s "$T/out" ] && echo 1 || echo 0)"
rm -f "$T/calls"; run 3 1 b-dosql
ok "not variant a: no read at all" "$([ ! -f "$T/calls" ] && [ ! -s "$T/out" ] && echo 1 || echo 0)"

# #1152 proof (strummer, cf759hx deploy 2): the answering code was new while the legs still ran the old build. Not ok.
printf '%s\n' '{"worker":"new","cron":"new","alarm":"old","state":"legs-stale","same":false}' > "$T/answers"; run
ok "the object answers on the new build but its last alarm ran the old one: a WARNING naming the alarm, never ok" "$(grep -q 'WARNING' "$T/out" && grep -q 'alarm' "$T/out" && grep -q 'old' "$T/out" && ! grep -q 'cron object: ok' "$T/out" && echo 1 || echo 0)"
printf '%s\n' '{"worker":"new","cron":"new","alarm":null,"state":"legs-stale","same":false}' > "$T/answers"; run
ok "no alarm on record yet: a WARNING, never ok" "$(grep -q 'WARNING' "$T/out" && ! grep -q 'cron object: ok' "$T/out" && echo 1 || echo 0)"
# The cron object exists exactly when a-settings.sh renders it: with a_cron_on loaded (deploy.sh sources a-settings.sh),
# its answer decides, so A_CRON unset reads once the default is on (#1164), and a_cron_on false never reads.
printf '%s\n' '{"worker":"new","cron":"new","alarm":"new","state":"ok","same":true}' > "$T/answers"; rm -f "$T/calls"
(a_cron_on() { return 0; }; unset A_CRON; CRON_VERSION_WAIT_S=3 CRON_VERSION_EVERY_S=1 VARIANT=a cron_version_readback "http://127.0.0.1:$PORT" tok > "$T/out" 2>&1)
ok "a_cron_on says on with A_CRON unset: it reads (ok)" "$([ -f "$T/calls" ] && grep -q 'cron object: ok' "$T/out" && echo 1 || echo 0)"
rm -f "$T/calls"
(a_cron_on() { return 1; }; A_CRON=1 CRON_VERSION_WAIT_S=3 CRON_VERSION_EVERY_S=1 VARIANT=a cron_version_readback "http://127.0.0.1:$PORT" tok > "$T/out" 2>&1)
ok "a_cron_on says off: no read, whatever A_CRON says" "$([ ! -f "$T/calls" ] && [ ! -s "$T/out" ] && echo 1 || echo 0)"
printf '%s\n' 'not json' > "$T/answers"; run 2
ok "an unreadable answer is a WARNING (could not read), rc 0" "$(grep -q 'WARNING' "$T/out" && grep -qi 'could not' "$T/out" && [ "$(cat "$T/rc")" = 0 ] && echo 1 || echo 0)"

# #1152 (lead, 2026-11-22): the default wait covers approach A's idle backoff. An idle cron object parks its next alarm
# up to IDLE_MAX_MS (5 min) ahead, set by the OLD build; measured on cf759hw: the first tick on the new build came
# 3 min 29 s and 2 min 44 s after the deploy, both at the parked time. 120 s warned falsely on both.
lib="$ROOT/deploy/lib/cron-version.sh"
# shellcheck disable=SC2016  # the literal default line of the lib, not an expansion
ok "#1152 the default wait is 600 s (10 min), above the 5 min idle cap" "$(grep -qF 'wait=${CRON_VERSION_WAIT_S:-600}' "$lib" && echo 1 || echo 0)"
idle=$(grep -oE 'IDLE_MAX_MS = [0-9]+ \* 60 \* 1000' "$ROOT/spikes/b2-wordpress/cron-idle.mjs" | grep -oE '= [0-9]+' | tr -dc 0-9)
dflt=$(grep -oE 'wait=\$\{CRON_VERSION_WAIT_S:-[0-9]+\}' "$lib" | grep -oE '[0-9]+' | tail -1)
ok "#1152 the default wait (${dflt:-?} s) is at least 2x IDLE_MAX_MS (cron-idle.mjs: ${idle:-?} min)" "$([ -n "$idle" ] && [ -n "$dflt" ] && [ "$dflt" -ge $((idle * 60 * 2)) ] && echo 1 || echo 0)"
printf '%s\n' '{"worker":"new","cron":"old","alarm":"old"}' '{"worker":"new","cron":"new","alarm":"new"}' > "$T/answers"; run 3
ok "#1152 an ok after waiting prints the measured lag" "$(grep -qE 'cron object: ok.*lag [0-9]+ s' "$T/out" && echo 1 || echo 0)"

# #1360: one wake right after the upload's readback starts, before the poll. A failed wake never fails the deploy.
# shellcheck disable=SC2016  # the literal call in cron-version.sh, not an expansion
pat='cron_version_wake "$url" "$token"'
call=$(grep -nF "$pat" "$lib" | head -1 | cut -d: -f1)
loop=$(grep -n 'while :; do' "$lib" | head -1 | cut -d: -f1)
ok "#1360 cron_version_wake is called once, before the readback loop" "$([ -n "$call" ] && [ -n "$loop" ] && [ "$call" -lt "$loop" ] && [ "$(grep -cF "$pat" "$lib")" = 1 ] && echo 1 || echo 0)"
rm -f "$T/wake-status"
printf '%s\n' '{"worker":"new","cron":"new","alarm":"new","state":"ok","same":true}' > "$T/answers"
run
ok "#1360 the wake is one POST /_cron-wake before any /_cron-build poll ($(tr '\n' ' ' < "$T/log" 2>/dev/null))" "$( [ -f "$T/log" ] && head -1 "$T/log" | grep -qx 'POST /_cron-wake' && [ "$(grep -c 'POST /_cron-wake' "$T/log")" = 1 ] && grep -q 'GET /_cron-build' "$T/log" && echo 1 || echo 0)"
ok "#1360 an accepted wake is printed" "$(grep -qx 'cron wake: accepted' "$T/out" && echo 1 || echo 0)"
echo 500 > "$T/wake-status"
printf '%s\n' '{"worker":"new","cron":"new","alarm":"new","state":"ok","same":true}' > "$T/answers"
run 3
ok "#1360 a failed wake is printed, the readback still runs, and the deploy is not failed" "$(grep -q 'cron wake: not accepted' "$T/out" && grep -q 'cron object: ok' "$T/out" && [ "$(cat "$T/rc")" = 0 ] && [ "$(grep -c 'POST /_cron-wake' "$T/log")" = 1 ] && echo 1 || echo 0)"
rm -f "$T/wake-status" "$T/log"
cron_version_wake "http://127.0.0.1:1" tok > "$T/down" 2>&1
echo $? > "$T/downrc"
ok "#1360 a wake that cannot connect prints not accepted and returns 0" "$(grep -q 'not accepted' "$T/down" && [ "$(cat "$T/downrc")" = 0 ] && echo 1 || echo 0)"
rm -f "$T/log"
(a_cron_on() { return 1; }; A_CRON=1 CRON_VERSION_WAIT_S=3 CRON_VERSION_EVERY_S=1 VARIANT=a cron_version_readback "http://127.0.0.1:$PORT" tok > "$T/out" 2>&1)
ok "#1360 a_cron_on says off: no wake" "$( ! grep -q 'POST /_cron-wake' "$T/log" 2>/dev/null && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
