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
# #721: enable_request_signal was added after the #296 benches ran. The benches stay the record; the comparison maps the
# render's flags line back to theirs (benchflags), and section 8 asserts the flag itself.
benchflags() { sed 's/^- compatibility_flags = \["nodejs_compat", "enable_request_signal"\]$/- compatibility_flags = ["nodejs_compat"]/'; }
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
  python3 -I "$HERE/canon.py" "$1" | benchflags | grep -vE '^vars (SITE_ORIGIN|HTTP_ALLOW_HOSTS) = ' > "$T/r.canon"
  python3 -I "$HERE/canon.py" "$2" > "$T/b.canon"
  if diff -u "$T/b.canon" "$T/r.canon" > "$T/d"; then ok "$3" 1; else sed 's/^/        /' "$T/d"; ok "$3 (above: - the bench, + deploy.sh)" 0; fi
}

echo "1. the defaults render the measured site: the #666 bench plus the two #296 step 3 defaults (OCV and HPOS cache on)"
render "$T/a.toml"; rc=$?
ok "render_conf ran (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"; [ $rc = 0 ] || cat "$T/render.err"
# #296: the step 3 series measured arm C (both on) against the bench; the lead ruled them approach A's defaults.
python3 -I "$HERE/canon.py" "$T/a.toml" | benchflags | grep -vE '^vars (SITE_ORIGIN|HTTP_ALLOW_HOSTS) = ' > "$T/d.canon"
# #1078: the KV L2 is off by default on approach A (the benches ran with it on, and stay the record): mapped here.
{ python3 -I "$HERE/canon.py" "$HERE/bench.toml" | sed 's/^vars OBJECT_CACHE_L2 = "on"$/vars OBJECT_CACHE_L2 = "off"/'; echo 'vars OBJECT_CACHE_VERSIONS = "on"'; echo 'vars WOO_HPOS_CACHE = "on"'; } | sort > "$T/bd.canon"
if diff -u "$T/bd.canon" <(sort "$T/d.canon") > "$T/d1"; then ok "deploy.sh variant a equals the bench plus the two defaults" 1; else sed 's/^/        /' "$T/d1"; ok "deploy.sh variant a equals the bench plus the two defaults" 0; fi
render "$T/a0.toml" OBJECT_CACHE_VERSIONS=0 WOO_HPOS_CACHE=off OBJECT_CACHE_L2=1; rc=$? # #1078: the bench ran with L2 on
compare "$T/a0.toml" "$HERE/bench.toml" "with both set off, deploy.sh variant a equals the #666 bench config exactly"

echo "2. PHP_OVERFLOW=1 renders the overflow run (pool 32, the PhpRuntime binding and its migration)"
# The overflow bench predates the #296 defaults: compared with both off (test 1 covers the defaults).
render "$T/o.toml" PHP_OVERFLOW=1 OBJECT_CACHE_VERSIONS=0 WOO_HPOS_CACHE=off OBJECT_CACHE_L2=1; rc=$? # #1078: the bench ran with L2 on
ok "render_conf ran (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"; [ $rc = 0 ] || cat "$T/render.err"
compare "$T/o.toml" "$HERE/bench-overflow.toml" "deploy.sh variant a with PHP_OVERFLOW=1 equals the overflow bench"

echo "3. the gate can fail: one changed setting is a difference"
python3 -I "$HERE/canon.py" "$HERE/bench.toml" > "$T/b.canon"
python3 -I "$HERE/canon.py" "$HERE/bench-overflow.toml" > "$T/bo.canon"
differs() { # differs <bench.canon> <label> [VAR=value ...]
  local b=$1 label=$2; shift 2
  render "$T/m.toml" "$@" || { ok "$label (the render ran)" 0; return; }
  python3 -I "$HERE/canon.py" "$T/m.toml" | benchflags | grep -vE '^vars (SITE_ORIGIN|HTTP_ALLOW_HOSTS) = ' > "$T/m.canon"
  ok "$label" "$(diff -q "$b" "$T/m.canon" >/dev/null && echo 0 || echo 1)"
}
differs "$T/b.canon" "A_CLIENT=mysql2 (index-a.js) differs from the bench" A_CLIENT=mysql2
differs "$T/bo.canon" "PHP_OVERFLOW_POOL=31 differs from the overflow bench" PHP_OVERFLOW=1 PHP_OVERFLOW_POOL=31
differs "$T/b.canon" "OBSERVABILITY=1 (events only) differs from the bench (full)" OBSERVABILITY=1

