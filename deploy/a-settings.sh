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
#   PHP_MEMORY_REUSE  on or unset: a recycled PHP runtime hands its memory to the next boot (#598, #705).
#   BOOT_GATE         on or unset: a boot that would stack past the budget answers a known 503. Only WITH
#                     PHP_MEMORY_REUSE=on: alone it refuses every reboot until GC (the 503 storm), so it is refused.
# #666, the measured approach-A site. The object cache (L2 in the site's own OC_KV namespace) and lazy MEMFS
# nodes are always rendered, from the ONE source the provisioning path uses (aVars, through
# deploy/provision/a-vars-toml.mjs); deploy/tests/a-render-test.sh diffs the render against the bench config.
#   A_CLIENT          lean (default: index-a-lean.js, the hand-rolled MySQL client every #296 run and
#                     wp-a-lean measured, #218) or mysql2 (index-a.js, what deploy.sh deployed before #666).
#   PHP_OVERFLOW      0 (default) or 1: a queued PHP request moves to a Durable Object pool (#646,
#                     docs/approach-a-overflow.md); renders the PhpRuntime binding and its migration.
#   PHP_OVERFLOW_POOL 1 to 128 (default 32, the measured default, #646). Needs PHP_OVERFLOW=1. The runtime
#                     (overflow.mjs) takes 1 to 128; it ran 129 to 256 as 32, so those are refused here (#714).
#   PHP_OVERFLOW_MAX_HELD off, or 1 to 1000 (#714, #717): the most overflowed requests one Worker isolate holds in
#                     flight. Unset renders nothing: the code default, 16. off: no cap. Needs PHP_OVERFLOW=1.
#   MEM_LEDGER        on or unset: a MEASUREMENT flag (the isolate memory ledger on every request, and the
#                     overflow-held line, #714). Never a default; a deploy without it turns it off.
#   OBJECT_CACHE_VERSIONS 1 (default since #296 step 3) or 0: options in the cross-isolate cache under an exact version (#668, #686),
#                     through aVars. Exact only on a Hyperdrive config that does not cache queries (#650): deploy.sh's
#                     Terraform makes it with caching disabled, and a-render-test.sh holds that line.
#   WOO_HPOS_CACHE    on (default since #296 step 3; unset is on) or off: WooCommerce's HPOS Data Caching (#697), through
#                     aVars. On approach A its cache (group orders_data) lives for one request only. off leaves WooCommerce's
#                     own setting.
#   PF_ENGINE_JS and PF_ENGINE_WASM (every variant): another engine's loader and wasm for
#                     prepare.sh, for example the lean-trim artifact of the pagefeather-engine
#                     workflow (#592). Both or neither.

# shellcheck source=lib/memory-reuse.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib/memory-reuse.sh" # #603: one rule with deploy/wfp/lib.sh

# a_settings_check <variant>: exit status 2 and the reason on stderr when a setting is wrong.
a_settings_check() {
  local variant=$1 v
  if [ "$variant" != a ]; then
    for v in OPCACHE_A OPCACHE_REMOTE SITE_REMOTE RECYCLE_WASM_MIB PHP_MEMORY_REUSE BOOT_GATE A_CLIENT PHP_OVERFLOW PHP_OVERFLOW_POOL PHP_OVERFLOW_MAX_HELD MEM_LEDGER OBJECT_CACHE_VERSIONS WOO_HPOS_CACHE; do
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
  memory_reuse_check || return 2   # #603: the one rule (deploy/lib/memory-reuse.sh)
  case "${A_CLIENT:-lean}" in lean|mysql2) ;; *) echo "A_CLIENT must be lean or mysql2, not ${A_CLIENT}" >&2; return 2 ;; esac
  case "${PHP_OVERFLOW:-0}" in 0|1) ;; *) echo "PHP_OVERFLOW must be 0 or 1, not ${PHP_OVERFLOW}" >&2; return 2 ;; esac
  case "${OBJECT_CACHE_VERSIONS:-0}" in 0|1) ;; *) echo "OBJECT_CACHE_VERSIONS must be 0 or 1, not ${OBJECT_CACHE_VERSIONS}" >&2; return 2 ;; esac
  case "${WOO_HPOS_CACHE:-}" in ''|on|off) ;; *) echo "WOO_HPOS_CACHE must be on, off or unset, not ${WOO_HPOS_CACHE}" >&2; return 2 ;; esac
  v=${PHP_OVERFLOW_POOL:-}
  if [ -n "$v" ] && [ "${PHP_OVERFLOW:-0}" != 1 ]; then
    echo "PHP_OVERFLOW_POOL needs PHP_OVERFLOW=1" >&2; return 2
  fi
  if [ -n "$v" ] && { ! [[ "$v" =~ ^[0-9]{1,3}$ ]] || [ "$((10#$v))" -lt 1 ] || [ "$((10#$v))" -gt 128 ]; }; then
    echo "PHP_OVERFLOW_POOL must be an integer from 1 to 128, not ${v}" >&2; return 2
  fi
  v=${PHP_OVERFLOW_MAX_HELD:-}
  if [ -n "$v" ] && [ "${PHP_OVERFLOW:-0}" != 1 ]; then
    echo "PHP_OVERFLOW_MAX_HELD needs PHP_OVERFLOW=1" >&2; return 2
  fi
  if [ -n "$v" ] && [ "$v" != off ] && { ! [[ "$v" =~ ^[0-9]{1,4}$ ]] || [ "$((10#$v))" -lt 1 ] || [ "$((10#$v))" -gt 1000 ]; }; then
    echo "PHP_OVERFLOW_MAX_HELD must be off or an integer from 1 to 1000, not ${v}" >&2; return 2
  fi
  case "${MEM_LEDGER:-}" in ''|on) ;; *) echo "MEM_LEDGER must be on or unset, not ${MEM_LEDGER}" >&2; return 2 ;; esac
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
  [ "${MEM_LEDGER:-}" != on ] || echo 'MEM_LEDGER = "on"' # #714: a measurement flag, only when set
  memory_reuse_lines
  return 0
}

