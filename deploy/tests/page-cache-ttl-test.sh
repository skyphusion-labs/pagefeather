#!/usr/bin/env bash
# #759 pass 2 (the lead's ruling): PAGE_CACHE_TTL, the seconds a guest page stays fresh at the edge (index.js; 0 = the edge
# page cache off), on the b-dosql deploy paths. Before this only deploy/variants/c1-config.sh rendered it, so a wfp or
# deploy.sh "PAGE_CACHE_TTL=0" deployed with the cache ON and said nothing. Rendered only when set: an integer from 0
# to 86400 (0 valid: off). Unset renders nothing (byte-identical). deploy/wfp: a RECORDED setting, so an update keeps it,
# and DROP_SETTINGS=PAGE_CACHE_TTL returns to the default. deploy.sh: refused before any step when bad, or when set on a
# variant other than b-dosql (c1 has its own, deploy/variants/c1-config.sh).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/page-cache-ttl-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE="$T/fence"; fence_dir "$FENCE"
APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)
rc_() { local v=$1; shift
  # shellcheck disable=SC2016
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pf-render VARIANT="$v" LOCATION=wnam \
    SITE_ORIGIN=https://pf-render.example.workers.dev BUCKET=MEDIA_BUCKET AI=0 "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { echo "STUB_$1"; }
      cd "$APP" && render_conf' 2> "$T/rc.err"; }
ru() { env -i PATH="$PATH" HOME="$T" "$@" bash -c ". '$ROOT/deploy/wfp/lib.sh' >/dev/null 2>&1; render_user one https://wp-one.sub.workers.dev" 2> "$T/ru.err"; }
lines() { grep -cE '^PAGE_CACHE_TTL = ' | tr -d ' '; }
echo "1. deploy.sh (render_conf, b-dosql)"
ok "absent: no line" "$([ "$(rc_ b-dosql | lines)" = 0 ] && echo 1 || echo 0)"
ok "empty: no line" "$([ "$(rc_ b-dosql PAGE_CACHE_TTL= | lines)" = 0 ] && echo 1 || echo 0)"
ok "0 (off): PAGE_CACHE_TTL = \"0\", once" "$([ "$(rc_ b-dosql PAGE_CACHE_TTL=0 | grep -cxF 'PAGE_CACHE_TTL = "0"')" = 1 ] && echo 1 || echo 0)"
ok "60: PAGE_CACHE_TTL = \"60\"" "$([ "$(rc_ b-dosql PAGE_CACHE_TTL=60 | grep -cxF 'PAGE_CACHE_TTL = "60"')" = 1 ] && echo 1 || echo 0)"
ok "86400 (the top): rendered" "$([ "$(rc_ b-dosql PAGE_CACHE_TTL=86400 | grep -cxF 'PAGE_CACHE_TTL = "86400"')" = 1 ] && echo 1 || echo 0)"
for bad in -1 86401 abc 1.5 '60 ' 0x10 007; do
  refuse "PAGE_CACHE_TTL must be an integer from 0 to 86400" VARIANT=b-dosql "PAGE_CACHE_TTL=$bad"
done
refuse "PAGE_CACHE_TTL is for variant b-dosql" VARIANT=a PAGE_CACHE_TTL=0 PLACEMENT=aws:us-west-2
ok "c1 keeps its own rule: 90000 passes this check (c1-config.sh decides)" "$(env -i PATH="$PATH" PAGE_CACHE_TTL=90000 bash -c ". '$ROOT/deploy/page-cache-ttl.sh' && page_cache_ttl_check c1" 2>/dev/null && echo 1 || echo 0)"
echo "2. deploy/wfp (render_user)"
ok "absent: no line" "$([ "$(ru | lines)" = 0 ] && echo 1 || echo 0)"
o=$(ru PAGE_CACHE_TTL=); ok "empty (site update's local -x of an unset setting): no line, not refused" "$([ $? = 0 ] && [ "$(printf '%s\n' "$o" | lines)" = 0 ] && echo 1 || echo 0)"
ok "0 (off): the line, once" "$([ "$(ru PAGE_CACHE_TTL=0 | grep -cxF 'PAGE_CACHE_TTL = "0"')" = 1 ] && echo 1 || echo 0)"
ok "300: the line" "$([ "$(ru PAGE_CACHE_TTL=300 | grep -cxF 'PAGE_CACHE_TTL = "300"')" = 1 ] && echo 1 || echo 0)"
for bad in -1 86401 abc 007; do ru PAGE_CACHE_TTL=$bad > /dev/null; ok "PAGE_CACHE_TTL=$bad: the render fails, named" "$([ $? != 0 ] && grep -q 'PAGE_CACHE_TTL must be an integer from 0 to 86400' "$T/ru.err" && echo 1 || echo 0)"; done
ok "a recorded setting (lib.sh SITE_SETTINGS)" "$(env -i PATH="$PATH" HOME="$T" bash -c ". '$ROOT/deploy/wfp/lib.sh' >/dev/null 2>&1; echo \" \$SITE_SETTINGS \"" | grep -q ' PAGE_CACHE_TTL ' && echo 1 || echo 0)"
ok "  site_settings.py SETTINGS and DROPPABLE_VARS" "$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s; print(int("PAGE_CACHE_TTL" in s.SETTINGS and "PAGE_CACHE_TTL" in s.DROPPABLE_VARS))' "$ROOT/deploy/wfp" 2>/dev/null)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
