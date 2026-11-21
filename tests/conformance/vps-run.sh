#!/bin/bash
# Run one upstream browser suite (#759) on a Vultr VPS. Never on Conrad's laptop: the suites drive
# a browser for hours, and load or long runs never run from it.
#
#   vps-run.sh install  <suite> <work-dir>             clone the suite at its pin, install it
#   vps-run.sh baseline <suite> <work-dir> <run-dir>   run it on STOCK upstream (wp-env, Docker)
#   vps-run.sh run      <suite> <work-dir> <run-dir>   run it on OUR throwaway (needs <run-dir>/env)
#   vps-run.sh collect  <suite> <work-dir> <run-dir> <tarball>   tar the run's Playwright outputDir copy (#1211)
#   box toolchain: git, Node (each suite pins its own), Docker for the baselines, and for wc also php-cli and composer
#   suites: wp (wordpress-develop), wc (WooCommerce core profile), wc-api (its api-tests, the same checkout),
#           wc-cpt (the wc @hpos tests with HPOS OFF, upstream envs/default-hpos-disabled; the same checkout), gb (Gutenberg)
#
# PF_SPECS="<filter> ..." (run only): passed to the TEST phase as Playwright file filters (a subset run, e.g. the #1008
# A/B: PF_SPECS="tests/product/"). The setup phase and check-state always run in full. A subset is recorded as one.
# Filters are relative to Playwright's working directory: plugins/woocommerce for wc, test/e2e for gb, the repo for wp.
#
# PF_BROWSER=browser-run (run only) puts the browsers on Cloudflare Browser Run, Chromium only; PF_WORKERS sets the
# worker count there (default 1: the specs share one site's state). A Browser Run row is never mixed with a local-browser row: the Chromium differs.
#
# BASELINE_WITHOUT_GUTENBERG_PLUGIN=1 (gb baseline only): the stock arm is core 7.1.4 alone, with the Gutenberg plugin NOT
# mounted (upstream's .wp-env.test.json mounts it; our sites do not ship it). Its failures that are also ours are
# "needs the Gutenberg plugin", not ours.
# PF_TIER (run and baseline) names the tier ("Free DO", "Paid DO", "WfP", "Hyperdrive"): an exclude row that starts with
# "[<tier>]" skips its spec on that tier only. Without PF_TIER no tier-scoped row applies, so the spec runs.
#
# DRY=1 prints the commands and runs nothing. Before "run": build the throwaway with the line from
# prepare-content.sh, deploy it, then "runner.py prepare" writes <run-dir>/env. After both runs:
#   runner.py summarize --report <run-dir>/report.json --out <run-dir>/results.json   (each run)
#   runner.py compare --baseline <base-run>/results.json --ours <our-run>/results.json
# The install and baseline steps follow each upstream README at the pin. Their first real run is on
# the VPS; check the printed commands against the README of that pin if a step fails.
set -euo pipefail
# Run from a private COPY of this script (sb1120: a branch switch in the clone rewrote vps-run.sh under two running
# suites). The first start copies the script to a temp file and re-execs that copy once (PF_VPS_RUN_SELF guards the
# loop). The copy unlinks itself at once; bash keeps reading the open file. "here" stays the real tests/conformance, so
# pins.env, runner.py and the rest are found as before. Only this script is frozen: runner.py is read at each call.
if [ -z "${PF_VPS_RUN_SELF:-}" ]; then
  orig_here=$(cd "$(dirname "$0")" && pwd)
  self=$(mktemp "${TMPDIR:-/tmp}/vps-run.XXXXXX")
  cp "$orig_here/$(basename "$0")" "$self"
  PF_VPS_RUN_SELF=$self PF_VPS_RUN_HERE=$orig_here exec bash "$self" "$@"
