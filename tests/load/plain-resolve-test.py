#!/usr/bin/env python3
"""#760: a non-Woo load run measures where each PLAIN page renders, never a redirect. No site.
A fresh install has pretty permalinks now, so /?p=1, /?page_id=2, /?cat=1 and /?feed=rss2 answer
301 to their pretty URL; load.py follows no redirect. resolve_plain follows each same-site Location
once before the run. Against a stub that redirects as such a site does:
  - the run completes, and every browse request after the resolve phase gets a 200 (no 3xx measured);
  - each redirecting path is asked once (the resolve), and the pretty targets are what the run browses;
  - a redirect chain longer than the hop bound, or a redirect off the site, ends the run (non-zero), named.
The plain case (no redirects) is page-class-test.py's: it keeps the PLAIN paths as they are.
Run: python3 -I tests/load/plain-resolve-test.py
"""
import json, os, subprocess, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
LOAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
fails = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:300]))
    if not ok:
        fails.append(name)
PRETTY = {"/?p=1": "/2026/11/16/hello-world/", "/?page_id=2": "/sample-page/",
          "/?cat=1": "/category/uncategorized/", "/?feed=rss2": "/feed/"}
TARGETS = {"/", "/?s=hello"} | set(PRETTY.values())
class H(BaseHTTPRequestHandler):
    seen = None; lock = None; mode = "pretty"
    def log_message(self, *a): pass
    def send(self, code, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            # A header name or value with CR or LF would split the response: refuse it loudly, so a test fails.
            if any(ch in str(x) for x in (k, v) for ch in "\r\n"):
                raise ValueError("CR or LF in a response header: %r" % k)
            self.send_header(k, v)
        self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"ok")
    def do_GET(self):
        p = self.path
        with self.lock:
            self.seen.append(p)
        if p in PRETTY:
            if self.mode == "offsite" and p == "/?cat=1":
                return self.send(301, {"Location": "https://elsewhere.example/category/uncategorized/"})
            if self.mode == "loop" and p == "/?cat=1":
                return self.send(301, {"Location": "/?cat=1"})
            # one absolute, the rest relative, as WordPress sends absolute ones
            # The absolute one is built from the server's own bound address, never from the request (Host).
            host, port = self.server.server_address[:2]
            loc = ("http://%s:%d" % (host, port) + PRETTY[p]) if p == "/?page_id=2" else PRETTY[p]
            return self.send(301, {"Location": loc})
        self.send(200, {"cf-cache-status": "HIT"})
def run(mode):
    seen = []
    H.seen, H.lock, H.mode = seen, threading.Lock(), mode
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": "http://127.0.0.1:%d" % srv.server_address[1],
           "WOO": "0", "SETUP": "0", "LEVELS": "4", "SECONDS": "3", "BUYERS": "0", "ADMINS": "0", "LOAD_MODE": "cached"}
    p = subprocess.run([sys.executable, "-I", LOAD], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True, timeout=60)
    srv.shutdown()
    return p, seen
p, seen = run("pretty")
steps = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{") and '"users"' in l and '"steps"' not in l]
check("the run completes", p.returncode == 0 and len(steps) == 1, (p.returncode, p.stderr[-300:]))
redirecting = [x for x in seen if x in PRETTY]
check("each redirecting PLAIN path is asked exactly once (the resolve)", sorted(redirecting) == sorted(PRETTY), redirecting)
browsed = [x for x in seen if x not in PRETTY]
check("the run browses only the pages' own URLs", set(browsed) <= TARGETS and len(browsed) > len(TARGETS), sorted(set(browsed)))
check("every pretty target is browsed", set(PRETTY.values()) <= set(browsed), sorted(set(browsed)))
if steps:
    s = steps[0]
    st = s.get("status") or {}
    check("every request of the run answered 200, none a redirect", set(st) == {"200"} and st["200"] == s.get("requests", -1) > 0, (st, s.get("requests")))
p, _ = run("offsite")
check("a redirect off the site ends the run, named", p.returncode != 0 and "redirects off this site" in p.stderr, (p.returncode, p.stderr[-200:]))
p, _ = run("loop")
check("a redirect that never settles ends the run, named", p.returncode != 0 and "did not settle" in p.stderr, (p.returncode, p.stderr[-200:]))
print("%d failing" % len(fails))
sys.exit(1 if fails else 0)
