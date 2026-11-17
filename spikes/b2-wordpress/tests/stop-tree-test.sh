#!/bin/bash
# #847: run.sh --stop must stop the whole server tree it started, then prove
# the port has no listener. A parent can die and leave a child holding the
# listen socket. The old stop killed only the pids in .dev-<port>.pid (the
# first listener, its parent, and the wrangler pid) and exited 0, so that
# child kept the port.
#
# This stand-in is a parent plus a child. It is not wrangler and it does not
# build. Wired from .github/workflows/ci.yml next to free-port-test.sh.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/stop-tree.XXXXXX")
fails=0
PARENT=
CHILD=
CANARY=
HOLD_PORT=
HOLD_DEV=
P_ORPHAN=
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
listeners() {
  lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' ' | sed 's/ *$//'
}
kill_pid() {
  [ -n "${1:-}" ] || return 0
  kill "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}
cleanup() {
  kill_pid "$PARENT"
  kill_pid "$CHILD"
  kill_pid "$CANARY"
  kill_pid "$HOLD_PORT"
  kill_pid "$HOLD_DEV"
  if [ -n "${P_ORPHAN:-}" ]; then
    rm -f "$HERE/.dev-$P_ORPHAN.pid"
  fi
  rm -f "$HERE/dev.log" "$HERE/out.json" "$HERE/.dev-port"
  [ -f "$SAVED/dev.log" ] && cp "$SAVED/dev.log" "$HERE/dev.log"
  [ -f "$SAVED/out.json" ] && cp "$SAVED/out.json" "$HERE/out.json"
  [ -f "$SAVED/.dev-port" ] && cp "$SAVED/.dev-port" "$HERE/.dev-port"
  rm -rf "$T"
}
trap cleanup EXIT

# A process this test started, and run.sh did not. --stop must leave it.
sleep 300 &
CANARY=$!

cat > "$T/stub.py" << 'PY'
import os, sys, socket, time
from http.server import BaseHTTPRequestHandler, HTTPServer

args = sys.argv[1:]

def flag(name):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return None

port = int(flag("--port") or "0")
log_path = os.environ["STUB_LOG"]
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", port))
sock.listen(50)
child = os.fork()
if child == 0:
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"ok"
            self.send_response(200)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, fmt, *a):
            pass
    httpd = HTTPServer(("127.0.0.1", port), H, bind_and_activate=False)
    httpd.socket.close()
    httpd.socket = sock
    httpd.serve_forever()
else:
    # The parent keeps the listen socket too, so both pids show as listeners.
    # run.sh records the lower pid. The child is the one that outlives it.
    with open(log_path, "w") as fh:
        fh.write("parent=%s\nchild=%s\nport=%s\n" % (os.getpid(), child, port))
        fh.flush()
    while True:
        time.sleep(3600)
PY

cat > "$T/hold.py" << 'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"hold"
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *a):
        pass

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
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

wait_listen() {
  local port=$1 i=0
  while [ "$i" -lt 30 ]; do
    [ -n "$(listeners "$port")" ] && return 0
    i=$((i + 1))
    sleep 0.1
  done
  return 1
}

# --- 1. Parent dies, child still listens, then --stop ---
P_ORPHAN=$(free_port)
rm -f "$HERE/.dev-port" "$HERE/.dev-$P_ORPHAN.pid" "$T/stub.log" "$T/orphan.out"
set +e
env -u INSPECTOR_PORT PATH="$PATH" WR="$T/wr" PORT="$P_ORPHAN" DEV_WAIT_S=8 \
  STUB_PY="$T/stub.py" STUB_LOG="$T/stub.log" \
  "$HERE/run.sh" _ping > "$T/orphan.out" 2>&1
rc_start=$?
set -u
PARENT=$(awk -F= '$1=="parent"{print $2}' "$T/stub.log" 2>/dev/null || true)
CHILD=$(awk -F= '$1=="child"{print $2}' "$T/stub.log" 2>/dev/null || true)
both=0
if [ "$rc_start" = 0 ] && alive "$PARENT" && alive "$CHILD"; then
  before=$(listeners "$P_ORPHAN")
  case " $before " in
    *" $PARENT "* )
      case " $before " in
        *" $CHILD "*) both=1 ;;
      esac
      ;;
  esac
fi
if [ "$both" != 1 ]; then
  ok "orphan setup: parent and child both listen (exit $rc_start)" 0
  echo "  --- start ---"
  sed -n '1,40p' "$T/orphan.out"
  echo "  --- stub ---"
  cat "$T/stub.log" 2>/dev/null || echo "  (no stub log)"
  echo "  listeners: ${before:-none}"
else
  ok "orphan setup: parent and child both listen" 1
  echo "  pid file: $(cat "$HERE/.dev-$P_ORPHAN.pid" 2>/dev/null || echo none)"
  kill "$PARENT" 2>/dev/null || true
  wait "$PARENT" 2>/dev/null || true
  sleep 0.2
  set +e
  env -u PORT "$HERE/run.sh" --stop > "$T/stop.out" 2> "$T/stop.err"
  rc_stop=$?
  set -u
  left=$(listeners "$P_ORPHAN")
  echo "  evidence orphan: stop_rc=$rc_stop listeners=${left:-none}"
  if [ -s "$T/stop.err" ]; then
    echo "  evidence orphan stderr: $(tr '\n' ' ' < "$T/stop.err")"
  fi
  freed=0
  loud=0
  if [ "$rc_stop" = 0 ] && [ -z "$left" ] && ! alive "$CHILD"; then
    freed=1
  fi
  if [ -n "$left" ] && [ "$rc_stop" != 0 ] \
    && grep -q "port $P_ORPHAN" "$T/stop.err" \
    && grep -q "pids:" "$T/stop.err"; then
    loud=1
  fi
  if [ "$freed" = 1 ] || [ "$loud" = 1 ]; then
    pass=1
  else
    pass=0
  fi
  ok "after the parent is killed, --stop frees the port or exits non-zero (rc $rc_stop, listeners ${left:-none})" "$pass"
  ok "a process this run did not start is still alive" "$(alive "$CANARY" && echo 1 || echo 0)"