fi
# Remove only the copy this process is running, never a path the caller named.
[ "$0" = "$PF_VPS_RUN_SELF" ] && rm -f "$0"
echo "vps-run: running a private copy of itself (from ${PF_VPS_RUN_HERE:?})" >&2
here=$PF_VPS_RUN_HERE
unset PF_VPS_RUN_SELF PF_VPS_RUN_HERE
. "$here/pins.env"
act=${1:?usage: vps-run.sh install|baseline|run|collect <suite> <work-dir> [run-dir] [tarball]}
suite=${2:?suite: wp wc wc-api wc-cpt gb}
work=${3:?work-dir}
case "$suite" in
  wp) repo=$WP_DEVELOP_REPO sha=$WP_DEVELOP_SHA e2e=tests/e2e ;;
  wc|wc-api|wc-cpt) repo=$WC_REPO sha=$WC_SHA e2e=plugins/woocommerce/tests/e2e ;;
  gb) repo=$GB_REPO sha=$GB_SHA e2e=test/e2e ;;
  *) echo "vps-run: unknown suite '$suite' (wp wc wc-api wc-cpt gb)" >&2; exit 2 ;;
esac
# wc-api and wc-cpt share the wc checkout (one clone, one install).
case "$suite" in wc-api|wc-cpt) co=wc ;; *) co=$suite ;; esac
src=$work/$co-$sha
x() { echo "+ $*"; [ "${DRY:-0}" = 1 ] || "$@"; }
in_dir() { local d=$1; shift; echo "+ (cd $d && $*)"; [ "${DRY:-0}" = 1 ] || (cd "$d" && "$@"); }
# Playwright's call log for a failed request prints the request headers, Authorization included (the seed's
# application password, sb1120 cf759hl). Each Playwright command runs through pw: its output passes a filter that masks
# Authorization values before any log file sees them, synchronously, and pw returns Playwright's own exit status.
redact_auth() { perl -pe 'BEGIN { $| = 1 } s/(authorization["'"'"']?\s*[:=]\s*["'"'"']?)(basic|bearer)\s+[A-Za-z0-9+\/=._~-]+/$1$2 <redacted>/gi'; }
pw() { "$@" 2>&1 | redact_auth; return "${PIPESTATUS[0]}"; }
need_run_dir() { run=${1:?run-dir}; x mkdir -p "$run"; }
# run and baseline refuse a checkout whose HEAD is not the pin. install checks it once; this closes the drift after
# install (a checkout moved by hand, or a stale clone): every arm must run the one pinned suite (#1158, #1201).
need_pinned_head() {
  [ "${DRY:-0}" = 1 ] && return 0
  local head
  head=$(git -C "$src" rev-parse HEAD 2>/dev/null) || { echo "vps-run: STOP: $src is not a git checkout (run install first)" >&2; exit 3; }
  [ "$head" = "$sha" ] || { echo "vps-run: STOP: $src is at $head, not the pin $sha" >&2; exit 3; }
}
# Gutenberg build.mjs runs one tsc project at a time when CI is set (conf759 2120z: parallel tsc OOM on vc2-4c-8gb after wp+wc).
gb_run_build() {
  local try=$1
  local log="$work/.gb-build-try-${try}.log"
  if [ "${DRY:-0}" = 1 ]; then
    echo "+ (cd $src && env CI=true NODE_OPTIONS=--max-old-space-size=6144 npm run build)  # attempt $try"
    return 0
  fi
  echo "+ (cd $src && env CI=true NODE_OPTIONS=--max-old-space-size=6144 npm run build)  # attempt $try, log $log"
  if (cd "$src" && env CI=true NODE_OPTIONS=--max-old-space-size=6144 npm run build) >"$log" 2>&1; then
    return 0
  fi
  echo "vps-run: gb install attempt $try failed; last lines:" >&2
  tail -n 30 "$log" >&2 2>/dev/null || true
  return 1
}
playwright() { # dir config: run Playwright with OUR wrapper config (exclusions, one worker, JSON report)
  local d=$1
  local -a specs=()
  # PF_SPECS: word-split on spaces on purpose (each word is one Playwright file filter).
  [ -z "${PF_SPECS:-}" ] || read -r -a specs <<< "$PF_SPECS"
  [ "${#specs[@]}" = 0 ] || echo "vps-run: SUBSET run, file filters: ${specs[*]}"
  # PF_BROWSER=browser-run: the browsers are Cloudflare Browser Run (hosted Chromium over CDP), not local ones.
  # pf-browser-run.cjs is preloaded into the runner and each worker; it needs PF_BROWSER_RUN_ACCOUNT and
  # PF_BROWSER_RUN_TOKEN_FILE (never the token itself). Each worker logs "@event browser-run" with the remote version.
  if [ "${PF_BROWSER:-}" = browser-run ]; then
    [ -n "${PF_BROWSER_RUN_ACCOUNT:-}" ] && [ -s "${PF_BROWSER_RUN_TOKEN_FILE:-/nonexistent}" ] \
      || { echo "vps-run: STOP: PF_BROWSER=browser-run needs PF_BROWSER_RUN_ACCOUNT and a non-empty PF_BROWSER_RUN_TOKEN_FILE" >&2; exit 3; }
    export NODE_OPTIONS="--require $here/pf-browser-run.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}"
    echo "vps-run: BROWSER RUN (Cloudflare, hosted Chromium over CDP), workers ${PF_WORKERS:-1}"
  fi
  x python3 -I "$here/runner.py" config --suite "$suite" --suite-dir "$src/$e2e" --run-dir "$run" ${pf_stock:+--stock} ${PF_TIER:+--tier "$PF_TIER"}
  case "$suite" in
    wc|wc-api|wc-cpt) # Two phases, so the login is asserted BEFORE any test (lead ruling): the setup projects
        # (global authentication, site setup; install wc is dropped in pf-conformance.config.mjs),
        # then check-state on both saved logins, then the tests alone. WP and Gutenberg use globalSetup.
        local st=$src/$e2e/.state rc=0
        # The setup phase writes the same report.json as the tests. It must never survive as "the results":
        # remove it after phase 1, whatever phase 1 did. A failed setup or login is a STOP (exit 3), not a result.
        x rm -f "$run/report.json"
        in_dir "$src/plugins/woocommerce" pw pnpm exec playwright test --config=tests/e2e/pf-conformance.config.mjs --project="site setup" || rc=$?
        x rm -f "$run/report.json"
        [ "$rc" = 0 ] || { echo "vps-run: STOP: the setup projects failed (rc $rc)" >&2; exit 3; }
        x python3 -I "$here/runner.py" check-state --base-url "${BASE_URL:-http://localhost:${WP_ENV_PORT:-8086}}" --state "$st/admin.json" --state "$st/customer.json" \
          || { echo "vps-run: STOP: check-state (the saved login is not real)" >&2; exit 3; }
        # The test projects. Ours (pf-conformance.config.mjs, run arm): e2e-pf, api-pf, e2e-cpt. The stock arm keeps
        # upstream's own projects (#1161), which have no e2e-pf: there the same tests are core-serial plus core-parallel
        # (e2e-pf is every spec under tests/ less our rows, and those rows drop blocks/**, api-tests/** and paypal), and the
        # API half is upstream's "api" (wcbase-wc4: 'Project(s) "e2e-pf" not found').
        local -a projs
        if [ -n "${pf_stock:-}" ]; then
          case "$suite" in wc) projs=(core-serial core-parallel) ;; wc-api) projs=(api) ;;
            *) echo "vps-run: STOP: no stock test projects for $suite" >&2; exit 3 ;; esac
        else
          case "$suite" in wc) projs=(e2e-pf) ;; wc-api) projs=(api-pf) ;; wc-cpt) projs=(e2e-cpt) ;; esac
        fi
        local -a pargs=()
        local pj; for pj in "${projs[@]}"; do pargs+=("--project=$pj"); done
        rc=0
        in_dir "$src/plugins/woocommerce" pw pnpm exec playwright test --config=tests/e2e/pf-conformance.config.mjs "${pargs[@]}" --no-deps ${specs[@]+"${specs[@]}"} || rc=$?
        # The wc checkout keeps one test-results folder for every run: copy this run's traces into the run dir, so the
        # next run cannot overwrite the evidence (sb1120: the wc-api traces were gone after the next wc run).
        if [ "${DRY:-0}" != 1 ] && [ -d "$src/$e2e/test-results" ]; then rm -rf "$run/test-results"; cp -R "$src/$e2e/test-results" "$run/test-results"; fi
        return "$rc" ;;
    # Media specs copy ./assets/ from the process directory. Upstream cwd is test/e2e (#980).
    gb) in_dir "$src/$e2e" pw npx playwright test --config=pf-conformance.config.mjs ${specs[@]+"${specs[@]}"} ;;
    *) in_dir "$d" pw npx playwright test --config="$e2e/pf-conformance.config.mjs" ${specs[@]+"${specs[@]}"} ;;
  esac
}

