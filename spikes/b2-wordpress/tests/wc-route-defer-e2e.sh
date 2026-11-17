#!/bin/bash
# #768: WooCommerce's REST routes are deferred, never removed (php/wc-route-defer.php). dosql-local, a WooCommerce
# site with a product; every comparison is the same build with the deferral on and off (x-pf-wc-defer: off, an
# operator switch):
#   1. post-new.php's wasm high-water, a fresh runtime per request, 3 each: on is at least 8 MiB under off.
#   2. the block editor's preload is identical, on against off (apart from the auto-draft's own id and the
#      diagnostic headers).
#   3. (x-pf-wc-defer: force, the deferral on a REST request) /wc/v3/products answers the same body as untouched,
#      and the routes were registered on demand.
#   4. (force) the full REST index lists the same namespaces and routes as untouched.
#   5. a wc-admin page answers the same on and off.
#   6. (force) a route that matches nothing is still a 404 (the fail-safe registers first, then matches).
#   7. on the editor screen, every mapped callback is found on the running WooCommerce: its preloaded answers say
#      deferred 13/13 (bar c, live).
#   8. SCOPE: a REST request and the front end are untouched (no deferral, no header).
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/wc-route-defer.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off" ./run.sh _ping > /dev/null || { echo "wc-route-defer: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "wc-route-defer: /_install failed"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-spike-token: $TOK" -X POST "$B/_activate?plugin=woocommerce/woocommerce.php")" = 200 ] || { echo "wc-route-defer: activating WooCommerce failed"; exit 1; }
B=$B SPIKE_TOKEN=$TOK ADMIN_PASSWORD=$PW python3 -I - <<'PY'
import json, os, re, statistics, sys, time
sys.path.insert(0, os.path.join(os.getcwd(), "tests")); import break_lib as BL
o = BL.login()
r = BL.rest(o, "/wc/v3/products", {"name": "Defer Mug %d" % time.time(), "type": "simple", "regular_price": "9.00", "status": "publish"})
if r["code"] != 201: sys.exit("wc-route-defer: creating a product answered %s" % r["code"])
OFF = {"x-pf-wc-defer": "off"}
FORCE = {"x-pf-wc-defer": "force"}
fails = []
def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (("  (" + detail + ")") if detail else "")); cond or fails.append(name)
def peak(h):
    BL.req(o, "/wp-login.php", headers={"x-runtime-recycle": "force"})
    x = BL.req(o, "/wp-admin/post-new.php", headers={"x-mem-ledger": "1", **h}, timeout=300)
    return json.loads((x["h"] or {}).get("x-perf") or "{}").get("wasm1MiB")
on = [peak({}) for _ in range(3)]; off = [peak(OFF) for _ in range(3)]
ok1 = all(isinstance(v, (int, float)) for v in on + off) and statistics.median(on) <= statistics.median(off) - 8
check("1. post-new.php's peak, deferred, is at least 8 MiB under not deferred", ok1, "on %s, off %s" % (on, off))
pid = json.loads(BL.rest(o, "/wp/v2/posts", {"title": "defer edit %d" % time.time(), "status": "draft", "content": "x"})["body"])["id"]
def peak_edit(h):
    BL.req(o, "/wp-login.php", headers={"x-runtime-recycle": "force"})
    x = BL.req(o, "/wp-admin/post.php?post=%d&action=edit" % pid, headers={"x-mem-ledger": "1", **h}, timeout=300)
    return json.loads((x["h"] or {}).get("x-perf") or "{}").get("wasm1MiB")
eon = [peak_edit({}) for _ in range(3)]; eoff = [peak_edit(OFF) for _ in range(3)]
check("1. post.php (edit) is in scope too: its peak, deferred, is lower than not deferred", all(isinstance(v, (int, float)) for v in eon + eoff) and statistics.median(eon) < statistics.median(eoff), "on %s, off %s" % (eon, eoff))
def preload(h):
    x = BL.req(o, "/wp-admin/post-new.php", headers=h, timeout=300)
    b = x["body"].decode("utf-8", "replace"); i = b.find("wp.apiFetch.createPreloadingMiddleware(")
    if i < 0: return None
    obj, _ = json.JSONDecoder().raw_decode(b[b.index("(", i) + 1:].lstrip())
    return {re.sub(r"/posts/\d+", "/posts/N", k): v for k, v in obj.items()}
