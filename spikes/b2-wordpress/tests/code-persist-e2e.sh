#!/bin/bash
# End-to-end check of #407 on local wrangler dev (DEV_ENV=dosql-local), against the real WordPress
# installer: a plugin installed from wp-admin (REST /wp/v2/plugins, the same Plugin_Upgrader) stays
# installed and active across a new runtime AND a new isolate; an install over the code budget is
# refused in plain words and leaves nothing behind; a delete forgets it. Needs outbound HTTPS to
# wordpress.org. Run after ./build.sh, ./prepare.sh and ./opcache.sh. Exits 1 on any failure.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT
STATE=$(mktemp -d "${TMPDIR:-/tmp}/code-persist.XXXXXX"); export PERSIST_TO=$STATE
J=$(mktemp "${TMPDIR:-/tmp}/code-persist-jar.XXXXXX")
trap './run.sh --stop >/dev/null 2>&1; rm -rf "$STATE" "$J"' EXIT
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
PW=local-spike-password
bad=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; bad=1; fi; }
start() { ./run.sh --stop >/dev/null 2>&1; DEV_LOCAL=1 DEV_VARS="CODE_PERSIST:on CODE_BUDGET_MB:$1" ./run.sh _ping > /dev/null || { echo "FAIL wrangler dev did not start"; exit 1; }; }
login() {
  rm -f "$J"
  curl -s -c "$J" -b "$J" -o /dev/null "$B/wp-login.php"
  curl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php"
  N=$(curl -s -c "$J" -b "$J" "$B/wp-admin/admin-ajax.php?action=rest-nonce")
}
rest() { # rest METHOD route [json] -> body; status in $T
  local out; out=$(curl -s -c "$J" -b "$J" -X "$1" -H "X-WP-Nonce: $N" -H 'Content-Type: application/json' ${3:+-d "$3"} -w '\n%{http_code}' "$B/?rest_route=$2")
  T=${out##*$'\n'}; R=${out%$'\n'*}
}
reboot_runtime() { curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null; }
field() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('$1') or (d.get('data') or {}).get('$1') or '')" "$R" 2>/dev/null; }

start 8
curl -s "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null
./e2e.sh "$B" > /dev/null 2>&1   # the first login on a fresh install (break_lib note, #394)
login
rest POST /wp/v2/plugins '{"slug":"hello-dolly","status":"active"}'
ok "install hello-dolly from wordpress.org: 201 active (got $T $(field status))" "$([ "$T" = 201 ] && [ "$(field status)" = active ] && echo 1 || echo 0)"
reboot_runtime
login
rest GET /wp/v2/plugins/hello-dolly/hello
ok "after a new runtime: installed and active (got $T $(field status))" "$([ "$T" = 200 ] && [ "$(field status)" = active ] && echo 1 || echo 0)"
start 8   # a new wrangler dev process: a new isolate, same storage
login
rest GET /wp/v2/plugins/hello-dolly/hello
ok "after a new isolate: installed and active (got $T $(field status))" "$([ "$T" = 200 ] && [ "$(field status)" = active ] && echo 1 || echo 0)"

start 0.001   # about 1 KB: below any real plugin
login
rest POST /wp/v2/plugins '{"slug":"classic-editor"}'
msg=$(field message)
ok "over the budget: refused in plain words (got $T: ${msg:0:90})" "$([ "$T" != 201 ] && echo "$msg" | grep -q 'room left' && echo 1 || echo 0)"
reboot_runtime
login
rest GET /wp/v2/plugins/classic-editor/classic-editor
ok "the refused install left nothing behind after a reboot (got $T)" "$([ "$T" = 404 ] && echo 1 || echo 0)"

start 8
login
rest POST /wp/v2/plugins/hello-dolly/hello '{"status":"inactive"}'
rest DELETE /wp/v2/plugins/hello-dolly/hello
ok "delete hello-dolly (got $T)" "$([ "$T" = 200 ] && echo 1 || echo 0)"
reboot_runtime
login
rest GET /wp/v2/plugins/hello-dolly/hello
ok "after a delete and a new runtime: gone (got $T)" "$([ "$T" = 404 ] && echo 1 || echo 0)"
exit $bad
