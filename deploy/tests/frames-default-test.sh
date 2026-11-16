#!/usr/bin/env bash
# #589 part 1 (the lead's ruling after run8, 2026-11-16): REQUEST_FRAMES is ON by default for b-dosql on the
# deploy.sh path. deploy.sh refuses a bad value, and REQUEST_FRAMES on another variant (only b-dosql has the
# object-SQLite undo log), before any step. render-conf.sh renders on by default, off when set.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/frames-default-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE="$T/fence"; fence_dir "$FENCE"
APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)
render() { # render <variant> [VAR=value ...]: the [vars] REQUEST_FRAMES line of deploy.sh's config, or "none"
  local v=$1; shift
  # shellcheck disable=SC2016
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pff-render VARIANT="$v" LOCATION=enam \
    SITE_ORIGIN=https://pff-render.example.workers.dev BUCKET=MEDIA_BUCKET AI=0 PLACEMENT=aws:us-west-2 "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { case "$1" in hyperdrive_id) echo HYPERDRIVE_ID ;; oc_kv_id) echo OC_KV_ID ;; d1_name) echo D1 ;; d1_id) echo D1ID ;; *) echo "out-$1" ;; esac; }
      cd "$APP" && render_conf' > "$T/r.toml" 2> "$T/r.err" || { echo "render-failed"; return; }
  grep -E '^REQUEST_FRAMES = ' "$T/r.toml" || echo none
}
echo "1. render-conf.sh"
ok "b-dosql, unset: REQUEST_FRAMES = \"on\" (the default)" "$([ "$(render b-dosql)" = 'REQUEST_FRAMES = "on"' ] && echo 1 || echo 0)"
ok "b-dosql, REQUEST_FRAMES=off: rendered off (the escape hatch)" "$([ "$(render b-dosql REQUEST_FRAMES=off)" = 'REQUEST_FRAMES = "off"' ] && echo 1 || echo 0)"
ok "b-dosql, REQUEST_FRAMES=on: rendered on" "$([ "$(render b-dosql REQUEST_FRAMES=on)" = 'REQUEST_FRAMES = "on"' ] && echo 1 || echo 0)"
ok "it sits in [vars], before the first table (with DB_IN_DO)" "$(render b-dosql >/dev/null; awk '/^\[/{exit} /^REQUEST_FRAMES = /{f=1} END{exit !f}' "$T/r.toml" && echo 1 || echo 0)"
for v in b-do a; do ok "variant $v: no REQUEST_FRAMES line (no object-SQLite undo log)" "$([ "$(render $v)" = none ] && echo 1 || echo 0)"; done
echo "2. deploy.sh refuses before any step"
for bad in yes 1 ON true; do refuse "REQUEST_FRAMES must be on, off or unset" VARIANT=b-dosql "REQUEST_FRAMES=$bad"; done
refuse "REQUEST_FRAMES is for variant b-dosql" VARIANT=a REQUEST_FRAMES=on
refuse "REQUEST_FRAMES is for variant b-dosql" VARIANT=b-do REQUEST_FRAMES=off
echo "$fails failing case(s)"
[ "$fails" = 0 ]
