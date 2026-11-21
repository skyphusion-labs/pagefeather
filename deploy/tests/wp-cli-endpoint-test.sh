#!/bin/bash
# #1258: WP_CLI_ENDPOINT is off unless it is exactly on, and on needs a custom
# domain plus the Access AUD and team. No Cloudflare. No secret is recorded.
#   deploy/tests/wp-cli-endpoint-test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
# shellcheck source=../lib/wp-cli-endpoint.sh
. "$ROOT/deploy/lib/wp-cli-endpoint.sh"
run() { env -i PATH="$PATH" "$@" bash -c '. "'"$ROOT"'/deploy/lib/wp-cli-endpoint.sh"; wp_cli_endpoint_check'; }
vars() { env -i PATH="$PATH" "$@" bash -c '. "'"$ROOT"'/deploy/lib/wp-cli-endpoint.sh"; wp_cli_endpoint_vars'; }

run; rc=$?
ok "unset passes and changes nothing (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
run WP_CLI_DEV_KEYS_B64=abc >/tmp/wp-cli-1258.out 2>/tmp/wp-cli-1258.err; rc=$?
ok "a dev key is refused on a deploy (rc $rc)" "$([ $rc = 2 ] && grep -q 'local engine check' /tmp/wp-cli-1258.err && echo 1 || echo 0)"
run WP_CLI_WALL_MS=200 >/tmp/wp-cli-1258.out 2>/tmp/wp-cli-1258.err; rc=$?
ok "a short wall is refused on a deploy (rc $rc)" "$([ $rc = 2 ] && grep -q 'WP_CLI_WALL_MS' /tmp/wp-cli-1258.err && echo 1 || echo 0)"
run WP_CLI_SLOW_MS=3000 >/tmp/wp-cli-1258.out 2>/tmp/wp-cli-1258.err; rc=$?
ok "a slow hook is refused on a deploy (rc $rc)" "$([ $rc = 2 ] && grep -q 'WP_CLI_SLOW_MS' /tmp/wp-cli-1258.err && echo 1 || echo 0)"
ok "unset renders no WP-CLI vars" "$([ -z "$(vars)" ] && echo 1 || echo 0)"

run WP_CLI_ENDPOINT=on >/tmp/wp-cli-1258.out 2>/tmp/wp-cli-1258.err; rc=$?
ok "on without CUSTOM_DOMAIN is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'needs CUSTOM_DOMAIN' /tmp/wp-cli-1258.err && echo 1 || echo 0)"

AUD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TEAM=testteam
HOST=shop.example.com
run WP_CLI_ENDPOINT=on CUSTOM_DOMAIN="$HOST" > /tmp/wp-cli-1258.out 2>/tmp/wp-cli-1258.err; rc=$?
ok "on without ACCESS_AUD is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'needs ACCESS_AUD' /tmp/wp-cli-1258.err && echo 1 || echo 0)"
run WP_CLI_ENDPOINT=on CUSTOM_DOMAIN="$HOST" ACCESS_AUD="$AUD" > /tmp/wp-cli-1258.out 2>/tmp/wp-cli-1258.err; rc=$?
ok "on without ACCESS_TEAM is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'needs ACCESS_TEAM' /tmp/wp-cli-1258.err && echo 1 || echo 0)"
run WP_CLI_ENDPOINT=yes CUSTOM_DOMAIN="$HOST" ACCESS_AUD="$AUD" ACCESS_TEAM="$TEAM"; rc=$?
ok "a value other than on is refused (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
run WP_CLI_ENDPOINT=on CUSTOM_DOMAIN="$HOST" ACCESS_AUD="$AUD" ACCESS_TEAM='team.example'; rc=$?
ok "a team name with a dot is refused (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
run WP_CLI_ENDPOINT=on CUSTOM_DOMAIN="$HOST" ACCESS_AUD='short' ACCESS_TEAM="$TEAM"; rc=$?
ok "a short AUD is refused (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
run WP_CLI_ENDPOINT=on CUSTOM_DOMAIN="$HOST" ACCESS_AUD="$AUD" ACCESS_TEAM="$TEAM"; rc=$?
ok "on with the domain, AUD and team passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"