# a_ocv_install <site url> <spike token> (#734): the options versions table for OBJECT_CACHE_VERSIONS=on, which no
# deploy installed before. A status read first: a complete table is NEVER re-installed (install drops and re-makes the
# triggers, and an options write in that gap would bump no version). Otherwise install, then read back. A provider
# that cannot make triggers answers versioned false: the var is then on but inert (safe; options stay per request),
# said loudly. A failed read or install stops the deploy: the default's state would be unknown. No token is printed.
a_ocv_install() {
  local url=$1 tok=$2 st out
  st=$(curl -s -f -m 60 -K <(printf 'header = "x-spike-token: %s"\n' "$tok") "$url/_ocversions?op=status") \
    || { echo "versions table: the status read failed; OBJECT_CACHE_VERSIONS is on and its state is unknown, so the deploy stops (#734)" >&2; return 1; }
  if python3 -I -c 'import json, sys; sys.exit(0 if json.loads(sys.argv[1]).get("complete") is True else 1)' "$st" 2>/dev/null; then
    echo "  versions table: already complete"; return 0
  fi
  out=$(curl -s -f -m 120 -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$tok") "$url/_ocversions?op=install") \
    || { echo "versions table: the install failed; the deploy stops (#734)" >&2; return 1; }
  if python3 -I -c 'import json, sys; sys.exit(0 if json.loads(sys.argv[1]).get("versioned") is False else 1)' "$out" 2>/dev/null; then
    echo "  WARNING: OBJECT_CACHE_VERSIONS is on but INERT on this site: $(python3 -I -c 'import json, sys; print(str(json.loads(sys.argv[1]).get("reason", ""))[:200])' "$out"). Options stay per request (safe). Deploy with OBJECT_CACHE_VERSIONS=0 to make that explicit."
    return 0
  fi
  st=$(curl -s -f -m 60 -K <(printf 'header = "x-spike-token: %s"\n' "$tok") "$url/_ocversions?op=status") || st='{}'
  if python3 -I -c 'import json, sys; sys.exit(0 if json.loads(sys.argv[1]).get("complete") is True else 1)' "$st" 2>/dev/null; then
    echo "  versions table: installed, complete"; return 0
  fi
  echo "versions table: installed, but the read-back is not complete; the deploy stops (#734)" >&2; return 1
}

# a_assets_first: the [assets] line a remote build needs. Without /_pf/ first the asset router
# would serve the packs, the site's PHP source and its compiled PHP, to anyone (#412).
a_assets_first() {
  [ "${OPCACHE_REMOTE:-0}" != 1 ] || echo 'run_worker_first = ["/_pf/*"]'
  return 0
}

# a_main: the Worker entry (A_CLIENT): the lean MySQL client by default (#218, #666), mysql2 when asked.
a_main() {
  if [ "${A_CLIENT:-lean}" = mysql2 ]; then echo index-a.js; else echo index-a-lean.js; fi
}

# a_overflow_vars and a_overflow_bindings: PHP_OVERFLOW=1 (#646), the [vars] lines, then the PhpRuntime pool
# with its migration. Nothing when it is off.
a_overflow_vars() {
  [ "${PHP_OVERFLOW:-0}" = 1 ] || return 0
  echo 'PHP_OVERFLOW = "on"'
  echo "PHP_OVERFLOW_POOL = \"$((10#${PHP_OVERFLOW_POOL:-32}))\""
  # #714: unset renders nothing (the code default, 16); off or a number renders it.
  case "${PHP_OVERFLOW_MAX_HELD:-}" in '') ;; off) echo 'PHP_OVERFLOW_MAX_HELD = "off"' ;; *) echo "PHP_OVERFLOW_MAX_HELD = \"$((10#$PHP_OVERFLOW_MAX_HELD))\"" ;; esac
}
a_overflow_bindings() {
  [ "${PHP_OVERFLOW:-0}" = 1 ] || return 0
  echo '[[durable_objects.bindings]]'; echo 'name = "PHP_RUNTIME"'; echo 'class_name = "PhpRuntime"'
  echo '[[migrations]]'; echo 'tag = "v1"'; echo 'new_sqlite_classes = ["PhpRuntime"]'
}
