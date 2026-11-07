#!/bin/bash
# Test of wait_build in deploy/wfp/lib.sh (issue #35 slice 5) against fake-build.py.
#   deploy/wfp/tests/wait-build-test.sh [another lib.sh]
# BUILD_WAIT 4, BUILD_EVICT_AFTER 1, BUILD_POLL_S 0.3. Cases:
#   flip-2       0  a re-upload flips /_build: no evict needed
#   evict-only   0  flips only after /_evict: wait_build calls it, then flips
#   never        1  never flips: fails at BUILD_WAIT, last "old"
# Exits 0 only when every case gives what it must.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d); trap 'rm -rf "$T"; pkill -f fake-build.py 2>/dev/null' EXIT
# shellcheck disable=SC1090
. "$LIB"
fails=0
run() { # run <mode>: prints "<rc> <output>"
  rm -f "$T/port"
  python3 -I "$HERE/fake-build.py" "$T/port" "$1" >/dev/null 2>&1 & local pid=$!
  for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
  local out rc
  out=$(BUILD_WAIT=4 BUILD_EVICT_AFTER=1 BUILD_POLL_S=0.3 wait_build "http://127.0.0.1:$(cat "$T/port")" t new 2>&1); rc=$?
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  echo "$rc|$out"
}
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
r=$(run flip-2);     ok "flip-2 -> 0 (${r#*|})"     "$([ "${r%%|*}" = 0 ] && echo 1 || echo 0)"
r=$(run evict-only); ok "evict-only -> 0, evict called (${r#*|})" "$([ "${r%%|*}" = 0 ] && printf '%s' "$r" | grep -q "calling /_evict" && echo 1 || echo 0)"
r=$(run never);      ok "never -> 1, last old (${r#*|})" "$([ "${r%%|*}" = 1 ] && printf '%s' "$r" | grep -q "did not go live" && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $fails
