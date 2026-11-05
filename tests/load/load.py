#!/usr/bin/env python3
"""Concurrent load on a WooCommerce site: shoppers browse, buyers check out.

Usage: B=<site url> ADMIN_PASSWORD=... python3 tests/load/load.py
Options (environment): LEVELS (concurrent users per step, default "1,5,10,25,50,100"),
SECONDS (per step, default 60), BUYERS (fraction of loops that buy, default 0.2),
SETUP=0 (skip the admin setup: payment method, store launch, products),
WOO=0 or 1 (default: 1 when the site's Store API answers). WOO=0 is plain
WordPress: browse only, over home, a post, a page, search, a
category and the feed; no setup and no buyers).

Each user loops until the step ends. A browse loop is one fresh GET (home, shop,
or a product page). A buy loop is three Store API requests: cart, add item,
checkout (cash on delivery, nothing charged). Every page bypasses the cache.

Per request it records the status, the time, and the Worker's own headers:
x-wasm-mib (WebAssembly memory), x-runtime-recycled, x-boot. A body that names
error 1102 (Worker exceeded resource limits) is counted on its own: that is the
128 MB memory limit or the CPU limit.

Prints one JSON line per step, then one line with all steps. Exit 0: a failed
request is a result.
"""
import concurrent.futures as cf, http.cookiejar, json, os, random, re, sys, threading, time, urllib.error, urllib.parse, urllib.request

B = os.environ["B"].rstrip("/")
LEVELS = [int(x) for x in os.environ.get("LEVELS", "1,5,10,25,50,100").split(",")]
SECONDS = float(os.environ.get("SECONDS", "60"))
BUYERS = float(os.environ.get("BUYERS", "0.2"))
UA = {"User-Agent": "wp-on-cf-load"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect)


def req(o, path, data=None, headers=None, method=None, timeout=60):
    h = dict(UA, **(headers or {}))
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        h.setdefault("Content-Type", "application/json")
    t = time.time()
    try:
        r = o.open(urllib.request.Request(B + path, data=data, headers=h, method=method), timeout=timeout)
        code, body, hd = r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        code, body, hd = e.code, e.read(), e.headers
    except Exception as e:
        return {"code": "EXC", "body": repr(e).encode(), "h": {}, "s": time.time() - t}
    return {"code": code, "body": body, "h": hd, "s": time.time() - t}


def nc(path):
    return path + ("&" if "?" in path else "?") + "nocache=%08x" % random.getrandbits(32)


def setup():
    """Admin: cash on delivery on, store launched, 5 products with no stock limit."""
    o = opener()
    req(o, "/wp-login.php")
    form = urllib.parse.urlencode({"log": "admin", "pwd": os.environ["ADMIN_PASSWORD"], "wp-submit": "Log In", "redirect_to": "/wp-admin/", "testcookie": "1"}).encode()
    r = req(o, "/wp-login.php", form, {"Content-Type": "application/x-www-form-urlencoded"})
    if r["code"] != 302:
        sys.exit("admin login failed: %s" % r["code"])
    page = req(o, "/wp-admin/post-new.php")
    m = re.search(rb'wpApiSettings\s*=\s*\{[^}]*"nonce":"([0-9a-f]+)"', page["body"]) or re.search(rb'"nonce":"([0-9a-f]{10})"', page["body"])
    if not m:
        sys.exit("no REST nonce on the admin page")
    H = {"X-WP-Nonce": m.group(1).decode()}
    rest = lambda p, d, method="POST": req(o, "/?rest_route=" + p, d, H, method)
    rest("/wc/v3/payment_gateways/cod", {"enabled": True}, "PUT")
    rest("/wc-admin/options", {"woocommerce_coming_soon": "no"})
    ids = []
    for i in range(5):
        r = rest("/wc/v3/products", {"name": "Load Mug %d-%d" % (int(time.time()), i), "type": "simple", "regular_price": "12.50", "status": "publish", "manage_stock": False})
        if r["code"] == 201:
            ids.append(json.loads(r["body"])["id"])
    if not ids:
        sys.exit("could not create products")
    return ids


def products():
    r = req(opener(), nc("/?rest_route=/wc/store/v1/products&per_page=20"))
    return [p for p in json.loads(r["body"]) if p.get("is_purchasable")] if r["code"] == 200 else []


def is_1102(r):
    return r["code"] != 200 and b"1102" in (r["body"] or b"")[:20000]


lock = threading.Lock()


