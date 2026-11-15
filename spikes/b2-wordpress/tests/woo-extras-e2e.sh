#!/bin/bash
# #667 on local workerd: WOO_EXTRAS unset, then off, each on a fresh dosql-local state.
# Same path as tests/frames-e2e.sh (run.sh, _install, activate WooCommerce) and the
# store calls in tests/woo.py (tests/woo_extras.py).
#   unset: the order-attribution script, the checkout meta and the four option
#          defaults are WooCommerce's own.
#   off:   no order-attribution script tag, no _wc_order_attribution_* meta, and
#          the four options read "no". Analytics stays yes.
# Prints one line per check. Exits 1 on any failure.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8817} DEV_ENV=${DEV_ENV:-dosql-local}
export SPIKE_TOKEN=${SPIKE_TOKEN:-local-spike-token}
export DEV_WAIT_S=${DEV_WAIT_S:-240}
B=http://localhost:$PORT
PW=${ADMIN_PASSWORD:-local-spike-password}
ST=(-H "x-spike-token: $SPIKE_TOKEN")
bad=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; bad=1; fi; }
STATE=""
trap './run.sh --stop >/dev/null 2>&1; [ -n "$STATE" ] && rm -rf "$STATE"' EXIT
for mode in unset off; do
  ./run.sh --stop >/dev/null 2>&1
  [ -n "$STATE" ] && rm -rf "$STATE"
  STATE=$(mktemp -d "${TMPDIR:-/tmp}/woo-extras-e2e.XXXXXX")
  export PERSIST_TO=$STATE
  vars=""
  [ "$mode" = off ] && vars="WOO_EXTRAS:off"
  DEV_LOCAL=1 DEV_VARS="$vars" ./run.sh _ping > /dev/null || { echo "FAIL $mode: wrangler dev did not start"; bad=1; continue; }
  inst=$(curl -s -m 300 "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install")
  ok "$mode: install" "$(printf '%s' "$inst" | grep -q installed && echo 1 || echo 0)"
  act=$(curl -s -m 180 "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_activate?plugin=woocommerce/woocommerce.php")
  # The Worker wraps PHP's JSON in {"out":"..."}, so the quotes are escaped.
  ok "$mode: activate WooCommerce" "$(printf '%s' "$act" | grep -q '\\"active\\":true' && echo 1 || echo 0)"
  WOO_EXTRAS_EXPECT=$mode B=$B ADMIN_PASSWORD=$PW SPIKE_TOKEN=$SPIKE_TOKEN python3 tests/woo_extras.py > "build/woo-extras-$mode.log" 2>&1
  w=$?
  ok "$mode: tests/woo_extras.py" "$([ $w = 0 ] && echo 1 || echo 0)"
  tail -20 "build/woo-extras-$mode.log" | sed "s/^/  $mode | /"
done
echo "$bad failing mode(s)"
exit $bad
