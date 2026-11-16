#!/usr/bin/env python3
"""page_class on a plain run and on a store run (#691). No site.

On WOO=0 the browse paths are PLAIN (home, a post, a page, search, a category,
the feed). Those are posts, not products: cache_by_page and hit_share must say
post, including for /?p=1. On WOO=1 a permalink from the Store API product list
stays product, and the two fixed paths stay home and shop (the names the #628
scorer reads).

Run: python3 -I tests/load/page-class-test.py
"""
import json, os, subprocess, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
PLAIN = ("/", "/?p=1", "/?page_id=2", "/?s=hello", "/?cat=1", "/?feed=rss2")
POST = "/?p=1"
fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(name)
        print("FAIL", name, str(detail)[:400])


class H(BaseHTTPRequestHandler):
    seen = None
    bad = None
    lock = None
    woo = False

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="text/html", headers=None):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = self.path
        if self.woo and "rest_route=/wc/store/v1/products" in p:
            prod = [{"id": 7, "permalink": "http://stub.example/product/mug/",
                     "is_purchasable": True, "is_in_stock": True}]
            return self.send(200, json.dumps(prod), "application/json")
        with self.lock:
            self.seen.append(p)
        if self.woo:
            if p not in ("/", "/?post_type=product") and not p.startswith("/product/"):
                self.bad.append(p)
        elif p not in PLAIN:
            self.bad.append(p)
        self.send(200, "ok", headers={"cf-cache-status": "HIT"})


def run(woo):
    seen, bad = [], []
    lock = threading.Lock()
    H.seen, H.bad, H.lock, H.woo = seen, bad, lock, woo
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
           "B": "http://127.0.0.1:%d" % srv.server_address[1],
           "WOO": "1" if woo else "0", "SETUP": "0",
           "LEVELS": "4", "SECONDS": "3", "BUYERS": "0", "ADMINS": "0",
           "LOAD_MODE": "cached"}
    p = subprocess.run([sys.executable, "-I", LOAD], env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True, timeout=60)
    srv.shutdown()
    steps = [json.loads(l) for l in p.stdout.splitlines()
             if l.startswith("{") and '"users"' in l and '"steps"' not in l]
    return p, steps, seen, bad


plain, psteps, pseen, pbad = run(False)
check("plain run completed", plain.returncode == 0 and len(psteps) == 1,
      (plain.returncode, plain.stderr[-300:]))
check("plain run requested the post path", POST in pseen, pseen[:8])
check("plain run requested no other path", not pbad, pbad[:3])
if psteps:
    by = psteps[0].get("cache_by_page") or {}
    hs = psteps[0].get("hit_share") or {}
    check("a non-Woo post is class post, not product",
          set(by) == {"post"} and hs.get("post") == 1.0 and "product" not in hs,
          (by, hs))

woo, wsteps, wseen, wbad = run(True)
check("Woo run completed", woo.returncode == 0 and len(wsteps) == 1,
      (woo.returncode, woo.stderr[-300:]))
check("Woo run requested a product path", any(x.startswith("/product/") for x in wseen), wseen[:8])
check("Woo run requested no other path", not wbad, wbad[:3])
if wsteps:
    by = wsteps[0].get("cache_by_page") or {}
    check("a Woo product path is still product, and home and shop stay",
          set(by) == {"home", "shop", "product"} and by.get("product"),
          by)

if fails:
    print("%d FAILED" % len(fails))
    sys.exit(1)
print("page-class-test: all pass")
