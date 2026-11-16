#!/bin/bash
# The first request of a runtime with WooCommerce active must set wordpress_test_cookie.
#
# After activation the runtime is dropped. The next request boots a new one (x-boot: 1).
# On that request Jetpack Connection, started from WooCommerce during plugins_loaded,
# schedules jetpack_clean_nonces because the event is not stored yet. wp_schedule_event()
# calls wp_get_schedules(), and WooCommerce's cron_schedules callback translates
# "Monthly" before after_setup_theme. The notice is printed before the headers, so
# wp-login.php cannot set its test cookie (#600).
#
# Needs ./build.sh and ./prepare.sh. Local wrangler dev only.
#   ./tests/boot-login-cookie.sh
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8873}
export DEV_LOCAL=1
B=http://localhost:$PORT
TOKEN=${SPIKE_TOKEN:-local-spike-token}
PW=${ADMIN_PASSWORD:-local-spike-password}
[ -s build/site.zip ] || { echo "FAIL build/site.zip missing: run ./build.sh"; exit 1; }
[ -s vendor/php_8_3.js ] || { echo "FAIL vendor/php_8_3.js missing: run ./prepare.sh"; exit 1; }
STATE=$(mktemp -d "${TMPDIR:-/tmp}/boot-login.XXXXXX")
export PERSIST_TO=$STATE
trap './run.sh --stop >/dev/null 2>&1; rm -rf "$STATE"' EXIT
bad=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; bad=1; fi; }
DEV_LOCAL=1 ./run.sh _ping > /dev/null || { echo "FAIL wrangler dev did not start"; exit 1; }
auth=(-H "x-spike-token: $TOKEN" -H "x-admin-password: $PW")
code=$(curl -sS -m 180 -o /tmp/boot-login-install.json -w '%{http_code}' -X POST "${auth[@]}" "$B/_install")
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if '\"installed\":true' in d.get('out','') or '\"installed\": \"already\"' in d.get('out','') or 'already' in d.get('out','') else 1)" /tmp/boot-login-install.json
installed=$?
ok "install (http $code)" "$([ "$code" = 200 ] && [ "$installed" = 0 ] && echo 1 || echo 0)"
if [ "$installed" != 0 ]; then echo "install body:"; python3 -c "import pathlib; print(pathlib.Path('/tmp/boot-login-install.json').read_text(errors='replace')[-500:])"; fi
code=$(curl -sS -m 240 -o /tmp/boot-login-activate.json -w '%{http_code}' -X POST "${auth[@]}" "$B/_activate?plugin=woocommerce/woocommerce.php")
active=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('1' if '\"active\":true' in d.get('out','') else '0')" /tmp/boot-login-activate.json 2>/dev/null || echo 0)
ok "WooCommerce active (http $code)" "$([ "$code" = 200 ] && [ "$active" = 1 ] && echo 1 || echo 0)"
if [ "$active" != 1 ]; then echo "activate body:"; python3 -c "import pathlib; print(pathlib.Path('/tmp/boot-login-activate.json').read_text(errors='replace')[-800:])"; fi
# #798: activation no longer drops the runtime, so a forced recycle does (spike-gated). The GET after it is the first
# request a new runtime serves.
curl -sS -m 60 -o /dev/null -H "x-spike-token: $TOKEN" -H 'x-runtime-recycle: force' "$B/?nocache=blc$RANDOM"
curl -sS -m 180 -D /tmp/boot-login.hdr -o /tmp/boot-login.body -H "x-spike-token: $TOKEN" "$B/wp-login.php"
python3 - << 'PY'
import pathlib, sys
h = pathlib.Path('/tmp/boot-login.hdr').read_text(errors='replace')
b = pathlib.Path('/tmp/boot-login.body').read_bytes()
text = b.decode('utf-8', 'replace')
lines = h.splitlines()
boot = ''
cookie = False
for line in lines:
    low = line.lower()
    if low.startswith('x-boot:'):
        boot = line.split(':', 1)[1].strip()
    if low.startswith('set-cookie:') and 'wordpress_test_cookie=' in line:
        cookie = True
start = text.lstrip('\ufeff').lstrip()
html_first = start.startswith('<!DOCTYPE') or start.startswith('<!doctype') or start.startswith('<html')
notice = '_load_textdomain_just_in_time' in text or 'Cookies are blocked' in text or 'headers already sent' in text
pathlib.Path('/tmp/boot-login-check.txt').write_text(
    'boot=%s\ncookie=%s\nhtml_first=%s\nnotice=%s\nbytes=%d\nhead=%s\n' % (
        boot, int(cookie), int(html_first), int(notice), len(b), repr(b[:180])
    )
)
print('first body starts:', repr(b[:160]))
print('x-boot:', boot or '(missing)', 'cookie:', cookie)
sys.exit(0)
PY
check() { python3 -c "import pathlib; d=dict(l.split('=',1) for l in pathlib.Path('/tmp/boot-login-check.txt').read_text().splitlines() if '=' in l); print(d.get('$1',''))"; }
ok "first GET is the boot request (x-boot $(check boot))" "$([ "$(check boot)" = 1 ] && echo 1 || echo 0)"
ok "first GET sets wordpress_test_cookie" "$([ "$(check cookie)" = 1 ] && echo 1 || echo 0)"
ok "first GET body is the login page, with nothing before it" "$([ "$(check html_first)" = 1 ] && echo 1 || echo 0)"
ok "first GET has no early-translation notice and no headers-already-sent warning" "$([ "$(check notice)" = 0 ] && echo 1 || echo 0)"
exit $bad