echo "4. WOO_EXTRAS=off (#667) reaches the rendered [vars], and unset renders nothing"
render "$T/w.toml" WOO_EXTRAS=off; rc=$?
ok "WOO_EXTRAS=off renders vars WOO_EXTRAS = \"off\" (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/w.toml" | grep -qx 'vars WOO_EXTRAS = "off"' && echo 1 || echo 0)"
ok "unset renders no WOO_EXTRAS line" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -q WOO_EXTRAS && echo 0 || echo 1)"

echo "4b. OBJECT_CACHE_L2 (#1078): unset renders off (the approach A default), 1 renders on, anything else is refused"
render "$T/l0.toml"; ok "OBJECT_CACHE_L2 unset renders off" "$(grep -c '^OBJECT_CACHE_L2 = "off"$' "$T/l0.toml")"
render "$T/l1.toml" OBJECT_CACHE_L2=1; ok "OBJECT_CACHE_L2=1 renders on" "$(grep -c '^OBJECT_CACHE_L2 = "on"$' "$T/l1.toml")"
if render "$T/lx.toml" OBJECT_CACHE_L2=on; then ok "OBJECT_CACHE_L2=on (not 0 or 1) is refused" 0; else ok "OBJECT_CACHE_L2=on (not 0 or 1) is refused" "$(grep -c 'OBJECT_CACHE_L2 must be 0 or 1' "$T/render.err")"; fi
echo "5. OBJECT_CACHE_VERSIONS (#668, #686): unset or 1 renders it on (the #296 default); an explicit 0 renders nothing"
render "$T/v.toml" OBJECT_CACHE_VERSIONS=1; rc=$?
ok "OBJECT_CACHE_VERSIONS=1 renders vars OBJECT_CACHE_VERSIONS = \"on\" (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/v.toml" | grep -qx 'vars OBJECT_CACHE_VERSIONS = "on"' && echo 1 || echo 0)"
render "$T/v0.toml" OBJECT_CACHE_VERSIONS=0; rc=$?
ok "OBJECT_CACHE_VERSIONS=0 renders none (rc $rc)" "$([ $rc = 0 ] && ! python3 -I "$HERE/canon.py" "$T/v0.toml" | grep -q OBJECT_CACHE_VERSIONS && echo 1 || echo 0)"
ok "unset renders it on (the default)" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -qx 'vars OBJECT_CACHE_VERSIONS = "on"' && echo 1 || echo 0)"
# #650: versions are exact only when Hyperdrive does not cache queries. deploy.sh's Terraform makes the site's config,
# so its hyperdrive resource must keep caching disabled (provisionSite checks the live config; this path cannot).
ok "the Terraform Hyperdrive config keeps caching disabled (#650)" "$(awk '/resource "cloudflare_hyperdrive_config" "wp"/{f=1} f&&/^}/{exit} f&&/caching = \{ disabled = true \}/{print 1; exit}' "$ROOT/deploy/terraform/main.tf" | grep -qx 1 && echo 1 || echo 0)"

echo "6. WOO_HPOS_CACHE (#697): unset or on renders it on (the #296 default); an explicit off renders nothing"
render "$T/h.toml" WOO_HPOS_CACHE=on; rc=$?
ok "WOO_HPOS_CACHE=on renders vars WOO_HPOS_CACHE = \"on\" (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/h.toml" | grep -qx 'vars WOO_HPOS_CACHE = "on"' && echo 1 || echo 0)"
ok "unset renders it on (the default)" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -qx 'vars WOO_HPOS_CACHE = "on"' && echo 1 || echo 0)"
render "$T/h0.toml" WOO_HPOS_CACHE=off; rc=$?
ok "WOO_HPOS_CACHE=off renders none (rc $rc)" "$([ $rc = 0 ] && ! python3 -I "$HERE/canon.py" "$T/h0.toml" | grep -q WOO_HPOS_CACHE && echo 1 || echo 0)"

