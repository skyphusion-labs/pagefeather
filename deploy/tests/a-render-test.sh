#!/usr/bin/env bash
# deploy.sh's variant-a config against the measured bench config (#666). Every #296 run used a hand-made
# config (deploy/tests/a-render/bench.toml, ids replaced), because deploy.sh rendered none of the object-cache,
# lazy-loading or overflow settings. This renders deploy.sh's config (render_conf, deploy/render-conf.sh) with
# a stub out() and no Terraform, and compares it with the bench config setting by setting (canon.py).
#
# The inputs a site chooses are given to match the bench: PLACEMENT (the database region), OBSERVABILITY=full
# (the bench logged every request), the media bucket. Nothing else is set: the measured settings must come
# from the DEFAULTS. Two lines are allowed in the render only: SITE_ORIGIN and HTTP_ALLOW_HOSTS, which deploy.sh
# always writes (the bench ran on the runtime defaults for both).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/deploy/tests/a-render"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/a-render-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)

# render <out.toml> [VAR=value ...]: deploy.sh's variant-a config for site pfa-render, in a clean environment.
render() {
  local dst=$1; shift
  # shellcheck disable=SC2016  # the script expands in the child shell, from the env -i values
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pfa-render VARIANT=a LOCATION=wnam \
    SITE_ORIGIN=https://pfa-render.example.workers.dev BUCKET=MEDIA_BUCKET AI=0 \
    PLACEMENT=aws:us-west-2 OBSERVABILITY=full THROWAWAY=1 "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { case "$1" in hyperdrive_id) echo HYPERDRIVE_ID ;; oc_kv_id) echo OC_KV_ID ;; *) echo "out: no stub for $1" >&2; return 1 ;; esac; }
      a_settings_check a
      cd "$APP" && render_conf' > "$dst" 2> "$T/render.err"
}
# compare <render.toml> <bench.toml> <label>: equal settings, apart from the two render-only lines.
compare() {
  python3 -I "$HERE/canon.py" "$1" | grep -vE '^vars (SITE_ORIGIN|HTTP_ALLOW_HOSTS) = ' > "$T/r.canon"
  python3 -I "$HERE/canon.py" "$2" > "$T/b.canon"
  if diff -u "$T/b.canon" "$T/r.canon" > "$T/d"; then ok "$3" 1; else sed 's/^/        /' "$T/d"; ok "$3 (above: - the bench, + deploy.sh)" 0; fi
}

echo "1. the defaults render the measured site"
render "$T/a.toml"; rc=$?
ok "render_conf ran (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"; [ $rc = 0 ] || cat "$T/render.err"
compare "$T/a.toml" "$HERE/bench.toml" "deploy.sh variant a equals the bench config"

echo "2. PHP_OVERFLOW=1 renders the overflow run (pool 32, the PhpRuntime binding and its migration)"
render "$T/o.toml" PHP_OVERFLOW=1; rc=$?
ok "render_conf ran (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"; [ $rc = 0 ] || cat "$T/render.err"
compare "$T/o.toml" "$HERE/bench-overflow.toml" "deploy.sh variant a with PHP_OVERFLOW=1 equals the overflow bench"

echo "3. the gate can fail: one changed setting is a difference"
python3 -I "$HERE/canon.py" "$HERE/bench.toml" > "$T/b.canon"
python3 -I "$HERE/canon.py" "$HERE/bench-overflow.toml" > "$T/bo.canon"
differs() { # differs <bench.canon> <label> [VAR=value ...]
  local b=$1 label=$2; shift 2
  render "$T/m.toml" "$@" || { ok "$label (the render ran)" 0; return; }
  python3 -I "$HERE/canon.py" "$T/m.toml" | grep -vE '^vars (SITE_ORIGIN|HTTP_ALLOW_HOSTS) = ' > "$T/m.canon"
  ok "$label" "$(diff -q "$b" "$T/m.canon" >/dev/null && echo 0 || echo 1)"
}
differs "$T/b.canon" "A_CLIENT=mysql2 (index-a.js) differs from the bench" A_CLIENT=mysql2
differs "$T/bo.canon" "PHP_OVERFLOW_POOL=31 differs from the overflow bench" PHP_OVERFLOW=1 PHP_OVERFLOW_POOL=31
differs "$T/b.canon" "OBSERVABILITY=1 (events only) differs from the bench (full)" OBSERVABILITY=1

echo "4. WOO_EXTRAS=off (#667) reaches the rendered [vars], and unset renders nothing"
render "$T/w.toml" WOO_EXTRAS=off; rc=$?
ok "WOO_EXTRAS=off renders vars WOO_EXTRAS = \"off\" (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/w.toml" | grep -qx 'vars WOO_EXTRAS = "off"' && echo 1 || echo 0)"
ok "unset renders no WOO_EXTRAS line" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -q WOO_EXTRAS && echo 0 || echo 1)"

echo "5. OBJECT_CACHE_VERSIONS=1 (#668, #686) reaches the rendered [vars]; unset or 0 renders nothing"
render "$T/v.toml" OBJECT_CACHE_VERSIONS=1; rc=$?
ok "OBJECT_CACHE_VERSIONS=1 renders vars OBJECT_CACHE_VERSIONS = \"on\" (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/v.toml" | grep -qx 'vars OBJECT_CACHE_VERSIONS = "on"' && echo 1 || echo 0)"
render "$T/v0.toml" OBJECT_CACHE_VERSIONS=0; rc=$?
ok "OBJECT_CACHE_VERSIONS=0 renders none (rc $rc)" "$([ $rc = 0 ] && ! python3 -I "$HERE/canon.py" "$T/v0.toml" | grep -q OBJECT_CACHE_VERSIONS && echo 1 || echo 0)"
ok "unset renders none" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -q OBJECT_CACHE_VERSIONS && echo 0 || echo 1)"
# #650: versions are exact only when Hyperdrive does not cache queries. deploy.sh's Terraform makes the site's config,
# so its hyperdrive resource must keep caching disabled (provisionSite checks the live config; this path cannot).
ok "the Terraform Hyperdrive config keeps caching disabled (#650)" "$(awk '/resource "cloudflare_hyperdrive_config" "wp"/{f=1} f&&/^}/{exit} f&&/caching = \{ disabled = true \}/{print 1; exit}' "$ROOT/deploy/terraform/main.tf" | grep -qx 1 && echo 1 || echo 0)"

[ "$fails" = 0 ] && echo "a-render: all checks pass" || echo "a-render: $fails failing check(s)"
exit $((fails > 0))
