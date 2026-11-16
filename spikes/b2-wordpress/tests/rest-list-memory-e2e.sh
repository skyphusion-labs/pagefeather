#!/bin/bash
# #728: a REST list over large posts must not load more post content than the object can hold.
#   tests/rest-list-memory-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# dosql-local, PHP_RECYCLE off. Seeds 120 draft pages of 512 KiB (measure394.py rest, REST_CONTENT_KIB=512) and three
# small pages, then, each request on a FRESH runtime (a forced recycle before it) with the ledger on:
#   1. _fields=id,title per_page=100 (the #728 request): 200, all 100 ids, and a wasm high-water no more than 20 MiB
#      over per_page=5's (it loads no content). Before php/rest-list-memory.php: 177 MiB.
#   2. _fields=id,content and _fields=id,excerpt (per_page=5): the content and the excerpt are still there.
#   3. no _fields, per_page=100: 400 rest_list_too_large, naming the budget; never a capped or partial 200.
#   4. no _fields, per_page=5 (under the budget): 200 with 5 items, as before.
#   5. ordinary lists (the small pages): the answer to _fields=id,title,slug,date (no content loaded) equals the answer
#      to _fields=id,title,slug,date,content with content removed (content loaded), item for item.
# wrangler dev does not enforce the 128 MiB isolate limit: (1) is checked on the memory the request reaches.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/rest-list-mem.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off" ./run.sh _ping > /dev/null || { echo "rest-list-mem: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "rest-list-mem: /_install failed"; exit 1; }
B=$B SPIKE_TOKEN=$TOK ADMIN_USER=admin ADMIN_PASSWORD=$PW ROUNDS=120 REST_CONTENT_KIB=512 python3 tests/measure394.py seed rest > "$STATE/seed.jsonl" 2> "$STATE/seed.err" || { echo "rest-list-mem: seeding failed"; tail -5 "$STATE/seed.err"; exit 1; }
B=$B TOK=$TOK PW=$PW python3 -I - <<'PY'
import http.cookiejar, json, os, re, sys, urllib.request, urllib.parse
B, TOK, PW = os.environ['B'], os.environ['TOK'], os.environ['PW']
jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def get(path, h=None, data=None):
    r = urllib.request.Request(B + path, data=data, headers=h or {})
    try:
        with op.open(r, timeout=300) as x: return x.status, {k.lower(): v for k, v in x.headers.items()}, x.read()
    except urllib.error.HTTPError as e: return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
get('/wp-login.php'); get('/wp-login.php', data=urllib.parse.urlencode({'log': 'admin', 'pwd': PW, 'wp-submit': 'Log In', 'redirect_to': '/wp-admin/', 'testcookie': '1'}).encode())
nonce = get('/wp-admin/admin-ajax.php?action=rest-nonce')[2].decode().strip()
if not re.fullmatch(r'[0-9a-f]{10}', nonce): sys.exit('rest-list-mem: no REST nonce')
H = {'X-WP-Nonce': nonce, 'x-spike-token': TOK}
for i in range(3):
    body = json.dumps({'title': 'small %d' % i, 'content': 'a short page %d' % i, 'status': 'draft'}).encode()
    st = get('/?rest_route=/wp/v2/pages', {**H, 'Content-Type': 'application/json'}, body)[0]
    if st != 201: sys.exit('rest-list-mem: creating a small page answered %d' % st)
def fresh(path):
    get('/wp-login.php', {'x-spike-token': TOK, 'x-runtime-recycle': 'force'})
    st, h, b = get(path, {**H, 'x-mem-ledger': '1'})
    return st, h, b, (json.loads(h.get('x-perf', '{}') or '{}').get('wasm1MiB'))
big = '/?rest_route=/wp/v2/pages&status=draft&context=edit&search=measure394&per_page=%d%s'
fail = []
def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + ((' (' + detail + ')') if detail else '')); ok or fail.append(name)
# 1
st5, _, _, m5 = fresh(big % (5, '&_fields=id,title'))
st, h, b, m = fresh(big % (100, '&_fields=id,title'))
items = json.loads(b) if st == 200 else []
check('1. _fields=id,title per_page=100: 200 with all 100 ids', st == 200 and len(items) == 100 and all('id' in x for x in items), 'status %d, %d items' % (st, len(items)))
check('1. it loads no content: its wasm high-water stays within 20 MiB of per_page=5', m is not None and m5 is not None and m - m5 <= 20, 'per_page=5 %s MiB, per_page=100 %s MiB' % (m5, m))
g = (json.loads(h.get('x-oc-stats') or '{}').get('groups') or {})
check('1. it drops only its own copies: no delete reaches the shared cache (posts.del 0)', 'x-oc-stats' in h and not g.get('posts.del'), 'x-oc-stats %s, posts.del %s' % ('x-oc-stats' in h, g.get('posts.del')))
# 2
st, _, b, _ = fresh(big % (5, '&_fields=id,content'))
c = json.loads(b) if st == 200 else []
check('2. _fields=id,content still gets the content', st == 200 and len(c) == 5 and all(len((x.get('content') or {}).get('raw', '')) > 500000 for x in c), 'status %d' % st)
st, _, b, _ = fresh(big % (5, '&_fields=id,excerpt'))
c = json.loads(b) if st == 200 else []
check('2. _fields=id,excerpt still gets the excerpt (made from the content)', st == 200 and len(c) == 5 and all('measure394' in (x.get('excerpt') or {}).get('raw', '') + (x.get('excerpt') or {}).get('rendered', '') for x in c), 'status %d' % st)
# 3
st, h, b, _ = fresh(big % (100, ''))
try: j = json.loads(b)
except Exception: j = {}
check('3. no _fields per_page=100: 400 rest_list_too_large, naming the budget', st == 400 and isinstance(j, dict) and j.get('code') == 'rest_list_too_large' and 'MiB' in j.get('message', ''), 'status %d, code %s' % (st, j.get('code') if isinstance(j, dict) else type(j).__name__))
check('3. never a capped or partial list', not (st == 200 and isinstance(j, list) and len(j) < 100), 'status %d' % st)
# 4
st, _, b, _ = fresh(big % (5, ''))
check('4. no _fields per_page=5 (under the budget): 200 with 5 items', st == 200 and len(json.loads(b)) == 5, 'status %d' % st)
# 5
small = '/?rest_route=/wp/v2/pages&status=draft&context=edit&search=small&per_page=10&_fields=%s'
s1, _, b1, _ = fresh(small % 'id,title,slug,date')
s2, _, b2, _ = fresh(small % 'id,title,slug,date,content')
a1 = json.loads(b1) if s1 == 200 else None
a2 = [{k: v for k, v in x.items() if k != 'content'} for x in json.loads(b2)] if s2 == 200 else None
check('5. an ordinary list: the answer without content loaded equals the one with it, item for item', a1 is not None and a1 == a2 and len(a1) == 3, '%s vs %s' % (s1, s2))
print('rest-list-mem: %d failing' % len(fail))
sys.exit(1 if fail else 0)
PY
