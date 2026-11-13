#!/bin/bash
# End-to-end check of #458 on local wrangler dev (DEV_ENV=dosql-local), after ./build.sh,
# ./prepare.sh and ./opcache.sh. The code lock is the default:
#   - Plugins > Add New, the plugin editor and the theme editor are not offered;
#   - a plugin install through REST is refused;
#   - the Plugins screen says how to add one (the build);
#   - activating and deactivating a plugin the build ships still works.
# CONTROL: the same REST install with CODE_LOCK=off (a local test instance only) succeeds, so the
# refusal above is the lock, not a broken install path. Needs outbound HTTPS to wordpress.org.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
PW=local-spike-password
J=$(mktemp "${TMPDIR:-/tmp}/code-lock-jar.XXXXXX"); STATE=""
trap './run.sh --stop >/dev/null 2>&1; rm -f "$J"; [ -n "$STATE" ] && rm -rf "$STATE"' EXIT
bad=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; bad=1; fi; }
start() { # start <DEV_VARS>
  ./run.sh --stop >/dev/null 2>&1; [ -n "$STATE" ] && rm -rf "$STATE"
  STATE=$(mktemp -d "${TMPDIR:-/tmp}/code-lock.XXXXXX"); export PERSIST_TO=$STATE
  DEV_LOCAL=1 DEV_VARS="$1" ./run.sh _ping > /dev/null || { echo "FAIL wrangler dev did not start"; exit 1; }
  curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
  ./e2e.sh "$B" > /dev/null 2>&1
  rm -f "$J"; curl -s -c "$J" -b "$J" -o /dev/null "$B/wp-login.php"
  curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php"
  N=$(curl -s -c "$J" -b "$J" "$B/wp-admin/admin-ajax.php?action=rest-nonce")
}
page() { curl -s -c "$J" -b "$J" -o "$J.body" -w '%{http_code}' "$B$1"; }
rest() { local out; out=$(curl -s -c "$J" -b "$J" -X "$1" -H "X-WP-Nonce: $N" -H 'Content-Type: application/json' ${3:+-d "$3"} -w '\n%{http_code}' "$B/?rest_route=$2"); T=${out##*$'\n'}; R=${out%$'\n'*}; }

start ""
c=$(page /wp-admin/plugin-install.php); ok "locked: Add New is not offered (plugin-install.php $c, $(grep -c 'Sorry, you are not allowed' "$J.body") refusal)" "$( { [ "$c" != 200 ] || grep -q 'Sorry, you are not allowed' "$J.body"; } && echo 1 || echo 0)"
c=$(page /wp-admin/plugin-editor.php); ok "locked: the plugin editor is not offered ($c)" "$( { [ "$c" != 200 ] || grep -q 'Sorry, you are not allowed' "$J.body"; } && echo 1 || echo 0)"
c=$(page /wp-admin/theme-editor.php); ok "locked: the theme editor is not offered ($c)" "$( { [ "$c" != 200 ] || grep -q 'Sorry, you are not allowed' "$J.body"; } && echo 1 || echo 0)"
c=$(page /wp-admin/plugins.php); ok "locked: the Plugins screen shows no Add New and says to use the build ($c)" "$([ "$c" = 200 ] && ! grep -q 'plugin-install.php' "$J.body" && grep -q "add it to the site&#039;s build and deploy it" "$J.body" && echo 1 || echo 0)"
rest POST /wp/v2/plugins '{"slug":"hello-dolly"}'
ok "locked: a REST plugin install is refused ($T)" "$([ "$T" != 201 ] && echo 1 || echo 0)"
rest POST /wp/v2/plugins/hello '{"status":"active"}'; a=$T
rest POST /wp/v2/plugins/hello '{"status":"inactive"}'; d=$T
ok "locked: activating and deactivating a shipped plugin still works ($a, $d)" "$([ "$a" = 200 ] && [ "$d" = 200 ] && echo 1 || echo 0)"

start "CODE_LOCK:off"
rest POST /wp/v2/plugins '{"slug":"hello-dolly"}'
ok "control, CODE_LOCK=off: the same REST install succeeds ($T)" "$([ "$T" = 201 ] && echo 1 || echo 0)"
rm -f "$J.body"
exit $bad
