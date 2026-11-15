#!/usr/bin/env python3
"""break_lib records x-d1-first-failure (the first failed SQL statement of a request, index.js; sent
only with the spike token) when D1_FIRST_FAILURE=1, so a woo.py or break.py run names the statement
behind an x-d1-failures count (#638: lean showed fail 1 on every woo.py step and nothing named it).
Off by default: the header carries SQL text, which can hold row data. Against a stand-in server.
Run: python3 -I spikes/b2-wordpress/tests/break-lib-first-failure-test.py"""
import http.server, importlib, os, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
FIRST = "no such function: REGEXP | SELECT 1 FROM wp_options WHERE option_name REGEXP ?"

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header("x-d1-calls", "9"); self.send_header("x-d1-failures", "1")
        self.send_header("x-d1-first-failure", FIRST)
        self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"ok")

srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
fails = 0
def check(name, ok):
    global fails
    print(("PASS " if ok else "FAIL ") + name); fails += 0 if ok else 1

def load(**env):
    for k in ("D1_FIRST_FAILURE", "SPIKE_TOKEN"):
        os.environ.pop(k, None)
    os.environ.update(env, B="http://127.0.0.1:%d" % srv.server_port)
    sys.path.insert(0, HERE)
    import break_lib
    return importlib.reload(break_lib)

L = load(SPIKE_TOKEN="test")
s = L.short(L.req(L.opener(), "/"))
check("off by default: short() has no firstFail", "firstFail" not in s)
check("  and fail still reads the count", s.get("fail") == "1")
L = load(SPIKE_TOKEN="test", D1_FIRST_FAILURE="1")
s = L.short(L.req(L.opener(), "/"))
check("D1_FIRST_FAILURE=1: short() names the failed statement", s.get("firstFail") == FIRST)
check("  the count is kept beside it", s.get("fail") == "1")
srv.shutdown()
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