echo "7. #715 review2 2: OBJECT_START_BY_S and OBJECT_CALL_DEADLINE_S reach [vars]; unset renders nothing; a bad value fails"
render "$T/s.toml" OBJECT_START_BY_S=off OBJECT_CALL_DEADLINE_S=120; rc=$?
ok "both render (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/s.toml" | grep -qx 'vars OBJECT_START_BY_S = "off"' && python3 -I "$HERE/canon.py" "$T/s.toml" | grep -qx 'vars OBJECT_CALL_DEADLINE_S = "120"' && echo 1 || echo 0)"
ok "unset renders neither" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -q 'OBJECT_START_BY_S\|OBJECT_CALL_DEADLINE_S' && echo 0 || echo 1)"
render "$T/bad.toml" OBJECT_START_BY_S=0; rc=$?
ok "OBJECT_START_BY_S=0 fails the render (rc $rc)" "$([ $rc != 0 ] && echo 1 || echo 0)"
ok "deploy.sh checks both before any step" "$(grep -q 'object_time_vars >/dev/null || exit 2' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"

echo "8. #721: every render sets enable_request_signal, the specific flag (the compatibility date is unchanged)"
ok "the default render sets the flag" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -qx -- '- compatibility_flags = \["nodejs_compat", "enable_request_signal"\]' && echo 1 || echo 0)"
ok "the compatibility date is the bench's" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -qx -- "$(python3 -I "$HERE/canon.py" "$HERE/bench.toml" | grep -- '^- compatibility_date')" && echo 1 || echo 0)"

echo "9. #721: OBJECT_DISCONNECT_SHED=off reaches [vars] (deploy.sh); unset renders nothing; a bad value fails; the flag stays"
render "$T/ds.toml" OBJECT_DISCONNECT_SHED=off; rc=$?
ok "off renders it (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/ds.toml" | grep -qx 'vars OBJECT_DISCONNECT_SHED = "off"' && echo 1 || echo 0)"
ok "and the flag stays on" "$(python3 -I "$HERE/canon.py" "$T/ds.toml" | grep -q enable_request_signal && echo 1 || echo 0)"
ok "unset renders none" "$(python3 -I "$HERE/canon.py" "$T/a.toml" | grep -q OBJECT_DISCONNECT_SHED && echo 0 || echo 1)"
render "$T/dsb.toml" OBJECT_DISCONNECT_SHED=0; rc=$?
ok "OBJECT_DISCONNECT_SHED=0 fails the render (rc $rc)" "$([ $rc != 0 ] && echo 1 || echo 0)"

echo "10. #714: PHP_OVERFLOW_MAX_HELD (off or 1 to 1000) and MEM_LEDGER=on reach [vars]; unset renders neither (the code default is no cap, #714)"
render "$T/mh.toml" PHP_OVERFLOW=1 PHP_OVERFLOW_MAX_HELD=off MEM_LEDGER=on; rc=$?
ok "off and the ledger render (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/mh.toml" | grep -qx 'vars PHP_OVERFLOW_MAX_HELD = "off"' && python3 -I "$HERE/canon.py" "$T/mh.toml" | grep -qx 'vars MEM_LEDGER = "on"' && echo 1 || echo 0)"
render "$T/m8.toml" PHP_OVERFLOW=1 PHP_OVERFLOW_MAX_HELD=08; rc=$?
ok "PHP_OVERFLOW_MAX_HELD=08 renders 8 (base 10) (rc $rc)" "$([ $rc = 0 ] && python3 -I "$HERE/canon.py" "$T/m8.toml" | grep -qx 'vars PHP_OVERFLOW_MAX_HELD = "8"' && echo 1 || echo 0)"
render "$T/m0.toml" PHP_OVERFLOW=1; rc=$?
ok "PHP_OVERFLOW=1 alone renders neither (rc $rc)" "$([ $rc = 0 ] && ! python3 -I "$HERE/canon.py" "$T/m0.toml" | grep -qE 'PHP_OVERFLOW_MAX_HELD|MEM_LEDGER' && echo 1 || echo 0)"


