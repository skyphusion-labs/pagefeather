#!/bin/bash
# The remote packs are the DEFAULT for every site (#394, the D/R round of 2026-11-14), offline.
#   deploy/wfp/tests/remote-default-test.sh [another lib.sh]
# - remote_pack_defaults: unset or empty turns both on; 0 opts out and is kept; OPCACHE_SPLIT=1 gets
#   no remote; SITE_REMOTE follows OPCACHE_REMOTE unless it is set.
# - The config rendered after the defaults has both vars, the ASSETS binding and /_pf/ first.
# - The wiring: site add, site update (after the recorded settings) and up.sh apply the defaults
#   BEFORE the build, so the build and the render read the same values.
# - site_settings.py dropcheck: OPCACHE_REMOTE=0 or SITE_REMOTE=0 from this run is an opt-out, not a
#   drop; the same config without the 0 is still refused (the guard is not weakened).
# Exits 0 only when every check holds. Needs bash, python3 (tomllib).
set -u
unset MAIL_FROM MAIL_FROM_NAME HTTP_ALLOW_HOSTS
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
WFP=$(cd "$HERE/.." && pwd)
PY=""
for p in "${PY_TOML:-}" python3 python3.14 python3.13 python3.12 python3.11; do
	[ -n "$p" ] && command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tomllib' 2>/dev/null && { PY=$p; break; }
done
[ -n "$PY" ] || { echo "FAIL no python3 with tomllib (3.11 or later) on PATH"; exit 1; }
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

# 1. The defaults. Each case runs in a clean shell with only the named inputs.
d() { env -u OPCACHE_REMOTE -u SITE_REMOTE -u OPCACHE_SPLIT "$@" bash -c ". '$LIB'; declare -F remote_pack_defaults >/dev/null || { echo missing; exit 0; }; remote_pack_defaults; echo \"\$OPCACHE_REMOTE \$SITE_REMOTE\""; }
check "unset: both on" "$(d)" "1 1"
check "empty: both on (a dropped or unrecorded setting reads empty)" "$(d OPCACHE_REMOTE= SITE_REMOTE=)" "1 1"
check "OPCACHE_REMOTE=0: the opt-out; SITE_REMOTE follows it" "$(d OPCACHE_REMOTE=0)" "0 0"
check "SITE_REMOTE=0 alone: the OPcache packs stay on" "$(d SITE_REMOTE=0)" "1 0"
check "OPCACHE_REMOTE=1 SITE_REMOTE=0 kept" "$(d OPCACHE_REMOTE=1 SITE_REMOTE=0)" "1 0"
check "OPCACHE_SPLIT=1: no remote (the split cannot be remote)" "$(d OPCACHE_SPLIT=1)" "0 0"
check "an explicit value is never replaced" "$(d OPCACHE_REMOTE=1 SITE_REMOTE=1 OPCACHE_SPLIT=0)" "1 1"
check "the defaults are exported to child processes" "$(env -u OPCACHE_REMOTE -u SITE_REMOTE -u OPCACHE_SPLIT bash -c ". '$LIB'; remote_pack_defaults; bash -c 'echo \$OPCACHE_REMOTE \$SITE_REMOTE'")" "1 1"

# 2. The render after the defaults.
rv() { "$PY" -c 'import json, sys, tomllib; c = tomllib.loads(sys.stdin.read()); v = c.get("vars", {}); print(json.dumps([v.get("OPCACHE_REMOTE"), v.get("SITE_REMOTE"), c.get("assets")], sort_keys=True))'; }
r() { env -u OPCACHE_REMOTE -u SITE_REMOTE -u OPCACHE_SPLIT "$@" bash -c ". '$LIB'; remote_pack_defaults 2>/dev/null; render_user one https://wp-one.sub.workers.dev" | rv; }
check "default render: both vars on, the ASSETS binding and /_pf/ first" "$(r)" '["on", "on", {"binding": "ASSETS", "directory": "build/public", "run_worker_first": ["/_pf/*"]}]'
check "opt-out render: no var, [assets] is the directory only" "$(r OPCACHE_REMOTE=0)" '[null, null, {"directory": "build/public"}]'
check "SITE_REMOTE=0 render: OPcache remote only" "$(r SITE_REMOTE=0)" '["on", null, {"binding": "ASSETS", "directory": "build/public", "run_worker_first": ["/_pf/*"]}]'
check "OPCACHE_SPLIT=1 render: the split, no remote var" "$(r OPCACHE_SPLIT=1)" '[null, null, {"binding": "ASSETS", "directory": "build/public", "run_worker_first": ["/_pf/*"]}]'

