#!/bin/bash
# End-to-end check of #452 on local wrangler dev (DEV_ENV=dosql-local), after ./build.sh and
# ./prepare.sh. Adds one test script to a COPY of build/site.zip for the run (restored on exit):
#   - fsockopen() to a public host must fail fast and cleanly at its first I/O, with no wait
#     for a poll and no socket cleanup error in the log;
#   - post_message_to_js() with a string that is not JSON must get an error back, not a throw.
# Exits 1 on any failure.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT
[ -s build/site.zip ] || { echo "FAIL build/site.zip missing: run ./build.sh"; exit 1; }
SAVE=$(mktemp "${TMPDIR:-/tmp}/site-zip.XXXXXX"); cp build/site.zip "$SAVE"
STATE=$(mktemp -d "${TMPDIR:-/tmp}/guards.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop >/dev/null 2>&1; cp "$SAVE" build/site.zip; rm -rf "$STATE" "$SAVE"' EXIT
python3 -I - build/site.zip <<'PY'
import sys, zipfile
php = r'''<?php
header('Content-Type: application/json');
$t = microtime(true);
$fp = @fsockopen('example.com', 80, $errno, $errstr, 5);
$sock = array('ok' => $fp !== false, 'errno' => $errno, 'errstr' => $errstr, 'ms' => (int) round((microtime(true) - $t) * 1000));
if ($fp) {
	stream_set_timeout($fp, 3);
	$w = @fwrite($fp, "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n");
	$r = @fread($fp, 64);
	$sock['write'] = $w;
	$sock['read'] = $r === false ? false : strlen($r);
	$sock['meta'] = stream_get_meta_data($fp);
	$sock['ms_io'] = (int) round((microtime(true) - $t) * 1000);
	$sock['last'] = error_get_last();
}
$reply = function_exists('post_message_to_js') ? post_message_to_js('this is not json') : null;
echo json_encode(array('socket' => $sock, 'message' => json_decode((string) $reply, true)));
'''
with zipfile.ZipFile(sys.argv[1], 'a') as z:
    z.writestr('wordpress/pf-guard-test.php', php)
PY
DEV_LOCAL=1 ./run.sh _ping > /dev/null || { echo "FAIL wrangler dev did not start"; exit 1; }
out=$(curl -s -m 60 "$B/pf-guard-test.php")
echo "answer: $out"
bad=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; bad=1; fi; }
v() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2], {}, {'d': d}))" "$out" "$1" 2>/dev/null; }
# php-wasm returns a resource from fsockopen() before the connect settles, so the check is the I/O:
# with no socket, the first write fails at once and the read never waits for a poll. Stock code
# waited out the whole stream timeout (3 s) on a WebSocket it could not poll, and its cleanup threw.
ok "the socket carries nothing: the write fails (got $(v "d['socket'].get('write')"))" "$([ "$(v "d['socket'].get('write')")" = False ] && echo 1 || echo 0)"
ok "and the I/O fails fast, under 1 s, not after the 3 s timeout (got $(v "d['socket'].get('ms_io')") ms)" "$([ "$(v "d['socket'].get('ms_io', 99999) < 1000")" = True ] && echo 1 || echo 0)"
n=$(grep -c 'removeListener is not a function' dev.log 2>/dev/null); n=${n:-0}
ok "no socket cleanup error in the dev log (got $n)" "$([ "$n" = 0 ] && echo 1 || echo 0)"
ok "a non-JSON message gets an error reply, not a throw (got $(v "d['message']"))" "$([ "$(v "d['message']['error']")" = 'message is not JSON' ] && echo 1 || echo 0)"
ok "the page answered (the runtime did not crash)" "$([ -n "$out" ] && echo 1 || echo 0)"
exit $bad