fi

# The child is ours. If --stop left it, this test reaps it. Do not leave it.
kill_pid "$CHILD"
CHILD=
kill_pid "$PARENT"
PARENT=
rm -f "$HERE/.dev-$P_ORPHAN.pid" "$HERE/.dev-port" "$HERE/dev.log" "$HERE/out.json"

# --- 2. No record, port free: say so and exit 0 ---
P_FREE=$(free_port)
rm -f "$HERE/.dev-$P_FREE.pid"
printf '%s\n' "$P_FREE" > "$HERE/.dev-port"
set +e
env -u PORT "$HERE/run.sh" --stop > "$T/free.out" 2> "$T/free.err"
rc_free=$?
set -u
free_left=$(listeners "$P_FREE")
free_ok=0
if [ "$rc_free" = 0 ] && [ -z "$free_left" ] \
  && grep -q "no record of a server on port $P_FREE" "$T/free.err" \
  && grep -q "free" "$T/free.err"; then
  free_ok=1
fi
echo "  evidence free: stop_rc=$rc_free listeners=${free_left:-none} stderr=$(tr '\n' ' ' < "$T/free.err")"
ok "no record and a free port: exit 0 and says so (rc $rc_free)" "$free_ok"
rm -f "$HERE/.dev-port" "$HERE/.dev-$P_FREE.pid"

# --- 3. No record, PORT set, port held by a process run.sh did not start ---
P_HELD=$(free_port)
python3 -I "$T/hold.py" "$P_HELD" > "$T/hold-port.log" 2>&1 &
HOLD_PORT=$!
if ! wait_listen "$P_HELD"; then
  ok "no record and PORT held: the holder did not listen" 0
else
  rm -f "$HERE/.dev-port" "$HERE/.dev-$P_HELD.pid"
  set +e
  env -u INSPECTOR_PORT PORT="$P_HELD" "$HERE/run.sh" --stop > "$T/held.out" 2> "$T/held.err"
  rc_held=$?
  set -u
  held_left=$(listeners "$P_HELD")
  held_ok=0
  if [ "$rc_held" != 0 ] && alive "$HOLD_PORT" \
    && printf '%s\n' "$held_left" | grep -q "$HOLD_PORT" \
    && grep -q "no record of a server on port $P_HELD" "$T/held.err" \
    && grep -q "pids:" "$T/held.err" \
    && grep -q "$HOLD_PORT" "$T/held.err"; then
    held_ok=1
  fi
  echo "  evidence held-PORT: stop_rc=$rc_held listeners=${held_left:-none} holder_alive=$(alive "$HOLD_PORT" && echo yes || echo no)"
  echo "  evidence held-PORT stderr: $(tr '\n' ' ' < "$T/held.err")"
  ok "no record and PORT held: non-zero, and the holder is left running (rc $rc_held)" "$held_ok"
fi
kill_pid "$HOLD_PORT"
HOLD_PORT=
rm -f "$HERE/.dev-port" "$HERE/.dev-$P_HELD.pid"

# --- 4. No record, .dev-port set, PORT unset, port held ---
P_DEV=$(free_port)
python3 -I "$T/hold.py" "$P_DEV" > "$T/hold-dev.log" 2>&1 &
HOLD_DEV=$!
if ! wait_listen "$P_DEV"; then
  ok "no record and .dev-port held: the holder did not listen" 0
else
  rm -f "$HERE/.dev-$P_DEV.pid"
  printf '%s\n' "$P_DEV" > "$HERE/.dev-port"
  set +e
  env -u PORT "$HERE/run.sh" --stop > "$T/devp.out" 2> "$T/devp.err"
  rc_dev=$?
  set -u
  dev_left=$(listeners "$P_DEV")
  dev_ok=0
  if [ "$rc_dev" != 0 ] && alive "$HOLD_DEV" \
    && printf '%s\n' "$dev_left" | grep -q "$HOLD_DEV" \
    && grep -q "no record of a server on port $P_DEV" "$T/devp.err" \
    && grep -q "pids:" "$T/devp.err" \
    && grep -q "$HOLD_DEV" "$T/devp.err"; then
    dev_ok=1
  fi
  echo "  evidence held-.dev-port: stop_rc=$rc_dev listeners=${dev_left:-none} holder_alive=$(alive "$HOLD_DEV" && echo yes || echo no)"
  echo "  evidence held-.dev-port stderr: $(tr '\n' ' ' < "$T/devp.err")"
  ok "no record and .dev-port held: non-zero, and the holder is left running (rc $rc_dev)" "$dev_ok"
fi
kill_pid "$HOLD_DEV"
HOLD_DEV=
rm -f "$HERE/.dev-port" "$HERE/.dev-$P_DEV.pid"

ok "the canary is still alive at the end" "$(alive "$CANARY" && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
