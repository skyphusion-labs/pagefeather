#!/bin/bash
# Run one upstream browser suite (#759) on a Vultr VPS. Never on Conrad's laptop: the suites drive
# a browser for hours, and load or long runs never run from it.
#
#   vps-run.sh install  <suite> <work-dir>             clone the suite at its pin, install it
#   vps-run.sh baseline <suite> <work-dir> <run-dir>   run it on STOCK upstream (wp-env, Docker)
#   vps-run.sh run      <suite> <work-dir> <run-dir>   run it on OUR throwaway (needs <run-dir>/env)
#   suites: wp (wordpress-develop), wc (WooCommerce core profile), wc-api (its api-tests, the same checkout),
#           wc-cpt (the wc @hpos tests with HPOS OFF, upstream envs/default-hpos-disabled; the same checkout), gb (Gutenberg)
#
# DRY=1 prints the commands and runs nothing. Before "run": build the throwaway with the line from
# prepare-content.sh, deploy it, then "runner.py prepare" writes <run-dir>/env. After both runs:
#   runner.py summarize --report <run-dir>/report.json --out <run-dir>/results.json   (each run)
#   runner.py compare --baseline <base-run>/results.json --ours <our-run>/results.json
# The install and baseline steps follow each upstream README at the pin. Their first real run is on
# the VPS; check the printed commands against the README of that pin if a step fails.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/pins.env"
act=${1:?usage: vps-run.sh install|baseline|run <suite> <work-dir> [run-dir]}
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
need_run_dir() { run=${1:?run-dir}; x mkdir -p "$run"; }
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
  x python3 -I "$here/runner.py" config --suite "$suite" --suite-dir "$src/$e2e" --run-dir "$run"
  case "$suite" in
    wc|wc-api|wc-cpt) # Two phases, so the login is asserted BEFORE any test (lead ruling): the setup projects
        # (global authentication, site setup; install wc is dropped in pf-conformance.config.mjs),
        # then check-state on both saved logins, then the tests alone. WP and Gutenberg use globalSetup.
        local st=$src/$e2e/.state rc=0
        # The setup phase writes the same report.json as the tests. It must never survive as "the results":
        # remove it after phase 1, whatever phase 1 did. A failed setup or login is a STOP (exit 3), not a result.
        x rm -f "$run/report.json"
        in_dir "$src/plugins/woocommerce" pnpm exec playwright test --config=tests/e2e/pf-conformance.config.mjs --project="site setup" || rc=$?
        x rm -f "$run/report.json"
        [ "$rc" = 0 ] || { echo "vps-run: STOP: the setup projects failed (rc $rc)" >&2; exit 3; }
        x python3 -I "$here/runner.py" check-state --base-url "${BASE_URL:-http://localhost:${WP_ENV_PORT:-8086}}" --state "$st/admin.json" --state "$st/customer.json" \
          || { echo "vps-run: STOP: check-state (the saved login is not real)" >&2; exit 3; }
        local proj=e2e-pf; [ "$suite" = wc-api ] && proj=api-pf; [ "$suite" = wc-cpt ] && proj=e2e-cpt
        in_dir "$src/plugins/woocommerce" pnpm exec playwright test --config=tests/e2e/pf-conformance.config.mjs --project="$proj" --no-deps ;;
    # Media specs copy ./assets/ from the process directory. Upstream cwd is test/e2e (#980).
    gb) in_dir "$src/$e2e" npx playwright test --config=pf-conformance.config.mjs ;;
    *) in_dir "$d" npx playwright test --config="$e2e/pf-conformance.config.mjs" ;;
  esac
}

case "$act" in
  install)
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
          # The pin's playwright.config.ts starts chromium, webkit (@webkit) and firefox (@firefox) (#1000).
          in_dir "$src" npx playwright install --with-deps chromium firefox webkit ;;
    esac
    ;;
  baseline)
    need_run_dir "${4:-}"
    # Stock upstream at the same pins, in Docker (wp-env). WP_ENV_CORE pins core to 7.1.4 where the
    # suite's own env file names a branch. The default credentials are admin / password.
    # The baseline must not see our throwaway: unset the names the suites read (a caller may export them).
    unset BASE_URL WP_BASE_URL ADMIN_USER ADMIN_PASSWORD WP_USERNAME WP_PASSWORD CUSTOMER_USER CUSTOMER_USERNAME CUSTOMER_PASSWORD
    # Stop this suite's env on exit: the wordpress-develop and Gutenberg envs both use port 8889.
    case "$suite" in
      wp) trap 'in_dir "$src" npm run env:stop || true' EXIT ;;
      wc|wc-api|wc-cpt) trap 'in_dir "$src/plugins/woocommerce" pnpm env:e2e:stop || true' EXIT ;;
      gb) trap 'in_dir "$src" npm run wp-env-test -- stop || true' EXIT ;;
    esac
    case "$suite" in
      wp) in_dir "$src" npm run build:dev; in_dir "$src" npm run env:start; in_dir "$src" npm run env:install ;;
      wc|wc-api|wc-cpt) in_dir "$src/plugins/woocommerce" env WP_ENV_CORE=WordPress/WordPress#7.1.4 pnpm env:e2e ;;
      gb) in_dir "$src" env WP_ENV_CORE=WordPress/WordPress#7.1.4 npm run wp-env-test -- start ;;
    esac
    playwright "$src"
    ;;
  run)
    need_run_dir "${4:-}"
    [ "${DRY:-0}" = 1 ] || [ -f "$run/env" ] || { echo "vps-run: no $run/env; run runner.py prepare first" >&2; exit 2; }
    # The env file holds the passwords: it is sourced, never printed.
    if [ "${DRY:-0}" = 1 ]; then echo "+ . $run/env"; else . "$run/env"; fi
    [ "${DRY:-0}" = 1 ] || [ "${PF_CONFORMANCE_SUITE:-}" = "$suite" ] || { echo "vps-run: $run/env is for suite '${PF_CONFORMANCE_SUITE:-}', not '$suite'" >&2; exit 2; }
    playwright "$src"
    ;;
  *) echo "vps-run: unknown action '$act' (install baseline run)" >&2; exit 2 ;;
esac