def strip(x):
    if isinstance(x, dict): return {k: strip(v) for k, v in x.items() if k not in ("X-PF-WC-Routes", "x-ast-cache", "X-Route-Cache")}
    if isinstance(x, list): return [strip(v) for v in x]
    return x
def norm(x):
    # The auto-draft is new on each request: its own id (and the dates) differ, and nothing else may.
    s = json.dumps(strip(x), sort_keys=True)
    body = x.get("body") if isinstance(x, dict) else None
    if isinstance(body, dict) and isinstance(body.get("id"), int):
        s = re.sub(r"(?<![0-9])%d(?![0-9])" % body["id"], "N", s)
    return re.sub(r'"(date|date_gmt|modified|modified_gmt)": "[^"]*"', "", s)
a, b = preload({}), preload(OFF)
diff = [k for k in (a or {}) if k in (b or {}) and norm(a[k]) != norm(b[k])]
check("2. the editor's preload is identical, deferred or not", a is not None and b is not None and sorted(a) == sorted(b) and not diff, "differing: %s" % diff[:3])
p1 = BL.rest(o, "/wc/v3/products?per_page=5", headers=FORCE); p2 = BL.rest(o, "/wc/v3/products?per_page=5")
st = (p1["h"] or {}).get("X-PF-WC-Routes") or ""
check("3. /wc/v3/products: the same body, deferred (forced) or untouched", p1["code"] == 200 and p1["body"] == p2["body"], "%s %s" % (p1["code"], p2["code"]))
check("3. and its routes were registered on demand", st.startswith("registered "), st)
i1, i2 = BL.rest(o, "/", headers=FORCE), BL.rest(o, "/")
j1, j2 = json.loads(i1["body"]), json.loads(i2["body"])
check("4. the full index: the same namespaces and routes", sorted(j1["namespaces"]) == sorted(j2["namespaces"]) and sorted(j1["routes"]) == sorted(j2["routes"]), "%d vs %d routes" % (len(j1["routes"]), len(j2["routes"])))
w1 = BL.req(o, "/wp-admin/admin.php?page=wc-admin&path=%2Fanalytics%2Foverview", timeout=300)
w2 = BL.req(o, "/wp-admin/admin.php?page=wc-admin&path=%2Fanalytics%2Foverview", headers=OFF, timeout=300)
check("5. a wc-admin page answers the same", w1["code"] == w2["code"] == 200 and len(w1["body"]) == len(w2["body"]), "%s %s, %d vs %d bytes" % (w1["code"], w2["code"], len(w1["body"]), len(w2["body"])))
u = BL.rest(o, "/wp/v2/no-such-route", headers=FORCE)
check("6. a route that matches nothing is still a 404 (registered first)", u["code"] == 404 and ((u["h"] or {}).get("X-PF-WC-Routes") or "").startswith("registered "), "%s %s" % (u["code"], (u["h"] or {}).get("X-PF-WC-Routes")))
s7 = sorted({(v.get("headers") or {}).get("X-PF-WC-Routes") for v in (a or {}).values() if isinstance(v, dict)} - {None})
check("7. on the editor screen, every mapped callback is found: its preloaded answers say deferred 13/13", s7 == ["deferred 13/13"], str(s7))
t = BL.rest(o, "/wp/v2/types"); f = BL.req(BL.opener(), "/")
check("8. scope: a REST request and the front end are untouched (no deferral header)", "X-PF-WC-Routes" not in (t["h"] or {}) and "X-PF-WC-Routes" not in (f["h"] or {}), "%s / %s" % ((t["h"] or {}).get("X-PF-WC-Routes"), (f["h"] or {}).get("X-PF-WC-Routes")))
print("wc-route-defer: %d failing" % len(fails))
sys.exit(1 if fails else 0)
PY