# 3. The wiring: the defaults come before the build in add, update and up.sh (and after the record in update).
SITE_SH="$WFP/site"; UP_SH="$WFP/up.sh"
line() { grep -n -- "$2" "$1" | head -1 | cut -d: -f1; }
upd_start=$(line "$SITE_SH" '^update_one_inner()')
upd_keep=$(awk -v s="$upd_start" 'NR > s && /keep_settings "\$bucket"/ { print NR; exit }' "$SITE_SH")
upd_def=$(awk -v s="$upd_start" 'NR > s && /^  remote_pack_defaults$/ { print NR; exit }' "$SITE_SH")
upd_build=$(awk -v s="$upd_start" 'NR > s && /build_dosql \|\|/ { print NR; exit }' "$SITE_SH")
ok "site update: defaults after keep_settings and before build_dosql ($upd_keep < $upd_def < $upd_build)" "$([ -n "$upd_keep" ] && [ -n "$upd_def" ] && [ -n "$upd_build" ] && [ "$upd_keep" -lt "$upd_def" ] && [ "$upd_def" -lt "$upd_build" ] && echo 1 || echo 0)"
add_start=$(line "$SITE_SH" '^if \[ "\$cmd" = add \]')
add_def=$(awk -v s="$add_start" 'NR > s && /^  remote_pack_defaults$/ { print NR; exit }' "$SITE_SH")
add_build=$(awk -v s="$add_start" 'NR > s && /build_dosql$/ { print NR; exit }' "$SITE_SH")
add_up=$(awk -v s="$add_start" 'NR > s && /site.sh" up/ { print NR; exit }' "$SITE_SH")
ok "site add: defaults before build_dosql and the render ($add_def < $add_build < $add_up)" "$([ -n "$add_def" ] && [ -n "$add_build" ] && [ -n "$add_up" ] && [ "$add_def" -lt "$add_build" ] && [ "$add_build" -lt "$add_up" ] && echo 1 || echo 0)"
up_def=$(line "$UP_SH" '^remote_pack_defaults$'); up_build=$(line "$UP_SH" 'build_dosql')
ok "up.sh: defaults before build_dosql ($up_def < $up_build)" "$([ -n "$up_def" ] && [ -n "$up_build" ] && [ "$up_def" -lt "$up_build" ] && echo 1 || echo 0)"

# 4. dropcheck: a live remote site, then an opted-out config.
printf '[vars]\nWP_HOME = "x"\n' > "$T/off.toml"
printf '{"result": [{"name": "OPCACHE_REMOTE", "type": "plain_text"}, {"name": "SITE_REMOTE", "type": "plain_text"}]}' > "$T/live.json"
echo '[]' > "$T/sec.json"
dc() { env -u OPCACHE_REMOTE -u SITE_REMOTE -u DROP_SETTINGS "$@" python3 -I "$WFP/site_settings.py" dropcheck "$T/off.toml" "$T/live.json" "$T/sec.json" >/dev/null 2>&1; echo $?; }
check "dropcheck control: dropping both without a word is REFUSED" "$(dc)" "6"
check "dropcheck: OPCACHE_REMOTE=0 SITE_REMOTE=0 is the opt-out, allowed" "$(dc OPCACHE_REMOTE=0 SITE_REMOTE=0)" "0"
check "dropcheck: only OPCACHE_REMOTE=0 still refuses the silent SITE_REMOTE drop" "$(dc OPCACHE_REMOTE=0)" "6"
check "dropcheck: an empty value is not an opt-out" "$(dc OPCACHE_REMOTE= SITE_REMOTE=)" "6"

[ "$fails" = 0 ] && echo "ALL PASS" || echo "$fails FAILED"
[ "$fails" = 0 ]
