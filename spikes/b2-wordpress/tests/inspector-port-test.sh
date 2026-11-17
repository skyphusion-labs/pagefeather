#!/bin/bash
# #802: run.sh must not take workerd's default inspector port 9230 when that
# port is already held, and an explicit INSPECTOR_PORT must be the port
# wrangler is given. A tiny listener holds 9230. WR is a stub, so this does
# not start wrangler. The listener this test starts is the only process it
# stops. Wired from .github/workflows/ci.yml next to local-creds-test.sh.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/inspector-port.XXXXXX")
HOLD=
OURS=0
P1=
P2=
P3=
P4=
P5=
fails=0
SAVED=$T/saved
mkdir -p "$SAVED"
[ -f "$HERE/dev.log" ] && cp "$HERE/dev.log" "$SAVED/dev.log"
[ -f "$HERE/out.json" ] && cp "$HERE/out.json" "$SAVED/out.json"

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
  stop_port "$P1"
  stop_port "$P2"
  stop_port "$P3"
  stop_port "$P4"
  stop_port "$P5"
  if [ "$OURS" = 1 ] && [ -n "$HOLD" ]; then
    kill "$HOLD" 2>/dev/null
    wait "$HOLD" 2>/dev/null
  fi
  rm -f "$HERE/dev.log" "$HERE/out.json"
  [ -f "$SAVED/dev.log" ] && cp "$SAVED/dev.log" "$HERE/dev.log"
  [ -f "$SAVED/out.json" ] && cp "$SAVED/out.json" "$HERE/out.json"
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
source = "flag" if insp_s else "default"
try:
    port = int(port_s)
    insp_port = int(insp_s) if insp_s else 9230
except (TypeError, ValueError):
    port = 0
    insp_port = 9230
    source = "bad"

with open(log_path, "w") as fh:
    fh.write("argv %s\n" % " ".join(args))
    fh.write("inspector=%s source=%s\n" % (insp_port, source))

if source == "bad" or port < 1:
    sys.stdout.write("ERROR inspector args\n")
    sys.exit(1)

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(("127.0.0.1", insp_port))
    s.listen(1)
except OSError:
    sys.stdout.write("ERROR inspector port %s already in use\n" % insp_port)
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
    s.close()
    sys.stdout.write("ERROR http port %s already in use\n" % port)
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

python3 -I -c '
import socket, sys, time
deadline = time.time() + 2
last = "9230 stayed busy"
s = None
while time.time() < deadline:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 9230))
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
  echo "could not bind 127.0.0.1:9230; this test does not touch another process"
  cat "$T/hold.err" >&2
  OURS=0
  HOLD=
  exit 1
fi
holder_seen=$(lsof -t -nP -iTCP:9230 -sTCP:LISTEN 2>/dev/null | head -1)
ok "the listener we started is the process on 9230" "$([ "$holder_seen" = "$HOLD" ] && echo 1 || echo 0)"

# invoke <inspector or -> <http port> <stub log> <combined output>
invoke() {
  rm -f "$3"
  if [ "$1" = "-" ]; then
    env -u INSPECTOR_PORT PATH="$PATH" WR="$T/wr" PORT="$2" DEV_WAIT_S=5 \
      STUB_PY="$T/stub.py" STUB_LOG="$3" \
      "$HERE/run.sh" _ping > "$4" 2>&1
  else
    env PATH="$PATH" WR="$T/wr" PORT="$2" DEV_WAIT_S=5 \
      INSPECTOR_PORT="$1" STUB_PY="$T/stub.py" STUB_LOG="$3" \
      "$HERE/run.sh" _ping > "$4" 2>&1
  fi
}

dump() {
  echo "  --- $1 (exit $2) ---"
  sed -n '1,40p' "$3"
  echo "  --- stub log ---"
  if [ -f "$4" ]; then sed -n '1,20p' "$4"; else echo "  (wrangler was not started)"; fi
}

