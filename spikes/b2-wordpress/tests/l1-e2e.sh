#!/bin/bash
# End-to-end check of #394 L1 (the OPcache boot pack out of module memory) on local wrangler dev,
# after a SPLIT build (build.sh, opcache.sh, file-trace.sh, opcache-split.py). Three runs:
#   1. the boot pack from the Assets binding: logged, pages and admin work;
#   2. the fallback (OPCACHE_BOOT_SOURCE=module): logged as a fallback, pages and admin work;
#   3. the split turned off (OPCACHE_SPLIT=off): no boot pack at all, pages still work (OPcache compiles).
# In every run, GET /_pf/<id>/<chunk> answers 404, with and without the spike token (#412: the
# packs hold the site's compiled PHP). Exits 1 on any failure.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
PW=local-spike-password
ID=$(python3 -c "import re,sys; m=re.search(r'\"id\": \"([^\"]+)\"', open('build/opcache-boot-index.js').read()); print(m.group(1) if m else '')")
[ -n "$ID" ] || { echo "FAIL build/opcache-boot-index.js has no split: run opcache-split.py first"; exit 1; }
CHUNK=$(python3 -c "import json,re; print(json.loads(re.search(r'\{.*\}', open('build/opcache-boot-index.js').read()).group(0))['chunks'][0])")
[ -s "build/public/_pf/$ID/$CHUNK" ] || { echo "FAIL build/public/_pf/$ID/$CHUNK is missing"; exit 1; }
bad=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; bad=1; fi; }
STATE=""
trap './run.sh --stop >/dev/null 2>&1; [ -n "$STATE" ] && rm -rf "$STATE"' EXIT
run_case() { # run_case <label> <DEV_VARS> <expected l1 log fragment or "none">
  local label=$1 vars=$2 want=$3
  ./run.sh --stop >/dev/null 2>&1; [ -n "$STATE" ] && rm -rf "$STATE"
  STATE=$(mktemp -d "${TMPDIR:-/tmp}/l1-e2e.XXXXXX"); export PERSIST_TO=$STATE
  DEV_LOCAL=1 DEV_VARS="$vars" ./run.sh _ping > /dev/null || { echo "FAIL $label: wrangler dev did not start"; bad=1; return; }
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null
  ./e2e.sh "$B" > "build/l1-e2e-$label.log" 2>&1; local e2e=$?
  ok "$label: e2e.sh (pages, login, admin, editor, REST write)" "$([ $e2e = 0 ] && echo 1 || echo 0)"
  B=$B ADMIN_PASSWORD=$PW python3 tests/woo.py > "build/l1-woo-$label.log" 2>&1; local woo=$?
  ok "$label: tests/woo.py (the store and a checkout)" "$([ $woo = 0 ] && echo 1 || echo 0)"
  # The boot's L1 state, from x-perf on a request that boots a NEW runtime (/_install drops it).
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
  local l1; l1=$(curl -s -D - -o /dev/null "${ST[@]}" "$B/?nocache=l1$RANDOM" | grep -i '^x-perf:' | python3 -c "import json,sys; l=sys.stdin.read(); d=json.loads(l.split(': ',1)[1]) if l else {}; print(str(d.get('boot'))+' '+str(d.get('l1')))")
  ok "$label: a booting request reports l1 '$want' (got: $l1)" "$([[ "$l1" == "1 $want"* ]] && echo 1 || echo 0)"
  local c1 c2
  c1=$(curl -s -o /dev/null -w '%{http_code}' "$B/_pf/$ID/$CHUNK")
  c2=$(curl -s -o /dev/null -w '%{http_code}' "${ST[@]}" "$B/_pf/$ID/$CHUNK")
  ok "$label: /_pf/ is never served (stranger $c1, with the spike token $c2)" "$([ "$c1" = 404 ] && [ "$c2" = 404 ] && echo 1 || echo 0)"
}
run_case assets "" 'assets'
run_case fallback "OPCACHE_BOOT_SOURCE:module" 'fallback:forced'
run_case off "OPCACHE_SPLIT:off" 'none:split-off'
exit $bad
