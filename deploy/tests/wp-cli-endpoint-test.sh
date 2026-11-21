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

rm -f /tmp/wp-cli-1258.out /tmp/wp-cli-1258.err
[ "$fails" = 0 ] && echo "wp-cli-endpoint: all checks pass" || echo "wp-cli-endpoint: $fails failing check(s)"
exit $((fails > 0))
