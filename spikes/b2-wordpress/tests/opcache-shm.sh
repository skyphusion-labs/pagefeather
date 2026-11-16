#!/bin/bash
# #610: re-measure OPcache shared memory vs the file-cache fallback after #582 M2.
# opcache.sh's setup on an EMPTY OPcache: install, activate WooCommerce, e2e.sh, then
# read opcache_get_status() through /_mem and count file-cache .bin files from /_opcache-dump.
# Fallbacks = dump .bin files minus num_cached_scripts (the issue's 765 of 2,076 at 48).
# Usage (in spikes/b2-wordpress, after prepare.sh and build.sh):
#   tests/opcache-shm.sh <memory_consumption_mib> <out.json>
# Does not change the runtime default (48 in index.js). PHP_RECYCLE is off so one
# runtime holds the whole e2e, as opcache.sh primes.
set -u
mc=${1:?usage: tests/opcache-shm.sh <memory_consumption_mib> <out.json>}
out=${2:?usage: tests/opcache-shm.sh <memory_consumption_mib> <out.json>}
case "$mc" in *[!0-9]*) echo "opcache-shm: memory_consumption must be a whole number of MiB, not $mc"; exit 2;; esac
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=port.sh
. ./port.sh
# shellcheck disable=SC1091
. ./local-creds.sh
local_creds
python3 -c "import zipfile; zipfile.ZipFile('build/opcache.zip', 'w').close()"
rm -f build/opcache-boot.zip
echo 'export default null;' > build/opcache-boot-index.js
echo 'export default null;' > build/opcache-remote-index.js
echo 'export default null;' > build/site-remote-index.js
rm -rf build/public/_pf
STATE=$(mktemp -d "${TMPDIR:-/tmp}/opcache-shm-state.XXXXXX")
export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
ini=$(python3 -I -c 'import json,sys; print(json.dumps({"opcache.memory_consumption": sys.argv[1]}, separators=(",", ":")))' "$mc")
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off PHP_INI:$ini" ./run.sh _ping > /dev/null || { echo "opcache-shm: wrangler dev did not start"; tail -20 dev.log; exit 1; }
server_port || exit 1
B=http://localhost:$PORT
T=(-H "x-spike-token: ${SPIKE_TOKEN}")
PW=${ADMIN_PASSWORD}
curl -sf "${T[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "opcache-shm: /_install failed"; exit 1; }
curl -sf "${T[@]}" -X POST -H "x-admin-password: $PW" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null || { echo "opcache-shm: activating WooCommerce failed"; exit 1; }
e2e_start=$(date +%s)
./e2e.sh > build/opcache-shm-e2e.log 2>&1 || { echo "opcache-shm: e2e.sh failed; last lines:"; tail -15 build/opcache-shm-e2e.log; exit 1; }
e2e_s=$(( $(date +%s) - e2e_start ))
mkdir -p "$(dirname "$out")"
curl -sf "${T[@]}" -D build/opcache-shm.headers -o "${out}.mem" "$B/_mem" || { echo "opcache-shm: /_mem failed"; exit 1; }
curl -sf "${T[@]}" -o "${out}.dump.zip" "$B/_opcache-dump" || { echo "opcache-shm: /_opcache-dump failed"; exit 1; }
x_wasm=$(grep -i '^x-wasm-mib:' build/opcache-shm.headers | head -1 | tr -d '\r' | awk '{print $2}')
js=${PF_ENGINE_JS:-vendor/php_8_3.js}
wasm=${PF_ENGINE_WASM:-vendor/php_8_3.wasm}
js_sha=$(shasum -a 256 "$js" | awk '{print $1}')
wasm_sha=$(shasum -a 256 "$wasm" | awk '{print $1}')
commit=$(git rev-parse HEAD)
export OPCACHE_SHM_EXTRA
OPCACHE_SHM_EXTRA=$(python3 -I -c 'import json,sys; print(json.dumps({"e2e_s": int(sys.argv[1]), "x_wasm_mib": int(sys.argv[2]) if sys.argv[2] else None, "commit": sys.argv[3], "engine_js_sha256": sys.argv[4], "engine_wasm_sha256": sys.argv[5]}, separators=(",", ":")))' "$e2e_s" "${x_wasm:-}" "$commit" "$js_sha" "$wasm_sha")
python3 -I tests/opcache-shm.py "${out}.mem" "${out}.dump.zip" > "$out" || exit 1
python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("dump_bins") else 1)' "$out" || { echo "opcache-shm: dump zip held no .bin files"; exit 1; }
python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("opcache-shm: mc=%s cached=%s dump_bins=%s fallbacks=%s shm_used=%s MiB shm_free=%s MiB shm_full=%s wasm=%s MiB e2e_s=%s split=%s" % (r.get("mc"), r.get("cached"), r.get("dump_bins"), r.get("fallbacks"), r.get("shm_used_mib"), r.get("shm_free_mib"), r.get("shm_full"), r.get("wasm_mib"), r.get("e2e_s"), r.get("split_scripts")))' "$out"
