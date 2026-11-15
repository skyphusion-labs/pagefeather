#!/usr/bin/env python3
# WOO_EXTRAS on a running local site (#667). The site is already installed and
# WooCommerce is already active. Same helpers as tests/woo.py (break_lib).
#
#   WOO_EXTRAS_EXPECT=unset   WooCommerce's own defaults stay.
#   WOO_EXTRAS_EXPECT=off     the four options read "no", a guest page has no
#                             order-attribution script tag, and a checkout writes
#                             no _wc_order_attribution_* order meta.
# Analytics (woocommerce_analytics_enabled) stays "yes" in both modes.
#
# Option names are the ones WooCommerce 11.2.1 reads (WOO_VERSION in build.sh):
#   woocommerce_feature_order_attribution_enabled
#   woocommerce_allow_tracking
#   woocommerce_show_marketplace_suggestions
#   woocommerce_feature_remote_logging_enabled
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import opener, req, short, login, rest

EXPECT = os.environ.get("WOO_EXTRAS_EXPECT", "unset")
if EXPECT not in ("unset", "off"):
    print("FAIL WOO_EXTRAS_EXPECT must be unset or off, not %s" % EXPECT)
    sys.exit(2)

FOUR = (
    "woocommerce_allow_tracking",
    "woocommerce_show_marketplace_suggestions",
    "woocommerce_feature_order_attribution_enabled",
    "woocommerce_feature_remote_logging_enabled",
)
ANALYTICS = "woocommerce_analytics_enabled"
# Unset is WooCommerce 11.2.1's own default for each option (settings REST,
# which applies the setting default when the row was never saved).
UNSET = {
    "woocommerce_allow_tracking": "no",
    "woocommerce_show_marketplace_suggestions": "yes",
    "woocommerce_feature_order_attribution_enabled": "yes",
    "woocommerce_feature_remote_logging_enabled": "yes",
}
OFF = {k: "no" for k in FOUR}

results = []
def check(name, ok, r=None, extra=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (("  %s" % short(r)) if r else "") + (("  %s" % extra) if extra else ""))
    if not ok and r is not None and r.get("body"):
        print("     ", r["body"][:400])

def settings_map(o):
    r = rest(o, "/wc/v3/settings/advanced")
    if r["code"] != 200:
        return None, r
    rows = json.loads(r["body"])
    return {row.get("id"): row.get("value") for row in rows if isinstance(row, dict) and row.get("id")}, r

def attribution_script(body):
    return re.search(br"<script\b[^>]*order-attribution", body) is not None

def attribution_meta(order):
    keys = []
    for item in order.get("meta_data") or []:
        key = item.get("key") or ""
        if key.startswith("_wc_order_attribution_"):
            keys.append(key)
    return keys

o = login()
r = rest(o, "/wc/v3/payment_gateways/cod", {"enabled": True}, method="PUT")
check("admin: enable cash on delivery", r["code"] == 200 and json.loads(r["body"]).get("enabled") is True, r)
r = rest(o, "/wc-admin/options", {"woocommerce_coming_soon": "no"})
check("admin: launch the store (coming soon off)", r["code"] == 200, r)

g = opener()
home = req(g, "/?nocache=1")
has_script = attribution_script(home["body"])
if EXPECT == "off":
    check("guest: no order-attribution script tag", home["code"] == 200 and not has_script, home)
else:
    check("guest: order-attribution script tag is still there", home["code"] == 200 and has_script, home)
if not (home["code"] == 200 and (has_script == (EXPECT != "off"))):
    srcs = re.findall(br"<script\b[^>]*\bsrc=[\"']([^\"']+)", home["body"])
    print("     script srcs:", [s.decode("utf-8", "replace")[:140] for s in srcs[:12]])

by_id, r = settings_map(o)
want = OFF if EXPECT == "off" else UNSET
if by_id is None:
    check("admin: read the advanced settings", False, r)
