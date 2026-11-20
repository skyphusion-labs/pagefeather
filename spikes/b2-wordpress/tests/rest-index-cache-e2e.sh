#!/bin/bash
# #1020: GET /wp-json/ (the bare REST index) answered from a stored copy (php/rest-index-cache.php). Proves, on WordPress
# in local workerd with WooCommerce active:
#   - a guest hit skips WooCommerce's routes (X-PF-WC-Routes: deferred); every hit's body is BYTE-IDENTICAL to that user's miss,
#     for a guest and for an admin (application password); the guest never gets the admin's copy (the index is per user);
#   - wrong credentials still get WordPress's 401, never the stored 200;
#   - a plugin activate misses, then hits; after the deactivate the first key (and body) comes back;
#   - the fresh-boot heap (x-wasm-mib) of a hit against a miss.
#   tests/rest-index-cache-e2e.sh   (in spikes/b2-wordpress, after prepare.sh; it runs build.sh itself, twice)
# Builds WITH tests/fixtures/rest-index/mu-plugins/pf1020-app-password.php (test builds only). Run it by hand.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8796} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/rest-index.XXXXXX"); export PERSIST_TO=$STATE
OUT=$(mktemp -d "${TMPDIR:-/tmp}/rest-index-out.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$OUT"; ./build.sh > /dev/null 2>&1' EXIT
IMPORT_CONTENT="$PWD/tests/fixtures/rest-index" IMPORT_MU_PLUGINS=pf1020-app-password.php ./build.sh > /dev/null 2>&1 || { echo "rest-index: build with the fixture failed"; exit 1; }
DEV_LOCAL=1 ./run.sh _ping > /dev/null || { echo "rest-index: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "rest-index: /_install failed"; exit 1; }
curl -sf "${ST[@]}" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null || { echo "rest-index: WooCommerce activation failed"; exit 1; }
APW=$(curl -s "${ST[@]}" "$B/?pf1020=app-password" | python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read())["password"] or "")')
[ -n "$APW" ] || { echo "rest-index: no application password"; exit 1; }
fails=0
n=0
# get <label> [curl args...]: GET /wp-json/ on a FRESH runtime; prints "status routes wasm" and keeps the body as $OUT/<label>
get() {
  local label=$1; shift
  curl -s -m 180 -o /dev/null "${ST[@]}" -H "x-runtime-recycle: force" "$B/?nocache=$RANDOM"
  local h="$OUT/$label.h"
  local code; code=$(curl -s -m 180 -o "$OUT/$label" -D "$h" -w '%{http_code}' "$@" "$B/wp-json/")
  local routes; routes=$(awk -F': ' 'tolower($1)=="x-pf-wc-routes"{gsub(/\r/,"",$2);print $2}' "$h")
  local idx; idx=$(awk -F': ' 'tolower($1)=="x-pf-rest-index"{gsub(/\r/,"",$2);print $2}' "$h")
  local wasm; wasm=$(awk -F': ' 'tolower($1)=="x-wasm-mib"{gsub(/\r/,"",$2);print $2}' "$h")
  echo "${code}|${idx:--}|${wasm:--}|${routes:--}"
}
same() {
  cmp -s "$OUT/$1" "$OUT/$2" && return 0
  python3 -I - "$OUT/$1" "$OUT/$2" <<'PYD'
import json, sys
a, b = (json.load(open(f)) for f in sys.argv[1:3])
for k in sorted(set(a) | set(b)):
    if a.get(k) != b.get(k):
        if isinstance(a.get(k), dict) and isinstance(b.get(k), dict):
            ks = sorted(set(a[k]) ^ set(b[k]))[:8] or [x for x in a[k] if a[k].get(x) != b[k].get(x)][:8]
            print("rest-index:   differs at", k, ks)
        else:
            print("rest-index:   differs at", k, str(a.get(k))[:120], "|", str(b.get(k))[:120])
PYD
  return 1
}
want() { # label got expected-status expected-index (hit, miss, or - for none)
  IFS='|' read -r c x w r <<<"$2"
  echo "rest-index: $1: status $c, index ${x}, wasm ${w} MiB, WooCommerce routes ${r}"
  [ "$c" = "$3" ] && [ "$x" = "$4" ] || { echo "rest-index: FAIL $1: wanted $3 and index $4"; fails=1; }
}
AUTH=(-u "admin:$APW")
# The index is PER USER (an admin's has image_sizes and the active theme link), so each user is checked against its own miss.
want "admin, first, EAGER (x-pf-wc-defer: off; miss)" "$(get e0 "${AUTH[@]}" "${ST[@]}" -H "x-pf-wc-defer: off")" 200 miss
cp "$OUT/e0" "$OUT/a0"

want "admin again (hit)" "$(get a0b "${AUTH[@]}")" 200 hit
same a0 a0b && echo "rest-index: admin hit is byte-identical to the admin miss" || { echo "rest-index: FAIL admin hit differs from admin miss"; fails=1; }
want "guest, first (miss: never the admin copy)" "$(get g0)" 200 miss
want "guest again (hit)" "$(get g0b)" 200 hit
same g0 g0b && echo "rest-index: guest hit is byte-identical to the guest miss" || { echo "rest-index: FAIL guest hit differs from guest miss"; fails=1; }
grep -q '"image_sizes"' "$OUT/a0" && ! grep -q '"image_sizes"' "$OUT/g0b" && echo "rest-index: the guest copy has no admin-only field (image_sizes)" || { echo "rest-index: FAIL admin-only field check"; fails=1; }
want "wrong credentials" "$(get bad -u admin:wrongwrongwrongwrongwrong)" 401 -
grep -q '"code":"incorrect_password"' "$OUT/bad" && echo "rest-index: wrong credentials get WordPress's own incorrect_password error" || { echo "rest-index: FAIL wrong credentials body"; head -c 200 "$OUT/bad"; fails=1; }
curl -s "${ST[@]}" "$B/?pf1020=activate-hello" > /dev/null
want "guest after a plugin activate (miss)" "$(get g1)" 200 miss
want "guest again (hit)" "$(get g1b)" 200 hit
same g1 g1b && echo "rest-index: guest hit after the activate is byte-identical to its miss" || { echo "rest-index: FAIL guest hit after activate differs"; fails=1; }
want "admin after the activate (miss: credentials, so eager)" "$(get a1 "${AUTH[@]}")" 200 miss
same a1 e0 && echo "rest-index: the admin miss is byte-identical to the eager admin index" || { echo "rest-index: FAIL admin miss differs from eager"; fails=1; }
want "admin again (hit)" "$(get a1b "${AUTH[@]}")" 200 hit
curl -s "${ST[@]}" "$B/?pf1020=deactivate-hello" > /dev/null
want "guest after a plugin deactivate (hit: the first guest copy's key again)" "$(get g2)" 200 hit
same g2 g0 && echo "rest-index: after the deactivate the guest index is the first one again" || { echo "rest-index: FAIL guest index after deactivate differs from the first"; fails=1; }
[ "$fails" = 0 ] || { echo "rest-index: FAIL"; exit 1; }
echo "rest-index: ok: hits skip WooCommerce routes, match the miss byte for byte for guest and admin, and plugin changes miss"
