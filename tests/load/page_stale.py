#!/usr/bin/env python3
"""How long does a guest see old stock on a cached page after a checkout? (#628)

    B=<site url> ADMIN_PASSWORD=... [ADMIN_USER=admin] CASE=qty|stockout|both \
      [N=5] [POLL_S=5] [MAX_S=900] [SETTLE_S=20] [WARM_S=1] python3 -I tests/load/page_stale.py

Run it on a THROWAWAY only (it makes products and orders, then deletes them).

  qty       one stock-managed product with 7 in stock. Warm its cached page, buy 1 as a guest, then
            read the cached page from a fresh client every POLL_S until it shows 6. Case 1 of #628:
            a quantity change in an order request asks no purge (edge-cache.php).
  stockout  N products with 1 in stock. Warm each cached page, buy each one (a stock STATUS change,
            which asks a purge; purges are limited per account), then count the cached pages that
            still say "in stock", every POLL_S. Case 2 of #628.

Two layers can show old stock, and the probe times each one:
  - the Worker: a page it RENDERS can still show the old stock (a stale object cache inside the
    Worker; there is no page cache inside it, index.js and the mu-plugins have none). worker_stale_s is
    the time until a cache-busted read shows the new value. 0 when the first such read does.
  - the edge (the #63 page cache): stale_s is the time until a CACHED read shows the new value.
    stale_s is never less than worker_stale_s.

Controls, so a number is never made from a read that could not see:
  - a cache-busted read (?nocache=) must show the NEW value (the sale's before minus one) within MAX_S.
    If it never does, the checkout did not change the stock, or the Worker shows old stock past MAX_S:
    could-not-measure, with no worker_stale_s;
  - a warm read must come from the cache (cf-cache-status HIT, STALE, UPDATING or REVALIDATED). If
    the site never says so, a fresh page cannot be told from a purged one: could-not-measure.
Guest reads send no cookie and no operator header: an operator request never uses the page cache.
EXPIRED is never a cache proof: it means the edge held a copy but fetched the page from the Worker.

Evidence, so a could-not-measure names its cause: each result keeps the two warm reads of its page
(cf-cache-status, cache-control, Age, x-entrypoint, and the NAMES of any Set-Cookie, never a value),
and the same for the home page "/", a control that tells "this site caches nothing" from "this page
is not cacheable". index.js marks a page not cacheable when it sets a cookie, when WordPress sent
no-cache, no-store or private, or for a status other than 200, 301 or 404 (pageCacheHeaders).
SETTLE_S waits out the purge the product create asks (PURGE_GAP_MS is 15 s) before the warm read.

Output: one `@event page-stale {json}` line per case, then a plain summary.
Exit: 0 measured, 3 could not measure, 2 usage. The admin password is read from the environment only.
"""
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

B = (os.environ.get("B") or "").rstrip("/")
UA = {"User-Agent": "pagefeather-page-stale/628"}
CACHED = ("HIT", "STALE", "UPDATING", "REVALIDATED")
TAG = "%x" % int(time.time())


