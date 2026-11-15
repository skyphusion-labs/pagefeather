#!/usr/bin/env python3
"""Test of tests/load/page_stale.py (#628) against a FAKE WooCommerce site. No account, no network.

The fake models the page cache of index.js and edge-cache.php: a guest GET with no WordPress cookie
and no operator header is answered from a cache for TTL seconds (cf-cache-status HIT, then STALE);
?nocache= is never cached (MISS). A checkout that changes a stock QUANTITY does not purge; a stock
STATUS change purges, unless the fake refuses purges past a limit (the account's 5 a minute).
Any request the fake does not know is recorded as UNEXPECTED and fails the case.
Run: python3 -I tests/load/page-stale-test.py
"""
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "page_stale.py")
PW = "pw-" + "y" * 12  # a stand-in admin password
TTL = 2.0

S = {}


def fresh_state(**kw):
    S.clear()
    S.update({"products": {}, "orders": {}, "next": 100, "cache": {}, "unexpected": [], "guest_bad": [],
              "purges_asked": 0, "purges_done": 0, "purge_limit": None, "purge_qty": False,
              "decrement": True, "cache_header": True, "deleted": [], "create_purge_delay": 0})
    S.update(kw)


def page_html(p):
    if p["stock"] > 0:
        return "<p class=\"stock in-stock\">%d in stock</p><form class=\"cart\"><button name=\"add-to-cart\">Add</button></form>" % p["stock"]
    return "<p class=\"stock out-of-stock\">Out of stock</p>"


