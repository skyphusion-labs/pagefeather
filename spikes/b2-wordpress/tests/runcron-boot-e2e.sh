#!/bin/bash
# #724 review, finding 2: /_runcron boots NO second runtime. It runs inside the request's own PHP lock; runCron resolves
# its runtime under that same lock ({ held: true }, #723), so it reuses the current runtime and never waits out the
# stale time (60 s) to drop it and boot another.
#   tests/runcron-boot-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# dosql-local, reuse and the gate on: a page makes a runtime current; /_runcron must answer within 30 s, and the ledger
# after it must show the same boot count and one live memory.
set -u
cd "$(dirname "$0")/.." || exit 1
export DEV_ENV=${DEV_ENV:-dosql-local}
# shellcheck source=port.sh
. ./port.sh
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/runcron-boot.XXXXXX"); export PERSIST_TO=$STATE
H=$(mktemp "${TMPDIR:-/tmp}/runcron-boot-h.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$H"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off PHP_MEMORY_REUSE:on BOOT_GATE:on" ./run.sh _ping > /dev/null || { echo "runcron-boot: wrangler dev did not start"; tail -20 dev.log; exit 1; }
server_port || exit 1
B=http://localhost:$PORT
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "runcron-boot: /_install failed"; exit 1; }
ledger() {
  local c; c=$(curl -s "${ST[@]}" -H 'x-mem-ledger: 1' -o /dev/null -D "$H" -w '%{http_code}' "$B/wp-login.php")
  grep -qi '^x-perf:' "$H" || { echo "runcron-boot: no ledger: status $c" >&2; echo "x x"; return; }
  grep -i '^x-perf:' "$H" | cut -d' ' -f2- | python3 -I -c 'import json,sys; r=(json.loads(sys.stdin.read() or "{}").get("mem") or {}).get("runtimes") or {}; print(r.get("booted"), r.get("memLive"))'
}
read -r booted0 _ < <(ledger)
t=$(curl -s "${ST[@]}" -o /dev/null -w '%{http_code} %{time_total}' --max-time 120 "$B/_runcron")
read -r booted1 live1 < <(ledger)
echo "runcron-boot: /_runcron $t s; booted $booted0 -> $booted1, memLive $live1"
s=${t#* }; c=${t%% *}
[ "$c" = 200 ] || { echo "runcron-boot: FAIL: /_runcron answered $c"; exit 1; }
awk -v s="$s" 'BEGIN { exit !(s < 30) }' || { echo "runcron-boot: FAIL: /_runcron took $s s (the nested lock went stale)"; exit 1; }
[ "$booted1" = "$booted0" ] || { echo "runcron-boot: FAIL: /_runcron booted a runtime ($booted0 -> $booted1)"; exit 1; }
[ "$live1" = 1 ] || { echo "runcron-boot: FAIL: $live1 live memories after /_runcron"; exit 1; }
echo "runcron-boot: ok: /_runcron ran on the current runtime, booted nothing, one memory"
