#!/usr/bin/env python3
"""Per-page PHP memory of a b-dosql site, for a plugin-memory check (issue #279).

    B=https://wp-<site>.<sub>.workers.dev SPIKE_TOKEN=... python3 tests/wfp/plugin-memory.py

The memory of record is the PHP WASM heap (x-wasm-mib): memory_get_usage reads 0 under
USE_ZEND_ALLOC=0, and the heap never shrinks, so one reading is the HIGH-WATER since that
runtime booted. To get one number per page, the probe first evicts the site's Durable Object
(POST /_evict, spike-token gated), so the next request boots a fresh runtime. It then reads the
page twice:
  - cold: the first request after the boot. x-wasm-mib is the boot plus this page.
  - warm: the same page again on that runtime, unless the cold one recycled. x-wasm-mib is
    the high-water after both, which shows whether the page keeps growing the heap.
A runtime past 100 MiB of heap is dropped after the request (x-runtime-recycled: memory), and the
next request pays a cold boot. A 503 is a request the site could not serve.

Pages: home, shop, a product, the Store API product list, a guest cart (classic session) and the
checkout page. No order is placed and nothing is written to the site except a guest session.

The heap grows in steps, so x-wasm-mib reads in steps too (99 and 119 are the values seen on a
WooCommerce store, 2026-11-11). 119 still answers, but the next step is past the 128 MiB isolate.

Output: one `@event mem.page {...}` line per page, then `@event mem.summary {...}`. Exit 2 (could
not measure) when a page did not get a fresh runtime. Exit 1 when a
page answers 5xx (or does not answer), or its cold heap reaches FAIL_MIB (default 120, past the
last step that still answered). WARN_MIB (default 100, the recycle threshold) only warns: every
such request makes the next one pay a cold boot. /_evict itself answers 502 (it aborts its own
object); the x-boot: 1 on the next request is the proof that the runtime is fresh.
Run it after a site update that adds a plugin, before the site goes live.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

B = os.environ.get("B", "").rstrip("/")
TOKEN = os.environ.get("SPIKE_TOKEN", "")
FAIL_MIB = int(os.environ.get("FAIL_MIB", "120"))
WARN_MIB = int(os.environ.get("WARN_MIB", "100"))
SETTLE_S = float(os.environ.get("SETTLE_S", "3"))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def opener(jar=None):
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar or CookieJar()), NoRedirect)


def req(o, path, method="GET", headers=None):
    # Every request carries the spike token: since #312 the site sends x-boot (the proof of a fresh
    # runtime) and the other performance headers only on a request with it. Without it every page
    # read freshBoot false, and the run still said ok (measured on fdprobe1112e, 2026-11-12).
    h = {"User-Agent": "wp-on-cf-plugin-memory", "x-spike-token": TOKEN}
    h.update(headers or {})
    r = urllib.request.Request(B + path, method=method, headers=h, data=b"" if method == "POST" else None)
    t = time.time()
    try:
        resp = o.open(r, timeout=120)
        code, body, hd = resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e:
        code, body, hd = e.code, e.read(), e.headers
    except Exception as e:  # noqa: BLE001 -- a failed request is data
        return {"code": "EXC", "err": repr(e)[:160], "s": round(time.time() - t, 2), "body": b""}
    mib = hd.get("x-wasm-mib")
    return {"code": code, "s": round(time.time() - t, 2), "mib": int(mib) if mib and mib.isdigit() else None,
            "recycled": hd.get("x-runtime-recycled"), "boot": hd.get("x-boot"), "phpMs": hd.get("x-php-ms"),
            "body": body}


def evict():
    r = req(opener(), "/_evict", method="POST")
    time.sleep(SETTLE_S)
    return r["code"]


def product_slug():
    r = req(opener(), "/?rest_route=/wc/store/v1/products&per_page=20")
    try:
        items = json.loads(r["body"]) if r["code"] == 200 else []
    except ValueError:
        items = []
    simple = next((p for p in items if p.get("type") == "simple" and p.get("is_purchasable")), None)
    return simple


def pages(product):
    out = [("home", "/", None), ("shop", "/shop/", None), ("store-api", "/?rest_route=/wc/store/v1/products&per_page=20", None)]
    if product:
        out.append(("product", "/?p=%s" % product["id"], None))
        out.append(("cart", "/cart/", "/?add-to-cart=%s" % product["id"]))
        out.append(("checkout", "/checkout/", "/?add-to-cart=%s" % product["id"]))
    return out


def measure(name, path, setup):
    ev = evict()
    o = opener()
    pre = req(o, setup) if setup else None
    if pre:
        # The setup request booted a runtime; evict again so the page itself is the cold one,
        # and keep the cookie, so the cart is still there.
        evict()
    cold = req(o, path)
    warm = None if cold.get("recycled") else req(o, path)
    row = {"page": name, "path": path, "evict": ev, "freshBoot": cold.get("boot") == "1",
           "cold": {k: cold.get(k) for k in ("code", "s", "mib", "recycled", "boot", "phpMs")},
           "warm": {k: warm.get(k) for k in ("code", "s", "mib", "recycled", "boot", "phpMs")} if warm else None}
    return row


def main():
    if not B or not TOKEN:
        sys.exit("set B (the site origin) and SPIKE_TOKEN")
    product = product_slug()
    rows = []
    for name, path, setup in pages(product):
        row = measure(name, path, setup)
        rows.append(row)
        print("@event mem.page " + json.dumps(row, sort_keys=True), flush=True)
    bad = [r["page"] for r in rows if str(r["cold"]["code"]).startswith("5") or r["cold"]["code"] == "EXC"
           or (r["warm"] and str(r["warm"]["code"]).startswith("5"))]
    over = [r["page"] for r in rows if (r["cold"]["mib"] or 0) >= FAIL_MIB]
    warn = [r["page"] for r in rows if WARN_MIB <= (r["cold"]["mib"] or 0) < FAIL_MIB]
    summary = {"site": B, "product": (product or {}).get("name"), "failMib": FAIL_MIB, "warnMib": WARN_MIB,
               "maxColdMib": max((r["cold"]["mib"] or 0) for r in rows), "recycledCold": [r["page"] for r in rows if r["cold"]["recycled"]],
               "notFresh": [r["page"] for r in rows if not r["freshBoot"]],
               "errors": bad, "overFail": over, "overWarn": warn, "ok": not bad and not over}
    # A page whose cold read was NOT a fresh runtime measured an earlier page's high-water, not its
    # own: the run could not measure, so it never reads as a pass (exit 2).
    if summary["notFresh"]:
        summary["ok"] = False
        summary["couldNotMeasure"] = "no fresh runtime (x-boot 1) for: " + ", ".join(summary["notFresh"])
    print("@event mem.summary " + json.dumps(summary, sort_keys=True), flush=True)
    sys.exit(2 if summary.get("couldNotMeasure") else 0 if summary["ok"] else 1)


if __name__ == "__main__":
    main()