else:
    got = {k: by_id.get(k) for k in list(FOUR) + [ANALYTICS]}
    print("     options:", json.dumps(got, sort_keys=True))
    check("admin: the four options read %s" % ("no" if EXPECT == "off" else "their defaults"), all(by_id.get(k) == want[k] for k in FOUR), extra=json.dumps({k: by_id.get(k) for k in FOUR}, sort_keys=True))
    check("admin: WooCommerce Analytics stays yes", by_id.get(ANALYTICS) == "yes", extra="got %s" % by_id.get(ANALYTICS))

if EXPECT == "off" and by_id is not None:
    # A stored "yes" must not turn them back on: pre_option_* wins over the database.
    r = rest(o, "/wc-admin/options", {"woocommerce_allow_tracking": "yes"})
    check("admin: writing tracking yes is accepted as a write", r["code"] == 200, r)
    r = rest(o, "/wc/v3/settings/advanced/woocommerce_feature_order_attribution_enabled", {"value": "yes"}, method="PUT")
    check("admin: writing order attribution yes is accepted as a write", r["code"] == 200, r)
    by_id, r = settings_map(o)
    if by_id is None:
        check("admin: the four options still read no after a write", False, r)
    else:
        check("admin: the four options still read no after a write", all(by_id.get(k) == "no" for k in FOUR), extra=json.dumps({k: by_id.get(k) for k in FOUR}, sort_keys=True))
        check("admin: Analytics still yes after those writes", by_id.get(ANALYTICS) == "yes", extra="got %s" % by_id.get(ANALYTICS))

T = int(time.time())
r = rest(o, "/wc/v3/products", {"name": "Edge Mug %s" % T, "type": "simple", "regular_price": "12.50", "status": "publish", "manage_stock": True, "stock_quantity": 20})
pid = json.loads(r["body"]).get("id") if r["code"] == 201 else None
check("admin: create a product", bool(pid), r)

cart = req(g, "/?rest_route=/wc/store/v1/cart")
nonce = cart["h"].get("Nonce") if cart["h"] else None
token = cart["h"].get("Cart-Token") if cart["h"] else None
check("guest: Store API cart", cart["code"] == 200 and nonce and token, cart)
H = {"Nonce": nonce or "", "Cart-Token": token or "", "Content-Type": "application/json"}
r = req(g, "/?rest_route=/wc/store/v1/cart/add-item", json.dumps({"id": pid, "quantity": 1}).encode(), H)
check("guest: add 1 to cart", r["code"] == 201, r)
addr = {"first_name": "Ada", "last_name": "Edge", "address_1": "1 Worker Way", "city": "Austin", "state": "TX", "postcode": "78701", "country": "US", "email": "ada@example.com"}
payload = {"billing_address": addr, "shipping_address": {k: v for k, v in addr.items() if k != "email"}, "payment_method": "cod",
           "extensions": {"woocommerce/order-attribution": {"source_type": "utm", "utm_source": "pagefeather-probe", "utm_medium": "test"}}}
r = req(g, "/?rest_route=/wc/store/v1/checkout", json.dumps(payload).encode(), H)
order = json.loads(r["body"]) if r["code"] == 200 else {}
check("guest: checkout with attribution fields", r["code"] == 200 and order.get("order_id"), r, "order %s" % order.get("order_id"))
if order.get("order_id"):
    r = rest(o, "/wc/v3/orders/%s" % order["order_id"])
    od = json.loads(r["body"]) if r["code"] == 200 else {}
    keys = attribution_meta(od)
    if EXPECT == "off":
        check("admin: checkout wrote no _wc_order_attribution_* meta", r["code"] == 200 and keys == [], r, "keys %s" % keys)
    else:
        check("admin: checkout still wrote _wc_order_attribution_* meta", r["code"] == 200 and any(k.startswith("_wc_order_attribution_") for k in keys), r, "keys %s" % keys)

print("%d pass, %d fail (%s)" % (results.count(True), results.count(False), EXPECT))
sys.exit(0 if results and all(results) else 1)
