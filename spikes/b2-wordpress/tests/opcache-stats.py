#!/usr/bin/env python3
# #582 S4 M1: the payoff of OPcache lazy function bodies, measured on the editor screens. Needs an engine
# built with ENGINE_OPCACHE_STATS=1 (engine/opcache/opcache_module_stats.c) and a dev server with
# PHP_RECYCLE off (a recycle would start a new runtime and lose the counts). After each screen it reads
# /_mem, whose pagefeather_opcache_stats() reports the PREVIOUS request: the screen just loaded.
#   B=http://localhost:8797 ADMIN_PASSWORD=... [STATS_SPIKE_TOKEN=...] python3 tests/opcache-stats.py [rounds] [out.jsonl]
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import login, req

rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 2
out = open(sys.argv[2], 'w') if len(sys.argv) > 2 else None
screens = [('dashboard', '/wp-admin/'), ('post-new post', '/wp-admin/post-new.php'), ('post-new page', '/wp-admin/post-new.php?post_type=page'),
           ('post.php post', '/wp-admin/post.php?post=1&action=edit'), ('post.php page', '/wp-admin/post.php?post=2&action=edit'), ('profile', '/wp-admin/profile.php')]
# The spike token goes on /_mem only: with SPIKE_TOKEN in the environment, break_lib adds it to every
# request, and the login then answered 200, not 302 (runs 43659334789, 43660572446).
st = {'x-spike-token': os.environ.pop('STATS_SPIKE_TOKEN', 'local-spike-token')}
os.environ.pop('SPIKE_TOKEN', None)
o = login()
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