def purge():
    S["purges_asked"] += 1
    if S["purge_limit"] is not None and S["purges_done"] >= S["purge_limit"]:
        return
    S["purges_done"] += 1
    S["cache"].clear()


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json", extra=None):
        b = body if isinstance(body, bytes) else (json.dumps(body).encode() if not isinstance(body, str) else body.encode())
        self.send_response(code)
        self.send_header("content-type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def _bad(self, why):
        S["unexpected"].append("%s %s: %s" % (self.command, self.path, why))
        self._send(599, {"error": why})

    def _admin(self):
        return "wordpress_logged_in_x=admin" in (self.headers.get("Cookie") or "") and self.headers.get("X-WP-Nonce") == "abcdef0123"

    def _body(self):
        n = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(n) if n else b""
        return raw

    def _route(self):
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        return u.path, q, (q.get("rest_route") or [None])[0]

    def do_GET(self):
        path, q, rr = self._route()
        if path == "/wp-login.php" and not rr:
            return self._send(200, "login", "text/html")
        if path == "/wp-admin/admin-ajax.php":
            if "wordpress_logged_in_x=admin" not in (self.headers.get("Cookie") or ""):
                return self._bad("nonce without login")
            return self._send(200, "abcdef0123", "text/plain")
        if rr == "/wc/store/v1/cart":
            return self._send(200, {"items": []}, extra={"Nonce": "storenonce", "Cart-Token": "ct-%d" % time.time()})
        m = re.match(r"^/product/(p\d+)/$", path)
        if m and not rr:
            p = S["products"].get(m.group(1))
            if not p:
                return self._send(404, "gone", "text/html")
            guest = not self.headers.get("Cookie") and not any(k.lower() == "x-spike-token" for k in self.headers.keys())
            if not guest:
                S["guest_bad"].append(self.path)
            ext = {}
            if "nocache" in q or not guest:
                html, status = page_html(p), "MISS"
            else:
                key = path
                now = time.time()
                c = S["cache"].get(key)
                if c and now - c[1] < TTL:
                    html, status = c[0], "HIT"
                else:
                    html, status = page_html(p), "MISS"
                    S["cache"][key] = (html, now)
            if S["cache_header"]:
                ext["cf-cache-status"] = status
            return self._send(200, html, "text/html", ext)
        return self._bad("unknown GET")

    def do_POST(self):
        path, q, rr = self._route()
        raw = self._body()
        if path == "/wp-login.php" and not rr:
            f = urllib.parse.parse_qs(raw.decode())
            if f.get("pwd") != [PW]:
                return self._send(200, "bad", "text/html")
            return self._send(302, "", "text/html", {"Set-Cookie": "wordpress_logged_in_x=admin; Path=/", "Location": "/wp-admin/"})
        if rr == "/wc/v3/products":
            if not self._admin():
                return self._bad("product create without admin")
            d = json.loads(raw)
            if not d.get("manage_stock"):
                return self._bad("probe product must manage stock")
            pid = S["next"]
            S["next"] += 1
            slug = "p%d" % pid
            S["products"][slug] = {"id": pid, "stock": int(d["stock_quantity"])}
            # A product create cleans its post cache (edge-cache.php). The Worker sends that purge up to
            # PURGE_GAP_MS later; create_purge_delay models it, so a warm read before it would be emptied.
            if S["create_purge_delay"]:
                threading.Timer(S["create_purge_delay"], purge).start()
            else:
                purge()
            return self._send(201, {"id": pid, "permalink": "http://shop.example/product/%s/" % slug})
        if rr == "/wc/store/v1/cart/add-item":
            if self.headers.get("Nonce") != "storenonce":
                return self._bad("add without nonce")
            d = json.loads(raw)
            self._cart = d["id"]
            S.setdefault("carts", {})[self.headers.get("Cart-Token")] = d["id"]
            return self._send(201, {"ok": 1})
        if rr == "/wc/store/v1/checkout":
            pid = S.get("carts", {}).get(self.headers.get("Cart-Token"))
            p = next((x for x in S["products"].values() if x["id"] == pid), None)
            if not p:
                return self._bad("checkout of an unknown cart")
            if p["stock"] < 1:
                return self._send(409, {"code": "out_of_stock"})
            was = p["stock"]
            if S["decrement"]:
                p["stock"] -= 1
            oid = S["next"]
            S["next"] += 1
            S["orders"][oid] = pid
            # edge-cache.php: no purge for a quantity change in an order request; a status change purges.
            if S["purge_qty"] or (was > 0 and p["stock"] == 0):
                purge()
            return self._send(200, {"order_id": oid})
        return self._bad("unknown POST")

    def do_DELETE(self):
        path, q, rr = self._route()
        if not self._admin():
            return self._bad("delete without admin")
        m = re.match(r"^/wc/v3/(products|orders)/(\d+)$", rr or "")
        if not m or q.get("force") != ["true"]:
            return self._bad("unknown DELETE")
        kind, i = m.group(1), int(m.group(2))
        S["deleted"].append((kind, i))
        if kind == "products":
            for k, v in list(S["products"].items()):
                if v["id"] == i:
                    del S["products"][k]
        else:
            S["orders"].pop(i, None)
        return self._send(200, {"deleted": True})


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = "http://127.0.0.1:%d" % srv.server_address[1]

FAILS = []


def check(name, cond, detail=""):
    if not cond:
        FAILS.append(name)
        print("FAIL", name, str(detail)[:400])


def run(case, **env):
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": B, "ADMIN_PASSWORD": PW, "CASE": case,
         "POLL_S": "0.25", "MAX_S": "6", "SETTLE_S": "0", "WARM_S": "0.1", "N": "4", "SPIKE_TOKEN": "operator-token"}
    e.update(env)
    p = subprocess.run([sys.executable, "-I", PROBE], env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=120)
    ev = [json.loads(l.split(" ", 2)[2]) for l in p.stdout.splitlines() if l.startswith("@event page-stale ")]
    return p.returncode, ev, p.stdout + p.stderr


def common(name, out):
    check(name + " no unexpected calls", not S["unexpected"], S["unexpected"])
    check(name + " guest reads carry no cookie and no operator header", not S["guest_bad"], S["guest_bad"][:3])
    check(name + " never prints the password", PW not in out)
    check(name + " cleans up its products and orders", not S["products"] and not S["orders"], (S["products"], S["orders"]))


