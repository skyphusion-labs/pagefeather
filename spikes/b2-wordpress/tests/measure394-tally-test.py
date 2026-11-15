#!/usr/bin/env python3
"""#589: measure394.tally, the cross-tab of one REST write's ANSWER, its READ-BACK state and its FRAME
state (#352 /_frame). The #589 defect is "5xx and found": the write committed, the client was told it
failed. "2xx and absent" is a silent loss and must stay 0. A failed read (read-failed) is never counted
as found or absent (#519). Offline: no network.
  python3 -I spikes/b2-wordpress/tests/measure394-tally-test.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.argv = [sys.argv[0], 'tallytest']
from measure394 import tally

def w(code, state, frame=None, wl=None, reset=None):
    return {'label': 'rest-page', 'code': code, 'state': state, 'frame': frame, 'writeLoss': wl, 'reset': reset}

rows = [
    w(201, 'found'), w(201, 'found'),
    w(500, 'found', 'kept', 'unknown', 'storage'),          # the #589 defect: committed, told failed
    w(500, 'found', None, 'unknown', 'memory'),             # frames off: no frame state
    w(500, 'absent', 'rolled-back', 'rolled-back', 'memory'),  # proven rollback: correct
    w(500, 'absent', 'ended-at-reset', 'unknown', 'memory'),
    w(201, 'absent'),                                       # a silent loss
    w(500, 'read-failed', 'kept', 'unknown', 'memory'),     # unknown outcome: never found or absent
    {'label': 'post-new', 'code': 500, 'state': None},      # not a REST write: ignored
]
t = tally(rows)
fail = 0
def check(name, got, want):
    global fail
    ok = got == want; fail += not ok
    print('%s %s: %s' % ('PASS' if ok else 'FAIL', name, got if ok else 'got %r, want %r' % (got, want)))
check('writes counted (REST only)', t['writes'], 8)
check('2xx and found', t['2xx-found'], 2)
check('5xx and found (the #589 defect)', t['5xx-found'], 2)
check('5xx and absent', t['5xx-absent'], 2)
check('2xx and absent (silent loss)', t['2xx-absent'], 1)
check('read-failed is its own bucket', t['read-failed'], 1)
check('frame states of the 5xx', t['frame5xx'], {'kept': 2, 'none': 1, 'rolled-back': 1, 'ended-at-reset': 1})
check('5xx-found by frame state', t['5xx-found-by-frame'], {'kept': 1, 'none': 1})
check('reset kinds of the 5xx', t['reset5xx'], {'storage': 1, 'memory': 4})

# frame_of against a stand-in Worker: a 5xx with x-pf-req is probed at /_frame?id=, the state read back.
import http.server, threading, importlib
seen = []
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        seen.append((self.path, self.headers.get('x-spike-token')))
        b = b'{"frame": {"req": "pf-1", "state": "kept", "points": 0}}'
        self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
import break_lib, measure394
os.environ['SPIKE_TOKEN'] = 'test'
break_lib.B = 'http://127.0.0.1:%d' % srv.server_port
measure394.req.__globals__['B'] = break_lib.B
fr = measure394.frame_of(break_lib.opener(), {'code': 500, 'h': {'x-pf-req': 'pf-1'}})
check('frame_of reads the frame state of a 5xx', fr.get('frame'), 'kept')
check('  it asked /_frame?id=<x-pf-req> with the spike token', seen[-1:], [('/_frame?id=pf-1', 'test')])
check('frame_of skips a 2xx (no probe)', (measure394.frame_of(break_lib.opener(), {'code': 201, 'h': {'x-pf-req': 'pf-2'}}), len(seen)), ({}, 1))
del os.environ['SPIKE_TOKEN']
check('frame_of without the spike token records none, no probe', (measure394.frame_of(break_lib.opener(), {'code': 500, 'h': {'x-pf-req': 'pf-3'}}), len(seen)), ({'frame': None}, 1))
srv.shutdown()
print('%d failing check(s)' % fail)
sys.exit(1 if fail else 0)
