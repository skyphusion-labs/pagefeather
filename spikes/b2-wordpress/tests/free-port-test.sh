#!/bin/bash
# #839: when PORT is unset and 8797 is already held, run.sh picks another free
# TCP port on 127.0.0.1 and a later step (e2e.sh) uses that same port. An
# explicit PORT is passed through unchanged. WR is a stub, so this does not
# start wrangler. The listener this test starts is the only process it stops.
# Wired from .github/workflows/ci.yml next to inspector-port-test.sh.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/free-port.XXXXXX")
HOLD=
OURS=0
CHOSEN=
PEX=
fails=0
SAVED=$T/saved
mkdir -p "$SAVED"
[ -f "$HERE/dev.log" ] && cp "$HERE/dev.log" "$SAVED/dev.log"
[ -f "$HERE/out.json" ] && cp "$HERE/out.json" "$SAVED/out.json"
[ -f "$HERE/.dev-port" ] && cp "$HERE/.dev-port" "$SAVED/.dev-port"

ok() {
  if [ "$2" = 1 ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1"
    fails=$((fails + 1))
  fi
}
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
free_port() {
  python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}
stop_port() {
  [ -n "$1" ] || return 0
  PORT=$1 "$HERE/run.sh" --stop >/dev/null 2>&1
  rm -f "$HERE/.dev-$1.pid"
}
cleanup() {
  stop_port "$CHOSEN"
  stop_port "$PEX"
  if [ "$OURS" = 1 ] && [ -n "$HOLD" ]; then
    kill "$HOLD" 2>/dev/null
    wait "$HOLD" 2>/dev/null
  fi
  rm -f "$HERE/dev.log" "$HERE/out.json" "$HERE/.dev-port"
  [ -f "$SAVED/dev.log" ] && cp "$SAVED/dev.log" "$HERE/dev.log"
  [ -f "$SAVED/out.json" ] && cp "$SAVED/out.json" "$HERE/out.json"
  [ -f "$SAVED/.dev-port" ] && cp "$SAVED/.dev-port" "$HERE/.dev-port"
  rm -rf "$T"
}
trap cleanup EXIT

cat > "$T/stub.py" << 'PY'
import os, sys, socket
from http.server import BaseHTTPRequestHandler, HTTPServer

args = sys.argv[1:]
log_path = os.environ["STUB_LOG"]

def flag(name):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return None

port_s = flag("--port")
insp_s = flag("--inspector-port")
try:
    port = int(port_s)
except (TypeError, ValueError):
    port = 0

with open(log_path, "w") as fh:
    fh.write("argv %s\n" % " ".join(args))
    fh.write("port=%s\n" % port)

if port < 1:
    sys.stdout.write("ERROR http port\n")
    sys.exit(1)

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ok"
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *a):
        pass

try:
    httpd = HTTPServer(("127.0.0.1", port), H)
except OSError:
    sys.stdout.write("ERROR http port %s already in use\n" % port)
    sys.exit(1)
if insp_s:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", int(insp_s)))
        s.listen(1)
    except OSError:
        sys.stdout.write("ERROR inspector port %s already in use\n" % insp_s)
        sys.exit(1)
httpd.serve_forever()
PY

cat > "$T/wr" << 'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' stub
  exit 0
fi
exec python3 -I "$STUB_PY" "$@"
EOF
chmod +x "$T/wr"

# A curl that records the URL and answers 200, so e2e.sh shows which port it
# was given without talking to a real server.
cat > "$T/curl" << 'PY'
#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
url = None
out = None
hdr = None
takes = {
    "-o", "-D", "-w", "-m", "-H", "-c", "-b", "-X", "-d",
    "--data-urlencode", "--max-redirs", "--retry",
}
i = 0
while i < len(args):
    a = args[i]
    if a in takes:
        if i + 1 < len(args):
            if a == "-o":
                out = args[i + 1]
            elif a == "-D":
                hdr = args[i + 1]
            i += 2
            continue
    if a.startswith("-"):
        i += 1
        continue
    url = a
    i += 1
log = os.environ.get("CURL_LOG")
if log and url:
    with open(log, "a") as fh:
        fh.write(url + "\n")
if out and out != "/dev/null":
    with open(out, "w") as fh:
        fh.write("")
if hdr and hdr != "/dev/null":
    with open(hdr, "w") as fh:
        fh.write("HTTP/1.1 200 OK\r\n\r\n")
sys.stdout.write("0.01")
sys.exit(0)
PY
chmod +x "$T/curl"

python3 -I -c '
import socket, sys, time
deadline = time.time() + 2
last = "8797 stayed busy"
s = None
while time.time() < deadline:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 8797))
        break
    except OSError as e:
        last = str(e)
        s.close()
        s = None
        time.sleep(0.1)
if s is None:
    sys.stderr.write(last + "\n")
    sys.exit(1)
s.listen(1)
sys.stdout.write("ready\n")
sys.stdout.flush()
while True:
    time.sleep(3600)
' > "$T/hold.out" 2> "$T/hold.err" &
HOLD=$!
OURS=1
i=0
while [ "$i" -lt 30 ]; do
  grep -q '^ready$' "$T/hold.out" 2>/dev/null && break
  alive "$HOLD" || break
  i=$((i + 1))
  sleep 0.1
