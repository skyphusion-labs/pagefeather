#!/bin/bash
# #598 reproducer, as a CHARACTERIZATION test: it asserts the stacking IS present today.
#   tests/recycle-stack-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# On local workerd, dosql-local (PHP in the object, as on a site), PHP_RECYCLE off: an admin screen is recycled on
# purpose (x-runtime-recycle: force, spike-gated) and the very next admin request comes at once, as the 16:54Z
# login came after the fixture load. Today that request boots BESIDE the retired runtime, whose WebAssembly
# memory is still resident: the ledger in its x-perf reads memLive 2 or more and retiredMem 1 or more. That is
# #598 (wrangler dev does not enforce the 128 MiB isolate limit, so this shows the stacking, not the death).
# Exit 0 when the stacking is present. Exit 1 when it is not: the memory reuse of #603 has landed (or something
# else changed what a recycle leaves behind), and this test must then be flipped to assert ONE memory.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/recycle-stack.XXXXXX"); export PERSIST_TO=$STATE
J=$(mktemp "${TMPDIR:-/tmp}/recycle-stack-jar.XXXXXX"); H=$(mktemp "${TMPDIR:-/tmp}/recycle-stack-h.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$J" "$H"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off" ./run.sh _ping > /dev/null || { echo "recycle-stack: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "recycle-stack: /_install failed"; exit 1; }
req() { curl -s -c "$J" -b "$J" -o /dev/null -D "$H" -w '%{http_code}' "$@"; }
c=$(req "$B/wp-login.php"); [ "$c" = 200 ] || { echo "recycle-stack: wp-login.php answered $c"; exit 1; }
req --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php" > /dev/null
# the heavy admin screen, recycled on purpose after it answers
code=$(req "${ST[@]}" -H 'x-runtime-recycle: force' "$B/wp-admin/post-new.php")
grep -qi '^x-runtime-recycled:' "$H" || { echo "recycle-stack: the forced recycle was not done (status $code)"; exit 1; }
# the next admin request, at once
code=$(req "${ST[@]}" -H 'x-mem-ledger: 1' "$B/wp-admin/edit.php")
python3 -I - "$H" "$code" <<'PY'
import json, sys
hdr = {}
for line in open(sys.argv[1], errors="replace"):
    if ":" in line:
        k, v = line.split(":", 1)
        hdr[k.strip().lower()] = v.strip()
rt = ((json.loads(hdr.get("x-perf", "{}")).get("mem") or {}).get("runtimes") or {})
if sys.argv[2] != "200" or not rt:
    sys.exit("recycle-stack: edit.php answered %s with ledger %s: this check cannot see the runtimes" % (sys.argv[2], json.dumps(rt)))
print("recycle-stack: runtimes %s" % json.dumps(rt))
if rt.get("memLive", 0) >= 2 and rt.get("retiredMem", 0) >= 1:
    print("recycle-stack: characterized: the next boot ran BESIDE %s MiB of the retired runtime (memLive %s): #598 is present" % (rt.get("retiredMemMiB"), rt.get("memLive")))
    sys.exit(0)
sys.exit("recycle-stack: the stacking is GONE (memLive %s, retiredMem %s): has #603 landed? Flip this test to assert one memory" % (rt.get("memLive"), rt.get("retiredMem")))
PY
