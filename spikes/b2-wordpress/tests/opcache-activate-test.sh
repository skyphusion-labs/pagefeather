#!/usr/bin/env bash
# #677: opcache.sh's WooCommerce activation (opcache-activate.sh) against a stand-in dev server. Before, any
# failure, including a local dev server that died after startup (wrangler's esbuild deadlock), was reported
# as "WooCommerce did not activate", with no answer and no dev.log. Now: a dead server is named with its
# dev.log lines; a failed activation on a live server is retried once; a second failure names the HTTP status
# and the body tail of the activation's own answer.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/opcache-activate-test.XXXXXX"); SP=
trap '[ -n "$SP" ] && kill "$SP" 2>/dev/null; rm -rf "$T"' EXIT
serve() { # serve <script>: answers /_activate by <script>, a comma list of codes ("500,200"); /_ping 200
  PORT=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 -I -c '
import http.server, json, sys
seq = sys.argv[2].split(","); n = [0]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, b):
        self.send_response(code); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self.send(200, b"pong")
    def do_POST(self):
        c = int(seq[min(n[0], len(seq) - 1)]); n[0] += 1
        open(sys.argv[3], "w").write(str(n[0]))
        if c == 200: return self.send(200, json.dumps({"out": json.dumps({"active": True}, separators=(",", ":"))}, separators=(",", ":")).encode())
        self.send(c, b"PHP Fatal error: Uncaught Error: Call to undefined function wc_example() in /wordpress/wp-content/plugins/x.php:12")
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()' "$PORT" "$1" "$T/count" & SP=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/_ping" && break; sleep 0.1; done
}
stop() { kill "$SP" 2>/dev/null; wait "$SP" 2>/dev/null; SP=; }
act() { # act <server pid>: run woo_activate in a fresh shell; prints its output, returns its rc
  ( cd "$T" && env -i PATH="$PATH" PORT="$PORT" SERVER="$1" ACTIVATE_RETRY_S=0 bash -c ". '$HERE/opcache-activate.sh' && woo_activate" ) > "$T/out" 2>&1
}
: > "$T/dev.log"

serve 200; act "$SP"; rc=$?; stop
ok "a good activation: rc 0, one call" "$([ $rc = 0 ] && [ "$(cat "$T/count")" = 1 ] && echo 1 || echo 0)"

serve 500,200; act "$SP"; rc=$?; stop
ok "one failure on a live server, then success: retried once, rc 0" "$([ $rc = 0 ] && [ "$(cat "$T/count")" = 2 ] && echo 1 || echo 0)"

serve 500,500; act "$SP"; rc=$?; stop
ok "two failures on a live server: rc 1, no third call" "$([ $rc = 1 ] && [ "$(cat "$T/count")" = 2 ] && echo 1 || echo 0)"
ok "  it names the HTTP status" "$(grep -q 'answered HTTP 500 twice' "$T/out" && echo 1 || echo 0)"
ok "  and the body tail (the PHP fatal)" "$(grep -q 'Call to undefined function wc_example' "$T/out" && echo 1 || echo 0)"
ok "  and never only the old bare sentence" "$([ "$(grep -c . "$T/out")" -gt 1 ] && echo 1 || echo 0)"

serve 500; printf 'fatal error: all goroutines are asleep - deadlock!\ngoroutine 1 [chan receive]:\n' > "$T/dev.log"; act "$SP"; rc=$?; stop
ok "esbuild's deadlock in dev.log: the dev server is named dead, rc 1" "$([ $rc = 1 ] && grep -q 'local dev server died' "$T/out" && echo 1 || echo 0)"
ok "  with the dev.log lines" "$(grep -q 'all goroutines are asleep' "$T/out" && echo 1 || echo 0)"
ok "  and not blamed on WooCommerce" "$(! grep -q 'WooCommerce did not activate' "$T/out" && echo 1 || echo 0)"
: > "$T/dev.log"

serve 500; DEAD=99999999; act "$DEAD"; rc=$?; stop
ok "the server process is gone: named dead, rc 1, no retry" "$([ $rc = 1 ] && grep -q 'local dev server died' "$T/out" && [ "$(cat "$T/count")" = 1 ] && echo 1 || echo 0)"

# The wiring: both priming scripts activate through the helper, and neither keeps the old one-shot line.
for f in opcache.sh file-trace.sh; do
  ok "$f activates through woo_activate" "$(grep -qE '^\s*woo_activate \|\| exit 1$' "$HERE/$f" && echo 1 || echo 0)"
  ok "$f no longer has the bare 'WooCommerce did not activate' one-shot" "$(grep -q 'echo "WooCommerce did not activate"; exit 1' "$HERE/$f" && echo 0 || echo 1)"
done
ok "opcache.sh's install says why it failed (never a silent set -e exit)" "$(grep -q 'the install answered HTTP' "$HERE/opcache.sh" && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
