#!/usr/bin/env python3
# #582 S4 M1: the payoff of OPcache lazy function bodies, measured on the editor screens. Needs an engine
# built with ENGINE_OPCACHE_STATS=1 (engine/opcache/opcache_module_stats.c) and a dev server with
# PHP_RECYCLE off (a recycle would start a new runtime and lose the counts). After each screen it reads
# /_mem, whose pagefeather_opcache_stats() reports the PREVIOUS request: the screen just loaded.
#   ADMIN_PASSWORD=... [STATS_SPIKE_TOKEN=...] python3 tests/opcache-stats.py [rounds] [out.jsonl]
# The base URL is B if set, else http://localhost:$PORT, else the port in
# .dev-port (dev_port.py). With none of those, this script exits.
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import re
from dev_port import base_url
if not os.environ.get("B", "").strip():
    os.environ["B"] = base_url()
from break_lib import login, opener, req

rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 2
out = open(sys.argv[2], 'w') if len(sys.argv) > 2 else None
screens = [('dashboard', '/wp-admin/'), ('post-new post', '/wp-admin/post-new.php'), ('post-new page', '/wp-admin/post-new.php?post_type=page'),
           ('post.php post', '/wp-admin/post.php?post=1&action=edit'), ('post.php page', '/wp-admin/post.php?post=2&action=edit'), ('profile', '/wp-admin/profile.php')]
# The spike token goes on /_mem only (the screens need no operator headers).
st = {'x-spike-token': os.environ.pop('STATS_SPIKE_TOKEN', 'local-spike-token')}
os.environ.pop('SPIKE_TOKEN', None)
# The runtime's first request (x-boot 1) displays a WooCommerce notice before the headers in local dev,
# so wp-login.php cannot set its test cookie and a login on that request fails (#600; it cost runs
# 43659334789 and 43660572446). Absorb the boot request first, and print the login page's own error if
# the login still fails.
w = req(opener(), '/wp-login.php')
print('warm-up GET /wp-login.php: %s' % w['code'])
try:
    o = login()
except AssertionError:
    p = opener(); req(p, '/wp-login.php')
    r = req(p, '/wp-login.php', {'log': 'admin', 'pwd': os.environ['ADMIN_PASSWORD'], 'wp-submit': 'Log In', 'redirect_to': '/wp-admin/', 'testcookie': '1'})
    b = (r['body'] or b'').decode('utf-8', 'replace')
    e = re.search(r'id="login_error"[^>]*>(.*?)</div>', b, re.S)
    print('opcache-stats.py: login failed, %s: %s' % (r['code'], re.sub(r'<[^>]+>', ' ', e.group(1)).strip()[:300] if e else b[:300]))
    sys.exit(1)
rows = []
for n in range(rounds):
    for name, path in screens:
        r = req(o, path)
        m = req(o, '/_mem', headers=st)
        mj = json.loads(m['body'] or b'{}') if m['code'] == 200 else {}
        pf = (mj.get('ini') or {}).get('pf')
        wasm = round(mj['wasmMemoryBytes'] / 1048576, 1) if mj.get('wasmMemoryBytes') else None  # the runtime's memory after the screen
        row = {'round': n + 1, 'screen': name, 'code': r['code'], 'wasm_mib': wasm, 'pf': pf}
        rows.append(row)
        if out: out.write(json.dumps(row) + '\n')
        if pf:
            d, c, db, cb = pf['declared_functions'], pf['called_functions'], pf['declared_body_bytes'], pf['called_body_bytes']
            print('%d %-14s %s wasm=%s declared %6d called %5d (%4.1f%%)  bodies %6.2f MiB, called %5.2f MiB, never called %6.2f MiB' % (
                n + 1, name, r['code'], wasm, d, c, 100.0 * c / max(d, 1), db / 1048576, cb / 1048576, (db - cb) / 1048576))
        else:
            print('%d %-14s %s wasm=%s no stats (%s)' % (n + 1, name, r['code'], wasm, m['code']))
ok = [x for x in rows if x['pf'] and x['code'] == 200]
if not ok:
    print('opcache-stats.py: no stats read'); sys.exit(1)
never = [(x['pf']['declared_body_bytes'] - x['pf']['called_body_bytes']) / 1048576 for x in ok]
print('@event opcache-stats ' + json.dumps({'screens': len(ok), 'never_called_body_mib_min': round(min(never), 2), 'never_called_body_mib_max': round(max(never), 2),
      'called_share_max': round(max(x['pf']['called_functions'] / max(x['pf']['declared_functions'], 1) for x in ok), 3), 'sizeof_zend_op': ok[0]['pf']['sizeof_zend_op']}))
