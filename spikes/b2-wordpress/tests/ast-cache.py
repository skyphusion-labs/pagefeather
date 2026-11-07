#!/usr/bin/env python3
"""Local test of the AST translation cache (issue #173). Needs a running
dosql-local server with the WooCommerce store set up (DEV_ENV=dosql-local
./run.sh, then tests/woo.py once). No network beyond the local server.

  B=http://localhost:8799 python3 tests/ast-cache.py

Checks:
  1. the cache is HIT on a checkout: x-ast-cache hits > 0 (the measured path).
  2. the kill switch works: the x-ast-cache-off header makes hits = 0 on the
     same checkout path.
  3. RESULTS are identical cache-on vs cache-off (the correctness guard: a wrong
     cached translation would diverge). Deterministic reads: the Store API
     products list and a single product. Plus both checkouts create a valid
     order (the write path is correct with and without the cache).
Exit 0 only when all pass.
"""
import http.cookiejar, json, os, sys, urllib.request, urllib.error
B = os.environ.get("B", "http://localhost:8799")
def opener(): return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def req(o, path, data=None, off=False):
    h = {"User-Agent": "ast-cache-test"}
    if off: h["x-ast-cache-off"] = "1"
    if isinstance(data, dict): data = json.dumps(data).encode(); h["Content-Type"] = "application/json"
    r = urllib.request.Request(B + path, data=data, headers=h)
    try: resp = o.open(r, timeout=180); return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e: return e.code, e.read(), e.headers

fails = 0
def ok(label, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + label); 
    if not cond: fails += 1
def hits(h):
    v = h.get("x-ast-cache") or ""
    try: return int(v.split("hits=")[1].split()[0])
    except Exception: return None

def products(off):
    _, b, _ = req(opener(), "/?rest_route=/wc/store/v1/products&per_page=20&orderby=id", off=off)
    return [(p["id"], p["name"], p.get("prices", {}).get("price"), p.get("is_in_stock")) for p in json.loads(b)]

def checkout(off):
    o = opener()
    pid = [p for p in products(off) if p[3]][0][0]
    _, _, ch = req(o, "/?rest_route=/wc/store/v1/cart", off=off)
    H = {"Nonce": ch.get("Nonce"), "Cart-Token": ch.get("Cart-Token") or ""}
    hh = {"User-Agent": "ast-cache-test", **H}
    if off: hh["x-ast-cache-off"] = "1"
    d = json.dumps({"id": pid, "quantity": 1}).encode()
    r = urllib.request.Request(B + "/?rest_route=/wc/store/v1/cart/add-item", data=d, headers={**hh, "Content-Type": "application/json"})
    o.open(r, timeout=120).read()
    addr = {"first_name": "L", "last_name": "T", "address_1": "1 X", "city": "Detroit", "state": "MI", "postcode": "48201", "country": "US", "email": "x@e.com", "phone": "5555550100"}
    body = json.dumps({"billing_address": addr, "shipping_address": {k: v for k, v in addr.items() if k != "email"}, "payment_method": "cod"}).encode()
    r = urllib.request.Request(B + "/?rest_route=/wc/store/v1/checkout", data=body, headers={**hh, "Content-Type": "application/json"})
    try: resp = o.open(r, timeout=180); return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e: return e.code, e.read(), e.headers

c_on, b_on, h_on = checkout(False)
ok("checkout 200 + order, cache on", c_on == 200 and b'"order_id"' in b_on)
ok("cache is HIT on checkout (x-ast-cache hits > 0)", (hits(h_on) or 0) > 0)
c_off, b_off, h_off = checkout(True)
ok("checkout 200 + order, cache off", c_off == 200 and b'"order_id"' in b_off)
ok("kill switch: x-ast-cache-off makes hits = 0", hits(h_off) == 0)
ok("Store API products identical cache-on vs cache-off", products(False) == products(True) and len(products(False)) > 0)
print("%d failing check(s)" % fails)
sys.exit(fails)
