#!/usr/bin/env python3
"""Test of tests/load/load.py's cache split by page class (#628 C2). No site.

The #628 bar compares the PRODUCT-page HIT share between two arms, but load.py's browse mix is "/",
"/?post_type=product" and product permalinks, and the home page is not under C2. So each browse row
gets a class (home, shop, product), and each step reports cache_by_page and hit_share per class.
The stub: "/" is always HIT, the shop is always MISS, a product page alternates HIT and EXPIRED.
EXPIRED is not a hit (the page came from the Worker). Run: python3 -I tests/load/cache-by-page-test.py
"""
import json, os, subprocess, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
lock = threading.Lock()
n_product = [0]
# The flat shape, measured on pf628 at ea50be6 (2026-11-15): every read answered EXPIRED outside while
# the render stamp showed a 120 s cache. So the home page here is EXPIRED on every read but served from
# a 2 s cache with its stamp: a status-based share reads 0, the stamp-based share must not.
home_cache = {"made": 0.0}
bad = []


class H(BaseHTTPRequestHandler):
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
        if "rest_route=/wc/store/v1/products" in p:
            prods = [{"id": i, "permalink": "http://stub.example/product/p%d/" % i, "is_purchasable": True, "is_in_stock": True} for i in (1, 2)]
            return self.send(200, json.dumps(prods), "application/json")
        if p == "/":
            import time as _t
            now = _t.time()
            with lock:
                if now - home_cache["made"] >= 2.0:
                    home_cache["made"] = now
                made = int(home_cache["made"] * 1000)
            return self.send(200, "home", headers={"cf-cache-status": "EXPIRED", "x-pf-rendered": str(made)})
        if p == "/?post_type=product":
            # a fresh render on every read: stamped NOW, so never a stamp hit
            import time as _t
            return self.send(200, "shop", headers={"cf-cache-status": "MISS", "x-pf-rendered": str(int(_t.time() * 1000))})
        if p.startswith("/product/p"):
            with lock:
                n_product[0] += 1
                st = "HIT" if n_product[0] % 2 else "EXPIRED"
            return self.send(200, "product", headers={"cf-cache-status": st})
        bad.append(p)
        self.send(404, "no")


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": "http://127.0.0.1:%d" % srv.server_address[1], "WOO": "1", "SETUP": "0",
       "LEVELS": "3", "SECONDS": "3", "BUYERS": "0", "ADMINS": "0", "LOAD_MODE": "cached",
       # the stub caches for 2 s, so the stamp margin is scaled down with it (a real site: 120 s and 1500 ms)
       "STAMP_HIT_MS": "100"}
p = subprocess.run([sys.executable, "-I", LOAD], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=120)
srv.shutdown()
steps = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{") and '"users"' in l and '"steps"' not in l]
fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(name)
        print("FAIL", name, str(detail)[:300])


check("load.py ran one step", p.returncode == 0 and len(steps) == 1, (p.returncode, p.stderr[-300:]))
check("no unknown path", not bad, bad[:3])
if steps:
    s = steps[0]
    by = s.get("cache_by_page") or {}
    hs = s.get("hit_share") or {}
    check("three page classes", set(by) == {"home", "shop", "product"}, by)
    check("the classes add up to the browse mix", sum(sum(v.values()) for v in by.values()) == sum((s.get("cache") or {}).values()), (by, s.get("cache")))
    check("home by status is no HIT (EXPIRED outside)", hs.get("home") == 0.0, hs)
    st = s.get("hit_share_stamp") or {}
    check("home by stamp is mostly cached", st.get("home") is not None and st["home"] >= 0.5, st)
    check("home by stamp is not ALL cached (each window starts with a fresh render)", st.get("home") is not None and st["home"] < 1.0, st)
    check("a fresh render on every read is never a stamp hit", st.get("shop") == 0.0, st)
    check("pages with no stamp have no stamp share", "product" not in st, st)
    check("stamped reads are counted", (s.get("stamped") or {}).get("home", 0) > 0, s.get("stamped"))
    check("shop is no HIT", hs.get("shop") == 0.0, hs)
    check("product is about half (EXPIRED is not a hit)", hs.get("product") is not None and 0.3 <= hs["product"] <= 0.7 and by.get("product", {}).get("EXPIRED", 0) > 0, (hs, by.get("product")))
if fails:
    print("%d FAILED" % len(fails))
    sys.exit(1)
print("cache-by-page-test: all pass")
