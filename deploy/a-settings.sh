# shellcheck shell=bash
# The #394 admin fixes for approach A (VARIANT=a: PHP in the Worker, MySQL through Hyperdrive),
# sourced by deploy/deploy.sh. Every setting is off unless it is set, EXCEPT OPCACHE_A, OPCACHE_REMOTE and
# SITE_REMOTE: deploy.sh turns those on by default (#1020, a_remote_pack_defaults in deploy/lib/remote-packs.sh); 0
# opts out of each. The runtime half is already in spikes/b2-wordpress/index.js, which
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
#   PHP_OVERFLOW      1 (the default since #1119: Conrad ruled it on for approach A) or 0 (the explicit opt-out): a
#                     queued PHP request moves to a Durable Object pool instead of waiting behind a long run in its
#                     isolate (#646, docs/approach-a-overflow.md); renders the PhpRuntime binding and its migration.
#                     Unset or empty is the default. The DO tiers are unchanged (variant a only).
#                     always (#714, a MEASUREMENT arm): EVERY eligible request moves, so a Worker isolate never
#                     boots PHP for a shopper request (measured locally: about 65 MiB less per front isolate at
#                     peak). Renders PHP_OVERFLOW = "always" and the same pool. Every query then runs from an
#                     object (26 ms p50 against 8 ms from the placed Worker), so it is not a default.
#   PHP_OVERFLOW_POOL 1 to 128 (default 32, the measured default, #646). Needs overflow on (not 0). The runtime
#                     (overflow.mjs) takes 1 to 128; it ran 129 to 256 as 32, so those are refused here (#714).
#   A_CRON=1            #855: a Workers Cron Trigger and a named PhpRuntime id cron for WP-Cron and Action Scheduler on
#                     Hyperdrive approach A. Unset leaves today's render (no trigger, no DO for cron). PHP_OVERFLOW=on
#                     already renders PHP_RUNTIME; A_CRON=1 without overflow adds that binding and migration.
#                     #1152: after a deploy the cron object can keep the previous build for minutes. Each Cron Trigger
#                     tick carries the Worker's build; a cron object on another build resets itself at the start of its
#                     next leg (at most once per 10 min). deploy.sh then reads /_cron-build for CRON_VERSION_WAIT_S
#                     (default 120) and WARNS, naming both builds, if it has not moved (deploy/lib/cron-version.sh).
#   PHP_OVERFLOW_MAX_HELD off, or 1 to 1000 (#714, #717): the most overflowed requests one Worker isolate holds in
#                     flight. Unset renders nothing: the code default, NO cap (#714 measured a cap of 16 losing 479
#                     requests to save 2). A number caps; off: no cap. Needs PHP_OVERFLOW=1.
#   PHP_OVERFLOW_DEPTH 0 to 50 (#1119): how many requests must already WAIT on a busy isolate before the next one
#                     moves to the pool. Unset renders nothing: the code default 1, under which the first request
#                     behind a long run waits (measured on cf759hx, 2026-11-20). 0 moves that first waiter too. Needs
#                     PHP_OVERFLOW=1 or always.
#   MEM_LEDGER        on or unset: a MEASUREMENT flag (the isolate memory ledger on every request, and the
#                     overflow-held line, #714). Never a default; a deploy without it turns it off.
#   OBJECT_CACHE_VERSIONS 1 (default since #296 step 3) or 0: options in the cross-isolate cache under an exact version (#668, #686),
#                     through aVars. Exact only on a Hyperdrive config that does not cache queries (#650): deploy.sh's
#                     Terraform makes it with caching disabled, and a-render-test.sh holds that line.
#   OBJECT_CACHE_L2   0 (default, #1078) or 1: the object cache's KV L2. Off: on Hyperdrive a cold KV read (95 to 125 ms) costs
#                     more than the query it saves (about 12 ms), and an options write makes every options key cold.
#   WOO_HPOS_CACHE    on (default since #296 step 3; unset is on) or off: WooCommerce's HPOS Data Caching (#697), through
#                     aVars. On approach A its cache (group orders_data) lives for one request only. off leaves WooCommerce's
#                     own setting.
#   PHP_ENGINE (every variant, #771): lean (the default, pinned in spikes/b2-wordpress/engine.lock) or npm.
#   PF_ENGINE_JS and PF_ENGINE_WASM (every variant): another engine's loader and wasm for
#                     prepare.sh, for example the lean-trim artifact of the pagefeather-engine
#                     workflow (#592). Both or neither.

# shellcheck source=lib/memory-reuse.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib/memory-reuse.sh" # #603: one rule with deploy/wfp/lib.sh
# shellcheck source=SCRIPTDIR/lib/remote-packs.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib/remote-packs.sh" # #598: the b-dosql packs, one rule with deploy/wfp/lib.sh

