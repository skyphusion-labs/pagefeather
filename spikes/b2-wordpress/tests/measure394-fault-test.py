#!/usr/bin/env python3
"""#730 (#589 B): measure394's side of the fault injector, and the title read-back it needs. Offline, with
measure394.req replaced by a fake that records every request.
  python3 -I spikes/b2-wordpress/tests/measure394-fault-test.py
- FAULT_EVERY=k sends x-pf-fault: after-insert on every k-th REST create (rounds 0, k, 2k ...) and marks each
  row injected true or false; it is refused without SPIKE_TOKEN.
- A create read back by title (a 5xx has no id) searches the exact quoted title, 3 rows a page with
  _fields=id,title, and pages until found or the results run out. A page that fails makes it read-failed, never
  absent (#589 run7c: 100 rows with content was a memory death).
- tally counts the injected creates: answered 2xx (the injector did not fire), 5xx, their frame states, found."""
import io, json, os, sys, contextlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.argv = [sys.argv[0], 'faulttest']
import measure394 as M

fail = 0
def check(name, ok):
    global fail
    fail += not ok
    print('%s %s' % ('PASS' if ok else 'FAIL', name))

calls = []
def fake(pages_for_search=None, create_code=500):
    def req(a, path, body=None, headers=None, method=None):
        calls.append({'path': path, 'headers': dict(headers or {}), 'method': method})
        if 'rest-nonce' in path:
            return {'code': 200, 'body': b'n1'}
        if path.startswith('/?rest_route=/wp/v2/pages') and method == 'POST':
            return {'code': create_code, 'body': b'{}', 'h': {'x-pf-req': 'pf%d' % len(calls), 'x-isolate-reset': 'memory', 'x-write-loss': '1'}}
        if path.startswith('/_frame'):
            return {'code': 200, 'body': json.dumps({'frame': {'state': 'rolled-back', 'points': 0}}).encode()}
        if 'search=' in path:
            pg = int(path.split('&page=')[1].split('&')[0]) if '&page=' in path else 1
            seq = pages_for_search or []
            if pg > len(seq):
                return {'code': 400, 'body': b'{"code":"rest_post_invalid_page_number"}'}
            item = seq[pg - 1]
            return item if isinstance(item, dict) and 'code' in item else {'code': 200, 'body': json.dumps(item).encode()}
        return {'code': 200, 'body': b'{}'}
    return req

# 1. FAULT_EVERY
os.environ['SPIKE_TOKEN'] = 't'; os.environ['FAULT_EVERY'] = '2'
M.req = fake([[]])
M.rows.clear(); calls.clear()
with contextlib.redirect_stdout(io.StringIO()):
    for i in range(4):
        M.rest_round(object(), 'pnrest', i)
posts = [c for c in calls if c['method'] == 'POST']
check('FAULT_EVERY=2: the header on rounds 0 and 2 only', [c['headers'].get('x-pf-fault') for c in posts] == ['after-insert', None, 'after-insert', None])
check('  rows marked injected true, false, true, false', [r.get('injected') for r in M.rows] == [True, False, True, False])
os.environ.pop('FAULT_EVERY')
M.rows.clear(); calls.clear()
with contextlib.redirect_stdout(io.StringIO()):
    M.rest_round(object(), 'pnrest', 0)
check('unset: no header, and no injected key (old rows unchanged)', 'x-pf-fault' not in [c for c in calls if c['method'] == 'POST'][0]['headers'] and 'injected' not in M.rows[0])
os.environ['FAULT_EVERY'] = '1'; os.environ.pop('SPIKE_TOKEN')
try:
    with contextlib.redirect_stdout(io.StringIO()):
        M.rest_round(object(), 'pnrest', 0)
    refused = False
except SystemExit:
    refused = True
check('FAULT_EVERY without SPIKE_TOKEN: refused', refused)
os.environ['SPIKE_TOKEN'] = 't'
for bad in ('x', '-1', '0.5'):
    os.environ['FAULT_EVERY'] = bad
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            M.rest_round(object(), 'pnrest', 0)
        r = False
    except SystemExit:
        r = True
    check('FAULT_EVERY=%s: refused' % bad, r)
os.environ.pop('FAULT_EVERY')

# 2. the title read-back
T = 'measure394 faulttest 1'
hit = {'id': 9, 'title': {'raw': T}}
other = lambda n: {'id': n, 'title': {'raw': 'measure394 faulttest 1%d' % n}}
def st(pages):
    calls.clear(); M.req = fake(pages)
    return M.check_state(object(), 'n1', {'code': 500}, T)['state']
check('found on page 2 (round 1 LIKE-matches 10 to 19)', st([[other(0), other(1), other(2)], [other(3), hit]]) == 'found')
q = [c['path'] for c in calls if 'search=' in c['path']]
check('  the search is the exact quoted title, 3 a page, _fields=id,title', all('per_page=3' in p and '_fields=id,title' in p and 'search=%22measure394+faulttest+1%22' in p for p in q) and len(q) == 2)
check('absent when the results run out (a short page)', st([[other(0), other(1), other(2)], [other(3)]]) == 'absent')
check('absent past the last page (400)', st([[other(0), other(1), other(2)]]) == 'absent')
check('read-failed when a page fails, never absent', st([[other(0), other(1), other(2)], {'code': 503, 'body': b'The site restarted'}]) == 'read-failed')
calls.clear(); M.req = fake([[]])
s = M.check_state(object(), 'n1', {'code': 201, 'body': b'{"id": 77}'}, T)
check('a 201 still reads back by its id', any('/wp/v2/pages/77&context=edit' in c['path'] for c in calls))

# 3. tally of the injected creates
rs = [dict(label='rest-page', code=500, state='absent', frame='rolled-back', injected=True),
      dict(label='rest-page', code=500, state='absent', frame=None, injected=True),
      dict(label='rest-page', code=201, state='found', injected=True),
      dict(label='rest-page', code=500, state='found', frame='kept', injected=True),
      dict(label='rest-page', code=201, state='found', injected=False)]
t = M.tally(rs)['injected']
check('tally: 4 injected, 3 answered 5xx, 1 answered 2xx (not fired)', (t['n'], t['5xx'], t['2xx']) == (4, 3, 1))
check('  frame states of the injected 5xx (none counted apart: the frame row is missing)', t['frame'] == {'rolled-back': 1, 'none': 1, 'kept': 1})
check('  injected 5xx found on read-back (kept, told failed)', t['5xx-found'] == 1)
print('%d failing check(s)' % fail)
sys.exit(1 if fail else 0)
