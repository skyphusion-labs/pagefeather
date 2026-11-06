#!/usr/bin/env python3
"""Reproduce the 409 and 400 answers of the a2 load matrix (issue #50) and
record their bodies. The same buy loop as tests/load/load.py (Store API: cart,
add-item, checkout with cash on delivery), USERS at once, LOOPS each.

Usage: B=https://<site> USERS=30 LOOPS=2 python3 tests/a2/conflict-repro.py
Prints one JSON line per answer that is not 2xx (kind, status, error code,
message, data), then a summary line. It makes test orders (cash on delivery).
"""
import concurrent.futures as cf, http.cookiejar, json, os, re, time, urllib.error, urllib.request

B = os.environ["B"].rstrip("/")
USERS = int(os.environ.get("USERS", "30"))
LOOPS = int(os.environ.get("LOOPS", "2"))


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def req(o, path, data=None, headers=None):
    h = {"User-Agent": "wp-on-cf-a2-conflict-repro", "Content-Type": "application/json"}
    h.update(headers or {})
    r = urllib.request.Request(B + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method="POST" if data is not None else "GET")
    t = time.time()
    try:
        resp = o.open(r, timeout=180)
        return {"code": resp.status, "body": resp.read(), "h": resp.headers, "s": time.time() - t}
    except urllib.error.HTTPError as e:
        return {"code": e.code, "body": e.read(), "h": e.headers, "s": time.time() - t}
    except Exception as e:
        return {"code": "EXC", "body": repr(e).encode(), "h": {}, "s": time.time() - t}


def nc(p):
    return p + ("&" if "?" in p else "?") + "nocache=%d" % time.time_ns()


def describe(kind, r):
    d = {"kind": kind, "status": r["code"], "s": round(r["s"], 2)}
    try:
        j = json.loads(r["body"])
        d.update(code=j.get("code"), message=(j.get("message") or "")[:300], data=j.get("data"))
    except (ValueError, TypeError):
        d["body"] = (r["body"] or b"")[:300].decode(errors="replace")
    return d


prods = json.loads(req(opener(), nc("/?rest_route=/wc/store/v1/products&per_page=20"))["body"])
ids = [p["id"] for p in prods if p.get("is_purchasable")]
assert ids, "no purchasable products"
out = []


def buyer(u):
    o = opener()
    res = []
    for i in range(LOOPS):
        c = req(o, nc("/?rest_route=/wc/store/v1/cart"))
        if not (isinstance(c["code"], int) and c["code"] < 300):
            res.append(describe("cart", c))
            continue
        H = {"Nonce": c["h"].get("Nonce") or "", "Cart-Token": c["h"].get("Cart-Token") or ""}
        a = req(o, "/?rest_route=/wc/store/v1/cart/add-item", {"id": ids[(u + i) % len(ids)], "quantity": 1}, H)
        if not (isinstance(a["code"], int) and a["code"] < 300):
            res.append(describe("add", a))
        addr = {"first_name": "Load", "last_name": "Test", "address_1": "1 Edge Way", "city": "Detroit", "state": "MI", "postcode": "48201", "country": "US", "email": "load@example.com", "phone": "5555550100"}
        k = req(o, "/?rest_route=/wc/store/v1/checkout", {"billing_address": addr, "shipping_address": {x: y for x, y in addr.items() if x != "email"}, "payment_method": "cod"}, H)
        if not (k["code"] == 200 and b'"order_id"' in k["body"]):
            res.append(describe("checkout", k))
        res.append({"kind": "_loop", "add": a["code"], "checkout": k["code"]})
    return res


with cf.ThreadPoolExecutor(USERS) as ex:
    for r in ex.map(buyer, range(USERS)):
        out.extend(r)
loops = [x for x in out if x["kind"] == "_loop"]
for x in out:
    if x["kind"] != "_loop":
        print(json.dumps(x))
pairs = {}
for x in loops:
    k = "add %s / checkout %s" % (x["add"], x["checkout"])
    pairs[k] = pairs.get(k, 0) + 1
print(json.dumps({"summary": {"users": USERS, "loops": LOOPS, "buys": len(loops), "pairs": pairs}}))