# a_settings_check <variant>: exit status 2 and the reason on stderr when a setting is wrong.
a_settings_check() {
  local variant=$1 v
  if [ "$variant" != a ] && [ "$variant" != b-dosql ]; then
    # #598: the packs are b-dosql's too (on by default there, deploy/lib/remote-packs.sh); b-do and c1 have none.
    for v in OPCACHE_REMOTE SITE_REMOTE; do
      [ -z "${!v:-}" ] || { echo "$v is for variant a or b-dosql only" >&2; return 2; }
    done
  fi
  if [ "$variant" != a ]; then
    for v in OPCACHE_A RECYCLE_WASM_MIB PHP_MEMORY_REUSE BOOT_GATE A_CLIENT A_CRON PHP_OVERFLOW PHP_OVERFLOW_POOL PHP_OVERFLOW_MAX_HELD PHP_OVERFLOW_DEPTH MEM_LEDGER OBJECT_CACHE_VERSIONS WOO_HPOS_CACHE OBJECT_CACHE_L2; do
      [ -z "${!v:-}" ] || { echo "$v is for variant a only (deploy/wfp has its own settings for b-dosql)" >&2; return 2; }
    done
  fi
  case "${A_CRON:-0}" in 0|1) ;; *) echo "A_CRON must be 0 or 1, not ${A_CRON}" >&2; return 2 ;; esac
  case "${OPCACHE_A:-0}" in 0|1) ;; *) echo "OPCACHE_A must be 0 or 1, not ${OPCACHE_A}" >&2; return 2 ;; esac
  case "${OPCACHE_REMOTE:-0}" in 0|1) ;; *) echo "OPCACHE_REMOTE must be 0 or 1, not ${OPCACHE_REMOTE}" >&2; return 2 ;; esac
  case "${SITE_REMOTE:-0}" in 0|1) ;; *) echo "SITE_REMOTE must be 0 or 1, not ${SITE_REMOTE}" >&2; return 2 ;; esac
  if [ "${SITE_REMOTE:-0}" = 1 ] && [ "${OPCACHE_REMOTE:-0}" != 1 ]; then
    echo "SITE_REMOTE=1 needs OPCACHE_REMOTE=1 (the same open hook and fetch budget; OPcache off cannot fit it)" >&2; return 2
  fi
  if [ "$variant" = a ] && [ "${OPCACHE_REMOTE:-0}" = 1 ] && [ "${OPCACHE_A:-0}" != 1 ]; then
    echo "OPCACHE_REMOTE=1 on variant a needs OPCACHE_A=1 (the D1 priming records the file trace the packs follow)" >&2; return 2
  fi
  v=${RECYCLE_WASM_MIB:-}
  if [ -n "$v" ] && { ! [[ "$v" =~ ^[0-9]{2,3}$ ]] || [ "$((10#$v))" -lt 64 ] || [ "$((10#$v))" -gt 240 ]; }; then
    echo "RECYCLE_WASM_MIB must be an integer from 64 to 240, not ${v}" >&2; return 2
  fi
  memory_reuse_check || return 2   # #603: the one rule (deploy/lib/memory-reuse.sh)
  # #724 review, finding 7: not on variant a until measured. The drain and the offer run in timers and continuations
  # of the recycling Worker request, which workerd may cancel at that request's end; b-dosql (one object) is the target.
  if [ "$variant" = a ] && { [ -n "${PHP_MEMORY_REUSE:-}" ] || [ -n "${BOOT_GATE:-}" ]; }; then
    echo "PHP_MEMORY_REUSE is not supported on variant a yet (#724): render it for a b-dosql site with deploy/wfp" >&2; return 2
  fi
  case "${A_CLIENT:-lean}" in lean|mysql2) ;; *) echo "A_CLIENT must be lean or mysql2, not ${A_CLIENT}" >&2; return 2 ;; esac
  case "${PHP_OVERFLOW:-1}" in 0|1|always) ;; *) echo "PHP_OVERFLOW must be 0, 1 or always, not ${PHP_OVERFLOW}" >&2; return 2 ;; esac
  case "${OBJECT_CACHE_VERSIONS:-0}" in 0|1) ;; *) echo "OBJECT_CACHE_VERSIONS must be 0 or 1, not ${OBJECT_CACHE_VERSIONS}" >&2; return 2 ;; esac
  case "${WOO_HPOS_CACHE:-}" in ''|on|off) ;; *) echo "WOO_HPOS_CACHE must be on, off or unset, not ${WOO_HPOS_CACHE}" >&2; return 2 ;; esac
  case "${OBJECT_CACHE_L2:-0}" in 0|1) ;; *) echo "OBJECT_CACHE_L2 must be 0 or 1, not ${OBJECT_CACHE_L2}" >&2; return 2 ;; esac
  v=${PHP_OVERFLOW_POOL:-}
  if [ -n "$v" ] && ! a_overflow_on; then
    echo "PHP_OVERFLOW_POOL needs PHP_OVERFLOW=1 or always" >&2; return 2
  fi
  if [ -n "$v" ] && { ! [[ "$v" =~ ^[0-9]{1,3}$ ]] || [ "$((10#$v))" -lt 1 ] || [ "$((10#$v))" -gt 128 ]; }; then
    echo "PHP_OVERFLOW_POOL must be an integer from 1 to 128, not ${v}" >&2; return 2
  fi
  v=${PHP_OVERFLOW_MAX_HELD:-}
  if [ -n "$v" ] && ! a_overflow_on; then
    echo "PHP_OVERFLOW_MAX_HELD needs PHP_OVERFLOW=1 or always" >&2; return 2
  fi
  if [ -n "$v" ] && [ "$v" != off ] && { ! [[ "$v" =~ ^[0-9]{1,4}$ ]] || [ "$((10#$v))" -lt 1 ] || [ "$((10#$v))" -gt 1000 ]; }; then
    echo "PHP_OVERFLOW_MAX_HELD must be off or an integer from 1 to 1000, not ${v}" >&2; return 2
  fi
  v=${PHP_OVERFLOW_DEPTH:-}
  if [ -n "$v" ] && ! a_overflow_on; then
    echo "PHP_OVERFLOW_DEPTH needs PHP_OVERFLOW=1 or always" >&2; return 2
  fi
  if [ -n "$v" ] && { ! [[ "$v" =~ ^[0-9]{1,2}$ ]] || [ "$((10#$v))" -gt 50 ]; }; then
    echo "PHP_OVERFLOW_DEPTH must be an integer from 0 to 50, not ${v}" >&2; return 2
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

