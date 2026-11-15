#!/usr/bin/env bash
# #677: server_alive, the check opcache.sh runs after /_install and before it blames WooCommerce.
# A dead local dev server (recorded pid gone, /_ping silent, or esbuild's deadlock line in dev.log)
# must be named, with that dev.log line, and must not be reported as "WooCommerce did not activate".
# A live server whose activation fails, even when dev.log holds a PHP Fatal error, still says WooCommerce.
# Wired from .github/workflows/ci.yml next to opcache-activate-test.sh.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/opcache-server-alive.XXXXXX"); SP=
trap '[ -n "$SP" ] && kill "$SP" 2>/dev/null; rm -rf "$T"' EXIT

# The esbuild line, then enough later lines that a 15-line tail of dev.log does not contain it.
bury_deadlock() {
  {
    printf '%s\n' 'fatal error: all goroutines are asleep - deadlock!'
    i=0
    while [ "$i" -lt 20 ]; do
      printf 'noise %s\n' "$i"
      i=$((i + 1))
    done
  } > "$T/dev.log"
}

serve() { # serve <codes>: POST /_activate or /_install returns the next code; GET /_ping is 200.
  PORT=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 -I -c '
import http.server, sys
seq = sys.argv[2].split(",")
n = [0]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _send(self, code, b):
        self.send_response(code)
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        self._send(200, b"pong")
    def do_POST(self):
        c = int(seq[min(n[0], len(seq) - 1)])
        n[0] += 1
        open(sys.argv[3], "w").write(str(n[0]))
        if sys.argv[4] == "die" and n[0] == 1:
            f = open(sys.argv[5], "a")
            f.write("fatal error: all goroutines are asleep - deadlock!\n")
            for i in range(20):
                f.write("noise %d\n" % i)
            f.close()
        body = b"PHP Fatal error: Uncaught Error: Call to undefined function wc_example() in plugin.php:12"
        if c == 200:
            body = b"already"
        self._send(c, body)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$PORT" "$1" "$T/count" "${2:-stay}" "$T/dev.log" &
  SP=$!
  i=0
  while [ "$i" -lt 50 ]; do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/_ping" && break
    i=$((i + 1))
    sleep 0.1
  done
}
stop() { kill "$SP" 2>/dev/null || true; wait "$SP" 2>/dev/null || true; SP=; }

# runsh <pid> <statements>: source the helper and run the statements. Prints nothing; rc is the statements'.
runsh() {
  (
    cd "$T" && env -i PATH="$PATH" PORT="$PORT" SERVER="$1" ACTIVATE_RETRY_S=0 \
      bash -c ". '$HERE/opcache-activate.sh'; $2"
  ) > "$T/out" 2>&1
}

: > "$T/dev.log"
echo 0 > "$T/count"
PORT=9

bury_deadlock
runsh 99999999 server_alive
rc=$?
ok "server_alive quotes the buried esbuild line and does not blame WooCommerce" \
  "$([ "$rc" != 0 ] && grep -q 'the local dev server died: fatal error: all goroutines are asleep - deadlock!' "$T/out" && ! grep -q 'WooCommerce did not activate' "$T/out" && echo 1 || echo 0)"

: > "$T/dev.log"
serve 500 die
echo 0 > "$T/count"
runsh "$SP" woo_activate
rc=$?
stop
ok "activation failure that writes the buried deadlock line names the dead server" \
  "$([ "$rc" != 0 ] && grep -q 'the local dev server died: fatal error: all goroutines are asleep - deadlock!' "$T/out" && ! grep -q 'WooCommerce did not activate' "$T/out" && echo 1 || echo 0)"
ok "  and does not retry /_activate" "$([ "$(cat "$T/count")" = 1 ] && echo 1 || echo 0)"

: > "$T/dev.log"
bury_deadlock
serve 500
echo 0 > "$T/count"
killed=$SP
kill "$SP" 2>/dev/null || true
wait "$SP" 2>/dev/null || true
SP=
runsh "$killed" woo_activate
rc=$?
ok "killing the server, with the deadlock line buried in dev.log, names that line" \
  "$([ "$rc" != 0 ] && grep -q 'the local dev server died: fatal error: all goroutines are asleep - deadlock!' "$T/out" && ! grep -q 'WooCommerce did not activate' "$T/out" && echo 1 || echo 0)"

# The port is still open, so a call would be counted. The recorded pid is not that process.
: > "$T/dev.log"
bury_deadlock
serve 500
echo 0 > "$T/count"
runsh 99999999 woo_activate
rc=$?
stop
ok "a gone recorded pid, with the deadlock line buried, quotes that line" \
  "$([ "$rc" != 0 ] && grep -q 'the local dev server died: fatal error: all goroutines are asleep - deadlock!' "$T/out" && ! grep -q 'WooCommerce did not activate' "$T/out" && echo 1 || echo 0)"
ok "  and does not call /_activate" "$([ "$(cat "$T/count")" = 0 ] && echo 1 || echo 0)"

: > "$T/dev.log"
printf '%s\n' 'ERROR php request failed' 'PHP Fatal error: Uncaught Error: Call to undefined function wc_example() in plugin.php:12' > "$T/dev.log"
serve 500,500
echo 0 > "$T/count"
runsh "$SP" woo_activate
rc=$?
stop
ok "a live server with a PHP Fatal error still says WooCommerce" \
  "$([ "$rc" != 0 ] && grep -q 'WooCommerce did not activate' "$T/out" && ! grep -q 'the local dev server died' "$T/out" && echo 1 || echo 0)"
ok "  and retries /_activate once" "$([ "$(cat "$T/count")" = 2 ] && echo 1 || echo 0)"

: > "$T/dev.log"
serve 500
echo 0 > "$T/count"
runsh "$SP" install_dev
rc=$?
stop
ok "a live server keeps the /_install answer" \
  "$([ "$rc" != 0 ] && grep -q 'the install answered HTTP 500' "$T/out" && grep -q 'wc_example' "$T/out" && ! grep -q 'the local dev server died' "$T/out" && echo 1 || echo 0)"

: > "$T/dev.log"
bury_deadlock
serve 500
echo 0 > "$T/count"
killed=$SP
kill "$SP" 2>/dev/null || true
wait "$SP" 2>/dev/null || true
SP=
runsh "$killed" install_dev
rc=$?
ok "a dead server after /_install is named, not WooCommerce" \
  "$([ "$rc" != 0 ] && grep -q 'the local dev server died: fatal error: all goroutines are asleep - deadlock!' "$T/out" && ! grep -q 'WooCommerce did not activate' "$T/out" && echo 1 || echo 0)"

ok "opcache.sh runs install_dev before woo_activate" "$(awk '
  /install_dev \|\| exit 1/ { if (!i) i = NR }
  /woo_activate \|\| exit 1/ { if (!w) w = NR }
  END { print (i > 0 && w > i) ? 1 : 0 }
' "$HERE/opcache.sh")"
ok "file-trace.sh installs through install_dev" "$(grep -q 'install_dev || exit 1' "$HERE/file-trace.sh" && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