def user(stop, prods, rec):
    while time.time() < stop:
        o = opener()
        if random.random() < BUYERS:
            p = random.choice(prods)
            c = req(o, "/?rest_route=/wc/store/v1/cart")
            rec("cart", c)
            H = {"Nonce": c["h"].get("Nonce") or "", "Cart-Token": c["h"].get("Cart-Token") or ""} if c["h"] else {}
            a = req(o, "/?rest_route=/wc/store/v1/cart/add-item", {"id": p["id"], "quantity": 1}, H)
            rec("add", a)
            addr = {"first_name": "Load", "last_name": "Test", "address_1": "1 Edge Way", "city": "Detroit", "state": "MI", "postcode": "48201", "country": "US", "email": "load@example.com", "phone": "5555550100"}
            k = req(o, "/?rest_route=/wc/store/v1/checkout", {"billing_address": addr, "shipping_address": {x: y for x, y in addr.items() if x != "email"}, "payment_method": "cod"}, H)
            ok = k["code"] == 200 and b'"order_id"' in k["body"]
            rec("checkout", k, ok)
        else:
            p = random.choice(prods)
            u = urllib.parse.urlparse(p["permalink"])
            own = u.path + ("?" + u.query if u.query else "")
            path = own if not WOO else random.choice(["/", "/?post_type=product", own])
            rec("browse", req(o, nc(path)))


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, max(0, int(-(-q * len(xs) // 1)) - 1))], 3)


def step(n, prods):
    rows = []

    def rec(kind, r, ok=None):
        h = r["h"] or {}
        row = {"k": kind, "c": r["code"], "s": r["s"], "ok": (r["code"] in (200, 201) if ok is None else ok),
               "e1102": is_1102(r), "mib": h.get("x-wasm-mib"), "rec": h.get("x-runtime-recycled"), "boot": h.get("x-boot")}
        with lock:
            rows.append(row)

    t0 = time.time()
    stop = t0 + SECONDS
    with cf.ThreadPoolExecutor(n) as ex:
        list(ex.map(lambda _: user(stop, prods, rec), range(n)))
    wall = time.time() - t0
    # The client's own 1-minute load: at or above its CPU count, the client was
    # the limit, not the site.
    out = {"users": n, "seconds": round(wall, 1), "client_load1": round(os.getloadavg()[0], 2), "client_cpus": os.cpu_count(), "requests": len(rows), "rps": round(len(rows) / wall, 2),
           "errors": sum(1 for r in rows if not r["ok"]), "e1102": sum(1 for r in rows if r["e1102"]),
           "status": {}, "recycled": {}, "boots": sum(1 for r in rows if r["boot"] == "1"),
           "max_wasm_mib": max([int(r["mib"]) for r in rows if r["mib"]] or [0]), "kinds": {}}
    for r in rows:
        out["status"][str(r["c"])] = out["status"].get(str(r["c"]), 0) + 1
        if r["rec"]:
            out["recycled"][r["rec"]] = out["recycled"].get(r["rec"], 0) + 1
    for k in ("browse", "cart", "add", "checkout"):
        xs = [r["s"] for r in rows if r["k"] == k]
        if xs:
            out["kinds"][k] = {"n": len(xs), "ok": sum(1 for r in rows if r["k"] == k and r["ok"]),
                               "p50": pct(xs, .5), "p95": pct(xs, .95), "p99": pct(xs, .99), "max": round(max(xs), 3)}
    return out


def has_woo():
    r = req(opener(), nc("/?rest_route=/wc/store/v1/products&per_page=1"))
    return r["code"] == 200


# WOO=1 or 0 forces the mode; unset, the site decides (its Store API answers or not).
WOO = {"1": True, "0": False}.get(os.environ.get("WOO", ""), None)
PLAIN = ["/", "/?p=1", "/?page_id=2", "/?s=hello", "/?cat=1", "/?feed=rss2"]

if __name__ == "__main__":
    if WOO is None:
        WOO = has_woo()
    if WOO:
        if os.environ.get("SETUP", "1") != "0":
            setup()
        prods = products()
        if not prods:
            sys.exit("no purchasable products")
    else:
        BUYERS = 0.0
        prods = [{"permalink": B + p} for p in PLAIN]
    allsteps = []
    for n in LEVELS:
        s = step(n, prods)
        allsteps.append(s)
        print(json.dumps(s), flush=True)
    print(json.dumps({"target": B, "woo": WOO, "levels": LEVELS, "seconds_per_level": SECONDS, "buyers": BUYERS, "steps": allsteps}))
