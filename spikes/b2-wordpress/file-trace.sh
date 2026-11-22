#!/bin/bash
# Record which bundle files each request reads (#394 M0, file-trace.mjs). Run after ./build.sh and
# ./opcache.sh, so the trace sees the PRIMED build a site runs (a cold runtime loads the shipped
# OPcache files; a warm one should not need them).
#
# Starts wrangler dev with FILE_TRACE=on on a fresh local state, installs, activates WooCommerce
# (WOO_ACTIVE=1, as the store build), drives the pages e2e.sh and tests/woo.py drive plus the
# admin pages of #394, then saves GET /_trace to build/file-trace.json and stops the server.
# Summarize with: python3 file-trace-report.py build/file-trace.json
set -euo pipefail
cd "$(dirname "$0")"
# #682: the local dev server and every request here run on the local token and password.
# shellcheck source=local-creds.sh
. ./local-creds.sh
local_creds
# #1316: every request below is bounded (bcurl): a local endpoint that never answers stops the build with a reason.
# shellcheck source=fetch-bound.sh
. ./fetch-bound.sh
[ -s build/opcache.zip ] || { echo "build/opcache.zip is missing or empty: run ./opcache.sh first"; exit 1; }
STATE=$(mktemp -d "${TMPDIR:-/tmp}/file-trace-state.XXXXXX")
export PERSIST_TO=$STATE
trap 'rm -rf "$STATE"' EXIT
had_port=0
if [ -n "${PORT:-}" ]; then
  had_port=1
fi
run_out=$(mktemp "${TMPDIR:-/tmp}/pf-run-port.XXXXXX")
DEV_LOCAL=1 DEV_VARS="FILE_TRACE:on${DEV_VARS:+ $DEV_VARS}" ./run.sh _ping > "$run_out" || { cat "$run_out" >&2; rm -f "$run_out"; exit 1; }
# #839: one line, the port run.sh chose. An explicit PORT is not announced again.
# e2e.sh and woo.py then use that same port.
if [ "$had_port" = 0 ]; then
  grep -E '^port [0-9]+$' "$run_out" || true
fi
rm -f "$run_out"
# shellcheck source=port.sh
. ./port.sh
take_port || { echo "could not pick a free port"; exit 1; }
if [ "${port_from:-}" = picked ]; then
  echo "port $PORT"
fi
trap './run.sh --stop; rm -rf "$STATE"' EXIT
P=$PORT
B=http://localhost:$P
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
PW=${ADMIN_PASSWORD:-local-spike-password}
# #677: install_dev keeps the /_install answer and runs server_alive before activation.
SERVER=$(cut -d' ' -f1 ".dev-$P.pid" 2>/dev/null || true)
PORT=$P
# shellcheck source=opcache-activate.sh
. ./opcache-activate.sh
install_dev || exit 1
if [ "${WOO_ACTIVE:-1}" = 1 ]; then
  woo_activate || exit 1
fi
# Drop what install and activation read: the trace is for page traffic.
bcurl "${ST[@]}" -sf "$B/_trace" > /dev/null
./e2e.sh "$B" > build/file-trace-e2e.log 2>&1 || { echo "e2e failed, see build/file-trace-e2e.log"; exit 1; }
if [ "${WOO_ACTIVE:-1}" = 1 ]; then
  B=$B ADMIN_PASSWORD=$PW python3 tests/woo.py > build/file-trace-woo.log 2>&1 || { echo "woo.py failed, see build/file-trace-woo.log"; exit 1; }
fi
# The #394 admin pages, logged in, each twice (the second is warm).
J=$(mktemp "${TMPDIR:-/tmp}/file-trace-jar.XXXXXX")
bcurl -s -c "$J" -b "$J" -o /dev/null --data-urlencode "pwd=$PW" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php"
for path in /wp-admin/ /wp-admin/profile.php '/wp-admin/post-new.php?post_type=page' /wp-admin/ /wp-admin/profile.php '/wp-admin/post-new.php?post_type=page' '/?post_type=product' '/?post_type=product' /; do
  code=$(bcurl -s -c "$J" -b "$J" -o /dev/null -w '%{http_code}' "$B$path")
  echo "$code $path" >> build/file-trace-admin.log
done
# #569 (#394 Gate 2): the GET screens of the 7-screen round (docs/admin-memory-matrix.md,
# admin-round.py), each COLD (a forced recycle drops the runtime, so the next request boots one; #798: /_install no
# longer drops it) then
# warm. Post 1 and page 2 are the ones a WordPress install makes. The profile SAVE (a POST with a
# nonce) is not traced.
for path in /wp-admin/ /wp-admin/post-new.php '/wp-admin/post-new.php?post_type=page' '/wp-admin/post.php?post=1&action=edit' '/wp-admin/post.php?post=2&action=edit' /wp-admin/profile.php; do
  bcurl "${ST[@]}" -s -o /dev/null -H 'x-runtime-recycle: force' "$B/?nocache=ft$RANDOM"
  for pass in cold warm; do
    code=$(bcurl -s -c "$J" -b "$J" -o /dev/null -w '%{http_code}' "$B$path")
    echo "$code $pass $path" >> build/file-trace-admin.log
  done
done
rm -f "$J"
bcurl "${ST[@]}" -sf "$B/_trace" > build/file-trace.json
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['on'], 'FILE_TRACE was not on'; print('file-trace.json:', len(d['requests']), 'requests,', d['dropped'], 'dropped')" build/file-trace.json
