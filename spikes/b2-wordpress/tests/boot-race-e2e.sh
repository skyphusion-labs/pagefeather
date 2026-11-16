#!/bin/bash
# #603 (B): a drop that lands in the MIDDLE of a boot (AT=instantiate: after the boot took the spare, the #724 review's
# finding 4) (the boot awaits before it instantiates) must not leave two
# runtimes: the boot that a drop superseded instantiates nothing and hands off to the current boot.
#   tests/boot-race-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# dosql-local, reuse and the gate on, the seam BOOT_TEST_DELAY_MS=1500 (a boot waits 1.5 s after its own turn). A
# forced recycle leaves no runtime; request A then boots (slowly); 0.4 s later request B drops the runtime outside
# the PHP lock (x-pf-test-drop: 1, the seam) and waits for the lock. Both must answer 200, and afterwards the
# ledger must show ONE live memory and ONE boot for the two of them.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/boot-race.XXXXXX"); export PERSIST_TO=$STATE
H=$(mktemp "${TMPDIR:-/tmp}/boot-race-h.XXXXXX"); HA=$(mktemp "${TMPDIR:-/tmp}/boot-race-ha.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$H" "$HA"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off PHP_MEMORY_REUSE:on BOOT_GATE:on BOOT_TEST_DELAY_MS:1500${AT:+ BOOT_TEST_DELAY_AT:$AT}" ./run.sh _ping > /dev/null || { echo "boot-race: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "boot-race: /_install failed"; exit 1; }
# ledger [curl args]: "booted memLive" from the ledger in x-perf of one wp-login.php request
ledger() {
  local c; c=$(curl -s "${ST[@]}" -H 'x-mem-ledger: 1' "$@" -o /dev/null -D "$H" -w '%{http_code}' "$B/wp-login.php")
  grep -qi '^x-perf:' "$H" || { echo "boot-race: no ledger: status $c, $(grep -i '^x-runtime-wait' "$H" | tr -d '\r' | tr '\n' ' ')" >&2; echo "0 0"; return; }
  grep -i '^x-perf:' "$H" | cut -d' ' -f2- | python3 -I -c 'import json,sys; r=(json.loads(sys.stdin.read() or "{}").get("mem") or {}).get("runtimes") or {}; print(r.get("booted"), r.get("memLive"))'
}
curl -s "${ST[@]}" -o /dev/null "$B/wp-login.php"
# one request reads the boot count and is recycled: no runtime is current when the race starts
read -r booted0 _ < <(ledger -H 'x-runtime-recycle: force')
grep -qi '^x-runtime-recycled:' "$H" || { echo "boot-race: the forced recycle was not done"; exit 1; }
# A: boots slowly (1.5 s inside its boot); B: drops 0.4 s in, outside the lock
curl -s "${ST[@]}" -o /dev/null -w '%{http_code}' "$B/wp-login.php" > "$HA" &
pa=$!
sleep 0.4
cb=$(curl -s "${ST[@]}" -H 'x-pf-test-drop: 1' -o /dev/null -w '%{http_code}' "$B/wp-login.php")
wait $pa; ca=$(cat "$HA")
read -r booted1 live1 < <(ledger)
echo "boot-race: A $ca, B $cb; boots for the two: $((booted1 - booted0)) (booted $booted0 -> $booted1), memLive $live1"
[ "$ca" = 200 ] && [ "$cb" = 200 ] || { echo "boot-race: FAIL: A $ca, B $cb"; exit 1; }
[ "$live1" = 1 ] || { echo "boot-race: FAIL: $live1 live memories: a superseded boot instantiated beside the current one"; exit 1; }
if [ "${AT:-}" = instantiate ]; then
  # the drop lands after A started instantiating: A instantiates before it can see it (unavoidable), then its callers
  # are handed a boot that REUSES A's memory. The invariant is one memory, never a second one beside it.
  [ $((booted1 - booted0)) -le 2 ] || { echo "boot-race: FAIL: $((booted1 - booted0)) boots for one drop"; exit 1; }
  grep -i '^x-perf:' "$H" | cut -d' ' -f2- | python3 -I -c 'import json,sys; m=json.loads(sys.stdin.read() or "{}").get("mem") or {}; t=(m.get("memReuse") or {}).get("taken", 0); sys.exit(0 if t and t >= 1 else "boot-race: FAIL: no memory was taken for reuse after the superseded instantiation")' || exit 1
else
  [ $((booted1 - booted0)) = 1 ] || { echo "boot-race: FAIL: $((booted1 - booted0)) boots for one drop: the superseded boot instantiated"; exit 1; }
fi
echo "boot-race: ok: a drop in the middle of a boot leaves one runtime"
