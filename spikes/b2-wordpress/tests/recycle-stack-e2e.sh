#!/bin/bash
# #598 reproducer on local workerd: after a runtime recycle, the next boot must not run beside the retired runtime.
#   tests/recycle-stack-e2e.sh                     (in spikes/b2-wordpress, after prepare.sh and build.sh)
#   REUSE=off GATE=off tests/recycle-stack-e2e.sh  the red: today's stacking (memLive 2), exit 1
# dosql-local (PHP in the object, as on a site), PHP_RECYCLE off, PHP_MEMORY_REUSE=${REUSE:-on}, BOOT_GATE=${GATE:-on}.
# An admin screen is recycled on purpose (x-runtime-recycle: force, spike-gated) and the very next admin request
# comes at once, as the 16:54Z login came after the fixture load. Twice. Each time that request must answer 200
# with ONE live WebAssembly.Memory in the isolate (the ledger in its x-perf: runtimes.memLive 1, retiredMem 0)
# and a memory taken for reuse (memReuse.taken grew). A 503 fails too: with a spare the size check must not refuse.
# Before the recycles, the deploy flow: /_install, a page, then /_activate (WooCommerce), which drops the runtime and
# boots a fresh one INSIDE its own request (#705 review, findings 1 and 2). /_activate must answer 200 (the gate must
# not refuse it), and the next request must see ONE live memory (the old one must not be kept beside the new one).
# Caveat: wrangler dev does not enforce the 128 MiB isolate limit, so this checks the invariant, not the death.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/recycle-stack.XXXXXX"); export PERSIST_TO=$STATE
J=$(mktemp "${TMPDIR:-/tmp}/recycle-stack-jar.XXXXXX"); H=$(mktemp "${TMPDIR:-/tmp}/recycle-stack-h.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$J" "$H"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off PHP_MEMORY_REUSE:${REUSE:-on} BOOT_GATE:${GATE:-on}" ./run.sh _ping > /dev/null || { echo "recycle-stack: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "recycle-stack: /_install failed"; exit 1; }
req() { curl -s -c "$J" -b "$J" -o /dev/null -D "$H" -w '%{http_code}' "$@"; }
# a page first, so a runtime is CURRENT when /_activate drops and reboots inside its own request
c=$(req "$B/wp-login.php"); [ "$c" = 200 ] || { echo "recycle-stack: deploy flow: wp-login.php answered $c"; exit 1; }
c=$(req "${ST[@]}" -X POST "$B/_activate?plugin=woocommerce/woocommerce.php")
[ "$c" = 200 ] || { echo "recycle-stack: deploy flow: /_activate after /_install answered $c ($(grep -i '^x-runtime-wait' "$H" | tr -d '\r' | tr '\n' ' '))"; exit 1; }
c=$(req "${ST[@]}" -H 'x-mem-ledger: 1' "$B/wp-login.php")
python3 -I - "$H" "$c" <<'PY2' || exit 1
import json, sys
hdr = {}
for line in open(sys.argv[1], errors="replace"):
    if ":" in line:
        k, v = line.split(":", 1); hdr[k.strip().lower()] = v.strip()
rt = ((json.loads(hdr.get("x-perf", "{}")).get("mem") or {}).get("runtimes") or {})
if sys.argv[2] != "200" or not rt:
    sys.exit("recycle-stack: deploy flow: wp-login.php answered %s with ledger %s" % (sys.argv[2], json.dumps(rt)))
print("recycle-stack: deploy flow: runtimes %s" % json.dumps(rt), file=sys.stderr)
if rt.get("memLive") != 1:
    sys.exit("recycle-stack: deploy flow: VIOLATION: %s live memories after /_install and /_activate (%s MiB retired)" % (rt.get("memLive"), rt.get("retiredMemMiB")))
PY2
c=$(req "$B/wp-login.php"); [ "$c" = 200 ] || { echo "recycle-stack: wp-login.php answered $c"; exit 1; }
req --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php" > /dev/null
# The check of one round (prints the new memReuse.taken on stdout)
read -r -d '' CHECK <<'PY'
import json, sys
h, code, rnd, taken0 = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
hdr = {}
for line in open(h, errors="replace"):
    if ":" in line:
        k, v = line.split(":", 1)
        hdr[k.strip().lower()] = v.strip()
tag = "recycle-stack: round %s:" % rnd
if code == 503 and hdr.get("x-runtime-wait") == "retired-resident":
    sys.exit("%s REFUSED: 503 x-runtime-wait retired-resident, %s MiB retired (a spare must be reused, not refused)" % (tag, hdr.get("x-runtime-wait-mib")))
perf = json.loads(hdr.get("x-perf", "{}"))
mem = perf.get("mem") or {}
rt, mr = mem.get("runtimes") or {}, mem.get("memReuse") or {}
if not rt:
    sys.exit("%s no ledger in x-perf (status %d): this check cannot see the runtimes" % (tag, code))
print("%s status %d, runtimes %s, memReuse %s" % (tag, code, json.dumps(rt), json.dumps(mr)), file=sys.stderr)
if code != 200:
    sys.exit("%s status %d, not 200" % (tag, code))
if rt.get("retiredMem", 0) > 0 or rt.get("memLive", 0) != 1:
    sys.exit("%s VIOLATION: the request booted beside %s MiB of a retired runtime still resident (memLive %s)" % (tag, rt.get("retiredMemMiB"), rt.get("memLive")))
taken = int(mr.get("taken", 0))
if taken <= taken0:
    sys.exit("%s no memory was taken for reuse (taken %d, before %d)" % (tag, taken, taken0))
print("%s ok: ONE memory, reused (taken %d)" % (tag, taken), file=sys.stderr)
print(taken)
PY
taken0=0
for round in 1 2; do
  # the heavy admin screen, recycled on purpose after it answers
  code=$(req "${ST[@]}" -H 'x-runtime-recycle: force' "$B/wp-admin/post-new.php")
  grep -qi '^x-runtime-recycled:' "$H" || { echo "recycle-stack: round $round: the forced recycle was not done (status $code)"; exit 1; }
  # the next admin request, at once
  code=$(req "${ST[@]}" -H 'x-mem-ledger: 1' "$B/wp-admin/edit.php")
  taken0=$(python3 -I -c "$CHECK" "$H" "$code" "$round" "$taken0") || exit 1
done
echo "recycle-stack: ok: two recycles, one memory each time, no retired memory resident"
