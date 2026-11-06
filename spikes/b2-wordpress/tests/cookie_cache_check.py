#!/usr/bin/env python3
# Page cache and cookies on variant b (issue #63).
# Usage: B=https://<site> ADMIN_PASSWORD=... python3 tests/cookie_cache_check.py
# Each check prints PASS or FAIL. Exits 1 on any FAIL. It writes nothing.
#
# The page is read with a fresh query value (cookieprobe=<n>), and with no
# nocache parameter: that is what a visitor gets. Before #63 the cache keyed
# on the whole Cookie header (Vary: Cookie), so a visitor with any cookie that
# is not WordPress's (analytics _ga, WooCommerce order attribution sbjs_*)
# missed, and each _ga value was its own entry.
import os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import opener, req, login

SBJS = "sbjs_migrations=1418474375998%3D1; sbjs_current=typ%3Dtypein%7C%7C%7Csrc%3D%28direct%29"
results = []


def check(name, ok, extra=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""), flush=True)


def cf(r):
    return (r["h"].get("cf-cache-status") if r["h"] else None) or "none"


def ep(r):
    return (r["h"].get("x-entrypoint") if r["h"] else None) or "gateway"


# Local workerd has no Workers Cache (no cf-cache-status): there only the route
# is checked (x-entrypoint), and the HIT checks are reported as SKIP.
LOCAL = "localhost" in os.environ.get("B", "") or "127.0.0.1" in os.environ.get("B", "")


def hit(name, r):
    if LOCAL:
        print("SKIP " + name + "  (local: no Workers Cache)", flush=True)
    else:
        check(name, cf(r) == "HIT", cf(r))


def visit(path, cookie=None, o=None):
    return req(o or opener(), path, headers={"Cookie": cookie} if cookie else None)


path = "/?p=1&cookieprobe=%d" % int(time.time())
a = visit(path)
b = visit(path)
check("no cookie: 200 from the Pages entrypoint", a["code"] == 200 and ep(a) == "pages", "%s %s" % (a["code"], ep(a)))
hit("no cookie: second read a HIT", b)
g1 = visit(path, "_ga=GA1.1.111.222")
check("an analytics cookie (_ga): the Pages entrypoint", ep(g1) == "pages", ep(g1))
hit("an analytics cookie (_ga): HIT", g1)
g2 = visit(path, "_ga=GA1.1.333.444; _gid=GA1.1.555")
hit("another _ga value: HIT (one entry for all visitors)", g2)
s = visit(path, SBJS)
check("order attribution cookies (sbjs_*): the Pages entrypoint", ep(s) == "pages", ep(s))
hit("order attribution cookies (sbjs_*): HIT", s)
check("the cached page has no Set-Cookie", not (s["h"].get("set-cookie") if s["h"] else None), str(s["h"].get("set-cookie") if s["h"] else None))
cc = (b["h"].get("cache-control") or "") if b["h"] else ""
check("the browser is told to ask again (no-cache, not public)", "no-cache" in cc and "public" not in cc, cc)
check("no Vary: Cookie on the page", "cookie" not in ((b["h"].get("vary") or "") if b["h"] else "").lower(), str(b["h"].get("vary") if b["h"] else None))
cart = visit(path, "woocommerce_items_in_cart=1; wp_woocommerce_session_x=y; _ga=GA1.1.111.222")
check("a cart cookie: the gateway, not the cached copy", ep(cart) == "gateway" and cf(cart) != "HIT", "%s %s" % (ep(cart), cf(cart)))
pp = visit(path, "wp-postpass_abc=x")
check("a post password cookie: the gateway, not the cached copy", ep(pp) == "gateway" and cf(pp) != "HIT", "%s %s" % (ep(pp), cf(pp)))
o = login()
li = req(o, path)
check("logged in: the gateway, not the cached copy, and the admin bar", ep(li) == "gateway" and cf(li) != "HIT" and b"wpadminbar" in li["body"], "%s %s admin bar %s" % (ep(li), cf(li), b"wpadminbar" in li["body"]))
check("logged out page has no admin bar", b"wpadminbar" not in s["body"], "")
print("FAILS %d" % results.count(False))
sys.exit(1 if False in results else 0)
