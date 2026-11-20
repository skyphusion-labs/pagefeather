#!/bin/bash
# #836 (the lead's ruling, option 2): a deterministic refusal on a READ answers a non-retryable 500 that names it
# (x-sql-refused), never WordPress's plausible empty 200. A read MySQL would also fail (no such table) keeps wpdb's path.
#   tests/sql-refused-e2e.sh   (in spikes/b2-wordpress, after prepare.sh; it runs build.sh itself, twice)
# It builds WITH the fixture tests/fixtures/sql-refused/mu-plugins/pf836-refused-read.php, installs, and asks for three
# reads: refused (a long LIKE with a '%' inside: 500, x-sql-refused like-pattern, no Retry-After), short (the same
# shape under the cap: 200) and missing (no such table: 200 with WordPress's own error). Then WooCommerce through
# ordinary requests, where the 500 applies: activation (200, active) and create_pages with the cart option cleared
# (200, the same cart page found again, one cart page). Both run WooCommerce's 5 KB cart-page LIKE probe, which
# d1-dialect rewrites since #836 (a); without that rewrite they would answer the refusal 500. On exit it builds again
# WITHOUT the fixture. Not in CI's e2e loop: the fixture must never be in that build. Run it by hand.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8798} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/sql-refused.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"; ./build.sh > /dev/null 2>&1' EXIT
IMPORT_CONTENT="$PWD/tests/fixtures/sql-refused" IMPORT_MU_PLUGINS=pf836-refused-read.php ./build.sh > /dev/null 2>&1 || { echo "sql-refused: build with the fixture failed"; exit 1; }
DEV_LOCAL=1 ./run.sh _ping > /dev/null || { echo "sql-refused: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "sql-refused: /_install failed"; exit 1; }
fails=0
probe() { # shape -> "status refused retry-after"
  local h; h=$(mktemp "${TMPDIR:-/tmp}/sql-refused-h.XXXXXX")
  local code; code=$(curl -s -o /dev/null -D "$h" -w '%{http_code}' "${ST[@]}" -G --data-urlencode "pf836=$1" --data-urlencode "nocache=$RANDOM" "$B/")
  local ref; ref=$(awk -F': ' 'tolower($1)=="x-sql-refused"{gsub(/\r/,"",$2);print $2}' "$h")
  local ra; ra=$(awk -F': ' 'tolower($1)=="retry-after"{gsub(/\r/,"",$2);print $2}' "$h")
  rm -f "$h"
  echo "$code ${ref:--} ${ra:--}"
}
read -r c r a < <(probe refused); echo "sql-refused: refused read: status $c, x-sql-refused $r, retry-after $a"
[ "$c" = 500 ] && [ "$r" = like-pattern ] && [ "$a" = - ] || fails=1
read -r c r a < <(probe short); echo "sql-refused: short read: status $c, x-sql-refused $r"
[ "$c" = 200 ] && [ "$r" = - ] || fails=1
read -r c r a < <(probe missing); echo "sql-refused: missing-table read: status $c, x-sql-refused $r"
[ "$c" = 200 ] && [ "$r" = - ] || fails=1
woo() { # shape -> "status refused" and the JSON body in $WOO_BODY
  local h; h=$(mktemp "${TMPDIR:-/tmp}/sql-refused-h.XXXXXX")
  WOO_BODY=$(curl -s -D "$h" -w '\n%{http_code}' "${ST[@]}" -G --data-urlencode "pf836=$1" --data-urlencode "nocache=$RANDOM" "$B/")
  WOO_CODE=${WOO_BODY##*$'\n'}; WOO_BODY=${WOO_BODY%$'\n'*}
  WOO_REF=$(awk -F': ' 'tolower($1)=="x-sql-refused"{gsub(/\r/,"",$2);print $2}' "$h"); rm -f "$h"
}
woo activate-woo
act=$(python3 -I -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("active"))
except ValueError: print("not-json")' <<<"$WOO_BODY")
echo "sql-refused: WooCommerce activation: status $WOO_CODE, x-sql-refused ${WOO_REF:--}, active $act"
[ "$WOO_CODE" = 200 ] && [ -z "$WOO_REF" ] && [ "$act" = True ] || fails=1
woo create-pages
read -r before after carts < <(python3 -I -c 'import json,sys
try:
    d = json.loads(sys.stdin.read()); print(d.get("before"), d.get("after"), d.get("carts"))
except ValueError: print("x x x")' <<<"$WOO_BODY")
echo "sql-refused: create_pages with the cart option cleared: status $WOO_CODE, x-sql-refused ${WOO_REF:--}, cart page $before -> $after, cart pages $carts"
[ "$WOO_CODE" = 200 ] && [ -z "$WOO_REF" ] && [ "$before" -gt 0 ] 2>/dev/null && [ "$before" = "$after" ] && [ "$carts" = 1 ] || fails=1
[ "$fails" = 0 ] || { echo "sql-refused: FAIL"; exit 1; }
echo "sql-refused: ok: the refused read is a named 500; the others keep WordPress's answer"
