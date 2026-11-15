# shellcheck shell=bash
# WooCommerce's activation in the OPcache priming (opcache.sh), #677. Sourced; needs PORT and SERVER (the
# pid of the local wrangler dev, from .dev-$PORT.pid) and runs in the app dir (dev.log, build/).
#
# Before #677 opcache.sh tried /_activate ONCE and reported any failure as "WooCommerce did not activate",
# with no answer: a local dev server that died after startup (wrangler's esbuild service, "fatal error:
# all goroutines are asleep - deadlock!", 2026-11-15) read as a WooCommerce problem, and the activation's
# own answer was never shown. Now:
#   - a dead dev server (its process gone, /_ping not answering, or a fatal error in dev.log) is named, with
#     the dev.log lines, and never blamed on WooCommerce;
#   - a failed activation on a live server is retried once (a first activation can lose to a cold
#     runtime, #198; deploy.sh's ACT_TRIES does the same);
#   - a second failure names the HTTP status and the tail of the activation's answer, and dev.log's tail.
# Test: tests/opcache-activate-test.sh.

ACTIVATE_RETRY_S=${ACTIVATE_RETRY_S:-3}

# dev_log_tail [n]: the last lines of dev.log, blank lines and wrangler's log banner dropped.
dev_log_tail() { grep -v '^\s*$' dev.log 2>/dev/null | grep -v '🪵' | tail -"${1:-15}" | cut -c1-300; }

# dev_dead: prints why the local dev server is dead (and returns 0), or returns 1 when it is alive.
dev_dead() {
  if grep -qiE 'fatal error|all goroutines are asleep' dev.log 2>/dev/null; then echo "a fatal error in dev.log"; return 0; fi
  if [ -n "${SERVER:-}" ] && ! kill -0 "$SERVER" 2>/dev/null; then echo "its process $SERVER is gone"; return 0; fi
  curl -s -m 5 -o /dev/null -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" "localhost:$PORT/_ping" || { echo "it does not answer /_ping on port $PORT"; return 0; }
  return 1
}

# woo_activate: activate WooCommerce through the local /_activate; 0 when it reports active.
woo_activate() {
  local try code why
  mkdir -p build
  for try in 1 2; do
    code=$(curl -s -m 300 -o build/activate.out -w '%{http_code}' -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -X POST \
      -H "x-admin-password: ${ADMIN_PASSWORD:-local-spike-password}" "localhost:$PORT/_activate?plugin=woocommerce/woocommerce.php") || code=000
    if [ "$code" = 200 ] && grep -q '\\"active\\":true' build/activate.out; then return 0; fi
    if why=$(dev_dead); then
      echo "the local dev server died ($why) during the WooCommerce activation (try $try); this is the local tooling, not WooCommerce. Last lines of dev.log:"
      dev_log_tail
      return 1
    fi
    [ "$try" = 1 ] && { echo "WooCommerce activation try 1 answered HTTP $code; the dev server is alive, so it is tried once more"; sleep "$ACTIVATE_RETRY_S"; }
  done
  echo "WooCommerce did not activate: /_activate answered HTTP $code twice (the dev server is alive). The tail of its answer:"
  tr -c '[:print:]\n' ' ' < build/activate.out | tail -c 1200
  echo
  echo "Last lines of dev.log:"
  dev_log_tail
  return 1
}