P1=$(free_port)
set +e
invoke - "$P1" "$T/unset.log" "$T/unset.out"
rc1=$?
set -u
line1=$(grep -E '^inspector port [0-9]+$' "$T/unset.out" | head -1)
port1=${line1#inspector port }
stub1=$(cat "$T/unset.log" 2>/dev/null)
holder_ok=0
alive "$HOLD" && holder_ok=1
chose=0
if [ "$rc1" = 0 ] && [ -n "$port1" ] && [ "$port1" != 9230 ] && [ "$port1" != "$P1" ] \
  && printf '%s\n' "$stub1" | grep -q "inspector=$port1 source=flag" \
  && printf '%s\n' "$stub1" | grep -q -- "--inspector-port $port1" \
  && [ "$holder_ok" = 1 ]; then
  chose=1
fi
ok "unset INSPECTOR_PORT, with 9230 held, picks another free port and prints it (got ${port1:-none}, exit $rc1)" "$chose"
if [ "$chose" != 1 ]; then
  dump "unset" "$rc1" "$T/unset.out" "$T/unset.log"
fi

if [ "$chose" = 1 ]; then
  P2=$(free_port)
  set +e
  invoke - "$P2" "$T/second.log" "$T/second.out"
  rc2=$?
  set -u
  line2=$(grep -E '^inspector port [0-9]+$' "$T/second.out" | head -1)
  port2=${line2#inspector port }
  stub2=$(cat "$T/second.log" 2>/dev/null)
  both=0
  pid1=$(cut -d' ' -f1 "$HERE/.dev-$P1.pid" 2>/dev/null)
  pid2=$(cut -d' ' -f1 "$HERE/.dev-$P2.pid" 2>/dev/null)
  if [ "$rc2" = 0 ] && [ -n "$port2" ] && [ "$port2" != 9230 ] && [ "$port2" != "$port1" ] \
    && [ "$port2" != "$P2" ] \
    && printf '%s\n' "$stub2" | grep -q "inspector=$port2 source=flag" \
    && alive "$HOLD" && alive "$pid1" && alive "$pid2"; then
    both=1
  fi
  ok "a second unset run comes up on its own inspector port (got ${port2:-none}, exit $rc2) while the first and the 9230 listener stay up" "$both"
  if [ "$both" != 1 ]; then
    dump "second" "$rc2" "$T/second.out" "$T/second.log"
  fi

  P3=$(free_port)
  set +e
  invoke "$port1" "$P3" "$T/busy.log" "$T/busy.out"
  rc3=$?
  set -u
  refused=0
  if [ "$rc3" != 0 ] && [ ! -f "$T/busy.log" ] \
    && grep -q "inspector port $port1 is in use by pid" "$T/busy.out" \
    && alive "$HOLD" && alive "$pid1"; then
    refused=1
  fi
  ok "an explicit INSPECTOR_PORT that is held is refused, and that process is left running (exit $rc3)" "$refused"
  if [ "$refused" != 1 ]; then
    dump "explicit busy" "$rc3" "$T/busy.out" "$T/busy.log"
  fi
else
  ok "a second unset run comes up on its own inspector port (skipped: the first run did not come up)" 0
  ok "an explicit INSPECTOR_PORT that is held is refused (skipped: no chosen port to hold)" 0
  port1=
fi

FREE=$(free_port)
P4=$(free_port)
set +e
invoke "$FREE" "$P4" "$T/explicit.log" "$T/explicit.out"
rc4=$?
set -u
stub4=$(cat "$T/explicit.log" 2>/dev/null)
exact=0
choice_lines=$(grep -cE '^inspector port [0-9]+$' "$T/explicit.out" 2>/dev/null || true)
if [ "$rc4" = 0 ] && [ "$FREE" != 9230 ] \
  && printf '%s\n' "$stub4" | grep -q "inspector=$FREE source=flag" \
  && printf '%s\n' "$stub4" | grep -q -- "--inspector-port $FREE" \
  && [ "$choice_lines" = 0 ] \
  && alive "$HOLD"; then
  exact=1
fi
ok "explicit INSPECTOR_PORT $FREE is the port passed through, with no other choice (exit $rc4)" "$exact"
if [ "$exact" != 1 ]; then
  dump "explicit" "$rc4" "$T/explicit.out" "$T/explicit.log"
fi
stop_port "$P4"
P4=

set +e
invoke 9230 "$P1" "$T/def.log" "$T/def.out"
rc5=$?
set -u
# P1 may still be serving from the first run. Use a fresh http port if so.
if grep -q "port $P1 is in use" "$T/def.out" 2>/dev/null; then
  P5=$(free_port)
  set +e
  invoke 9230 "$P5" "$T/def.log" "$T/def.out"
  rc5=$?
  set -u
else
  P5=$P1
fi
named=0
if [ "$rc5" != 0 ] && grep -q "inspector port 9230 is in use by pid $HOLD" "$T/def.out" \
  && alive "$HOLD"; then
  named=1
fi
ok "explicit INSPECTOR_PORT 9230, while our listener holds it, is refused and the listener stays (exit $rc5)" "$named"
if [ "$named" != 1 ]; then
  dump "explicit 9230" "$rc5" "$T/def.out" "$T/def.log"
fi
stop_port "$P5"
[ "$P5" = "$P1" ] && P1=

echo "$fails failing case(s)"
[ "$fails" = 0 ]
