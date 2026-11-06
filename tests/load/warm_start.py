#!/usr/bin/env python3
"""Measure the c1 warm start (issue #73): is the first add to cart after a
sleep faster when a cached product view has started the container?

  B=<c1 site url> SPIKE_TOKEN=... python3 tests/load/warm_start.py [trials] [think_s]

One arm per run: the arm is the site's WARM_START (a deploy var), read back
from /_store-info. Run it once on a deploy with WARM_START=product, then once
on a deploy with WARM_START=off (the red control). Defaults: 3 trials, 10 s.

Each trial:
1. POST /_store-stop, then wait until /_store-info says the container is not
   running (up to 120 s).
2. One product view, as a new visitor (no cookie): GET the product page. The
   page must come from the edge (the gateway's Storefront cache), so the
   script primes it first, while the container is awake.
3. Wait think_s (a shopper reading the page). Read /_store-info: running yet?
   A view the edge served stale (cf-cache-status UPDATING) also sends a
   refresh to the container, which starts it in either arm: the median uses
   HIT views only and lists the others (not_hit_trials).
4. Add to cart, as the same new visitor: GET /?add-to-cart=<id> (a cookie
   jar, no redirect followed). Its time is the result.
5. Read /_store-info again: warm (starts, skipped_running, skipped_gap,
   failed), running.
Each trial waits WARM_GAP_S + 5 s between its prime and its measured view, so
the gateway's rate limit does not block the measured view's start. The product comes from the Store API (?rest_route=/wc/store/v1/products),
asked before the first stop, while the container is awake anyway: a SIMPLE,
in-stock, purchasable product (a variable product would only redirect to its
page). A trial counts as an add to cart only when WooCommerce set the
woocommerce_items_in_cart cookie (cart_added); the median uses those only.

Prints one JSON object: the arm, the product, every trial, and the median
add-to-cart time. Uses User-Agent wp-on-cf-warm-start (the edge refuses
urllib's default, #72).
"""
import http.cookiejar
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

B = os.environ["B"].rstrip("/")
TOKEN = os.environ["SPIKE_TOKEN"]
UA = "wp-on-cf-warm-start"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def call(path, method="GET", token=False, jar=None, timeout=120):
    h = {"User-Agent": UA}
    if token:
        h["x-spike-token"] = TOKEN
    opener = urllib.request.build_opener(NoRedirect, *( [urllib.request.HTTPCookieProcessor(jar)] if jar is not None else []))
    req = urllib.request.Request(B + path, method=method, headers=h, data=b"" if method == "POST" else None)
    t = time.monotonic()
    try:
        r = opener.open(req, timeout=timeout)
        body, status, headers = r.read(), r.status, r.headers
    except urllib.error.HTTPError as e:
        body, status, headers = e.read(), e.code, e.headers
    return {"status": status, "s": round(time.monotonic() - t, 3), "body": body, "headers": headers}


def info():
    r = call("/_store-info", token=True)
    try:
        return json.loads(r["body"])
    except ValueError:
        return {"error": r["status"]}


def wait_stopped(limit=120):
    t = time.monotonic()
    while time.monotonic() - t < limit:
        i = info()
        if i.get("running") is False:
            return round(time.monotonic() - t, 1)
        time.sleep(3)
    sys.exit("the container did not stop in %d s" % limit)


def main():
    trials = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    think = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
    i0 = info()
    warm = i0.get("warm")
    if not warm:
        sys.exit("/_store-info has no warm key: deploy a Worker with #73 (warm.js) first. Got: %s" % json.dumps(i0)[:300])
    arm, gap = warm["mode"], float(warm["gap_s"])
    # ?rest_route= answers whatever the permalink setting is: on an imported
    # site (wp-import-c1, 2026-11-06) /wp-json/... answered 301 to a slash form.
    p = call("/?rest_route=/wc/store/v1/products&per_page=100&type=simple&stock_status=instock")
    if p["status"] != 200:
        sys.exit("Store API products: HTTP %s" % p["status"])
    ok = [x for x in json.loads(p["body"]) if x.get("type") == "simple" and x.get("is_in_stock") and x.get("is_purchasable")]
    if not ok:
        sys.exit("no simple, in-stock, purchasable product in the first 100 of the Store API")
    prod = ok[0]
    path = "/" + prod["permalink"].split("://", 1)[1].split("/", 1)[1]
    out = {"site": B, "arm": arm, "gap_s": gap, "think_s": think, "product": {"id": prod["id"], "path": path, "name": prod.get("name"), "type": prod.get("type")}, "trials": []}
    for n in range(trials):
        # Prime the edge copy of the product page while the container is up.
        # The prime is a product view too: it sets the gateway isolate's
        # WARM_GAP_S gate (warm.js). So wait out the gap BEFORE the measured
        # view, or the view's warm start is skipped when it lands on the same
        # isolate (measured 2026-11-06: product trial 3, no warm call at all).
        call(path)
        time.sleep(gap + 5)
        stop = call("/_store-stop", method="POST", token=True)
        stopped_after = wait_stopped()
        view = call(path)
        view_cache = view["headers"].get("cf-cache-status")
        time.sleep(think)
        before = info()
        jar = http.cookiejar.CookieJar()
        cart = call("/?add-to-cart=%d" % prod["id"], jar=jar)
        after = info()
        out["trials"].append({
            "n": n + 1,
            "stop_status": stop["status"], "stopped_after_s": stopped_after,
            "view_status": view["status"], "view_s": view["s"], "view_cache": view_cache,
            "running_before_cart": before.get("running"),
            "cart_status": cart["status"], "cart_s": cart["s"],
            "cart_added": any(c.name == "woocommerce_items_in_cart" and c.value == "1" for c in jar),
            "warm_after": after.get("warm"), "running_after": after.get("running"),
        })
        print(json.dumps(out["trials"][-1]), file=sys.stderr)
    # A view the edge served stale (UPDATING) sends a refresh to the container,
    # which starts it in either arm: that is a different path, so the median
    # uses HIT views only, and the others are listed.
    times = [t["cart_s"] for t in out["trials"] if t["cart_added"] and t["view_cache"] == "HIT"]
    out["add_to_cart_median_s"] = round(statistics.median(times), 3) if times else None
    out["not_hit_trials"] = [t["n"] for t in out["trials"] if t["view_cache"] != "HIT"]
    # The direct evidence: was the container already up when the cart came?
    out["running_before_cart"] = [t["running_before_cart"] for t in out["trials"]]
    out["view_cache"] = [t["view_cache"] for t in out["trials"]]
    out["cart_added"] = [t["cart_added"] for t in out["trials"]]
    out["utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