# 1. quantity: no purge on a quantity change, so the cached page is old for about the TTL.
fresh_state()
code, ev, out = run("qty")
common("qty", out)
r = [e for e in ev if e.get("case") == "qty"]
check("qty reports one result", len(r) == 1 and code == 0, (code, out[-600:]))
if r:
    r = r[0]
    check("qty saw the cache", r.get("cached_proof") is True, r)
    check("qty control saw the new quantity", r.get("control_new") is True, r)
    check("qty stale for about the TTL", r.get("stale_s") is not None and TTL - 0.6 <= r["stale_s"] <= TTL + 1.0, r.get("stale_s"))
    check("qty names the old and new quantity", r.get("before") == 7 and r.get("after") == 6, r)

# 2. quantity with a purge on the quantity (a candidate fix): the page is right within a poll.
fresh_state(purge_qty=True)
code, ev, out = run("qty")
common("qty purged", out)
r = [e for e in ev if e.get("case") == "qty"]
check("qty purged stale near zero", r and r[0].get("stale_s") is not None and r[0]["stale_s"] <= 0.6, r)

# 3. the control: the checkout did not change the stock, so the probe cannot measure. Never a number.
fresh_state(decrement=False)
code, ev, out = run("qty")
r = [e for e in ev if e.get("case") == "qty"]
check("no change is could-not-measure", r and r[0].get("stale_s") is None and r[0].get("control_new") is False and r[0].get("verdict") == "could_not_measure" and code != 0, (code, r))
check("no change still cleans up", not S["products"] and not S["orders"], (S["products"], S["orders"]))

# 3b. a delayed create purge (the Worker sends it up to 15 s later): SETTLE_S waits it out, so the
#     warm copy is not emptied by it and the reading is the real staleness, not a near-zero one.
fresh_state(create_purge_delay=0.6)
code, ev, out = run("qty", SETTLE_S="0.9")
r = [e for e in ev if e.get("case") == "qty"]
check("qty settles past the create purge", r and r[0].get("stale_s") is not None and TTL - 0.6 <= r[0]["stale_s"] <= TTL + 1.0, r)
time.sleep(0.7)

# 4. no cache header: the probe cannot tell a cached read from an uncached one, and says so.
fresh_state(cache_header=False)
code, ev, out = run("qty")
r = [e for e in ev if e.get("case") == "qty"]
check("no cache header is flagged", r and r[0].get("cached_proof") is False and r[0].get("verdict") == "could_not_measure", r)

# 5. stock-outs: each sale makes a status change and asks a purge. Here the 4 product creates use up
#    the purge limit, so every sale's purge is refused (the account's 5 a minute, shared by every site),
#    and every page stays "in stock" until the TTL. A purge that IS sent empties every wp-pages page.
fresh_state(purge_limit=4)
code, ev, out = run("stockout", N="4")
common("stockout", out)
r = [e for e in ev if e.get("case") == "stockout"]
check("stockout reports", len(r) == 1 and code == 0, (code, out[-600:]))
if r:
    r = r[0]
    check("stockout all controls see out of stock", r.get("control_out") == 4, r)
    check("stockout pages still in stock right after the sales", r.get("in_stock_at_0") == 4, r)
    check("stockout counts the refused purges", S["purges_asked"] - S["purges_done"] == 4, (S["purges_asked"], S["purges_done"]))
    check("stockout max stale near the TTL", r.get("max_stale_s") is not None and TTL - 0.6 <= r["max_stale_s"] <= TTL + 1.0, r)
fresh_state(decrement=False)
code, ev, out = run("stockout", N="3")
r = [e for e in ev if e.get("case") == "stockout"]
check("stockout with no stock change is could-not-measure", r and r[0].get("verdict") == "could_not_measure" and r[0].get("control_out") == 0 and code == 3, (code, r))
fresh_state()
code, ev, out = run("stockout", N="4")
r = [e for e in ev if e.get("case") == "stockout"]
check("stockout with every purge sent is fresh", r and r[0].get("in_stock_at_0") == 0 and (r[0].get("max_stale_s") or 0) <= 0.6, r)

srv.shutdown()
if FAILS:
    print("%d FAILED" % len(FAILS))
    sys.exit(1)
print("page-stale-test: all cases pass")
