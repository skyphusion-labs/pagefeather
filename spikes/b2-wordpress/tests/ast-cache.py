#!/usr/bin/env python3
"""Local test of the AST translation cache (issue #173). Needs a running
dosql-local server with the WooCommerce store set up (DEV_ENV=dosql-local
./run.sh, then tests/woo.py once). No network beyond the local server.

  B=http://localhost:8799 python3 tests/ast-cache.py

The checkout is the cache-active path (reads have 0 hits: the object cache
dedupes option reads within a request, so only a checkout's ~300 queries carry
intra-request repeats). So the correctness guard compares a checkout cache-on
vs cache-off, NORMALIZED (the order id/key/number and the redirect that echoes
them are inherently per-order); every other field (cart totals, line items,
status, addresses) must be byte-identical. A wrong cached translation would
change those. The ON run must report x-ast-hits > 0, so "identical" cannot pass
on a silently-inert cache.

Checks:
  1. checkout cache-on: 200 + order, and x-ast-cache hits > 0.
  2. kill switch: x-ast-cache-off makes hits = 0 on the same path.
  3. the normalized checkout is IDENTICAL cache-on vs cache-off (wrong-result guard).
  4. a Store API read is byte-identical cache-on vs cache-off (sanity; 0 hits).
Exit 0 only when all pass.
"""
import http.cookiejar, json, os, sys, urllib.request, urllib.error
B = os.environ.get("B", "http://localhost:8799")
VOLATILE = ("order_id", "order_key", "order_number", "payment_result")
def opener(): return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def raw(o, path, data=None, off=False, extra=None):
    h = {"User-Agent": "ast-cache-test"}
    if off: h["x-ast-cache-off"] = "1"
    h.update(extra or {})
    if isinstance(data, dict): data = json.dumps(data).encode(); h["Content-Type"] = "application/json"
    r = urllib.request.Request(B + path, data=data, headers=h)
    try: resp = o.open(r, timeout=180); return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e: return e.code, e.read(), e.headers
def hits(h):
    v = h.get("x-ast-cache") or ""
    try: return int(v.split("hits=")[1].split()[0])
    except Exception: return None
def norm(body):
    d = json.loads(body)
    for k in VOLATILE: d.pop(k, None)
    return json.dumps(d, sort_keys=True)
def checkout(off):
    o = opener()
    pb = raw(o, "/?rest_route=/wc/store/v1/products&per_page=20&orderby=id", off=off)[1]
    pid = [p for p in json.loads(pb) if p.get("is_purchasable") and p.get("is_in_stock")][0]["id"]
    _, _, ch = raw(o, "/?rest_route=/wc/store/v1/cart", off=off)
    H = {"Nonce": ch.get("Nonce"), "Cart-Token": ch.get("Cart-Token") or ""}
    raw(o, "/?rest_route=/wc/store/v1/cart/add-item", {"id": pid, "quantity": 1}, off=off, extra=H)
    addr = {"first_name": "L", "last_name": "T", "address_1": "1 X", "city": "Detroit", "state": "MI", "postcode": "48201", "country": "US", "email": "x@e.com", "phone": "5555550100"}
    return raw(o, "/?rest_route=/wc/store/v1/checkout", {"billing_address": addr, "shipping_address": {k: v for k, v in addr.items() if k != "email"}, "payment_method": "cod"}, off=off, extra=H)

fails = 0
def ok(label, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + label)
    if not cond: fails += 1

c_on, b_on, h_on = checkout(False)
ok("checkout 200 + order, cache on", c_on == 200 and b'"order_id"' in b_on)
hit_on = hits(h_on)
ok("cache is HIT on checkout (x-ast-cache hits > 0)", (hit_on or 0) > 0)
c_off, b_off, h_off = checkout(True)
ok("checkout 200 + order, cache off", c_off == 200 and b'"order_id"' in b_off)
ok("kill switch: x-ast-cache-off makes hits = 0", hits(h_off) == 0)
ok("normalized checkout IDENTICAL cache-on vs cache-off (and the ON run had %s hits)" % hit_on,
   norm(b_on) == norm(b_off) and (hit_on or 0) > 0)
r_on = raw(opener(), "/?rest_route=/wc/store/v1/products&per_page=20&orderby=id")[1]
r_off = raw(opener(), "/?rest_route=/wc/store/v1/products&per_page=20&orderby=id", off=True)[1]
ok("Store API read byte-identical cache-on vs cache-off (sanity)", r_on == r_off and len(r_on) > 0)

print("%d failing check(s)" % fails)
sys.exit(fails)