# a_overflow_on: PHP_OVERFLOW is 1 or always (#714), the two settings that render the pool. Unset or empty is 1 (#1119:
# on by default for approach A); 0 is the opt-out.
a_overflow_on() {
  case "${PHP_OVERFLOW:-1}" in 1|always) return 0 ;; esac
  return 1
}
# a_overflow_vars and a_overflow_bindings: PHP_OVERFLOW=1 (#646) or always (#714), the [vars] lines, then the
# PhpRuntime pool with its migration. Nothing when it is off.
a_overflow_vars() {
  a_overflow_on || return 0
  if [ "${PHP_OVERFLOW:-1}" = always ]; then echo 'PHP_OVERFLOW = "always"'; else echo 'PHP_OVERFLOW = "on"'; fi
  echo "PHP_OVERFLOW_POOL = \"$((10#${PHP_OVERFLOW_POOL:-32}))\""
  # #714: unset renders nothing (the code default, no cap); off or a number renders it.
  case "${PHP_OVERFLOW_MAX_HELD:-}" in '') ;; off) echo 'PHP_OVERFLOW_MAX_HELD = "off"' ;; *) echo "PHP_OVERFLOW_MAX_HELD = \"$((10#$PHP_OVERFLOW_MAX_HELD))\"" ;; esac
  # #1119: unset renders nothing (the code default, depth 1); a number renders it.
  [ -z "${PHP_OVERFLOW_DEPTH:-}" ] || echo "PHP_OVERFLOW_DEPTH = \"$((10#$PHP_OVERFLOW_DEPTH))\""
}
a_overflow_bindings() {
  a_overflow_on || return 0
  echo '[[durable_objects.bindings]]'; echo 'name = "PHP_RUNTIME"'; echo 'class_name = "PhpRuntime"'
  echo '[[migrations]]'; echo 'tag = "v1"'; echo 'new_sqlite_classes = ["PhpRuntime"]'
}

# a_cron_on: A_CRON=1 (#855), the deploy gate until live acceptance.
a_cron_on() {
  [ "${A_CRON:-0}" = 1 ]
}
# a_cron_vars, a_cron_triggers, a_cron_bindings: render the cron driver. Bindings are skipped when PHP_OVERFLOW
# is on (the pool binding is the same PhpRuntime class).
a_cron_vars() {
  a_cron_on || return 0
  echo 'A_CRON = "on"'
}
a_cron_triggers() {
  a_cron_on || return 0
  local sched="${A_CRON_CRON:-* * * * *}"
  echo '[triggers]'
  echo "crons = [\"$sched\"]"
}
a_cron_bindings() {
  a_cron_on || return 0
  a_overflow_on && return 0
  echo '[[durable_objects.bindings]]'; echo 'name = "PHP_RUNTIME"'; echo 'class_name = "PhpRuntime"'
  echo '[[migrations]]'; echo 'tag = "v1"'; echo 'new_sqlite_classes = ["PhpRuntime"]'
}
