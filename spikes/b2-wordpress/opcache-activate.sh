# shellcheck shell=bash
# WooCommerce's install and activation in the OPcache priming (opcache.sh, file-trace.sh), #677.
# Sourced; needs PORT and SERVER (the pid of the local wrangler dev, from .dev-$PORT.pid) and runs
# in the app dir (dev.log, build/).
#
# Before #677 a failed /_activate was always "WooCommerce did not activate", and /_install's answer
# was discarded. A dev server that died after startup (wrangler's esbuild service, "fatal error:
# all goroutines are asleep - deadlock!", 2026-11-15) read as a WooCommerce problem. #678 named a
# dead server, but matched "fatal error" in any case, so a PHP Fatal error on a live server was
# the same report, and the deadlock line was only the tail of dev.log (missed once it scrolled).
#
# server_alive: the recorded pid is running, /_ping answers, and dev.log has no esbuild deadlock
# line ("fatal error:" or "all goroutines are asleep"). A dead server prints
# "the local dev server died: <that line, or the pid or the missed ping>" and returns 1.
# A PHP "Fatal error" or a wrangler ERROR line is not that deadlock.
# install_dev runs it after /_install and keeps a live server's answer. woo_activate runs it
# before /_activate and again when activation fails, then retries a live server once (#198).
# Test: tests/opcache-server-alive-test.sh and tests/opcache-activate-test.sh.

ACTIVATE_RETRY_S=${ACTIVATE_RETRY_S:-3}

# dev_log_tail [n]: the last lines of dev.log, blank lines and wrangler's log banner dropped.
dev_log_tail() { grep -v '^\s*$' dev.log 2>/dev/null | grep -v '🪵' | tail -"${1:-15}" | cut -c1-300; }

# server_alive: 0 when this run's dev server is still up. A dead server prints one line and returns 1.
server_alive() {
  local line
  # Case-sensitive: esbuild prints lowercase "fatal error:". PHP prints "Fatal error".
  line=$(grep -m 1 -E 'fatal error:|all goroutines are asleep' dev.log 2>/dev/null || true)
  if [ -n "$line" ]; then
    printf 'the local dev server died: %s\n' "${line:0:300}"
    return 1
  fi
  if [ -n "${SERVER:-}" ] && ! kill -0 "$SERVER" 2>/dev/null; then
    printf 'the local dev server died: pid %s is not running\n' "$SERVER"
    return 1
  fi
  if ! curl -s -m 5 -o /dev/null -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" "localhost:${PORT}/_ping"; then
    printf 'the local dev server died: nothing answers /_ping on port %s\n' "$PORT"
    return 1
  fi
  return 0
}

# install_dev: POST /_install. Keeps the answer. Names a dead server before any plugin is blamed.
# 0 only when a live server answered HTTP 200.
install_dev() {
  local code
  mkdir -p build
  code=$(curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -s -m 300 -o build/install.out -w '%{http_code}' \
    -X POST -H "x-admin-password: ${ADMIN_PASSWORD:-local-spike-password}" "localhost:${PORT}/_install") || code=000
  if ! server_alive; then
    echo "Last lines of dev.log:"
    dev_log_tail
    return 1
  fi
  if [ "$code" != 200 ]; then
    echo "the install answered HTTP $code. The tail of its answer:"
    tr -c '[:print:]\n' ' ' < build/install.out | tail -c 1200
    echo
    echo "Last lines of dev.log:"
    dev_log_tail
    return 1
  fi
  return 0
}

# woo_activate: activate WooCommerce through the local /_activate; 0 when it reports active.
woo_activate() {
  local try code
  mkdir -p build
  if ! server_alive; then
    echo "Last lines of dev.log:"
    dev_log_tail
    return 1
  fi
  for try in 1 2; do
    code=$(curl -s -m 300 -o build/activate.out -w '%{http_code}' -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -X POST \
      -H "x-admin-password: ${ADMIN_PASSWORD:-local-spike-password}" "localhost:${PORT}/_activate?plugin=woocommerce/woocommerce.php") || code=000
    if [ "$code" = 200 ] && grep -q '\\"active\\":true' build/activate.out; then return 0; fi
    if ! server_alive; then
      echo "Last lines of dev.log:"
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
