#!/bin/bash
# #661: a WooCommerce activation whose first attempt died mid-install must still end INSTALLED.
# tests/wc-install-lock-e2e.sh (in spikes/b2-wordpress, after prepare.sh; it runs build.sh itself, twice).
# On a deployed store, the first /_activate on a cold isolate can die of the memory reset (#198) after
# WC_Install::install() took its wc_installing lock. The lock stays (its release is a finally that a dead run never
# reaches), so deploy.sh's retry found it, install() returned WITHOUT installing, and WordPress still saved the plugin
# as active. Then every request failed the lock INSERT (x-d1-failures 1) and, with create_roles never run, every
# WooCommerce REST write answered 403 (#661; #791's control, 2026-11-17). The reset cannot happen under wrangler
# dev, so this plants the lock that attempt leaves (the fixture, tests/fixtures/wc-lock) and asserts:
#   1. /_activate answers active AND installed (true);
#   2. the stored state is a real install: woocommerce_version = WC_VERSION, no lock, the administrator holds
#      edit_products and manage_woocommerce, and the customer role exists;
#   3. a guest page fails no statement (x-d1-failures 0);
#   4. the fixture's gate: without the spike token, ?pf661=1 is an ordinary page.
# Red on main: active but not installed, no version, no caps, and every page fails statements.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
ST=(-H "x-spike-token: $TOK"); FX=(-H "x-spike-token: $TOK" -H "x-oc-off: 1")
STATE=$(mktemp -d "${TMPDIR:-/tmp}/wc-lock.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"; ./build.sh > /dev/null 2>&1' EXIT
IMPORT_CONTENT="$PWD/tests/fixtures/wc-lock" IMPORT_MU_PLUGINS=pf661-lock.php ./build.sh > /dev/null 2>&1 || { echo "wc-lock: build with the fixture failed"; exit 1; }
DEV_LOCAL=1 ./run.sh _ping > /dev/null || { echo "wc-lock: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "wc-lock: /_install failed"; exit 1; }
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
plant=$(curl -s "${FX[@]}" "$B/?pf661_plant=5")
ok "the fixture planted a fresh lock ($plant)" "$(grep -q '"planted":true' <<<"$plant" && echo 1 || echo 0)"
act=$(curl -s -X POST "${ST[@]}" "$B/_activate?plugin=woocommerce/woocommerce.php")
echo "  /_activate: $(python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); o=d.get("out",""); print(o[o.find("{\"active"):][:400])' "$act" 2>/dev/null || echo "${act:0:300}")"
ok "/_activate answers active" "$(grep -q '\\"active\\":true' <<<"$act" && echo 1 || echo 0)"
ok "/_activate answers installed" "$(grep -q '\\"installed\\":true' <<<"$act" && echo 1 || echo 0)"
st=$(curl -s "${FX[@]}" "$B/?pf661=1"); echo "  state: $st"
chk() { python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); print(1 if eval(sys.argv[2], {}, d) else 0)' "$st" "$1" 2>/dev/null || echo 0; }
ok "woocommerce_version is stored and equals WC_VERSION" "$(chk 'db_version is not None and db_version == code_version')"
ok "no wc_installing lock is left" "$(chk 'lock is None')"
ok "the administrator holds edit_products and manage_woocommerce" "$(chk 'edit_products and manage_woocommerce')"
ok "the customer role exists (create_roles ran)" "$(chk 'customer_role')"
h=$(curl -s -o /dev/null -D - "${ST[@]}" "$B/?pf661_guest=$RANDOM" | tr -d '\r')
f=$(grep -i '^x-d1-failures:' <<<"$h" | awk '{print $2}')
echo "  guest page: x-d1-failures ${f:-none} $(grep -i '^x-d1-first-failure:' <<<"$h" | cut -c1-200)"
ok "a guest page fails no statement" "$([ "${f:-0}" = 0 ] && echo 1 || echo 0)"
ok "without the spike token, ?pf661=1 is an ordinary page (the fixture's gate)" "$(curl -s -o /dev/null -w '%{content_type}' -H 'x-oc-off: 1' "$B/?pf661=1" | grep -qi 'text/html' && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
