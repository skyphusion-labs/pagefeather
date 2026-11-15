# Sourced by opcache.sh and file-trace.sh (#682). Both build against a LOCAL dev server (run.sh), which
# must run on the local token and admin password. Before, they took SPIKE_TOKEN and ADMIN_PASSWORD from
# the caller, so a caller with a site's real values exported started the local server on the real token
# and sent the wrong password: /_activate ran as a non-operator, answered 200 with an empty body, and
# WooCommerce did not activate (four ggc.sh updates, 2026-11-15).
# local_creds pins the local values for this script and everything it starts, and names (never prints)
# each variable it ignored. Test: tests/local-creds-test.sh.
local_creds() {
  local v want
  for v in SPIKE_TOKEN ADMIN_PASSWORD; do
    case $v in SPIKE_TOKEN) want=local-spike-token;; ADMIN_PASSWORD) want=local-spike-password;; esac
    if [ -n "${!v:-}" ] && [ "${!v}" != "$want" ]; then
      echo "note: $v from the caller's environment is ignored; the local dev server uses its local value (#682)" >&2
    fi
  done
  export SPIKE_TOKEN=local-spike-token ADMIN_PASSWORD=local-spike-password
}
