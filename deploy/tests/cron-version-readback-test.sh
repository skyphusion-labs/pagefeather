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
    def do_GET(self):
        if self.headers.get("x-spike-token") != "tok":
            self.send_response(403); self.end_headers(); return
        lines = open(os.path.join(T, "answers")).read().splitlines()
        body = lines[min(calls[0], len(lines) - 1)].encode(); calls[0] += 1
        open(os.path.join(T, "calls"), "w").write(str(calls[0]))
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 -I "$T/stub.py" "$PORT" "$T" & SP=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
. "$ROOT/deploy/lib/cron-version.sh"
# run [wait s] [A_CRON] [VARIANT]
run() { CRON_VERSION_WAIT_S=${1:-3} CRON_VERSION_EVERY_S=1 A_CRON=${2:-1} VARIANT=${3:-a} cron_version_readback "http://127.0.0.1:$PORT" tok > "$T/out" 2>&1; echo $? > "$T/rc"; }

echo '{"worker":"new","cron":"new","same":true}' > "$T/answers"; run
ok "the same build: ok, rc 0 ($(cat "$T/out"))" "$(grep -q 'ok' "$T/out" && [ "$(cat "$T/rc")" = 0 ] && ! grep -q WARNING "$T/out" && echo 1 || echo 0)"

printf '%s\n' '{"worker":"new","cron":"old","same":false}' > "$T/answers"; run
ok "still on the old build after the wait: a WARNING naming both builds, and rc 0 (never fails the deploy)" "$(grep -q 'WARNING' "$T/out" && grep -q 'old' "$T/out" && grep -q 'new' "$T/out" && grep -q '1152' "$T/out" && [ "$(cat "$T/rc")" = 0 ] && echo 1 || echo 0)"

printf '%s\n' '{"worker":"new","cron":"old","same":false}' '{"worker":"new","cron":"new","same":true}' > "$T/answers"; run 5
ok "it moves on the second read: ok, no warning" "$(grep -q 'ok' "$T/out" && ! grep -q WARNING "$T/out" && echo 1 || echo 0)"

printf '%s\n' '{"worker":"new","cron":"new","same":true}' > "$T/answers"; rm -f "$T/calls"; run 3 0
ok "A_CRON off: no read at all" "$([ ! -f "$T/calls" ] && [ ! -s "$T/out" ] && echo 1 || echo 0)"
rm -f "$T/calls"; run 3 1 b-dosql
ok "not variant a: no read at all" "$([ ! -f "$T/calls" ] && [ ! -s "$T/out" ] && echo 1 || echo 0)"

printf '%s\n' 'not json' > "$T/answers"; run 2
ok "an unreadable answer is a WARNING (could not read), rc 0" "$(grep -q 'WARNING' "$T/out" && grep -qi 'could not' "$T/out" && [ "$(cat "$T/rc")" = 0 ] && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
