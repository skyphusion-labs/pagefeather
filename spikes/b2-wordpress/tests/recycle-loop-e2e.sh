#!/bin/bash
# #603 (A): with memory reuse a runtime inherits the retired runtime's memory, at its old size (wasm memory never
# shrinks). A recycle line read from the memory's size would then recycle the new runtime on its first request,
# and the next, forever: a cold boot per request. The recycle must follow what THIS runtime grew.
#   tests/recycle-loop-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# dosql-local, PHP_MEMORY_REUSE and BOOT_GATE on, the recycle ON with RECYCLE_WASM_MIB=64 (an admin screen ends
# above it). A forced recycle of post-new.php hands its memory (above 64) to the next boot; then three admin
# requests on that runtime must each answer 200 with NO recycle, on the same runtime serial (x-perf rt).
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/recycle-loop.XXXXXX"); export PERSIST_TO=$STATE
J=$(mktemp "${TMPDIR:-/tmp}/recycle-loop-jar.XXXXXX"); H=$(mktemp "${TMPDIR:-/tmp}/recycle-loop-h.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$J" "$H"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_MEMORY_REUSE:on BOOT_GATE:on RECYCLE_WASM_MIB:64" ./run.sh _ping > /dev/null || { echo "recycle-loop: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "recycle-loop: /_install failed"; exit 1; }
req() { curl -s -c "$J" -b "$J" -o /dev/null -D "$H" -w '%{http_code}' "$@"; }
hdr() { grep -i "^$1:" "$H" | head -1 | tr -d '\r' | cut -d' ' -f2-; }
req "$B/wp-login.php" > /dev/null
req --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php" > /dev/null
c=$(req "${ST[@]}" -H 'x-runtime-recycle: force' "$B/wp-admin/post-new.php")
[ -n "$(hdr x-runtime-recycled)" ] || { echo "recycle-loop: the forced recycle was not done ($c)"; exit 1; }
echo "recycle-loop: post-new.php recycled at $(hdr x-wasm-mib) MiB (the memory the next boot inherits)"
rts=""
for i in 1 2 3; do
  c=$(req "${ST[@]}" "$B/wp-admin/edit.php")
  rt=$(hdr x-perf | python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read() or "{}").get("rt"))')
  why=$(hdr x-runtime-recycled)
  echo "recycle-loop: edit.php $i: $c, $(hdr x-wasm-mib) MiB, rt $rt, recycled '${why}'"
  [ "$c" = 200 ] || { echo "recycle-loop: FAIL: edit.php $i answered $c"; exit 1; }
  [ -z "$why" ] || { echo "recycle-loop: FAIL: edit.php $i recycled ($why) on an inherited memory: the recycle loop"; exit 1; }
  rts="$rts $rt"
done
[ "$(echo $rts | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')" = 1 ] || { echo "recycle-loop: FAIL: three requests ran on runtimes$rts"; exit 1; }
echo "recycle-loop: ok: three requests on the inherited memory, one runtime (rt$rts), no recycle"
