# shellcheck shell=bash
# The #394 admin fixes for approach A (VARIANT=a: PHP in the Worker, MySQL through Hyperdrive),
# sourced by deploy/deploy.sh. Every setting is off unless it is set, so a deploy without them is
# the deploy of before. The runtime half is already in spikes/b2-wordpress/index.js, which
# index-a.js wraps: only the build and the Wrangler config were missing. Test:
# deploy/tests/a-settings-test.sh.
#
#   OPCACHE_A=1       prime A's OPcache on the D1 build, the way opcache-a.sh does (#218): no Docker,
#                     no local MySQL; an empty or unreadable cache fails the deploy (a_opcache_count,
#                     from #625 by rollins-sb1114l). Unset or 0 keeps today's path: a Docker MariaDB
#                     when Docker runs, else no priming (every new runtime compiles PHP first).
#   OPCACHE_REMOTE=1  #563: every OPcache file leaves the bundle, as packs under /_pf/ that PHP
#                     fetches when it opens a file (opcache-remote.py). Needs OPCACHE_A=1, which
#                     records the file trace the packs are ordered by (trace-filter.py).
#   SITE_REMOTE=1     #569: site.zip leaves the bundle too (site-remote.py). Needs OPCACHE_REMOTE=1.
#   RECYCLE_WASM_MIB  #602: the PHP runtime recycle line, an integer from 64 to 240 (MiB). Unset
#                     keeps index.js's 100. With the lean engine use 140: at 100 its editor pages
#                     end between the line and the isolate replacement point and stack a second
#                     memory (#598: 20 of 70 at 100, 0 of 280 at 140, on b-dosql pf582t).
#   PF_ENGINE_JS and PF_ENGINE_WASM (every variant): another engine's loader and wasm for
#                     prepare.sh, for example the lean-trim artifact of the pagefeather-engine
#                     workflow (#592). Both or neither.

# a_settings_check <variant>: exit status 2 and the reason on stderr when a setting is wrong.
a_settings_check() {
  local variant=$1 v
  if [ "$variant" != a ]; then
    for v in OPCACHE_A OPCACHE_REMOTE SITE_REMOTE RECYCLE_WASM_MIB; do
      [ -z "${!v:-}" ] || { echo "$v is for variant a only (deploy/wfp has its own settings for b-dosql)" >&2; return 2; }
    done
  fi
  case "${OPCACHE_A:-0}" in 0|1) ;; *) echo "OPCACHE_A must be 0 or 1, not ${OPCACHE_A}" >&2; return 2 ;; esac
  case "${OPCACHE_REMOTE:-0}" in 0|1) ;; *) echo "OPCACHE_REMOTE must be 0 or 1, not ${OPCACHE_REMOTE}" >&2; return 2 ;; esac
  case "${SITE_REMOTE:-0}" in 0|1) ;; *) echo "SITE_REMOTE must be 0 or 1, not ${SITE_REMOTE}" >&2; return 2 ;; esac
  if [ "${SITE_REMOTE:-0}" = 1 ] && [ "${OPCACHE_REMOTE:-0}" != 1 ]; then
    echo "SITE_REMOTE=1 needs OPCACHE_REMOTE=1 (the same open hook and fetch budget; OPcache off cannot fit it)" >&2; return 2
  fi
  if [ "${OPCACHE_REMOTE:-0}" = 1 ] && [ "${OPCACHE_A:-0}" != 1 ]; then
    echo "OPCACHE_REMOTE=1 on variant a needs OPCACHE_A=1 (the D1 priming records the file trace the packs follow)" >&2; return 2
  fi
  v=${RECYCLE_WASM_MIB:-}
  if [ -n "$v" ] && { ! [[ "$v" =~ ^[0-9]{2,3}$ ]] || [ "$((10#$v))" -lt 64 ] || [ "$((10#$v))" -gt 240 ]; }; then
    echo "RECYCLE_WASM_MIB must be an integer from 64 to 240, not ${v}" >&2; return 2
  fi
  if [ -n "${PF_ENGINE_JS:-}" ] || [ -n "${PF_ENGINE_WASM:-}" ]; then
    [ -n "${PF_ENGINE_JS:-}" ] && [ -n "${PF_ENGINE_WASM:-}" ] || { echo "PF_ENGINE_JS and PF_ENGINE_WASM: set both or neither" >&2; return 2; }
    [ -s "$PF_ENGINE_JS" ] || { echo "PF_ENGINE_JS is not a file with content: $PF_ENGINE_JS" >&2; return 2; }
    [ -s "$PF_ENGINE_WASM" ] || { echo "PF_ENGINE_WASM is not a file with content: $PF_ENGINE_WASM" >&2; return 2; }
  fi
  return 0
}

# a_opcache_count <opcache.zip>: how many compiled scripts the primed cache holds. An empty or
# unreadable cache is a failure, never a deploy (#625, rollins-sb1114l).
a_opcache_count() {
  local n
  n=$(python3 -I -c 'import sys, zipfile; print(len([i for i in zipfile.ZipFile(sys.argv[1]).infolist() if not i.is_dir()]))' "$1" 2>/dev/null) \
    || { echo "OPCACHE_A=1: $1 is not a readable zip" >&2; return 1; }
  [ "$n" -gt 0 ] || { echo "OPCACHE_A=1: $1 holds 0 compiled scripts" >&2; return 1; }
  echo "  OPcache primed for approach A: $n compiled scripts"
}

# a_vars: the [vars] lines of these settings (nothing when none is set).
a_vars() {
  [ "${OPCACHE_REMOTE:-0}" != 1 ] || echo 'OPCACHE_REMOTE = "on"'
  [ "${SITE_REMOTE:-0}" != 1 ] || echo 'SITE_REMOTE = "on"'
  [ -z "${RECYCLE_WASM_MIB:-}" ] || echo "RECYCLE_WASM_MIB = \"$((10#$RECYCLE_WASM_MIB))\""
  return 0
}

# a_assets_first: the [assets] line a remote build needs. Without /_pf/ first the asset router
# would serve the packs, the site's PHP source and its compiled PHP, to anyone (#412).
a_assets_first() {
  [ "${OPCACHE_REMOTE:-0}" != 1 ] || echo 'run_worker_first = ["/_pf/*"]'
  return 0
}