case "$act" in
  install)
    # WooCommerce's postinstall runs "composer install", so the box needs php-cli and composer (wcbase-wc1 died there).
    case "$suite" in wc|wc-api|wc-cpt)
      if [ "${DRY:-0}" != 1 ]; then
        for tool in php composer; do
          command -v "$tool" >/dev/null 2>&1 \
            || { echo "vps-run: STOP: the wc install needs $tool on the box (php-cli and composer: WooCommerce's postinstall runs composer install)" >&2; exit 3; }
        done
      fi ;;
    esac
    x mkdir -p "$work"
    [ -d "$src/.git" ] || { x git init -q "$src"; x git -C "$src" remote add origin "$repo"; }
    x git -C "$src" fetch -q --depth 1 origin "$sha"
    x git -C "$src" checkout -q FETCH_HEAD
    if [ "${DRY:-0}" != 1 ] && [ "$(git -C "$src" rev-parse HEAD)" != "$sha" ]; then
      echo "vps-run: HEAD is not the pin $sha; refused" >&2; exit 1
    fi
    case "$suite" in
      wp) in_dir "$src" npm ci; in_dir "$src" npx playwright install --with-deps chromium ;;
      wc|wc-api|wc-cpt) in_dir "$src" corepack enable
          in_dir "$src" pnpm install --frozen-lockfile --filter=@woocommerce/plugin-woocommerce...
          # External throwaway needs the built package (pnpm install leaves source only).
          in_dir "$src" pnpm --filter=@woocommerce/e2e-utils-playwright run build
          in_dir "$src/plugins/woocommerce" pnpm exec playwright install --with-deps chromium ;;
      # Gutenberg 23.6 dropped build:packages; the pin uses npm run build (conf759 STOP 2026-11-17).
      gb) in_dir "$src" npm ci
          in_dir "$src" npm run clean:packages
          in_dir "$src" npm run clean:package-types
          in_dir "$src" npm rebuild esbuild 2>/dev/null || in_dir "$src" node ./node_modules/esbuild/install.js 2>/dev/null || true
          gb_build=0
          for gb_try in 1 2 3; do
            if gb_run_build "$gb_try"; then gb_build=1; break; fi
            echo "vps-run: gb install attempt $gb_try failed; retrying after clean" >&2
            in_dir "$src" npm run clean:packages
            in_dir "$src" npm run clean:package-types
            in_dir "$src" npm rebuild esbuild 2>/dev/null || true
            [ "$gb_try" = 2 ] && in_dir "$src" rm -rf node_modules/.cache
          done
          [ "$gb_build" = 1 ] || { echo "vps-run: STOP: gb build failed after 3 attempts (Gutenberg tsc; see install log tail)" >&2; exit 3; }
          in_dir "$src" npx playwright install --with-deps chromium ;;
    esac
    ;;
  baseline)
    need_run_dir "${4:-}"
    need_pinned_head
    # Stock upstream at the same pins, in Docker (wp-env). WP_ENV_CORE pins core to 7.1.4 where the
    # suite's own env file names a branch. The default credentials are admin / password.
    # The baseline must not see our throwaway: unset the names the suites read (a caller may export them).
    unset BASE_URL WP_BASE_URL ADMIN_USER ADMIN_PASSWORD WP_USERNAME WP_PASSWORD CUSTOMER_USER CUSTOMER_USERNAME CUSTOMER_PASSWORD
    # The baseline's wrapper config is --stock (#1112): upstream's own baseURL, storageState and globalSetup, so the
    # stock run targets wp-env the way upstream does. Only the exclusions, one worker and the JSON report are ours.
    pf_stock=1
    # Stop this suite's env on exit: the wordpress-develop and Gutenberg envs both use port 8889.
    case "$suite" in
      wp) trap 'in_dir "$src" npm run env:stop || true' EXIT ;;
      wc|wc-api|wc-cpt) trap 'in_dir "$src/plugins/woocommerce" pnpm env:e2e:stop || true' EXIT ;;
      gb) if [ "${BASELINE_WITHOUT_GUTENBERG_PLUGIN:-0}" = 1 ]; then
            trap 'in_dir "$src" npx wp-env --config .wp-env.test-without-gutenberg-plugin.json stop || true' EXIT
          else
            trap 'in_dir "$src" npm run wp-env-test -- stop || true' EXIT
          fi ;;
    esac
    case "$suite" in
      wp) in_dir "$src" npm run build:dev; in_dir "$src" npm run env:start; in_dir "$src" npm run env:install ;;
      # The stock arm mounts WooCommerce from SOURCE, so it must be BUILT first, as the e2e README at the pin says
      # ("pnpm --filter='@woocommerce/plugin-woocommerce' build", then env:e2e). Unbuilt, WooCommerce's first boot is a
      # fatal on includes/react-admin/feature-config.php (wcbase-wc2). Our run arm serves a built WooCommerce and skips it.
      wc|wc-api|wc-cpt) in_dir "$src" env NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter=@woocommerce/plugin-woocommerce build
          [ "${DRY:-0}" = 1 ] || [ -f "$src/plugins/woocommerce/includes/react-admin/feature-config.php" ] \
            || { echo "vps-run: STOP: the WooCommerce build left no includes/react-admin/feature-config.php" >&2; exit 3; }
          in_dir "$src/plugins/woocommerce" env WP_ENV_CORE=WordPress/WordPress#7.1.4 pnpm env:e2e ;;
      # BASELINE_WITHOUT_GUTENBERG_PLUGIN=1: the stock arm is core 7.1.4 ALONE, as our sites are (none ships the
      # Gutenberg plugin; upstream's env mounts it). runner.py writes the env file without the two plugin mounts.
      gb) if [ "${BASELINE_WITHOUT_GUTENBERG_PLUGIN:-0}" = 1 ]; then
            echo "vps-run: BASELINE WITHOUT THE GUTENBERG PLUGIN (core 7.1.4 alone)"
            x python3 -I "$here/runner.py" wp-env-without-gutenberg-plugin --suite-dir "$src" || exit 3
            in_dir "$src" env WP_ENV_CORE=WordPress/WordPress#7.1.4 npx wp-env --config .wp-env.test-without-gutenberg-plugin.json start
          else
            in_dir "$src" env WP_ENV_CORE=WordPress/WordPress#7.1.4 npm run wp-env-test -- start
          fi ;;
    esac
    playwright "$src"
    ;;
  run)
    need_run_dir "${4:-}"
    need_pinned_head
    [ "${DRY:-0}" = 1 ] || [ -f "$run/env" ] || { echo "vps-run: no $run/env; run runner.py prepare first" >&2; exit 2; }
    # The env file holds the passwords: it is sourced, never printed.
    if [ "${DRY:-0}" = 1 ]; then echo "+ . $run/env"; else . "$run/env"; fi
    [ "${DRY:-0}" = 1 ] || [ "${PF_CONFORMANCE_SUITE:-}" = "$suite" ] || { echo "vps-run: $run/env is for suite '${PF_CONFORMANCE_SUITE:-}', not '$suite'" >&2; exit 2; }
    playwright "$src"
    ;;
  collect)
    # #1211: the traces, screenshots and videos of a run are Playwright's outputDir, which the wc arm copies to
    # <run-dir>/test-results after each run. A driver that tarred another folder (sb1120 wcb2: <run-dir>/artifacts) got an
    # empty archive and lost every trace. So the collect step lives here, next to the copy, and an empty one is a STOP.
    run=${4:?run-dir}; out=${5:?tarball}
    [ -d "$run/test-results" ] || { echo "vps-run: STOP: no $run/test-results to collect (did the run reach its test phase?)" >&2; exit 3; }
    n_all=$(find "$run/test-results" -type f | wc -l | tr -d ' ')
    [ "$n_all" -gt 0 ] || { echo "vps-run: STOP: $run/test-results has no files" >&2; exit 3; }
    x tar -czf "$out" -C "$run" test-results
    echo "vps-run: collected $n_all files from $run/test-results into $out: $(find "$run/test-results" -name trace.zip | wc -l | tr -d ' ') trace.zip, $(find "$run/test-results" -name '*.png' | wc -l | tr -d ' ') png, $(find "$run/test-results" -name '*.webm' | wc -l | tr -d ' ') webm"
    ;;
  *) echo "vps-run: unknown action '$act' (install baseline run collect)" >&2; exit 2 ;;
esac