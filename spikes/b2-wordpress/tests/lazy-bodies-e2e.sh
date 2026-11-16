#!/bin/bash
# #582 S4 M2a: the lazy-body layout under a real compile workload. From an EMPTY OPcache (everything compiles
# during the requests, as opcache.sh primes), at the default memory_consumption 48, where WordPress and
# WooCommerce overflow shared memory and part of the scripts take the file-cache fallback: install, activate
# WooCommerce, run e2e.sh, then read opcache_get_status()'s pagefeather_lazy_bodies through /_mem.
# Gate: e2e.sh passes, split_scripts > 0, mismatch == 0 and noregion == 0. Usage (in spikes/b2-wordpress, after
# prepare.sh and build.sh): tests/lazy-bodies-e2e.sh <out.json>. Exit 1 on any failure, with the reason.
# LB_MC=<MiB> runs it at another memory_consumption: at the priming size (128) nothing falls back, and the
# line "split <n> of <cached> cached scripts" is the reading of how many scripts a primed zip holds split.
# LB_PRIMED=1 (#582 M2b stage 2): keep the PRIMED build/opcache.zip (run right after opcache.sh, no build.sh in
# between), so scripts load from it and their bodies load at first call. Runs e2e.sh and tests/woo.py, then gates
# body_fail == 0, lazy_scripts > 0 and body_loads > 0 as well. Then the M2c reading (printed, not gated): a new
# runtime, a login, and the FIRST post-new.php, with the body load time it spent (body_load_ns) against its wall
# time, and the fallback threshold of the design (#582 issuecomment-6889399893): 250 ms or 5%, whichever first.
set -u
out=${1:?out.json}
cd "$(dirname "$0")/.."
# shellcheck source=port.sh
. ./port.sh
if [ "${LB_PRIMED:-0}" = 1 ]; then
  python3 -I -c "import sys, zipfile; n = sum(1 for x in zipfile.ZipFile('build/opcache.zip').namelist() if x.endswith('.bin')); print('primed zip: %d .bin files' % n); sys.exit(0 if n else 1)" || { echo "lazy-bodies-e2e: LB_PRIMED=1 but build/opcache.zip holds no .bin (run opcache.sh first, with no build.sh after it)"; exit 1; }
else
  python3 -c "import zipfile; zipfile.ZipFile('build/opcache.zip', 'w').close()"
