#!/usr/bin/env python3
# Edge page cache: correct for every shopper (issue #58).
# Usage: B=https://<site> ADMIN_PASSWORD=... python3 tests/edge_check.py
# Each check prints PASS or FAIL. Exits 1 on any FAIL. It writes a product, an
# order (one guest checkout is not needed: a classic add to cart only) and
# changes the site tagline (then sets it back).
#
# Reads here have NO nocache parameter: they are what a visitor gets. WAIT
# (default 20 s) is how long a change may take to show after the admin request
# returns (a purge); the page cache TTL is the backstop, not the target.
import http.cookiejar, json, os, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import opener, req, short, login, rest

WAIT = float(os.environ.get("WAIT", "20"))
SBJS = "sbjs_migrations=1418474375998%3D1; sbjs_current=typ%3Dtypein%7C%7C%7Csrc%3D%28direct%29; sbjs_session=pgs%3D1%7C%7C%7Ccpg%3D"
results = []


def check(name, ok, extra=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))


def cf(r):
    return (r["h"].get("cf-cache-status") if r["h"] else None) or "none"


def visit(path, cookie=None):
    return req(opener(), path, headers={"Cookie": cookie} if cookie else None)


def until_new(path, new, old):
    """Read path (as a visitor) until it shows new; then 5 more reads must too."""
    t0 = time.time()
    while time.time() - t0 < WAIT:
        r = visit(path)
        if r["code"] == 200 and new in r["body"]:
            after = [visit(path) for _ in range(5)]
            stale = sum(1 for x in after if old is not None and old in x["body"])
            return True, round(time.time() - t0, 1), "then 5 reads: %d old, cache %s" % (stale, sorted({cf(x) for x in after})), stale == 0
        time.sleep(1)
    return False, round(time.time() - t0, 1), "still old after %.0f s" % WAIT, False


T = int(time.time())
o = login()

# 1. A visitor with no state gets the edge copy; cookies with no state do not change that.
page = "/?edgecheck=%d" % T
a, b = visit(page), visit(page)
check("visitor, no cookie: second read is a HIT", cf(b) == "HIT", "%s then %s" % (cf(a), cf(b)))
s = visit(page, SBJS + "%016x" % T)
check("visitor with order attribution cookies (sbjs_*): HIT", cf(s) == "HIT", cf(s))
c = visit(page, "woocommerce_items_in_cart=1; woocommerce_cart_hash=x; " + SBJS + "1")
check("visitor with a cart cookie: not the edge copy", cf(c) != "HIT", cf(c))
li = visit(page, "wordpress_logged_in_x=admin%7C1")
check("visitor with a login cookie: not the edge copy", cf(li) != "HIT", cf(li))
h = visit(page)
check("the edge copy does not tell the browser to keep it", "no-cache" in (h["h"].get("cache-control") or "") and "public" not in (h["h"].get("cache-control") or ""), h["h"].get("cache-control"))

# 2. Add to cart (classic link): the next page is not the edge copy.
r = rest(o, "/wc/v3/products", {"name": f"Edge Check Mug {T}", "type": "simple", "regular_price": "10.00", "status": "publish", "manage_stock": True, "stock_quantity": 3})
pid = json.loads(r["body"]).get("id") if r["code"] == 201 else None
check("admin: create a product (10.00, stock 3)", pid, str(short(r)))
if not pid:
    sys.exit(1)
link = urllib.parse.urlparse(json.loads(r["body"]).get("permalink", ""))
ppath = link.path + ("?" + link.query if link.query else "")
for _ in range(2):
    visit(ppath)  # fill the edge copy
w = opener()
add = req(w, "/?add-to-cart=%d" % pid)
names = sorted(x.name.split("_")[0] + "_" + x.name.split("_")[1] if x.name.count("_") > 1 else x.name for x in w.jar)
check("classic add to cart sets the WooCommerce cookies", any(x.name.startswith("woocommerce_items_in_cart") for x in w.jar), str(names))
nxt = req(w, ppath)
check("the next product page for that shopper is not the edge copy", cf(nxt) != "HIT", cf(nxt))

# 3. Changes reach visitors through the edge copy.
ok, t, d, clean = until_new(ppath, b"10.00", None)
check("before: the product page shows 10.00", ok, d)
r = rest(o, f"/wc/v3/products/{pid}", {"regular_price": "13.75"}, method="PUT")
check("admin: price to 13.75", r["code"] == 200, str(short(r)))
ok, t, d, clean = until_new(ppath, b"13.75", b"10.00")
check("after: visitors see 13.75 within %.0f s" % WAIT, ok and clean, "after %s s; %s" % (t, d))
api = "/?rest_route=/wc/store/v1/products/%d" % pid
r = rest(o, f"/wc/v3/products/{pid}", {"stock_quantity": 0}, method="PUT")
check("admin: stock to 0 (sold out)", r["code"] == 200, str(short(r)))
ok, t, d, clean = until_new(ppath, b"out-of-stock", None)
check("after: the cached product page says out of stock within %.0f s" % WAIT, ok and clean, "after %s s; %s" % (t, d))
r = rest(o, "/wp/v2/settings", method="GET")
old_tag = json.loads(r["body"]).get("description", "") if r["code"] == 200 else ""
new_tag = f"Edge tagline {T}"
for _ in range(2):
    visit("/?feed=rss2")
r = rest(o, "/wp/v2/settings", {"description": new_tag}, method="POST")
check("admin: tagline changed", r["code"] == 200, str(short(r)))
ok, t, d, clean = until_new("/?feed=rss2", new_tag.encode(), (old_tag or "\x00").encode())
check("after: the cached feed shows the new tagline within %.0f s" % WAIT, ok and clean, "after %s s; %s" % (t, d))
rest(o, "/wp/v2/settings", {"description": old_tag}, method="POST")
r = rest(o, f"/wc/v3/products/{pid}?force=true", method="DELETE")
check("admin: delete the product", r["code"] == 200, str(short(r)))
print(f"{sum(results)} of {len(results)} passed")
sys.exit(0 if all(results) else 1)
