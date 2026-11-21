# shellcheck shell=bash
# #1258: POST /_pf/wp-cli. Off unless WP_CLI_ENDPOINT=on.
# On needs a custom domain (#1264) and the same Access application as the wp-admin
# gate (#1260): ACCESS_AUD is that application's AUD, ACCESS_TEAM is the team name.
# #1260 does not write those values yet. The operator sets them to the wp-admin app.
# Secrets are not recorded. Test: deploy/tests/wp-cli-endpoint-test.sh.

# Local engine-check seams (#1258). run.sh writes DEV_LOCAL=1. No deploy path
# renders it. The route honors a seam only when that var is 1 and SPIKE_TOKEN
# is the local dev token. Every deploy path calls this and refuses the var,
# the local token, and the three seam vars.
wp_cli_local_seam_check() {
  [ -z "${DEV_LOCAL:-}" ] || { echo "DEV_LOCAL is set by the local runner only (#1258)" >&2; return 2; }
  [ -z "${WP_CLI_DEV_KEYS_B64:-}" ] || { echo "WP_CLI_DEV_KEYS_B64 is a local engine check only (#1258)" >&2; return 2; }
  [ -z "${WP_CLI_WALL_MS:-}" ] || { echo "WP_CLI_WALL_MS is a local engine check only (#1258)" >&2; return 2; }
  [ -z "${WP_CLI_SLOW_MS:-}" ] || { echo "WP_CLI_SLOW_MS is a local engine check only (#1258)" >&2; return 2; }
  [ "${SPIKE_TOKEN:-}" = local-spike-token ] && { echo "SPIKE_TOKEN must not be the local dev token on a deploy (#1258)" >&2; return 2; }
  return 0
}

wp_cli_endpoint_check() {
  wp_cli_local_seam_check || return 2
  case "${WP_CLI_ENDPOINT:-}" in
    "") return 0 ;;
    on) ;;
    *) echo "WP_CLI_ENDPOINT must be on or unset, not ${WP_CLI_ENDPOINT}" >&2; return 2 ;;
  esac
  [ -n "${CUSTOM_DOMAIN:-}" ] || { echo "WP_CLI_ENDPOINT=on needs CUSTOM_DOMAIN: Access needs a hostname in a zone (#1264, #1260)" >&2; return 2; }
  [ -n "${ACCESS_AUD:-}" ] || { echo "WP_CLI_ENDPOINT=on needs ACCESS_AUD, the wp-admin Access application's AUD (#1260)" >&2; return 2; }
  [ -n "${ACCESS_TEAM:-}" ] || { echo "WP_CLI_ENDPOINT=on needs ACCESS_TEAM, the Cloudflare Access team name (#1260)" >&2; return 2; }
  [[ "$ACCESS_AUD" =~ ^[A-Za-z0-9]{16,128}$ ]] || { echo "ACCESS_AUD must be the application's AUD tag (#1258)" >&2; return 2; }
  [[ "$ACCESS_TEAM" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { echo "ACCESS_TEAM must be one lower-case label, the team name (#1258)" >&2; return 2; }
}

# [vars] lines. Unset prints nothing, so a deploy without the endpoint is unchanged.
wp_cli_endpoint_vars() {
  [ -z "${WP_CLI_ENDPOINT:-}" ] || echo 'WP_CLI_ENDPOINT = "on"'
  [ -z "${ACCESS_AUD:-}" ] || printf 'ACCESS_AUD = "%s"\n' "$ACCESS_AUD"
  [ -z "${ACCESS_TEAM:-}" ] || printf 'ACCESS_TEAM = "%s"\n' "$ACCESS_TEAM"
}
