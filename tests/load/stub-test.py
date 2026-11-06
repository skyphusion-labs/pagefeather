#!/usr/bin/env python3
"""Test of tests/load/load.py against a stub Store API (issue #40). No site.

Usage: python3 tests/load/stub-test.py [path/to/load.py]   (default: tests/load/load.py)

The stub answers the cart request in turn with 500, a dropped connection
(load.py sees an exception, as for a timeout) and 200 with a Nonce. add-item
and checkout answer 401 when the Nonce header is missing, as WooCommerce does.
load.py runs one short step (3 users, 3 s, every loop buys). The checks:
no add-item or checkout reaches the stub without a Nonce; no 401 is
recorded; "aborted" equals the failed cart requests; buys still succeed.
Exit 0 when all pass. With the load.py from before #40 the checks fail
(that is the control).
"""
import json, os, socket, subprocess, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOAD = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
lock = threading.Lock()
seen = {"cart": 0, "cart_failed": 0, "add": 0, "checkout": 0, "no_nonce": 0}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj, headers=None):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def route(self):
        q = self.path.split("rest_route=", 1)[-1].split("&", 1)[0]
        return q.replace("%2F", "/")

    def do_GET(self):
        r = self.route()
        if r.startswith("/wc/store/v1/products"):
            return self.send(200, [{"id": i, "is_purchasable": True, "is_in_stock": True, "permalink": "http://stub/?p=%d" % i} for i in (1, 2)])
        if r == "/wc/store/v1/cart":
            with lock:
                seen["cart"] += 1
                n = seen["cart"]
                if n % 3 != 0:
                    seen["cart_failed"] += 1
            if n % 3 == 1:
                return self.send(500, {"code": "stub_error"})
            if n % 3 == 2:
                # Drop the connection with no answer: the client raises.
                self.connection.shutdown(socket.SHUT_RDWR)
                self.close_connection = True
                return
            return self.send(200, {"items": []}, {"Nonce": "stubnonce", "Cart-Token": "stubtoken"})
        return self.send(200, {})

    def do_POST(self):
        r = self.route()
        self.rfile.read(int(self.headers.get("content-length") or 0))
        kind = "add" if r == "/wc/store/v1/cart/add-item" else "checkout" if r == "/wc/store/v1/checkout" else None
        if not kind:
            return self.send(404, {})
        with lock:
            seen[kind] += 1
            if not self.headers.get("Nonce"):
                seen["no_nonce"] += 1
        if not self.headers.get("Nonce"):
            return self.send(401, {"code": "woocommerce_rest_missing_nonce"})
        return self.send(201 if kind == "add" else 200, {"order_id": 7} if kind == "checkout" else {"items": [1]})


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = dict(os.environ, B="http://127.0.0.1:%d" % srv.server_address[1], LEVELS="3", SECONDS="3", BUYERS="1", SETUP="0", WOO="1")
p = subprocess.run([sys.executable, LOAD], env=env, capture_output=True, text=True, timeout=120)
srv.shutdown()
steps = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{") and '"users"' in l and '"steps"' not in l]
if p.returncode != 0 or not steps:
    print("load.py did not run:", p.returncode, p.stderr[-500:])
    sys.exit(1)
s = steps[0]
checks = [
    ("no add-item or checkout without a Nonce reached the site", seen["no_nonce"] == 0, seen["no_nonce"]),
    ("no 401 recorded", s["status"].get("401", 0) == 0, s["status"]),
    ("aborted equals the failed cart requests", s.get("aborted") == seen["cart_failed"], (s.get("aborted"), seen["cart_failed"])),
    ("some loops did buy (checkout ok > 0)", (s["kinds"].get("checkout") or {}).get("ok", 0) > 0, s["kinds"].get("checkout")),
    ("the stub saw failed carts (the test exercised the path)", seen["cart_failed"] > 0, seen["cart_failed"]),
]
fails = 0
for name, ok, detail in checks:
    print(("ok   " if ok else "FAIL ") + name + "  " + json.dumps(detail))
    fails += not ok
print("stub saw:", json.dumps(seen))
sys.exit(1 if fails else 0)
