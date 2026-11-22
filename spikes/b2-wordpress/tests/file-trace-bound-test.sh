#!/bin/bash
# #1316: file-trace.sh's requests are bounded. A local endpoint that accepts and never answers used to stall a deploy
# forever (2026-11-22, a curl with no --max-time on the build's wrangler dev). Every curl in file-trace.sh goes through
# bcurl (fetch-bound.sh), which gives up after FILE_TRACE_CURL_MAX_S and names the URL. No network: local sockets only.
set -u
cd "$(dirname "$0")/.."
fail=0; pass() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
# 1. Static: no bare curl is left in file-trace.sh (comments aside).
bare=$(grep -nE '(^|[^a-z_])curl ' file-trace.sh | grep -vE '^[0-9]+:\s*#' | grep -vE 'bcurl ' || true)
[ -z "$bare" ] && pass "file-trace.sh has no bare curl" || { bad "file-trace.sh still has a bare curl:"; echo "$bare"; }
grep -qE '^\. \./fetch-bound\.sh' file-trace.sh && pass "file-trace.sh sources fetch-bound.sh" || bad "file-trace.sh does not source fetch-bound.sh"
[ -f fetch-bound.sh ] || { bad "fetch-bound.sh is missing"; exit 1; }
# shellcheck source=../fetch-bound.sh
. ./fetch-bound.sh
# 2. A server that accepts and never answers: bcurl returns non-zero within the bound and names the URL.
PORTF=$(mktemp "${TMPDIR:-/tmp}/ftb-port.XXXXXX"); ERR=$(mktemp "${TMPDIR:-/tmp}/ftb-err.XXXXXX")
python3 -I - "$PORTF" <<'PY' &
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", 0)); s.listen(8)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
held = []
while True:
    c, _ = s.accept(); held.append(c)   # accept, read nothing back, never answer
PY
SRV=$!
for i in $(seq 1 50); do [ -s "$PORTF" ] && break; sleep 0.1; done
P=$(cat "$PORTF"); U="http://127.0.0.1:$P/wp-login.php"
# The test's own watchdog: an unbounded bcurl would hang here, so it is killed at 10 s and counts as a FAIL.
t0=$(date +%s); ( FILE_TRACE_CURL_MAX_S=2 bcurl -s -o /dev/null "$U" 2> "$ERR" ) & BC=$!
for i in $(seq 1 100); do kill -0 $BC 2>/dev/null || break; sleep 0.1; done
if kill -0 $BC 2>/dev/null; then kill $BC 2>/dev/null; wait $BC 2>/dev/null; rc=0; echo "watchdog: bcurl still waiting at 10 s" >> "$ERR"; else wait $BC; rc=$?; fi; t1=$(date +%s)
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
[ "$rc" -ne 0 ] && pass "a hung endpoint makes bcurl fail (rc $rc)" || bad "bcurl returned 0 on a hung endpoint"
[ $((t1 - t0)) -le 8 ] && pass "bcurl gave up in $((t1 - t0)) s (bound 2 s)" || bad "bcurl took $((t1 - t0)) s against a 2 s bound"
grep -qF "$U" "$ERR" && pass "the failure names the URL" || { bad "the failure does not name the URL"; cat "$ERR"; }
grep -q "STOP" "$ERR" && pass "the failure says STOP" || bad "the failure does not say STOP"
# 3. A server that answers: bcurl returns 0 and passes the body through.
python3 -I - "$PORTF" <<'PY' &
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H); open(sys.argv[1], "w").write(str(s.server_address[1])); s.serve_forever()
PY
SRV=$!; : > "$PORTF"
for i in $(seq 1 50); do [ -s "$PORTF" ] && break; sleep 0.1; done
out=$(FILE_TRACE_CURL_MAX_S=5 bcurl -s "http://127.0.0.1:$(cat "$PORTF")/x"); rc=$?
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -f "$ERR"
[ "$rc" = 0 ] && [ "$out" = ok ] && pass "an answering endpoint passes through (rc 0, body ok)" || bad "an answering endpoint: rc $rc, body '$out'"
# 4. #1317 review: file-trace.sh runs under set -euo pipefail. A failing curl inside bcurl must still print STOP there,
# both as a plain call and inside a $(...) substitution, and the shell must stop (not carry on).
python3 -I - "$PORTF" <<'PY2' &
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", 0)); s.listen(8)
open(sys.argv[1], "w").write(str(s.getsockname()[1])); held = []
while True:
    c, _ = s.accept(); held.append(c)
PY2
SRV=$!; : > "$PORTF"
for i in $(seq 1 50); do [ -s "$PORTF" ] && break; sleep 0.1; done
U2="http://127.0.0.1:$(cat "$PORTF")/wp-admin/post-new.php"
for form in plain subst; do
  E2=$(mktemp "${TMPDIR:-/tmp}/ftb-e2.XXXXXX")
  ( FILE_TRACE_CURL_MAX_S=2 U2="$U2" FORM=$form bash -euo pipefail -c '. ./fetch-bound.sh
    if [ "$FORM" = plain ]; then bcurl -s -o /dev/null "$U2"; else code=$(bcurl -s -o /dev/null -w "%{http_code}" "$U2"); fi
    echo "CARRIED ON"' > "$E2.out" 2> "$E2" ) & BC=$!
  for i in $(seq 1 100); do kill -0 $BC 2>/dev/null || break; sleep 0.1; done
  if kill -0 $BC 2>/dev/null; then kill $BC 2>/dev/null; wait $BC 2>/dev/null; rc=0; echo "watchdog: still waiting at 10 s" >> "$E2"; else wait $BC; rc=$?; fi
  [ "$rc" -ne 0 ] && pass "set -e, $form: the shell stops (rc $rc)" || bad "set -e, $form: rc $rc"
  grep -q "STOP" "$E2" && grep -qF "$U2" "$E2" && pass "set -e, $form: the STOP line names the URL" || { bad "set -e, $form: no STOP line naming the URL"; cat "$E2"; }
  grep -q "CARRIED ON" "$E2.out" && bad "set -e, $form: the shell carried on after the failure" || pass "set -e, $form: nothing ran after the failure"
  rm -f "$E2" "$E2.out"
done
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -f "$PORTF"
[ "$fail" = 0 ] && echo "file-trace-bound: all checks passed" || { echo "file-trace-bound: FAILED"; exit 1; }
