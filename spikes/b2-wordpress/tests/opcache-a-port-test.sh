#!/bin/bash
# #1124: opcache-a.sh must not bind a fixed local port (8798). Two choices
# while that port is taken both succeed, on some other port. OPCACHE_A_PORT
# pins a port. A taken pin is refused, and the message names the holder.
# Wired from .github/workflows/ci.yml next to free-port-test.sh.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/opcache-a-port.XXXXXX")
HOLD8798=
HOLDNAMED=
fails=0

ok() {
  if [ "$2" = 1 ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1"
    fails=$((fails + 1))
  fi
}

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

cleanup() {
  if [ -n "$HOLD8798" ]; then
    kill "$HOLD8798" 2>/dev/null || true
    wait "$HOLD8798" 2>/dev/null || true
  fi
  if [ -n "$HOLDNAMED" ]; then
    kill "$HOLDNAMED" 2>/dev/null || true
    wait "$HOLDNAMED" 2>/dev/null || true
  fi
  rm -rf "$T"
}
trap cleanup EXIT

# The port deploy.sh used to force. Hold it when this test can, and never
# signal a listener this test did not start.
python3 -I -c '
import socket, sys, time
s = socket.socket()
try:
    s.bind(("127.0.0.1", 8798))
except OSError as e:
    sys.stderr.write("busy %s\n" % e)
    sys.exit(2)
s.listen(1)
sys.stdout.write("ready\n")
sys.stdout.flush()
while True:
    time.sleep(3600)
' > "$T/hold8798.out" 2> "$T/hold8798.err" &
HOLD8798=$!
i=0
while [ "$i" -lt 30 ]; do
  grep -q '^ready$' "$T/hold8798.out" 2>/dev/null && break
  alive "$HOLD8798" || break
  i=$((i + 1))
  sleep 0.1
done
ours8798=0
if grep -q '^ready$' "$T/hold8798.out" 2>/dev/null; then
  ours8798=1
else
  # Someone else already holds 8798. Leave that process alone.
  wait "$HOLD8798" 2>/dev/null || true
  HOLD8798=
fi
taken=0
if [ -n "$(lsof -t -nP -iTCP:8798 -sTCP:LISTEN 2>/dev/null | head -1)" ]; then
  taken=1
fi
ok "8798 is taken before the choices (this test holds it: $ours8798)" "$taken"
if [ "$taken" != 1 ]; then
  echo "  could not show that 8798 is taken; not asserting a free pick"
  echo "$fails failing case(s)"
  exit 1
fi

# Same prelude a deploy uses. While deploy.sh still assigns the fixed
# default, the child inherits 8798 and the choice must still not bind it.
choose() {
  # shellcheck disable=SC2086
  env -u PORT -u OPCACHE_A_PORT "$@" bash -c '
    set -euo pipefail
    if grep -q "PORT=\${PORT:-8798}" "'"$ROOT"'/deploy/deploy.sh"; then
      export PORT=${PORT:-8798}
    fi
    # shellcheck source=port.sh
    . "'"$HERE"'/port.sh"
    opcache_a_port
  '
}

one_pick() {
  local out=$1 err=$2
  set +e
  choose > "$out" 2> "$err"
  local rc=$?
  set -u
  printf '%s' "$rc"
}

port_ok() {
  local p=$1
  case "$p" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$p" != 8798 ] || return 1
  [ "$p" -ge 1 ] && [ "$p" -le 65535 ]
}

rc1=$(one_pick "$T/p1.out" "$T/p1.err")
p1=$(tr -d '[:space:]' < "$T/p1.out")
good1=0
if [ "$rc1" = 0 ] && port_ok "$p1"; then
  good1=1
fi
ok "first choice with 8798 taken succeeds on another port (got ${p1:-none}, exit $rc1)" "$good1"
if [ "$good1" != 1 ]; then
  echo "  --- stdout ---"; sed -n '1,20p' "$T/p1.out"
  echo "  --- stderr ---"; sed -n '1,20p' "$T/p1.err"
fi

rc2=$(one_pick "$T/p2.out" "$T/p2.err")
p2=$(tr -d '[:space:]' < "$T/p2.out")
good2=0
if [ "$rc2" = 0 ] && port_ok "$p2"; then
  good2=1
fi
ok "second choice with 8798 taken also succeeds (got ${p2:-none}, exit $rc2)" "$good2"
if [ "$good2" != 1 ]; then
  echo "  --- stdout ---"; sed -n '1,20p' "$T/p2.out"
  echo "  --- stderr ---"; sed -n '1,20p' "$T/p2.err"
fi

# A pin that another process holds is refused, and the line names that process
# (its pid and the command ps shows, the same text the refusal prints).
python3 -I -c '
import socket, sys, time
s = socket.socket()
s.bind(("127.0.0.1", 0))
port = s.getsockname()[1]
s.listen(1)
sys.stdout.write("%s\n" % port)
sys.stdout.flush()
while True:
    time.sleep(3600)
' > "$T/named.out" 2> "$T/named.err" &
HOLDNAMED=$!
i=0
named_port=
while [ "$i" -lt 30 ]; do
  named_port=$(tr -d '[:space:]' < "$T/named.out" 2>/dev/null || true)
  [ -n "$named_port" ] && break
  alive "$HOLDNAMED" || break
  i=$((i + 1))
  sleep 0.1
done
named_pid=$(lsof -t -nP -iTCP:"$named_port" -sTCP:LISTEN 2>/dev/null | sort -u | head -1)
shown=$(ps -o user= -o command= -p "$named_pid" | cut -c1-120)
refused=0
if [ -n "$named_port" ] && [ -n "$named_pid" ] && [ -n "$shown" ]; then
  set +e
  choose "OPCACHE_A_PORT=$named_port" > "$T/pin.out" 2> "$T/pin.err"
  rc_pin=$?
  set -u
  if [ "$rc_pin" != 0 ] && [ ! -s "$T/pin.out" ] \
    && grep -F "pid $named_pid ($shown)" "$T/pin.err" >/dev/null; then
    refused=1
  fi
fi
ok "a taken OPCACHE_A_PORT is refused and the message names the holder (pid ${named_pid:-none}, exit ${rc_pin:-none})" "$refused"
if [ "$refused" != 1 ]; then
  echo "  --- stdout ---"; sed -n '1,20p' "$T/pin.out" 2>/dev/null || true
  echo "  --- stderr ---"; sed -n '1,20p' "$T/pin.err" 2>/dev/null || true
fi

free_pin=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
set +e
choose "OPCACHE_A_PORT=$free_pin" "PORT=8798" > "$T/over.out" 2> "$T/over.err"
rc_over=$?
set -u
over=$(tr -d '[:space:]' < "$T/over.out")
won=0
if [ "$rc_over" = 0 ] && [ "$over" = "$free_pin" ]; then
  won=1
fi
ok "OPCACHE_A_PORT wins over PORT and is the port printed (got ${over:-none}, want $free_pin)" "$won"
if [ "$won" != 1 ]; then
  echo "  --- stdout ---"; sed -n '1,20p' "$T/over.out" 2>/dev/null || true
  echo "  --- stderr ---"; sed -n '1,20p' "$T/over.err" 2>/dev/null || true
fi

bad=0
set +e
choose "OPCACHE_A_PORT=nope" > "$T/bad.out" 2> "$T/bad.err"
rc_bad=$?
set -u
if [ "$rc_bad" != 0 ] && [ ! -s "$T/bad.out" ] && grep -q 'OPCACHE_A_PORT' "$T/bad.err"; then
  bad=1
fi
ok "a port that is not a number is refused (exit $rc_bad)" "$bad"

wired=0
if grep -q 'PORT=$(opcache_a_port)' "$HERE/opcache-a.sh" \
  && grep -q 'echo "port \$PORT"' "$HERE/opcache-a.sh" \
  && ! grep -q 'PORT=${PORT:-8798}' "$ROOT/deploy/deploy.sh"; then
  wired=1
fi
ok "opcache-a.sh logs the chosen port, and deploy.sh does not default it to 8798" "$wired"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