def num(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        sys.exit("%s must be a number" % name)


POLL_S, MAX_S, SETTLE_S, WARM_S = num("POLL_S", 5), num("MAX_S", 900), num("SETTLE_S", 20), num("WARM_S", 1)
N = int(num("N", 5))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def opener(cookies=True):
    hs = [NoRedirect]
    if cookies:
        hs.append(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    return urllib.request.build_opener(*hs)


def req(o, path, data=None, headers=None, method=None):
    h = dict(UA, **(headers or {}))
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        h.setdefault("Content-Type", "application/json")
    try:
        r = o.open(urllib.request.Request(B + path, data=data, headers=h, method=method), timeout=60)
        return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers
    except Exception as e:  # a failed read is recorded, never a value
        return "EXC", repr(e)[:120].encode(), {}


def admin():
    o = opener()
    req(o, "/wp-login.php")
    form = urllib.parse.urlencode({"log": os.environ.get("ADMIN_USER", "admin"), "pwd": os.environ["ADMIN_PASSWORD"],
                                   "wp-submit": "Log In", "redirect_to": "/wp-admin/", "testcookie": "1"}).encode()
    code, _, _ = req(o, "/wp-login.php", form, {"Content-Type": "application/x-www-form-urlencoded"})
    if code != 302:
        sys.exit("admin login failed: %s" % code)
    code, body, _ = req(o, "/wp-admin/admin-ajax.php?action=rest-nonce")
    o.nonce = body.decode("utf-8", "replace").strip()
    if code != 200 or not re.fullmatch(r"[a-f0-9]{10}", o.nonce):
        sys.exit("no REST nonce for the admin")
    return o


def rest(a, route, data=None, method=None):
    return req(a, "/?rest_route=" + route.replace("?", "&", 1), data, {"X-WP-Nonce": a.nonce}, method)


def make_product(a, qty, made):
    code, body, _ = rest(a, "/wc/v3/products", {"name": "Stale probe %s-%d" % (TAG, len(made)), "type": "simple",
                                                "regular_price": "9.00", "status": "publish", "manage_stock": True, "stock_quantity": qty})
    if code != 201:
        sys.exit("product create failed: %s" % code)
    d = json.loads(body)
    made.append(d["id"])
    u = urllib.parse.urlsplit(d["permalink"])
    return d["id"], u.path + ("?" + u.query if u.query else "")


def nc(path):
    return path + ("&" if "?" in path else "?") + "nocache=%x" % int(time.time() * 1e6)


def stock(html):
    """('in', quantity or None) or ('out', None) from a product page; (None, None) when unreadable."""
    t = html.decode("utf-8", "replace")
    if re.search(r'class="stock out-of-stock"', t):
        return "out", None
    m = re.search(r'class="stock in-stock"[^>]*>\s*(\d+)\s+in stock', t)
    if m:
        return "in", int(m.group(1))
    if re.search(r'class="stock in-stock"|name="add-to-cart"', t):
        return "in", None
    return None, None


def cookie_names(h):
    try:
        vals = h.get_all("Set-Cookie") or []
    except AttributeError:
        vals = []
    return sorted(set(v.split("=", 1)[0].strip() for v in vals if "=" in v))


def guest_read(path, bust=False):
    code, body, h = req(opener(cookies=False), nc(path) if bust else path)
    st = stock(body) if code == 200 else (None, None)
    g = (lambda k: h.get(k)) if h else (lambda k: None)
    return {"code": code, "state": st[0], "qty": st[1], "cache": g("cf-cache-status"), "age": g("age"),
            "cc": g("cache-control"), "entry": g("x-entrypoint"), "cookies": cookie_names(h) if h else []}


def evidence(r):
    return dict((k, r[k]) for k in ("code", "cache", "cc", "age", "entry", "cookies"))


def buy(pid):
    o = opener()
    code, _, h = req(o, "/?rest_route=/wc/store/v1/cart")
    if code != 200 or not h.get("Nonce"):
        return None
    H = {"Nonce": h.get("Nonce"), "Cart-Token": h.get("Cart-Token") or ""}
    code, _, _ = req(o, "/?rest_route=/wc/store/v1/cart/add-item", {"id": pid, "quantity": 1}, H)
    if code != 201:
        return None
    addr = {"first_name": "Stale", "last_name": "Probe", "address_1": "1 Edge Way", "city": "Detroit", "state": "MI",
            "postcode": "48201", "country": "US", "email": "probe@example.com", "phone": "5555550100"}
    code, body, _ = req(o, "/?rest_route=/wc/store/v1/checkout", {"billing_address": addr, "shipping_address": dict((k, v) for k, v in addr.items() if k != "email"), "payment_method": "cod"}, H)
    try:
        return int(json.loads(body)["order_id"]) if code == 200 else None
    except (ValueError, KeyError, TypeError):
        return None


def warm(path, keep=None):
    first = guest_read(path)
    time.sleep(WARM_S)
    second = guest_read(path)
    if keep is not None:
        keep.extend([evidence(first), evidence(second)])
    return second


def case_qty(a, made, orders):
    pid, path = make_product(a, 7, made)
    time.sleep(SETTLE_S)
    ev = []
    w = warm(path, ev)
    before = guest_read(path, bust=True)
    oid = buy(pid)
    t0 = time.time()
    if oid:
        orders.append(oid)
    after = guest_read(path, bust=True)
    want = before["qty"] - 1 if (oid and before["qty"] is not None) else None
    res = {"case": "qty", "cached_proof": w["cache"] in CACHED, "warm_cache": w["cache"], "before": before["qty"], "after": after["qty"],
           "bought": bool(oid), "control_new": want is not None and after["qty"] == want,
           "worker_stale_s": None, "stale_s": None, "polls": 0, "cache_seen": {}, "warm": ev}
    # The Worker layer: poll uncached reads until the new value shows, or MAX_S.
    if res["control_new"]:
        res["worker_stale_s"] = 0.0
    elif want is not None:
        while time.time() - t0 < MAX_S:
            time.sleep(POLL_S)
            if guest_read(path, bust=True)["qty"] == want:
                res["worker_stale_s"] = round(time.time() - t0, 2)
                break
    if res["worker_stale_s"] is not None:
        res["after"] = want
    if not (res["cached_proof"] and res["worker_stale_s"] is not None):
        res["verdict"] = "could_not_measure"
        return res
    while True:
        dt = time.time() - t0
        r = guest_read(path)
        res["polls"] += 1
        res["cache_seen"][str(r["cache"])] = res["cache_seen"].get(str(r["cache"]), 0) + 1
        if r["state"] == "in" and r["qty"] == want:
            res["stale_s"] = round(dt, 2)
            break
        if dt >= MAX_S:
            break
        time.sleep(POLL_S)
    res["verdict"] = "measured" if res["stale_s"] is not None else "stale_past_max"
    res["max_s"] = MAX_S
    return res


def case_stockout(a, made, orders):
    items = [make_product(a, 1, made) for _ in range(N)]
    time.sleep(SETTLE_S)
    ev = []
    proofs = [warm(p, ev)["cache"] in CACHED for _, p in items]
    t0s = {}
    for pid, p in items:
        oid = buy(pid)
        if oid:
            orders.append(oid)
            t0s[p] = time.time()
    t_end = time.time()
    control_out = sum(1 for _, p in items if guest_read(p, bust=True)["state"] == "out")
    res = {"case": "stockout", "n": N, "bought": len(t0s), "cached_proof": all(proofs), "control_out": control_out,
           "sales_s": round(t_end - min(t0s.values()), 2) if t0s else None, "in_stock_at_0": None, "max_stale_s": None,
           "never_fresh": None, "in_stock_over_time": [], "warm": ev[:4]}
    if not res["cached_proof"] or control_out != N or len(t0s) != N:
        res["verdict"] = "could_not_measure"
        return res
    fresh_at = {}
    while True:
        dt = time.time() - t_end
        still = 0
        for _, p in items:
            if p in fresh_at:
                continue
            r = guest_read(p)
            if r["state"] == "out":
                fresh_at[p] = time.time() - t0s[p]
            else:
                still += 1
        res["in_stock_over_time"].append([round(dt, 2), still])
        if res["in_stock_at_0"] is None:
            res["in_stock_at_0"] = still
        if not still or dt >= MAX_S:
            break
        time.sleep(POLL_S)
    res["never_fresh"] = N - len(fresh_at)
    res["max_stale_s"] = round(max(fresh_at.values()), 2) if fresh_at and not res["never_fresh"] else None
    res["verdict"] = "measured" if not res["never_fresh"] else "stale_past_max"
    res["max_s"] = MAX_S
    return res


def cleanup(a, made, orders):
    gone = {"orders": 0, "products": 0}
    for oid in orders:
        gone["orders"] += rest(a, "/wc/v3/orders/%d?force=true" % oid, method="DELETE")[0] == 200
    for pid in made:
        gone["products"] += rest(a, "/wc/v3/products/%d?force=true" % pid, method="DELETE")[0] == 200
    return dict(gone, orders_made=len(orders), products_made=len(made))


def main():
    case = os.environ.get("CASE", "both")
    if not B or not os.environ.get("ADMIN_PASSWORD") or case not in ("qty", "stockout", "both"):
        print(__doc__, file=sys.stderr)
        return 2
    a = admin()
    home = []
    home_cached = warm("/", home)["cache"] in CACHED
    made, orders, results = [], [], []
    try:
        if case in ("qty", "both"):
            results.append(case_qty(a, made, orders))
        if case in ("stockout", "both"):
            results.append(case_stockout(a, made, orders))
    finally:
        cl = cleanup(a, made, orders)
    for r in results:
        r["cleanup"] = cl
        r["home_cached"] = home_cached
        r["home_warm"] = home
        print("@event page-stale " + json.dumps(r, sort_keys=True), flush=True)
    for r in results:
        if r["verdict"] == "could_not_measure":
            print("%s: COULD NOT MEASURE (cache proof %s, control %s; the home page %s from the cache)" % (r["case"], r["cached_proof"], r.get("control_new", r.get("control_out")), "IS served" if home_cached else "is NOT served"))
            for e in r.get("warm", [])[:2]:
                print("  warm read: cf-cache-status %s, cache-control %s, cookies set %s" % (e["cache"], e["cc"], ",".join(e["cookies"]) or "none"))
        elif r["case"] == "qty":
            print("qty: a guest saw %s in stock for %s s after the checkout (now %s)" % (r["before"], r["stale_s"] if r["stale_s"] is not None else "> %s" % MAX_S, r["after"]))
        else:
            print("stockout: %d of %d pages still said in stock right after the sales; the last turned at %s s" % (r["in_stock_at_0"], r["n"], r["max_stale_s"] if r["max_stale_s"] is not None else "> %s" % MAX_S))
    print("cleanup: %d of %d orders and %d of %d products deleted" % (cl["orders"], cl["orders_made"], cl["products"], cl["products_made"]))
    return 3 if any(r["verdict"] == "could_not_measure" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