fi
rm -f build/opcache-boot.zip
echo 'export default null;' > build/opcache-boot-index.js
echo 'export default null;' > build/opcache-remote-index.js
echo 'export default null;' > build/site-remote-index.js
rm -rf build/public/_pf
STATE=$(mktemp -d "${TMPDIR:-/tmp}/lazy-bodies-state.XXXXXX")
export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
# LB_EAGER=1: the same engine with opcache.pagefeather_lazy_load=0 (the primed gate's red control: it must fail).
mc_vars=$(LB_MC=${LB_MC:-} LB_EAGER=${LB_EAGER:-0} python3 -I -c 'import json, os
ini = {}
if os.environ["LB_MC"]: ini["opcache.memory_consumption"] = os.environ["LB_MC"]
if os.environ["LB_EAGER"] == "1": ini["opcache.pagefeather_lazy_load"] = "0"
print("PHP_INI:" + json.dumps(ini, separators=(",", ":")) if ini else "")')
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off${mc_vars:+ $mc_vars}" ./run.sh _ping > /dev/null || { echo "lazy-bodies-e2e: wrangler dev did not start"; tail -20 dev.log; exit 1; }
server_port || exit 1
B=http://localhost:$PORT; T=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
curl -sf "${T[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "lazy-bodies-e2e: /_install failed"; exit 1; }
curl -sf "${T[@]}" -X POST -H "x-admin-password: $PW" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null || { echo "lazy-bodies-e2e: activating WooCommerce failed"; exit 1; }
./e2e.sh > build/lazy-bodies-e2e.log 2>&1 || { echo "lazy-bodies-e2e: e2e.sh failed; last lines:"; tail -15 build/lazy-bodies-e2e.log; exit 1; }
if [ "${LB_PRIMED:-0}" = 1 ]; then
  B=$B ADMIN_PASSWORD=$PW python3 tests/woo.py > build/lazy-bodies-woo.log 2>&1 || { echo "lazy-bodies-e2e: woo.py failed; last lines:"; tail -15 build/lazy-bodies-woo.log; exit 1; }
fi
curl -sf "${T[@]}" "$B/_mem" > "$out" || { echo "lazy-bodies-e2e: /_mem failed"; exit 1; }
python3 -I - "$out" <<'PY' || exit 1
import json, sys
m = json.load(open(sys.argv[1]))
ini = m.get("ini") or {}
lb = ini.get("lb")
print("lazy-bodies-e2e:", json.dumps({"lb": lb, "cached": ini.get("cached"), "mc": ini.get("mc"), "fco": ini.get("fco")}))
if not isinstance(lb, dict):
    sys.exit("lazy-bodies-e2e: opcache_get_status() has no pagefeather_lazy_bodies: not a lazy-body engine")
if lb.get("split_scripts", 0) <= 0:
    sys.exit("lazy-bodies-e2e: no script was persisted split (split_scripts %r)" % lb.get("split_scripts"))
if lb.get("dir_mismatch", 0) != 0:
    sys.exit("lazy-bodies-e2e: dir_mismatch %r: persist found a different number of bodies than calc" % lb.get("dir_mismatch"))
if "dir_entries" in lb and lb["dir_entries"] <= 0:
    sys.exit("lazy-bodies-e2e: dir_entries %r: no body directory was written" % lb.get("dir_entries"))
if lb.get("noregion") != 0:
    sys.exit("lazy-bodies-e2e: noregion %r: a body block was reached with no body region (left unsplit, never a bailout)" % lb.get("noregion"))
if lb.get("mismatch") != 0:
    sys.exit("lazy-bodies-e2e: %r head mismatches (%r overlapping): calc and persist disagree on the body region" % (lb.get("mismatch"), lb.get("overlap")))
if __import__("os").environ.get("LB_PRIMED") == "1":
    for k in ("lazy_scripts", "body_loads"):
        if lb.get(k, 0) <= 0:
            sys.exit("lazy-bodies-e2e: primed, but %s is %r: nothing loaded lazily (not a stage 2 engine, or the zip was not used)" % (k, lb.get(k)))
    if lb.get("body_fail") != 0:
        sys.exit("lazy-bodies-e2e: body_fail %r: a body did not load on a primed run (each is a request that threw)" % lb.get("body_fail"))
    print("lazy-bodies-e2e: primed: %d scripts lazy, %d whole (%d of them for a tail crossing), %d bodies loaded (%.2f MiB resident), body_fail 0, %.1f ms in body loads" % (lb["lazy_scripts"], lb.get("eager_scripts", 0), lb.get("xref_scripts", 0), lb["body_loads"], lb.get("body_bytes_resident", 0) / 2**20, lb.get("body_load_ns", 0) / 1e6))
print("lazy-bodies-e2e: ok at memory_consumption %s: split %d of %s cached scripts, %.2f MiB of bodies, %s directory entries, 0 mismatches" % (ini.get("mc"), lb["split_scripts"], ini.get("cached"), lb["body_bytes"] / 2**20, lb.get("dir_entries")))
PY
[ "${LB_PRIMED:-0}" = 1 ] || exit 0
# The M2c reading: a NEW runtime (the site stays: same PERSIST_TO), a login, then the first post-new.php.
./run.sh --stop > /dev/null 2>&1
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off${mc_vars:+ $mc_vars}" ./run.sh _ping > /dev/null || { echo "lazy-bodies-e2e: wrangler dev did not restart for the M2c reading"; exit 1; }
server_port || exit 1
B=http://localhost:$PORT
J=$(mktemp "${TMPDIR:-/tmp}/lazy-bodies-jar.XXXXXX")
curl -s -c "$J" -b "$J" -o /dev/null "$B/wp-login.php"
curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php"
curl -sf "${T[@]}" "$B/_mem" > "$out.m2c-a" || { echo "lazy-bodies-e2e: /_mem before post-new.php failed"; exit 1; }
wall=$(curl -s -c "$J" -b "$J" -o /dev/null -w '%{http_code} %{time_total}' "$B/wp-admin/post-new.php")
curl -sf "${T[@]}" "$B/_mem" > "$out.m2c-b" || { echo "lazy-bodies-e2e: /_mem after post-new.php failed"; exit 1; }
rm -f "$J"
python3 -I - "$out" "$wall" <<'PY'
import json, sys
out, (code, wall) = sys.argv[1], sys.argv[2].split()
a, b = (json.load(open(out + s))["ini"]["lb"] for s in (".m2c-a", ".m2c-b"))
ns = b.get("body_load_ns", 0) - a.get("body_load_ns", 0)
loads = b.get("body_loads", 0) - a.get("body_loads", 0)
wall_ms = float(wall) * 1000
share = ns / 1e6 / wall_ms if wall_ms else 0
trig = ns / 1e6 > 250 or share > 0.05
r = {"status": int(code), "wall_ms": round(wall_ms, 1), "body_load_ms": round(ns / 1e6, 2), "share": round(share, 4), "body_loads": loads,
     "body_bytes": b.get("body_bytes_loaded", 0) - a.get("body_bytes_loaded", 0), "fallback_triggered": trig}
print("@event m2c-first-post-new " + json.dumps(r))
print("lazy-bodies-e2e: M2c reading (local wrangler dev, not the live site): the first post-new.php after a boot spent %.1f ms in %d body loads, %.2f%% of its %.0f ms; threshold 250 ms or 5%%: fallback %s" % (ns / 1e6, loads, share * 100, wall_ms, "TRIGGERED" if trig else "not triggered"))
if int(code) != 200:
    sys.exit("lazy-bodies-e2e: post-new.php answered %s for the M2c reading (the login did not hold?)" % code)
PY