got=$(vars WP_CLI_ENDPOINT=on ACCESS_AUD="$AUD" ACCESS_TEAM="$TEAM")
ok "the three vars render when set" "$(printf '%s\n' "$got" | grep -qx 'WP_CLI_ENDPOINT = "on"' && printf '%s\n' "$got" | grep -qx "ACCESS_AUD = \"$AUD\"" && printf '%s\n' "$got" | grep -qx "ACCESS_TEAM = \"$TEAM\"" && echo 1 || echo 0)"

# shellcheck source=../lib/recorded-inputs.sh
. "$ROOT/deploy/lib/recorded-inputs.sh"
for n in WP_CLI_ENDPOINT ACCESS_AUD ACCESS_TEAM; do
  ok "RECORDED_INPUTS contains $n" "$(grep -qw "$n" <<<"$RECORDED_INPUTS" && echo 1 || echo 0)"
done
rec=$(env -i PATH="$PATH" SPIKE_TOKEN=secret-token WP_CLI_ENDPOINT=on ACCESS_AUD="$AUD" ACCESS_TEAM="$TEAM" bash -c '. "'"$ROOT"'/deploy/lib/recorded-inputs.sh"; deploy_inputs_value')
ok "the record has the three inputs and not the spike token" "$(printf '%s' "$rec" | base64 -d | grep -q '"WP_CLI_ENDPOINT": "on"' && printf '%s' "$rec" | base64 -d | grep -q "\"ACCESS_AUD\": \"$AUD\"" && ! printf '%s' "$rec" | base64 -d | grep -q secret-token && echo 1 || echo 0)"

ok "deploy.sh checks before any later step" "$(grep -q 'wp_cli_endpoint_check' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"
ok "render-conf.sh writes the vars" "$(grep -q 'wp_cli_endpoint_vars' "$ROOT/deploy/render-conf.sh" && echo 1 || echo 0)"

run SPIKE_TOKEN=not-the-local-token; rc=$?
ok "a real spike token passes the seam check (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
run SPIKE_TOKEN=local-spike-token >/tmp/wp-cli-1258.out 2>/tmp/wp-cli-1258.err; rc=$?
ok "the local spike token is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'local dev token' /tmp/wp-cli-1258.err && echo 1 || echo 0)"
run DEV_LOCAL=1 >/tmp/wp-cli-1258.out 2>/tmp/wp-cli-1258.err; rc=$?
ok "DEV_LOCAL is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'local runner only' /tmp/wp-cli-1258.err && echo 1 || echo 0)"

# Each deploy path refuses the local token and the three seam vars. deploy.sh is
# the real script, behind the fence, so a check that does not fire cannot reach
# Terraform. render-conf.sh and deploy/wfp render_user are the other two.
# shellcheck source=lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE=$(mktemp -d "${TMPDIR:-/tmp}/wp-cli-1258-fence.XXXXXX")
fence_dir "$FENCE"
echo "deploy.sh"
refuse "SPIKE_TOKEN must not be the local dev token" SPIKE_TOKEN=local-spike-token
refuse "DEV_LOCAL is set by the local runner only" DEV_LOCAL=1
refuse "WP_CLI_DEV_KEYS_B64 is a local engine check only" WP_CLI_DEV_KEYS_B64=abc
refuse "WP_CLI_WALL_MS is a local engine check only" WP_CLI_WALL_MS=200
refuse "WP_CLI_SLOW_MS is a local engine check only" WP_CLI_SLOW_MS=3000

APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)
T=$(mktemp -d "${TMPDIR:-/tmp}/wp-cli-1258-render.XXXXXX")
render_conf_try() {
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pf1258 VARIANT=b-dosql LOCATION=enam \
    SITE_ORIGIN=https://pf1258.example.workers.dev BUCKET=b AI=0 "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { echo "out-$1"; }
      cd "$APP" && render_conf
    ' > "$T/render.toml" 2> "$T/render.err"
}
render_user_try() {
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" "$@" bash -c '
      set -e
      . "'"$ROOT"'/deploy/wfp/lib.sh"
      render_user one https://wp-one.example.workers.dev
    ' > "$T/user.toml" 2> "$T/user.err"
}
path_refuses() { # path_refuses <path> <expected> <VAR=value>
  local path=$1 want=$2 rc=0
  if [ "$path" = render-conf ]; then render_conf_try "$3" || rc=$?
  else render_user_try "$3" || rc=$?; fi
  local err=$T/render.err out=$T/render.toml
  [ "$path" = wfp ] && { err=$T/user.err; out=$T/user.toml; }
  ok "$path refuses $3 (rc $rc)" "$([ $rc = 2 ] && grep -qF "$want" "$err" && ! grep -q 'DEV_LOCAL =' "$out" && echo 1 || echo 0)"
}
echo "render-conf.sh"
path_refuses render-conf "local dev token" SPIKE_TOKEN=local-spike-token
path_refuses render-conf "local runner only" DEV_LOCAL=1
path_refuses render-conf "WP_CLI_DEV_KEYS_B64" WP_CLI_DEV_KEYS_B64=abc
path_refuses render-conf "WP_CLI_WALL_MS" WP_CLI_WALL_MS=200
path_refuses render-conf "WP_CLI_SLOW_MS" WP_CLI_SLOW_MS=3000
echo "deploy/wfp"
path_refuses wfp "local dev token" SPIKE_TOKEN=local-spike-token
path_refuses wfp "local runner only" DEV_LOCAL=1
path_refuses wfp "WP_CLI_DEV_KEYS_B64" WP_CLI_DEV_KEYS_B64=abc
path_refuses wfp "WP_CLI_WALL_MS" WP_CLI_WALL_MS=200
path_refuses wfp "WP_CLI_SLOW_MS" WP_CLI_SLOW_MS=3000

render_conf_try SPIKE_TOKEN=not-the-local-token; rc=$?
ok "render-conf.sh with a real token renders and does not write DEV_LOCAL (rc $rc)" "$([ $rc = 0 ] && ! grep -q 'DEV_LOCAL' "$T/render.toml" && ! grep -q 'local-spike-token' "$T/render.toml" && ! grep -q 'WP_CLI_DEV_KEYS_B64\|WP_CLI_WALL_MS\|WP_CLI_SLOW_MS' "$T/render.toml" && echo 1 || echo 0)"
render_user_try SPIKE_TOKEN=not-the-local-token; rc=$?
ok "deploy/wfp with a real token renders and does not write DEV_LOCAL (rc $rc)" "$([ $rc = 0 ] && ! grep -q 'DEV_LOCAL' "$T/user.toml" && ! grep -q 'local-spike-token' "$T/user.toml" && ! grep -q 'WP_CLI_DEV_KEYS_B64\|WP_CLI_WALL_MS\|WP_CLI_SLOW_MS' "$T/user.toml" && echo 1 || echo 0)"
ok "run.sh is the only writer of the DEV_LOCAL worker var" "$(grep -q -- '--var "DEV_LOCAL:1"' "$ROOT/spikes/b2-wordpress/run.sh" && ! grep -q 'DEV_LOCAL =' "$ROOT/deploy/render-conf.sh" "$ROOT/deploy/wfp/lib.sh" "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"

rm -rf "$FENCE" "$T"
rm -f /tmp/wp-cli-1258.out /tmp/wp-cli-1258.err
[ "$fails" = 0 ] && echo "wp-cli-endpoint: all checks pass" || echo "wp-cli-endpoint: $fails failing check(s)"
exit $((fails > 0))
