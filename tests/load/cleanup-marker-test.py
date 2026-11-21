#!/usr/bin/env python3
"""Test of tests/load/load.py's run markers (#704). No site.

#704's first count window was load.py's whole run, and it held the CLEANUP that deletes the run's orders:
those deletions asked 119 + 119 purges that looked like "one per checkout". So load.py now prints three
structured lines with the UTC time: steps-start (after setup), cleanup-start and cleanup-end. A count
window can then never mix the checkouts and the cleanup.
The stub store: setup, products, cart, add-item, checkout, admin login, stock read and order DELETE. It
records when each order DELETE reached it. Every DELETE must fall between cleanup-start and cleanup-end,
and none before steps end. Run: python3 -I tests/load/cleanup-marker-test.py
"""
import calendar, json, os, re, subprocess, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
lock = threading.Lock()
S = {"next": 500, "deletes": [], "bad": []}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", headers=None):
        b = body if isinstance(body, bytes) else (body.encode() if isinstance(body, str) else json.dumps(body).encode())
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("content-length", 0))
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        p = self.path
        if p.startswith("/wp-login.php"):
            return self.send(200, "login", "text/html")
        if p.startswith("/wp-admin/admin-ajax.php"):
            return self.send(200, "abcdef0123", "text/plain")
        if p.startswith("/wp-admin/post-new.php"):
            return self.send(200, 'wpApiSettings = {"nonce":"abcdef0123"}', "text/html")
        if "rest_route=/wc/store/v1/products" in p:
            return self.send(200, [{"id": i, "permalink": "http://s.example/product/p%d/" % i, "is_purchasable": True, "is_in_stock": True} for i in (1, 2)])
        if "rest_route=/wc/store/v1/cart" in p:
            return self.send(200, {"items": []}, headers={"Nonce": "n1", "Cart-Token": "t%d" % (time.time() * 1e6)})
        if re.search(r"rest_route=/wc/v3/products/\d+", p):
            return self.send(200, {"manage_stock": False, "stock_quantity": None})
        if "rest_route=/wp/v2/pages" in p:
            return self.send(200, [])
        if p.startswith("/product/") or p == "/" or p.startswith("/?post_type"):
            return self.send(200, "page", "text/html")
        # #1145: CLEANUP reads the Scheduled Actions screen after it deletes orders.
        # This run queues no emails, so the screen is empty.
        if p.startswith("/wp-admin/admin.php") and "action-scheduler" in p:
            return self.send(200, '<h1>Scheduled Actions</h1><form id="action-scheduler-filter"><table></table></form>', "text/html")
        S["bad"].append("GET " + p)
        self.send(404, {})

    def do_POST(self):
        p = self.path
        self.body()
        if p.startswith("/wp-login.php"):
            return self.send(302, "", "text/html", {"Set-Cookie": "wordpress_logged_in_x=a; Path=/", "Location": "/wp-admin/"})
        if "rest_route=/wc/v3/products" in p:
            with lock:
                S["next"] += 1
                return self.send(201, {"id": S["next"]})
        if "rest_route=/wc-admin/options" in p:
            return self.send(200, {})
        if "rest_route=/wc/store/v1/cart/add-item" in p:
            return self.send(201, {})
        if "rest_route=/wc/store/v1/checkout" in p:
            with lock:
                S["next"] += 1
                return self.send(200, {"order_id": S["next"]})
        S["bad"].append("POST " + p)
        self.send(404, {})

    def do_PUT(self):
        self.body()
        return self.send(200, {})

    def do_DELETE(self):
        if re.search(r"rest_route=/wc/v3/orders/\d+", self.path):
            with lock:
                S["deletes"].append(time.time())
            return self.send(200, {"deleted": True})
        S["bad"].append("DELETE " + self.path)
        self.send(404, {})


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": "http://127.0.0.1:%d" % srv.server_address[1], "WOO": "1", "SETUP": "1",
       "LEVELS": "2", "SECONDS": "2", "BUYERS": "0.5", "ADMINS": "0", "CLEANUP": "1", "ADMIN_PASSWORD": "pw-" + "q" * 10, "LOAD_MODE": "cached"}
p = subprocess.run([sys.executable, "-I", LOAD], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=180)
srv.shutdown()
ev = {}
for l in p.stdout.splitlines():
    if l.startswith("{") and '"@event"' in l:
        d = json.loads(l)
        ev[d["@event"]] = d
fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(name)
        print("FAIL", name, str(detail)[:300])


def zt(e):
    return calendar.timegm(time.strptime(ev[e]["t"], "%Y-%m-%dT%H:%M:%SZ")) if e in ev else None


check("load.py ran", p.returncode == 0, p.stderr[-300:])
check("no unknown request", not S["bad"], S["bad"][:3])
for e in ("steps-start", "cleanup-start", "cleanup-end"):
    check("it prints %s with a UTC time" % e, e in ev and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", ev[e].get("t", "")) is not None, ev.get(e))
if all(e in ev for e in ("steps-start", "cleanup-start", "cleanup-end")):
    a, b, c = zt("steps-start"), zt("cleanup-start"), zt("cleanup-end")
    check("the markers are in order", a <= b <= c, (a, b, c))
    check("some orders were deleted", len(S["deletes"]) > 0, len(S["deletes"]))
    # one second of slack: the markers have second resolution
    check("every order DELETE is inside the cleanup window", all(b - 1 <= t <= c + 1 for t in S["deletes"]), (b, c, S["deletes"][:3]))
    check("the summary names the cleanup window", "cleanup_window" in (json.loads(p.stdout.strip().splitlines()[-1]) if p.stdout.strip() else {}), p.stdout.strip().splitlines()[-1][:200] if p.stdout.strip() else "")
if fails:
    print("%d FAILED" % len(fails))
    sys.exit(1)
print("cleanup-marker-test: all pass")
