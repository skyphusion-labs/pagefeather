#!/bin/bash
# #582 S4 M2a: the lazy-body layout under a real compile workload. From an EMPTY OPcache (everything compiles
# during the requests, as opcache.sh primes), at the default memory_consumption 48, where WordPress and
# WooCommerce overflow shared memory and part of the scripts take the file-cache fallback: install, activate
# WooCommerce, run e2e.sh, then read opcache_get_status()'s pagefeather_lazy_bodies through /_mem.
# Gate: e2e.sh passes, split_scripts > 0 and mismatch == 0. Usage (in spikes/b2-wordpress, after
# prepare.sh and build.sh): tests/lazy-bodies-e2e.sh <out.json>. Exit 1 on any failure, with the reason.
# LB_MC=<MiB> runs it at another memory_consumption: at the priming size (128) nothing falls back, and the
# line "split <n> of <cached> cached scripts" is the reading of how many scripts a primed zip holds split.
set -u
out=${1:?out.json}
cd "$(dirname "$0")/.."
python3 -c "import zipfile; zipfile.ZipFile('build/opcache.zip', 'w').close()"
rm -f build/opcache-boot.zip
echo 'export default null;' > build/opcache-boot-index.js
echo 'export default null;' > build/opcache-remote-index.js
echo 'export default null;' > build/site-remote-index.js
rm -rf build/public/_pf
STATE=$(mktemp -d "${TMPDIR:-/tmp}/lazy-bodies-state.XXXXXX")
export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
mc_vars=""; [ -z "${LB_MC:-}" ] || mc_vars="PHP_INI:{\"opcache.memory_consumption\":\"$LB_MC\"}"
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off${mc_vars:+ $mc_vars}" ./run.sh _ping > /dev/null || { echo "lazy-bodies-e2e: wrangler dev did not start"; tail -20 dev.log; exit 1; }
B=http://localhost:${PORT:-8797}; T=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
curl -sf "${T[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "lazy-bodies-e2e: /_install failed"; exit 1; }
curl -sf "${T[@]}" -X POST -H "x-admin-password: $PW" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null || { echo "lazy-bodies-e2e: activating WooCommerce failed"; exit 1; }
./e2e.sh > build/lazy-bodies-e2e.log 2>&1 || { echo "lazy-bodies-e2e: e2e.sh failed; last lines:"; tail -15 build/lazy-bodies-e2e.log; exit 1; }
curl -sf "${T[@]}" "$B/_mem" > "$out" || { echo "lazy-bodies-e2e: /_mem failed"; exit 1; }
python3 -I - "$out" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
ini = m.get("ini") or {}
lb = ini.get("lb")
print("lazy-bodies-e2e:", json.dumps({"lb": lb, "cached": ini.get("cached"), "mc": ini.get("mc"), "fco": ini.get("fco")}))
if not isinstance(lb, dict):
    sys.exit("lazy-bodies-e2e: opcache_get_status() has no pagefeather_lazy_bodies: not a lazy-body engine")
if lb.get("split_scripts", 0) <= 0:
    sys.exit("lazy-bodies-e2e: no script was persisted split (split_scripts %r)" % lb.get("split_scripts"))
if lb.get("mismatch") != 0:
    sys.exit("lazy-bodies-e2e: %r head mismatches (%r overlapping): calc and persist disagree on the body region" % (lb.get("mismatch"), lb.get("overlap")))
print("lazy-bodies-e2e: ok at memory_consumption %s: split %d of %s cached scripts, %.2f MiB of bodies, 0 mismatches" % (ini.get("mc"), lb["split_scripts"], ini.get("cached"), lb["body_bytes"] / 2**20))
PY
