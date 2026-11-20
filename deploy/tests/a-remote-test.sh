#!/usr/bin/env bash
# deploy/deploy.sh VARIANT=a: the remote packs on by default (#1020), as b-dosql has them since #598.
# The reading (strummer-sb1120, cf759hl, 2026-11-20, lean, WooCommerce 11.2.1, Hyperdrive): without the packs, 9 of 10
# GET /wp-json/ ended exceededMemory and EVERY request booted a fresh PHP runtime; with OPCACHE_A=1 OPCACHE_REMOTE=1
# SITE_REMOTE=1, 10 of 10 answered 200 at 105 MiB and the isolates were reused (warm CPU about 0.5 s against 3 s cold).
# 1. The default: a_remote_pack_defaults (deploy/lib/remote-packs.sh) fills OPCACHE_A, OPCACHE_REMOTE and SITE_REMOTE.
# 2. deploy.sh applies it on variant a, after the settings check and before the build and the render.
# 3. The render: variant a with no setting renders both vars and /_pf/ first; OPCACHE_REMOTE=0 renders none.
# shellcheck disable=SC2016  # the greps match deploy.sh's literal $VARIANT text
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
D="$ROOT/deploy/deploy.sh"; S="$ROOT/deploy/a-settings.sh"; L="$ROOT/deploy/lib/remote-packs.sh"
line() { grep -nE "$2" "$1" | head -1 | cut -d: -f1; }

echo "1. the default (deploy/lib/remote-packs.sh a_remote_pack_defaults)"
dflt() { env -i PATH="$PATH" "$@" bash -c ". '$L' && a_remote_pack_defaults && echo \"\${OPCACHE_A:-unset} \$OPCACHE_REMOTE \$SITE_REMOTE\"" 2>&1; }
want() { ok "$1: $3" "$([ "$2" = "$3" ] && echo 1 || echo 0)"; }
want "unset: primed, both packs on" "$(dflt)" "1 1 1"
want "OPCACHE_REMOTE=0: both packs off, the priming left as set" "$(dflt OPCACHE_REMOTE=0)" "unset 0 0"
want "OPCACHE_A=0: no priming, so no packs (they follow its trace)" "$(dflt OPCACHE_A=0)" "0 0 0"
want "OPCACHE_A=1: both packs on" "$(dflt OPCACHE_A=1)" "1 1 1"
want "SITE_REMOTE=0: OPcache packs only" "$(dflt SITE_REMOTE=0)" "1 1 0"
want "all three set: kept" "$(dflt OPCACHE_A=1 OPCACHE_REMOTE=1 SITE_REMOTE=0)" "1 1 0"
ok "every default passes the variant a check" "$(env -i PATH="$PATH" bash -c ". '$S' && a_remote_pack_defaults && a_settings_check a && OPCACHE_REMOTE= SITE_REMOTE= OPCACHE_A=0 a_remote_pack_defaults && a_settings_check a" >/dev/null 2>&1 && echo 1 || echo 0)"

echo "2. deploy.sh applies it on variant a"
chkl=$(line "$D" '^a_settings_check "\$VARIANT"'); defl=$(line "$D" '^\[ "\$VARIANT" != a \] \|\| a_remote_pack_defaults$')
buildl=$(line "$D" '^log "build"$'); renl=$(line "$D" '^render_conf > "\$CONF"$')
ok "after the settings check, before the build and the render (lines $chkl < ${defl:-none} < $buildl < $renl)" \
  "$([ -n "$defl" ] && [ "$chkl" -lt "$defl" ] && [ "$defl" -lt "$buildl" ] && [ "$defl" -lt "$renl" ] && echo 1 || echo 0)"

echo "3. the rendered lines with the default applied (deploy/a-settings.sh)"
r() { env -i PATH="$PATH" "$@" bash -c ". '$S' && a_remote_pack_defaults && a_vars && echo --- && a_assets_first" 2>&1; }
ok "no setting: both vars, and /_pf/ first" "$([ "$(r)" = "$(printf 'OPCACHE_REMOTE = "on"\nSITE_REMOTE = "on"\n---\nrun_worker_first = ["/_pf/*"]')" ] && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=0: nothing (the opt-out)" "$([ "$(r OPCACHE_REMOTE=0)" = '---' ] && echo 1 || echo 0)"

[ "$fails" = 0 ] && echo "PASS a-remote-test" || { echo "FAIL a-remote-test: $fails"; exit 1; }