done
if ! grep -q '^ready$' "$T/hold.out" 2>/dev/null; then
  echo "could not bind 127.0.0.1:8797; this test does not touch another process"
  cat "$T/hold.err" >&2
  OURS=0
  HOLD=
  exit 1
fi
holder_seen=$(lsof -t -nP -iTCP:8797 -sTCP:LISTEN 2>/dev/null | head -1)
ok "the listener we started is the process on 8797" "$([ "$holder_seen" = "$HOLD" ] && echo 1 || echo 0)"

rm -f "$HERE/.dev-port" "$T/unset.log" "$T/unset.out"
set +e
env -u PORT -u INSPECTOR_PORT PATH="$PATH" WR="$T/wr" DEV_WAIT_S=5 \
  STUB_PY="$T/stub.py" STUB_LOG="$T/unset.log" \
  "$HERE/run.sh" _ping > "$T/unset.out" 2>&1
rc1=$?
set -u
line1=$(grep -E '^port [0-9]+$' "$T/unset.out" | head -1)
CHOSEN=${line1#port }
stub1=$(cat "$T/unset.log" 2>/dev/null || true)
recorded=
if [ -f "$HERE/.dev-port" ]; then
  recorded=$(tr -d '[:space:]' < "$HERE/.dev-port")
fi
holder_ok=0
alive "$HOLD" && holder_ok=1
one_line=$(grep -cE '^port [0-9]+$' "$T/unset.out" 2>/dev/null || true)
listening=0
if [ -n "$CHOSEN" ]; then
  lp=$(lsof -t -nP -iTCP:"$CHOSEN" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "$lp" ] && listening=1
fi
chose=0
if [ "$rc1" = 0 ] && [ -n "$CHOSEN" ] && [ "$CHOSEN" != 8797 ] && [ "$one_line" = 1 ] \
  && [ "$recorded" = "$CHOSEN" ] && [ "$holder_ok" = 1 ] && [ "$listening" = 1 ] \
  && printf '%s\n' "$stub1" | grep -q "port=$CHOSEN" \
  && printf '%s\n' "$stub1" | grep -q -- "--port $CHOSEN"; then
  chose=1
fi
ok "unset PORT, with 8797 held, picks another free port and prints it once (got ${CHOSEN:-none}, exit $rc1)" "$chose"
if [ "$chose" != 1 ]; then
  echo "  --- unset (exit $rc1) ---"
  sed -n '1,40p' "$T/unset.out"
  echo "  --- stub log ---"
  if [ -f "$T/unset.log" ]; then sed -n '1,20p' "$T/unset.log"; else echo "  (wrangler was not started)"; fi
  echo "  --- recorded ---"
  printf '%s\n' "${recorded:-none}"
fi

# A later step in this directory, with PORT unset in its own environment,
# must use the port run.sh just chose. e2e.sh is that step. The mock curl
# records the URL and does not connect.
: > "$T/urls"
set +e
(
  cd "$HERE" || exit 1
  env -u PORT -u INSPECTOR_PORT PATH="$T:$PATH" CURL_LOG="$T/urls" \
    "$HERE/e2e.sh" > "$T/e2e.out" 2>&1
)
set -u
first=$(head -1 "$T/urls" 2>/dev/null || true)
same=0
if [ "$chose" = 1 ] && [ -n "$first" ] \
  && printf '%s\n' "$first" | grep -q "^http://localhost:${CHOSEN}/" \
  && ! grep -q 'localhost:8797' "$T/urls"; then
  same=1
fi
ok "a later step (e2e.sh) receives that same port (first ${first:-none})" "$same"
if [ "$same" != 1 ]; then
  echo "  --- e2e urls ---"
  sed -n '1,15p' "$T/urls" 2>/dev/null || true
  echo "  --- e2e out ---"
  sed -n '1,20p' "$T/e2e.out" 2>/dev/null || true
fi

stop_port "$CHOSEN"
rm -f "$HERE/.dev-port"
CHOSEN=

PEX=$(free_port)
rm -f "$T/explicit.log" "$T/explicit.out"
set +e
env -u INSPECTOR_PORT PATH="$PATH" WR="$T/wr" PORT="$PEX" DEV_WAIT_S=5 \
  STUB_PY="$T/stub.py" STUB_LOG="$T/explicit.log" \
  "$HERE/run.sh" _ping > "$T/explicit.out" 2>&1
rc4=$?
set -u
stub4=$(cat "$T/explicit.log" 2>/dev/null || true)
choice_lines=$(grep -cE '^port [0-9]+$' "$T/explicit.out" 2>/dev/null || true)
exact=0
if [ "$rc4" = 0 ] && [ "$PEX" != 8797 ] \
  && printf '%s\n' "$stub4" | grep -q "port=$PEX" \
  && printf '%s\n' "$stub4" | grep -q -- "--port $PEX" \
  && [ "$choice_lines" = 0 ] \
  && alive "$HOLD"; then
  exact=1
fi
ok "explicit PORT $PEX is the port passed through, with no other choice (exit $rc4)" "$exact"
if [ "$exact" != 1 ]; then
  echo "  --- explicit (exit $rc4) ---"
  sed -n '1,30p' "$T/explicit.out"
  echo "  --- stub log ---"
  if [ -f "$T/explicit.log" ]; then sed -n '1,20p' "$T/explicit.log"; else echo "  (wrangler was not started)"; fi
fi

echo "$fails failing case(s)"
[ "$fails" = 0 ]
