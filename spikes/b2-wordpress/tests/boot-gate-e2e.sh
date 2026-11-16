#!/bin/bash
# #705 review, finding 3: a refused boot on an OPERATOR route (/_peak) answers the known 503, and the next request
# does not await the same rejected boot again.
#   tests/boot-gate-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# dosql-local, PHP_RECYCLE off, PHP_MEMORY_REUSE off, BOOT_GATE on: /_install boots; a forced recycle of a page
# leaves its memory retired and alive (no reuse), so the next boot must be refused. /_peak is that next boot.
# #705 second review, finding 1: the refusals never last: with BOOT_GATE_MAX_REFUSE_S=3, a boot after the bound goes
# (the platform's memory reset frees what GC does not), so /_peak answers 200 once the streak is older than 3 s.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/boot-gate-e2e.XXXXXX"); export PERSIST_TO=$STATE
H=$(mktemp "${TMPDIR:-/tmp}/boot-gate-e2e-h.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$H"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off PHP_MEMORY_REUSE:off BOOT_GATE:on BOOT_GATE_MAX_REFUSE_S:3" ./run.sh _ping > /dev/null || { echo "boot-gate-e2e: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "boot-gate-e2e: /_install failed"; exit 1; }
seen=""
for i in 1 2; do
  c=$(curl -s -o /dev/null -D "$H" -w '%{http_code}' "${ST[@]}" "$B/_peak")
  w=$(grep -i '^x-runtime-wait:' "$H" | tr -d '\r' | awk '{print $2}')
  dn=$(grep -i '^x-runtime-wait-decision:' "$H" | tr -d '\r' | awk '{print $2}')
  echo "boot-gate-e2e: /_peak $i: $c ${w:-no x-runtime-wait} decision ${dn:-none}"
  [ "$c" = 503 ] && [ "$w" = retired-resident ] || { echo "boot-gate-e2e: FAIL: /_peak $i was not the known 503"; exit 1; }
  # not cached: a cached rejected boot answers the same refusal again, with the same decision serial
  [ -n "$dn" ] || { echo "boot-gate-e2e: FAIL: no decision serial"; exit 1; }
  [ "$dn" != "$seen" ] || { echo "boot-gate-e2e: FAIL: /_peak $i repeated decision $dn: a rejected boot was reused"; exit 1; }
  seen=$dn
done
sleep 4
c=$(curl -s -o /dev/null -D "$H" -w '%{http_code}' "${ST[@]}" "$B/_peak")
echo "boot-gate-e2e: /_peak after the 3 s bound: $c"
[ "$c" = 200 ] || { echo "boot-gate-e2e: FAIL: still $c after the bound: the gate refuses forever (the storm)"; exit 1; }
echo "boot-gate-e2e: ok: a refused operator boot is the known 503, decided again on each request, and never past the bound"
