#!/usr/bin/env python3
"""Test of tests/load/load.py against a stub Store API (#296, the #668 burst). No site.

Usage: python3 tests/load/stock-codes-stub-test.py [path/to/load.py]   (default: tests/load/load.py)

Two defects the #668 burst showed:
1. products() bought stock-managed products, so a long run sold one out mid-run: add-item 400
   woocommerce_rest_product_out_of_stock, then checkout 409 woocommerce_rest_cart_empty. Those are
   failures of the fixture, not of the site. A product with stock is one whose Store API
   add_to_cart.maximum is below 9999 (WooCommerce QuantityLimits: stock managed, no backorders).
2. A non-2xx kept only its status, so two checkout 403s could not be named. Each one now keeps the
   Store API error CODE, and only the code: never the message or the body, which can carry order data.

The stub lists product 1 (maximum 9999), product 2 (maximum 5, stock-managed) and product 3 (no
add_to_cart field: an older Store API, kept). Checkout answers 403 with a code, a message and a planted
marker every third time, and once a body that is not JSON. Exit 0 when all pass; with the load.py
from before this change the checks fail (that is the control).
"""
import json, os, subprocess, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOAD = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
MARK = "PLANTED-ORDER-DATA-7f3a"
lock = threading.Lock()
seen = {"add": {}, "checkout": 0, "nonjson": 0}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj, headers=None, raw=None):
        b = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def route(self):
        return self.path.split("rest_route=", 1)[-1].split("&", 1)[0].replace("%2F", "/")

    def do_GET(self):
        r = self.route()
        if r.startswith("/wc/store/v1/products"):
            mk = lambda i, extra: dict({"id": i, "is_purchasable": True, "is_in_stock": True, "permalink": "http://stub/?p=%d" % i}, **extra)
            return self.send(200, [mk(1, {"add_to_cart": {"minimum": 1, "maximum": 9999}}),
                                   mk(2, {"add_to_cart": {"minimum": 1, "maximum": 5}}),
                                   mk(3, {})])
        if r == "/wc/store/v1/cart":
            return self.send(200, {"items": []}, {"Nonce": "stubnonce", "Cart-Token": "stubtoken"})
        return self.send(200, {})

    def do_POST(self):
        r = self.route()
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        if r == "/wc/store/v1/cart/add-item":
            with lock:
                seen["add"][body.get("id")] = seen["add"].get(body.get("id"), 0) + 1
            if body.get("id") == 2:
                return self.send(400, {"code": "woocommerce_rest_product_out_of_stock", "message": MARK})
            return self.send(201, {"items": [1]})
        if r == "/wc/store/v1/checkout":
            with lock:
                seen["checkout"] += 1
                n = seen["checkout"]
            if n == 2:
                with lock:
                    seen["nonjson"] += 1
                return self.send(502, None, raw=b"<html>" + MARK.encode() + b"</html>")
            if n % 3 == 0:
                return self.send(403, {"code": "woocommerce_rest_stub_forbidden", "message": MARK, "data": {"order": MARK}})
            return self.send(200, {"order_id": 7, "billing_address": {"email": MARK}})
        return self.send(404, {})


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
codes = s.get("error_codes") or {}
checks = [
    ("no add-item for the stock-managed product (maximum 5)", seen["add"].get(2, 0) == 0, seen["add"]),
    ("the unlimited product (maximum 9999) was bought", seen["add"].get(1, 0) > 0, seen["add"]),
    ("a product with no add_to_cart field is kept (an older Store API)", seen["add"].get(3, 0) > 0, seen["add"]),
    ("the checkout 403 is kept with its Store API code", codes.get("checkout 403 woocommerce_rest_stub_forbidden", 0) > 0, codes),
    ("a non-JSON error body is kept as code none", codes.get("checkout 502 none", 0) == 1, codes),
    ("the stub sent a non-JSON error (the test exercised the path)", seen["nonjson"] == 1, seen["nonjson"]),
    ("no message or body text reaches the output", MARK not in p.stdout and MARK not in p.stderr, "marker absent" if MARK not in p.stdout + p.stderr else "MARKER FOUND"),
    ("a 2xx keeps no code", not any(k.split(" ")[1].startswith("2") for k in codes), codes),
]
fails = 0
for name, ok, detail in checks:
    print(("ok   " if ok else "FAIL ") + name + "  " + json.dumps(detail))
    fails += not ok
sys.exit(1 if fails else 0)
