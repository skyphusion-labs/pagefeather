#!/usr/bin/env python3
"""Test of tests/load/load.py ERRLOG against a stub Store API. No site.

Usage: python3 -I tests/load/errlog-stub-test.py [path/to/load.py]   (default: tests/load/load.py)

ERRLOG=<file> writes one JSON line per failed request with every response header by name, and the
value only for a diagnostic header. The stub answers every checkout 503 with diagnostic headers
(x-sql-failure, x-write-loss, cf-ray, retry-after), session headers that carry planted secrets
(set-cookie, Cart-Token, Nonce, x-wp-nonce) and a planted marker in the body. With the load.py from
before ERRLOG, no file is written and the checks fail (that is the control).
"""
import json, os, subprocess, sys, tempfile, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOAD = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
SECRET = "PLANTED-SESSION-SECRET-41c9"
BODY = "PLANTED-ORDER-BODY-88d2"
seen = {"checkout": 0}
lock = threading.Lock()


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
        return self.path.split("rest_route=", 1)[-1].split("&", 1)[0].replace("%2F", "/")

    def do_GET(self):
        r = self.route()
        if r.startswith("/wc/store/v1/products"):
            return self.send(200, [{"id": 1, "is_purchasable": True, "is_in_stock": True, "permalink": "http://stub/?p=1", "add_to_cart": {"minimum": 1, "maximum": 9999}}])
        if r == "/wc/store/v1/cart":
            return self.send(200, {"items": []}, {"Nonce": "stubnonce", "Cart-Token": "stubtoken"})
        return self.send(200, {})

    def do_POST(self):
        r = self.route()
        self.rfile.read(int(self.headers.get("content-length") or 0))
        if r == "/wc/store/v1/cart/add-item":
            return self.send(201, {"items": [1]})
        if r == "/wc/store/v1/checkout":
            with lock:
                seen["checkout"] += 1
            return self.send(503, {"code": "skyphusion_write_loss", "message": BODY},
                             {"x-sql-failure": "2", "x-write-loss": "none", "cf-ray": "stubray-1", "retry-after": "1",
                              "set-cookie": "wp_woocommerce_session_x=" + SECRET, "Cart-Token": SECRET, "Nonce": SECRET, "x-wp-nonce": SECRET})
        return self.send(404, {})


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
log = os.path.join(tempfile.mkdtemp(), "err.jsonl")
env = dict(os.environ, B="http://127.0.0.1:%d" % srv.server_address[1], LEVELS="2", SECONDS="3", BUYERS="1", SETUP="0", WOO="1", ERRLOG=log)
p = subprocess.run([sys.executable, LOAD], env=env, capture_output=True, text=True, timeout=120)
srv.shutdown()
lines = []
if os.path.exists(log):
    lines = [json.loads(l) for l in open(log) if l.strip()]
raw = open(log).read() if os.path.exists(log) else ""
co = [l for l in lines if l.get("k") == "checkout"]
h = co[0]["h"] if co else {}
checks = [
    ("load.py ran (exit 0)", p.returncode == 0, p.returncode),
    ("the stub answered checkouts (the test exercised the path)", seen["checkout"] > 0, seen["checkout"]),
    ("ERRLOG has one line per failed checkout", len(co) == seen["checkout"] and len(co) > 0, [len(co), seen["checkout"]]),
    ("  each line has the status and the Store API code", bool(co) and all(l["c"] == 503 and l["ec"] == "skyphusion_write_loss" for l in co), co[:1]),
    ("  diagnostic values are kept", h.get("x-sql-failure") == "2" and h.get("x-write-loss") == "none" and h.get("cf-ray") == "stubray-1" and h.get("retry-after") == "1", h),
    ("  session headers are listed by name, value redacted", all(h.get(k) == "<redacted>" for k in ("set-cookie", "cart-token", "nonce", "x-wp-nonce")), h),
    ("no planted secret or body text in ERRLOG or the output", SECRET not in raw and BODY not in raw and SECRET not in p.stdout + p.stderr and BODY not in p.stdout + p.stderr, "absent" if SECRET not in raw + p.stdout + p.stderr and BODY not in raw else "FOUND"),
    ("no successful request is logged", all(l["c"] not in (200, 201) for l in lines), [l["c"] for l in lines][:5]),
]
fails = 0
for name, ok, detail in checks:
    print(("ok   " if ok else "FAIL ") + name + "  " + json.dumps(detail)[:300])
    fails += not ok
sys.exit(1 if fails else 0)
