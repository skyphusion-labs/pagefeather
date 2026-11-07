#!/usr/bin/env python3
"""Offline self-check of tests/load/multi.py (issue #152). No real sites.

Usage: python3 tests/load/multi-stub-test.py [path/to/multi.py]

A stub HTTP server stands in for every site (all SITES point at it, with
different names and types). It answers any path 200 with a cf-cache-status
header (MISS when the request carries ?nocache=, HIT otherwise), except
/checkout/ which answers 500 with a body naming error 1102 (the isolate memory
limit). The checks, all without a network:
  1. PLAN=1 prints a plan for both sites and does NOT hit the stub.
  2. a short ramp (LEVELS="2,4", 1s) yields per-site stats for BOTH sites at
     BOTH levels, with requests > 0 and 2xx > 0, and a cache mix that is MISS
     under CACHE=miss.
  3. CHECKOUT_PROBE=1 records e1102 True for the woo site (the stub's /checkout/).
  4. MODE=isolation yields a light_delta for the non-heavy site.
Exit 0 only when every check holds. Needs python3 only.
"""
import json, os, subprocess, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

MULTI = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "multi.py")
lock = threading.Lock()
hits = {"total": 0, "checkout": 0}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        with lock:
            hits["total"] += 1
            if self.path.startswith("/checkout/"):
                hits["checkout"] += 1
        if self.path.startswith("/checkout/"):
            b = b'{"code":"rest_cannot","data":{"status":500}} error 1102 exceeded resources'
            self.send_response(500)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        b = b"<html><title>stub</title></html>"
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(b)))
        self.send_header("cf-cache-status", "MISS" if "nocache=" in self.path else "HIT")
        self.end_headers()
        self.wfile.write(b)


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d" % port
SITES = "shop:woo:%s blog:reg:%s" % (URL, URL)

fails = 0


def ok(label, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        fails += 1


def run(env, timeout=60):
    e = dict(os.environ, SITES=SITES, **env)
    p = subprocess.run([sys.executable, "-I", MULTI], capture_output=True, text=True, env=e, timeout=timeout)
    return p


# 1. PLAN: no network.
before = hits["total"]
p = run({"PLAN": "1"})
plan = json.loads(p.stdout.strip().splitlines()[-1])["plan"]
ok("PLAN lists both sites", len(plan["sites"]) == 2 and {s["name"] for s in plan["sites"]} == {"shop", "blog"})
ok("PLAN carries the levels", plan.get("total_levels") == [10, 50, 100, 250])
ok("PLAN hits no network", hits["total"] == before)

# 2. short ramp, cache=miss.
p = run({"LEVELS": "2,4", "SECONDS": "1", "CACHE": "miss"})
res = json.loads(p.stdout.strip().splitlines()[-1])
ok("ramp: exit 0", p.returncode == 0)
ok("ramp: two steps", len(res["steps"]) == 2)
good = True
for step in res["steps"]:
    names = {s["name"] for s in step["sites"]}
    if names != {"shop", "blog"}:
        good = False
    for s in step["sites"]:
        if s["requests"] <= 0 or s["status"]["2xx"] <= 0:
            good = False
ok("ramp: per-site stats, requests and 2xx > 0 for both at both levels", good)
miss = all(s["cache"].get("MISS", 0) > 0 for step in res["steps"] for s in step["sites"])
ok("ramp: cache=miss shows MISS at the edge", miss)
ok("ramp: levels recorded", [st["level"] for st in res["steps"]] == [2, 4])

# 3. checkout probe.
p = run({"LEVELS": "2", "SECONDS": "1", "CHECKOUT_PROBE": "1"})
res = json.loads(p.stdout.strip().splitlines()[-1])
cp = res.get("checkout_probe") or []
ok("checkout probe: woo site only, e1102 detected", len(cp) == 1 and cp[0]["name"] == "shop" and cp[0]["e1102"] is True)

# 4. isolation.
p = run({"MODE": "isolation", "ISO_HEAVY": "4", "ISO_LIGHT": "2", "SECONDS": "1", "HEAVY_SITE": "shop"})
res = json.loads(p.stdout.strip().splitlines()[-1])
iso = res.get("isolation") or {}
ld = iso.get("light_delta") or {}
ok("isolation: heavy=shop, delta for the light site blog", iso.get("heavy_site") == "shop" and "blog" in ld and "delta_ms" in ld["blog"])

srv.shutdown()
print("%d failing check(s)" % fails)
sys.exit(fails)
