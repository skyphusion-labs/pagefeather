#!/bin/bash
# #798: the deploy flow must not stack PHP runtimes. With PHP_MEMORY_REUSE off (the default on every live site), a
# dropped runtime's WebAssembly memory stays resident until V8 collects it, so a drop followed by a boot runs two
# memories in one isolate. /_install and /_activate used to drop at their START (the #185 fresh boot) and /_activate at
# its END too ("a fresh runtime loads the plugin cleanly"): 3 live memories after the deploy flow (#798).
#   tests/deploy-flow-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# dosql-local, PHP_RECYCLE off, PHP_MEMORY_REUSE off, BOOT_GATE off: /_install, a page, /_runcron, /_activate
# (WooCommerce), a page. It must hold: ONE live memory after the flow, NO boot after the first page's runtime, and
# /_activate after /_runcron answers its OWN result (active true; install may be nested, #661), never the cron's output (#185's symptom).
# Caveat: wrangler dev does not enforce the 128 MiB isolate limit, so this checks the invariant, not the death.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/deploy-flow.XXXXXX"); export PERSIST_TO=$STATE
H=$(mktemp "${TMPDIR:-/tmp}/deploy-flow-h.XXXXXX"); A=$(mktemp "${TMPDIR:-/tmp}/deploy-flow-a.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$H" "$A"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off PHP_MEMORY_REUSE:off BOOT_GATE:off" ./run.sh _ping > /dev/null || { echo "deploy-flow: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "deploy-flow: /_install failed"; exit 1; }
ledger() { # prints: <status> <booted> <memLive> <retiredMemMiB>
  local c; c=$(curl -s "${ST[@]}" -H 'x-mem-ledger: 1' -o /dev/null -D "$H" -w '%{http_code}' "$B/wp-login.php")
  grep -i '^x-perf:' "$H" | cut -d' ' -f2- | python3 -I -c 'import json,sys; r=(json.loads(sys.stdin.read() or "{}").get("mem") or {}).get("runtimes") or {}; print(sys.argv[1], r.get("booted"), r.get("memLive"), r.get("retiredMemMiB"))' "$c"
}
read -r c0 booted0 live0 _ < <(ledger)
echo "deploy-flow: after /_install and a page: status $c0, booted $booted0, memLive $live0"
[ "$c0" = 200 ] && [ "$live0" = 1 ] || { echo "deploy-flow: FAIL: the first page: status $c0, memLive $live0"; exit 1; }
c=$(curl -s "${ST[@]}" -o /dev/null -w '%{http_code}' --max-time 120 "$B/_runcron")
[ "$c" = 200 ] || { echo "deploy-flow: FAIL: /_runcron answered $c"; exit 1; }
c=$(curl -s "${ST[@]}" -X POST -o "$A" -w '%{http_code}' --max-time 300 "$B/_activate?plugin=woocommerce/woocommerce.php")
act=$(python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1])); out = d.get("out") or ""
# #661 nests install inside the shutdown object, so a scan that rejects nested braces misses active.
own = False
dec = json.JSONDecoder()
i = 0
while True:
    j = out.find("{", i)
    if j < 0:
        break
    try:
        obj, _end = dec.raw_decode(out, j)
    except json.JSONDecodeError:
        i = j + 1
        continue
    if isinstance(obj, dict) and obj.get("active") is True:
        own = True
        break
    i = j + 1
print("own" if own else "NOT-OWN:" + out[-160:].replace("\n", " "))' "$A" 2>/dev/null || echo "NOT-JSON")
echo "deploy-flow: /_activate after /_runcron: status $c, answer $act"
[ "$c" = 200 ] || { echo "deploy-flow: FAIL: /_activate answered $c"; exit 1; }
[ "$act" = own ] || { echo "deploy-flow: FAIL: /_activate did not answer its own result (#185): $act"; exit 1; }
read -r c1 booted1 live1 mib1 < <(ledger)
echo "deploy-flow: after /_runcron, /_activate and a page: status $c1, booted $booted0 -> $booted1, memLive $live1, retired $mib1 MiB"
[ "$c1" = 200 ] || { echo "deploy-flow: FAIL: the last page answered $c1"; exit 1; }
[ "$live1" = 1 ] || { echo "deploy-flow: VIOLATION: $live1 live memories after the deploy flow ($mib1 MiB retired)"; exit 1; }
[ "$booted1" = "$booted0" ] || { echo "deploy-flow: VIOLATION: the deploy flow booted $((booted1 - booted0)) more runtime(s) ($booted0 -> $booted1)"; exit 1; }
echo "deploy-flow: ok: one live memory, no extra boot, and /_activate answered its own result"
