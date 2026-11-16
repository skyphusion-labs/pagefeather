#!/bin/bash
# #724 review, finding 1: the spare PERSISTS until a boot takes it. #598 measured no GC within 660 s, so a spare dropped
# "to GC" after a quiet gap stays resident, and the next boot grows a second memory beside it: the #598 death.
#   tests/spare-persist-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# dosql-local, reuse and the gate on: a forced recycle leaves a spare; after 35 s of quiet (past the old 30 s TTL)
# the next request must reuse it: one live memory, and memReuse.taken grew.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/spare-persist.XXXXXX"); export PERSIST_TO=$STATE
H=$(mktemp "${TMPDIR:-/tmp}/spare-persist-h.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$H"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off PHP_MEMORY_REUSE:on BOOT_GATE:on" ./run.sh _ping > /dev/null || { echo "spare-persist: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "spare-persist: /_install failed"; exit 1; }
# reuse [curl args]: "taken memLive status" of one wp-login.php request; a reading it cannot take says why on stderr
reuse() {
  local c; c=$(curl -s "${ST[@]}" -H 'x-mem-ledger: 1' "$@" -o /dev/null -D "$H" -w '%{http_code}' "$B/wp-login.php")
  grep -qi '^x-perf:' "$H" || echo "spare-persist: no ledger: status $c, $(grep -i '^x-runtime-wait' "$H" | tr -d '\r' | tr '\n' ' ')" >&2
  grep -i '^x-perf:' "$H" | cut -d' ' -f2- | python3 -I -c 'import json,sys; m=json.loads(sys.stdin.read() or "{}").get("mem") or {}; print((m.get("memReuse") or {}).get("taken"), (m.get("runtimes") or {}).get("memLive"), sys.argv[1])' "$c"
}
read -r taken0 _ < <(reuse -H 'x-runtime-recycle: force')
grep -qi '^x-runtime-recycled:' "$H" || { echo "spare-persist: the forced recycle was not done"; exit 1; }
echo "spare-persist: recycled (taken $taken0); 35 s of quiet"
sleep 35
read -r taken1 live1 code1 < <(reuse)
echo "spare-persist: after 35 s: status $code1, taken $taken1, memLive $live1"
[ "$taken1" -gt "$taken0" ] 2>/dev/null || { echo "spare-persist: FAIL: the boot after the quiet gap took no spare (it grew a new memory)"; exit 1; }
[ "$live1" = 1 ] || { echo "spare-persist: FAIL: $live1 live memories"; exit 1; }
echo "spare-persist: ok: a boot 35 s after the recycle reused the spare"
