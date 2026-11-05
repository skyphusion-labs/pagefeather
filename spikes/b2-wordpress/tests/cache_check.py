#!/usr/bin/env python3
# Object cache coherence: an admin change must show on the next uncached page,
# whichever PHP worker answers. For a persistent object cache (C1 with
# OBJECT_CACHE=apcu), and harmless without one.
# Usage: B=https://<site> ADMIN_PASSWORD=... python3 tests/cache_check.py
# Each check prints PASS or FAIL. Exits 1 on any FAIL. It writes a product and
# changes the site tagline (then sets the tagline back).
#
# Each read is repeated READS times (default 8) so that every PHP worker answers
# at least once in practice. A check passes only if EVERY read shows the new
# value and none shows the old one. The "before" reads prove that the page shows
# the value at all, so a later pass is not a page that never had it.
import json, os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import opener, req, short, login, rest

READS = int(os.environ.get("READS", "8"))
results = []


def check(name, ok, extra=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))


def reads(path):
    g = opener()
    out = []
    for i in range(READS):
        sep = "&" if "?" in path else "?"
        r = req(g, f"{path}{sep}nocache={time.time_ns()}{i}")
        out.append(r)
    return out


def all_have(rs, new, old=None):
    codes = [r["code"] for r in rs]
    hit_new = sum(1 for r in rs if r["code"] == 200 and new in r["body"])
    hit_old = sum(1 for r in rs if old is not None and old in r["body"])
    return hit_new == len(rs) and hit_old == 0, f"new {hit_new}/{len(rs)} old {hit_old} codes {sorted(set(map(str, codes)))}"


o = login()
T = int(time.time())
name = f"Cache Mug {T}"
r = rest(o, "/wc/v3/products", {"name": name, "type": "simple", "regular_price": "10.00", "status": "publish", "manage_stock": True, "stock_quantity": 7})
pid = json.loads(r["body"]).get("id") if r["code"] == 201 else None
check("admin: create a product (10.00, stock 7)", pid, str(short(r)))
if not pid:
    sys.exit(1)
page = "/?p=%d" % pid
api = "/?rest_route=/wc/store/v1/products/%d" % pid

ok, d = all_have(reads(page), b"10.00")
check("before: every read of the product page shows 10.00", ok, d)

r = rest(o, f"/wc/v3/products/{pid}", {"regular_price": "13.75"}, method="PUT")
check("admin: price to 13.75", r["code"] == 200, str(short(r)))
ok, d = all_have(reads(page), b"13.75", b"10.00")
check("after: every read shows 13.75, none 10.00", ok, d)

ok, d = all_have(reads(api), b'"is_in_stock":true')
check("before: Store API says in stock on every read", ok, d)
r = rest(o, f"/wc/v3/products/{pid}", {"stock_quantity": 0}, method="PUT")
check("admin: stock to 0", r["code"] == 200, str(short(r)))
ok, d = all_have(reads(api), b'"is_in_stock":false', b'"is_in_stock":true')
check("after: Store API says out of stock on every read", ok, d)

# An option (alloptions is the most cached object of all): the site tagline.
r = rest(o, "/wp/v2/settings", method="GET")
old_tag = json.loads(r["body"]).get("description", "") if r["code"] == 200 else None
check("admin: read the tagline", old_tag is not None, str(short(r)))
new_tag = f"Tagline {T}"
r = rest(o, "/wp/v2/settings", {"description": new_tag}, method="POST")
check("admin: tagline changed", r["code"] == 200, str(short(r)))
ok, d = all_have(reads("/?feed=rss2"), new_tag.encode())
check("after: every read of the feed shows the new tagline", ok, d)
r = rest(o, "/wp/v2/settings", {"description": old_tag or ""}, method="POST")
check("admin: tagline set back", r["code"] == 200, str(short(r)))

r = rest(o, f"/wc/v3/products/{pid}?force=true", method="DELETE")
check("admin: delete the product", r["code"] == 200, str(short(r)))
rs = reads(api)
check("after: Store API answers 404 for the deleted product on every read", all(x["code"] == 404 for x in rs), str(sorted(set(str(x["code"]) for x in rs))))

print(f"{sum(results)} of {len(results)} passed")
sys.exit(0 if all(results) else 1)
