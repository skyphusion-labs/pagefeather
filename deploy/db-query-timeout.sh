# shellcheck shell=bash
# db_query_timeout_check (#1364, #1359): DB_QUERY_TIMEOUT_MS is digits only, from 1 to
# 600000 (10 minutes). Unset or empty renders nothing, so the engine keeps 30 s.
# A bad value returns 2 and names the setting. The same bounds as queryTimeoutMs in
# spikes/b2-wordpress/connector.mjs, but a bad value stops the deploy instead of
# falling back. One rule for deploy.sh (a-settings.sh), render-conf.sh and
# deploy/wfp kind a (a_inputs_check).
db_query_timeout_check() {
  local v=${DB_QUERY_TIMEOUT_MS:-}
  [ -n "$v" ] || return 0
  if ! [[ "$v" =~ ^[0-9]+$ ]] || ! awk -v x="$v" 'BEGIN { n = x + 0; exit !(n >= 1 && n <= 600000 && n == int(n)) }'; then
    echo "DB_QUERY_TIMEOUT_MS must be an integer from 1 to 600000, not ${v}" >&2
    return 2
  fi
}
