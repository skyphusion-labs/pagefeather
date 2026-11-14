#!/usr/bin/env python3
"""#519: measure394.classify, the state of a create from one read-back. A failed read must never be
counted as an absent row (op48arena counted 3 client exceptions and a 520 as 4 lost writes), and a
read without title.raw (context=view) must never be counted as absent either (the after-run search
that could not see any title). Offline: no network.
  python3 -I spikes/b2-wordpress/tests/measure394-state-test.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.argv = [sys.argv[0], 'statetest']
from measure394 import classify

T = 'measure394 statetest 7'
edit = lambda i, t: {'id': i, 'title': {'raw': t, 'rendered': t}}
view = lambda i, t: {'id': i, 'title': {'rendered': t}}
cases = [
    ('by id, the row is there', (200, json.dumps(edit(4724, T)), T, 4724), 'found'),
    ('by id, 404: the row is not there', (404, b'{"code":"rest_post_invalid_id"}', T, 4724), 'absent'),
    ('by id, another title', (200, json.dumps(edit(4724, 'other')), T, 4724), 'mismatch'),
    ('by id, an exception', ('EXC', b'', T, 4724), 'read-failed'),
    ('by id, a 520', (520, b'<html>', T, 4724), 'read-failed'),
    ('by id, a 500', (500, b'{}', T, 4724), 'read-failed'),
    ('by id, a 401 (bad nonce)', (401, b'{"code":"rest_cookie_invalid_nonce"}', T, 4724), 'read-failed'),
    ('by id, 200 but not JSON', (200, b'<html>', T, 4724), 'read-failed'),
    ('by id, view context (no raw): blind', (200, json.dumps(view(4724, T)), T, 4724), 'read-failed'),
    ('by title, one exact match among many', (200, json.dumps([edit(1, 'measure394 statetest 70'), edit(2, T)]), T, None), 'found'),
    ('by title, none match', (200, json.dumps([edit(1, 'measure394 statetest 70')]), T, None), 'absent'),
    ('by title, empty list', (200, b'[]', T, None), 'absent'),
    ('by title, 404 is a failed read (no id to miss)', (404, b'{}', T, None), 'read-failed'),
    ('by title, view context: blind', (200, json.dumps([view(2, T)]), T, None), 'read-failed'),
    ('by title, an exception', ('EXC', b'', T, None), 'read-failed'),
]
fail = 0
for name, args, want in cases:
    got = classify(*args)
    ok = got == want
    fail += not ok
    print('%s %s: %s' % ('PASS' if ok else 'FAIL', name, got if ok else 'got %s, want %s' % (got, want)))
print('%d failing check(s)' % fail)
sys.exit(1 if fail else 0)