# #1054: the Worker's [placement]. Measured on cf759hw (2026-11-20, same build c78301d, 10 runs each, p50): region
# aws:us-east-2 (ORD) 4.04 / 2.56 / 2.03 s on /, edit.php and the posts list; azure:westus2 (SEA, next to the
# wpref-mysql database) 0.83 / 1.36 / 0.56 s. host = <db>:3306 placed in ORD, not next to the database. So the
# default is never a silent aws:us-east-2 for an external MySQL: PLACEMENT is required there.
pl() { grep -A1 '^\[placement\]' "$1" | tail -1; }
render "$T/p1.toml" PLACEMENT= MYSQL=external MYSQL_HOST=wpref-mysql.mysql.database.azure.com; rc=$?
ok "#1054 an external MySQL with no PLACEMENT is refused, naming PLACEMENT (rc $rc)" "$([ "$rc" != 0 ] && grep -q 'PLACEMENT' "$T/render.err" && ! grep -q 'aws:us-east-2' "$T/p1.toml" 2>/dev/null && echo 1 || echo 0)"
ok "#1054   and an Azure host is told its form (azure:<the server's region>)" "$(grep -q 'azure:<' "$T/render.err" && echo 1 || echo 0)"
render "$T/p2.toml" PLACEMENT= MYSQL=vultr MYSQL_HOST=mysql-x.skyphusion.org; rc=$?
ok "#1054 MYSQL=vultr (deploy/mysql's ord box) with no PLACEMENT: region aws:us-east-2 (rc $rc)" "$([ "$rc" = 0 ] && [ "$(pl "$T/p2.toml")" = 'region = "aws:us-east-2"' ] && echo 1 || echo 0)"
render "$T/p3.toml" PLACEMENT=azure:westus2 MYSQL=external MYSQL_HOST=wpref-mysql.mysql.database.azure.com
ok "#1054 PLACEMENT=azure:westus2 renders that region" "$([ "$(pl "$T/p3.toml")" = 'region = "azure:westus2"' ] && echo 1 || echo 0)"
render "$T/p4.toml" PLACEMENT=host MYSQL=external MYSQL_HOST=db.example.org MYSQL_PORT=3307
ok "#1054 PLACEMENT=host renders host = <MYSQL_HOST>:<MYSQL_PORT>" "$([ "$(pl "$T/p4.toml")" = 'host = "db.example.org:3307"' ] && echo 1 || echo 0)"
render "$T/p5.toml" PLACEMENT=smart MYSQL=external MYSQL_HOST=db.example.org
ok "#1054 PLACEMENT=smart renders mode = smart" "$([ "$(pl "$T/p5.toml")" = 'mode = "smart"' ] && echo 1 || echo 0)"
render "$T/p6.toml" PLACEMENT=chicago MYSQL=external MYSQL_HOST=db.example.org; rc=$?
ok "#1054 an unknown PLACEMENT is refused (rc $rc)" "$([ "$rc" != 0 ] && grep -q 'PLACEMENT must be' "$T/render.err" && echo 1 || echo 0)"
ok "#1054 deploy.sh checks PLACEMENT before any step" "$(grep -q 'placement_check ) || exit 2' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"

# #1056: MAIL_ALLOWED_TO renders the destination allowlist on the send_email binding (c1 had it; a and b-* did not).
render "$T/m1.toml" PLACEMENT=azure:westus2 MAIL_FROM=wp-test@skyphusion.org MAIL_ALLOWED_TO=mackaye@skyphusion.org
ok "#1056 MAIL_ALLOWED_TO renders allowed_destination_addresses" "$(grep -qx 'send_email = \[{ name = "EMAIL", allowed_sender_addresses = \["wp-test@skyphusion.org"\], allowed_destination_addresses = \["mackaye@skyphusion.org"\] }\]' "$T/m1.toml" && echo 1 || echo 0)"
render "$T/m2.toml" PLACEMENT=azure:westus2 MAIL_ALLOWED_TO=mackaye@skyphusion.org; rc=$?
ok "#1056 MAIL_ALLOWED_TO with no sender is refused (rc $rc)" "$([ "$rc" != 0 ] && grep -q 'MAIL_ALLOWED_TO needs MAIL_FROM' "$T/render.err" && echo 1 || echo 0)"
ok "#1056 deploy.sh checks MAIL_ALLOWED_TO before any step" "$(grep -q 'MAIL_ALLOWED_TO="$MAIL_ALLOWED_TO" node "$APP/mail-from.mjs" --binding > /dev/null || exit 2' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"
[ "$fails" = 0 ] && echo "a-render: all checks pass" || echo "a-render: $fails failing check(s)"
exit $((fails > 0))
