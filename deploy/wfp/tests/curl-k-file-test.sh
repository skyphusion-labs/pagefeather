#!/bin/bash
# The curl config used by deploy/wfp/lib.sh api (#581).
# The token is written to a mode-600 file from mktemp and passed with -K.
# It is never on curl's argv. The file is removed when the call's shell exits,
# including when curl fails and the script exits non-zero.
#   deploy/wfp/tests/curl-k-file-test.sh [another lib.sh]
# Needs bash, curl, python3. Exits 0 only when every case holds.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/curl-k-file.XXXXXX")
fails=0
spid=""
child=""
cleanup() {
  [ -n "$child" ] && kill "$child" 2>/dev/null || true
  [ -n "$spid" ] && kill "$spid" 2>/dev/null || true
  [ -n "$child" ] && wait "$child" 2>/dev/null || true
  [ -n "$spid" ] && wait "$spid" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT
check() {
  if [ "$2" = "$3" ]; then printf '%s\n' "PASS $1"; else printf '%s\n' "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi
}

TOK="tok581test${RANDOM}"
python3 -I - "$T/seen" "$T/port" << 'PY' &
import sys, time, http.server
seen, portf = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/ready":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        auth = self.headers.get("Authorization") or ""
        with open(seen, "a") as fh:
            fh.write(auth + "\n")
        time.sleep(2)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(portf, "w") as fh:
    fh.write(str(srv.server_address[1]))
srv.serve_forever()
PY
spid=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.05; done
PORT=$(cat "$T/port" 2>/dev/null || true)
check "the local server bound a port" "$([ -n "$PORT" ] && echo yes || echo no)" "yes"
if [ -z "$PORT" ]; then
  printf '%s\n' "$fails failing case(s)"
  exit "$fails"
fi
for _ in $(seq 1 50); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/ready" && break; sleep 0.05; done

mkdir -p "$T/tmp"
cat > "$T/ok.sh" << EOF
set -euo pipefail
. "$LIB"
api GET "/slow" > "$T/body"
EOF
TMPDIR="$T/tmp" WFP_API="http://127.0.0.1:$PORT" CLOUDFLARE_API_TOKEN="$TOK" /bin/bash "$T/ok.sh" &
child=$!

args=""
kpid=""
for _ in $(seq 1 40); do
  kpid=$(ps -ax -o pid=,args= | awk -v p=":$PORT/slow" 'index($0, p) && index($0, "curl") {print $1; exit}')
  if [ -n "$kpid" ]; then
    args=$(ps -o args= -p "$kpid" 2>/dev/null || true)
    [ -n "$args" ] && break
  fi
  sleep 0.05
done
check "curl was running while its argv was read" "$([ -n "$args" ] && echo yes || echo no)" "yes"
kpath=$(printf '%s\n' "$args" | sed -n 's/.* -K \([^ ]*\).*/\1/p')
check "curl argv has a -K path" "$([ -n "$kpath" ] && echo yes || echo no)" "yes"

mode="missing"
if [ -n "$kpath" ] && [ -e "$kpath" ]; then
  mode=$(python3 -I -c 'import os, stat, sys
p = sys.argv[1]
st = os.lstat(p)
if not stat.S_ISREG(st.st_mode):
    print("not-file")
else:
    print(oct(stat.S_IMODE(st.st_mode)))' "$kpath")
fi
check "the curl config file is mode 600" "$mode" "0o600"

in_argv=$(printf '%s' "$args" | grep -c -F -- "$TOK" || true)
check "the token is not in curl's argv" "$in_argv" "0"
in_path=$(printf '%s' "$kpath" | grep -c -F -- "$TOK" || true)
check "the token is not in the config path" "$in_path" "0"

holds=no
if [ "$mode" = "0o600" ] && grep -q -F -- "Authorization: Bearer $TOK" "$kpath"; then
  holds=yes
fi
check "the config file holds the Authorization header" "$holds" "yes"

got_hdr=no
for _ in $(seq 1 40); do
  if [ -s "$T/seen" ] && grep -q -F -x -- "Bearer $TOK" "$T/seen"; then got_hdr=yes; break; fi
  sleep 0.05
done
check "the server received the Authorization header" "$got_hdr" "yes"

wait "$child" 2>/dev/null
rc=$?
child=""
check "api exits 0 when the server answers" "$rc" "0"
gone=yes
if [ -n "$kpath" ] && [ -e "$kpath" ]; then gone=no; fi
check "the config file is removed after a successful exit" "$gone" "yes"
code=$(tail -n 1 "$T/body" 2>/dev/null || true)
check "api prints the HTTP code" "$code" "200"

# Failing exit: curl cannot connect. set -e ends the script. No config file remains.
d=$(mktemp -d "$T/fail.XXXXXX")
closed=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
TMPDIR="$d" WFP_API="http://127.0.0.1:$closed" CLOUDFLARE_API_TOKEN="$TOK" /bin/bash -c '
set -euo pipefail
. "$1"
api GET "/nope" >/dev/null
echo UNREACHED
' bash "$LIB" > "$T/fail.out" 2> "$T/fail.err"
frc=$?
left=$(find "$d" -type f 2>/dev/null | wc -l | tr -d ' ')
check "a failing api exits non-zero" "$([ "$frc" -ne 0 ] && echo yes || echo no)" "yes"
check "a failing api does not continue" "$(grep -c UNREACHED "$T/fail.out" || true)" "0"
check "the config file is removed after a failing exit" "$left" "0"

printf '%s\n' "$fails failing case(s)"
exit "$fails"
