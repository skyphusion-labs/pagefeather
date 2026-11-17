#!/usr/bin/env bash
# #610: a STORE renders OPCACHE_MC = "64" (the runtime's OPcache size), every other site renders nothing (48), on every
# b-dosql deploy path: deploy.sh (render_conf, through a-vars-toml.mjs opcache-mc), deploy/wfp (render_user), and
# one-click (wp-site-config.mjs, the same rule as PAGE_CACHE_PRODUCT_TTL's store test). Approach A renders nothing
# (not measured; its PHP runs in the Worker). An explicit PHP_INI still wins in the runtime (opcache-size.test.mjs).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/opcache-store-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)
line='OPCACHE_MC = "64"'
rc_() { # rc_ <variant> [VAR=value ...]: deploy.sh's config
  local v=$1; shift
  # shellcheck disable=SC2016
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pf-render VARIANT="$v" LOCATION=wnam \
    SITE_ORIGIN=https://pf-render.example.workers.dev BUCKET=MEDIA_BUCKET AI=0 "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { echo "STUB_$1"; }
      cd "$APP" && render_conf' 2> "$T/rc.err"
}
has() { grep -cxF "$line" | tr -d " "; }
echo "1. deploy.sh (render_conf)"
ok "b-dosql store (WOO_ACTIVE=1): the line, once" "$([ "$(rc_ b-dosql WOO_ACTIVE=1 | has)" = 1 ] && echo 1 || echo 0)"
ok "b-dosql store by PLUGINS: the line" "$([ "$(rc_ b-dosql PLUGINS=woocommerce | has)" = 1 ] && echo 1 || echo 0)"
ok "b-dosql plain: nothing" "$([ "$(rc_ b-dosql | has)" = 0 ] && echo 1 || echo 0)"
ok "b-dosql WOO_ACTIVE=0 with woocommerce in PLUGINS: nothing" "$([ "$(rc_ b-dosql WOO_ACTIVE=0 PLUGINS=woocommerce | has)" = 0 ] && echo 1 || echo 0)"
ok "approach a store: nothing (not measured)" "$([ "$(rc_ a WOO_ACTIVE=1 PLACEMENT=aws:us-west-2 | grep -c OPCACHE_MC | tr -d ' ')" = 0 ] && echo 1 || echo 0)"
echo "2. deploy/wfp (render_user)"
ru() { env -i PATH="$PATH" HOME="$T" "$@" bash -c ". '$ROOT/deploy/wfp/lib.sh' >/dev/null 2>&1; render_user one https://wp-one.sub.workers.dev" 2> "$T/ru.err"; }
ok "a store: the line, once" "$([ "$(ru WOO_ACTIVE=1 | has)" = 1 ] && echo 1 || echo 0)"
ok "a store by IMPORT_PLUGINS: the line" "$([ "$(ru IMPORT_PLUGINS='woocommerce akismet' | has)" = 1 ] && echo 1 || echo 0)"
ok "plain: nothing" "$([ "$(ru | grep -c OPCACHE_MC | tr -d ' ')" = 0 ] && echo 1 || echo 0)"
echo "3. one-click (wp-site-config.mjs)"
r=$(node --input-type=module -e "
import { bDosqlVars, opcacheStoreMc } from '$ROOT/deploy/provision/wp-site-config.mjs';
const v = (o) => { const x = bDosqlVars({ siteOrigin: 'https://x.example', ...o }).find((b) => b.name === 'OPCACHE_MC'); return x ? x.text : 'none'; };
console.log([opcacheStoreMc({ wooActive: '1' }), opcacheStoreMc({}), opcacheStoreMc({ store: true }), opcacheStoreMc({ wooActive: '0', store: true }), v({ wooActive: '1' }), v({}), v({ store: true })].map((x) => (x === null ? 'null' : x)).join(' '));
" 2>&1)
ok "the rule: store 64, plain none, store flag 64, WOO_ACTIVE=0 wins; bDosqlVars store 64, plain none, flag 64 ($r)" "$([ "$r" = '64 null 64 null 64 none 64' ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
