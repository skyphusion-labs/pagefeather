#!/usr/bin/env python3
"""Test of tests/load/load.py ADMINS and CLEANUP (#394) against a stub site. No site.

Usage: python3 tests/load/admin-stub-test.py [path/to/load.py]   (default: tests/load/load.py)

The stub answers a WooCommerce site's login, REST nonce, admin screens, REST draft pages, Store API
cart/add/checkout (each checkout makes a new order id and takes 1 from the product's stock), and the
admin REST API for products (stock) and orders. Two runs:
  1. ADMINS=0 (the old behaviour): no request reaches an admin URL.
  2. ADMINS=0.5 BUYERS=0.5 CLEANUP=1: admin loops ran (all three kinds), checkouts made orders, and
     the cleanup deleted every order the run made, put the stock back as it was, and deleted every
     draft page the run made, and nothing else (a page that is not the run's is kept).
Exit 0 when all pass.
"""
import json, os, re, subprocess, sys, threading, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOAD = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
lock = threading.Lock()
S = {}

def reset():
    S.clear()
    S.update({"admin_hits": 0, "orders": {}, "next_order": 100, "stock": {1: 50, 2: 50}, "pages": {9000: "not the run's page"}, "next_page": 9001, "kinds": {}})

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj, headers=None):
        b = json.dumps(obj).encode() if not isinstance(obj, bytes) else obj
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b)))
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)
    def route(self):
        q = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(q.query)
        return q.path, (params.get("rest_route") or [""])[0], params
    def body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""
    def count(self, k):
        with lock: S["kinds"][k] = S["kinds"].get(k, 0) + 1
    def do_GET(self):
        path, r, params = self.route()
        if path.startswith("/wp-admin") or path == "/wp-login.php":
            with lock: S["admin_hits"] += 1
        if path == "/wp-admin/admin-ajax.php": return self.send(200, b"stubnonce")
        if path == "/wp-login.php": return self.send(200, b"login")
        if path == "/wp-admin/": self.count("dash"); return self.send(200, b"dash")
        if path == "/wp-admin/post-new.php": self.count("postnew"); return self.send(200, b"postnew")
        if r.startswith("/wc/store/v1/products"):
            return self.send(200, [{"id": i, "is_purchasable": True, "is_in_stock": True, "permalink": "http://stub/?p=%d" % i} for i in (1, 2)])
        if r == "/wc/store/v1/cart": return self.send(200, {"items": []}, {"Nonce": "n", "Cart-Token": "t"})
        m = re.match(r"^/wc/v3/products/(\d+)$", r)
        if m:
            i = int(m.group(1)); return self.send(200, {"id": i, "manage_stock": True, "stock_quantity": S["stock"][i]})
        if r == "/wp/v2/pages":
            tag = (params.get("search") or [""])[0]
            with lock: found = [{"id": k} for k, v in S["pages"].items() if tag and tag in v]
            return self.send(200, found)
        return self.send(200, b"page")
    def do_POST(self):
        path, r, params = self.route(); b = self.body()
        if path == "/wp-login.php":
            with lock: S["admin_hits"] += 1
            return self.send(302, b"", {"Location": "/wp-admin/", "Set-Cookie": "wordpress_logged_in_x=1; Path=/"})
        if r == "/wc/store/v1/cart/add-item": return self.send(201, {"items": [1]})
        if r == "/wc/store/v1/checkout":
            pid = 1
            with lock:
                oid = S["next_order"]; S["next_order"] += 1; S["orders"][oid] = True; S["stock"][pid] -= 1
            return self.send(200, {"order_id": oid})
        if r == "/wp/v2/pages":
            self.count("rest")
            title = json.loads(b or b"{}").get("title", "")
            with lock:
                pid = S["next_page"]; S["next_page"] += 1; S["pages"][pid] = title
            return self.send(201, {"id": pid})
        return self.send(404, {})
    def do_PUT(self):
        path, r, params = self.route(); b = self.body()
        m = re.match(r"^/wc/v3/products/(\d+)$", r)
        if m:
            with lock: S["stock"][int(m.group(1))] = json.loads(b)["stock_quantity"]
            return self.send(200, {})
        return self.send(404, {})
    def do_DELETE(self):
        path, r, params = self.route()
        m = re.match(r"^/wc/v3/orders/(\d+)$", r)
        if m:
            with lock: ok = S["orders"].pop(int(m.group(1)), None)
            return self.send(200 if ok else 404, {})
        m = re.match(r"^/wp/v2/pages/(\d+)$", r)
        if m:
            with lock: ok = S["pages"].pop(int(m.group(1)), None)
            return self.send(200 if ok else 404, {})
        return self.send(404, {})

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = dict(os.environ, B="http://127.0.0.1:%d" % srv.server_address[1], LEVELS="3", SECONDS="3", SETUP="0", WOO="1", ADMIN_PASSWORD="stub")
fails = 0
def check(name, ok, detail=""):
    global fails
    print(("ok   " if ok else "FAIL ") + name + "  " + json.dumps(detail)); fails += not ok
def run(**env):
    p = subprocess.run([sys.executable, LOAD], env=dict(base, **env), capture_output=True, text=True, timeout=120)
    lines = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
    return p, lines

reset()
p, lines = run(ADMINS="0", BUYERS="0.5")
check("ADMINS=0: load.py runs", p.returncode == 0, p.returncode)
check("ADMINS=0: no admin URL reached (the old behaviour)", S["admin_hits"] == 0, S["admin_hits"])

reset()
stock0 = dict(S["stock"])
p, lines = run(ADMINS="0.5", BUYERS="0.5", CLEANUP="1")
summary = lines[-1] if lines else {}
step = (summary.get("steps") or [{}])[0]
kinds = step.get("kinds", {})
cl = summary.get("cleanup", {})
check("ADMINS+CLEANUP: load.py runs", p.returncode == 0, p.stderr[-300:])
check("admin loops ran: dashboard, post-new and REST create", all(k in kinds for k in ("admin-dash", "admin-postnew", "admin-rest")), sorted(kinds))
check("checkouts made orders", cl.get("orders_made", 0) > 0, cl)
check("cleanup deleted every order the run made", cl.get("orders_deleted") == cl.get("orders_made") and not S["orders"], cl)
check("cleanup put the stock back as it was", S["stock"] == stock0, S["stock"])
check("cleanup deleted the run's draft pages", cl.get("draft_pages_deleted", 0) == S["kinds"].get("rest", -1), (cl, S["kinds"].get("rest")))
check("a page that is not the run's is kept", 9000 in S["pages"] and len(S["pages"]) == 1, sorted(S["pages"]))
srv.shutdown()
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
