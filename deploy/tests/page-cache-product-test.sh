#!/usr/bin/env bash
# deploy.sh PAGE_CACHE_PRODUCT_TTL (#706) for variants b-do, b-dosql and a.
# A store (WOO_ACTIVE=1) renders 30 with no flag. A non-store renders nothing.
# An integer from 5 to 600 wins. Anything else is refused before any step.
# The rendered line comes from the same function the one-click paths use
# (deploy/provision/wp-site-config.mjs, through a-vars-toml.mjs).
# Run: bash deploy/tests/page-cache-product-test.sh
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/page-cache-product.XXXXXX")
trap 'rm -rf "$T"' EXIT
APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE="$T/fence"; fence_dir "$FENCE"

# render <variant> <out> [VAR=value ...]: deploy.sh's config, no Terraform. PLACEMENT is set because #1054 requires it
# for variant a with an external MySQL; this test is about the page cache TTL, not placement.
render() {
  local variant=$1 dst=$2; shift 2
  # shellcheck disable=SC2016
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pf706 VARIANT="$variant" LOCATION=enam \
    SITE_ORIGIN=https://pf706.example.workers.dev BUCKET= AI=0 \
    PLACEMENT=aws:us-east-2 \
    "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { case "$1" in
        hyperdrive_id) echo HD ;; oc_kv_id) echo OC ;; d1_name) echo D1N ;; d1_id) echo D1I ;;
        *) echo "out: no stub for $1" >&2; return 1 ;;
      esac; }
      cd "$APP" && render_conf' > "$dst" 2> "$T/render.err"
}
count() { grep -cx "$2" "$1" || true; }
has30() { [ "$(count "$1" 'PAGE_CACHE_PRODUCT_TTL = "30"')" = 1 ]; }
has60() { [ "$(count "$1" 'PAGE_CACHE_PRODUCT_TTL = "60"')" = 1 ]; }
none() { ! grep -q PAGE_CACHE_PRODUCT_TTL "$1"; }

echo "1. the render, per variant"
for v in b-do b-dosql a; do
  render "$v" "$T/$v-store.toml" WOO_ACTIVE=1; rc=$?
  ok "$v: a store renders 30 with no flag (rc $rc)" "$([ $rc = 0 ] && has30 "$T/$v-store.toml" && echo 1 || echo 0)"
  render "$v" "$T/$v-plain.toml"; rc=$?
  ok "$v: a non-store renders nothing (rc $rc)" "$([ $rc = 0 ] && none "$T/$v-plain.toml" && echo 1 || echo 0)"
  render "$v" "$T/$v-over.toml" WOO_ACTIVE=1 PAGE_CACHE_PRODUCT_TTL=60; rc=$?
  ok "$v: the override wins (rc $rc)" "$([ $rc = 0 ] && has60 "$T/$v-over.toml" && echo 1 || echo 0)"
done
render a "$T/a-non.toml" PAGE_CACHE_PRODUCT_TTL=45; rc=$?
ok "a: the override renders on a non-store (rc $rc)" "$([ $rc = 0 ] && [ "$(count "$T/a-non.toml" 'PAGE_CACHE_PRODUCT_TTL = "45"')" = 1 ] && echo 1 || echo 0)"
render a "$T/a-zero.toml" PAGE_CACHE_PRODUCT_TTL=030; rc=$?
ok "a: a leading zero is decimal 30 (rc $rc)" "$([ $rc = 0 ] && has30 "$T/a-zero.toml" && echo 1 || echo 0)"

echo "2. a bad value is refused before any step"
for v in b-do b-dosql a; do
  for bad in 0 4 601 abc 30s -5; do
    refuse "PAGE_CACHE_PRODUCT_TTL must be an integer from 5 to 600" VARIANT="$v" WOO_ACTIVE=1 "PAGE_CACHE_PRODUCT_TTL=$bad"
  done
  refuse "WOO_ACTIVE must be 0 or 1" VARIANT="$v" WOO_ACTIVE=yes
done

echo "$fails failing case(s)"
[ "$fails" = 0 ]
