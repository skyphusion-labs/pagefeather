#!/usr/bin/env python3
# WooCommerce end-to-end: admin setup, then a guest buys a product.
# Usage: B=https://<worker> ADMIN_PASSWORD=... python3 tests/woo.py
# Prints PASS or FAIL per step with D1 calls and time. Exits 1 on any FAIL.
import json, os, re, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import opener, req, short, login, rest

results = []
def check(name, ok, r=None, extra=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  {short(r)}" if r else "") + (f"  {extra}" if extra else ""))
    if not ok and r is not None and r.get("body"):
        print("     ", r["body"][:300])

o = login()
r = rest(o, "/wc/v3/payment_gateways/cod", {"enabled": True}, method="PUT")
check("admin: enable cash on delivery", r["code"] == 200 and json.loads(r["body"]).get("enabled") is True, r)
# A new store starts in "coming soon" mode: guests see a placeholder on store pages.
r = rest(o, "/wc-admin/options", {"woocommerce_coming_soon": "no"}, method="POST")
check("admin: launch the store (coming soon off)", r["code"] == 200, r)
T = int(time.time())
r = rest(o, "/wc/v3/products", {"name": f"Edge Mug {T}", "type": "simple", "regular_price": "12.50", "status": "publish", "manage_stock": True, "stock_quantity": 20, "description": "A mug, sold from a Cloudflare Worker."})
pid = json.loads(r["body"]).get("id") if r["code"] == 201 else None
check("admin: create a product", pid, r)
plink = json.loads(r["body"]).get("permalink", "") if pid else ""

g = opener()  # a guest
shop = req(g, "/?post_type=product&nocache=1")
check("guest: shop page lists the product", shop["code"] == 200 and f"Edge Mug {T}".encode() in shop["body"], shop)
pp = req(g, "/?p=%s&nocache=1" % pid) if pid else {"code": 0, "body": b""}
if pp["code"] in (301, 302) and pp["h"].get("location"):
    pp = req(g, urllib.parse.urlparse(pp["h"]["location"]).path + "?" + urllib.parse.urlparse(pp["h"]["location"]).query)
check("guest: product page", pp["code"] == 200 and b"12.50" in pp["body"], pp)

cart = req(g, "/?rest_route=/wc/store/v1/cart")
nonce = cart["h"].get("Nonce") if cart["h"] else None
token = cart["h"].get("Cart-Token") if cart["h"] else None
check("guest: Store API cart (nonce and cart token)", cart["code"] == 200 and nonce and token, cart)
H = {"Nonce": nonce or "", "Cart-Token": token or "", "Content-Type": "application/json"}
r = req(g, "/?rest_route=/wc/store/v1/cart/add-item", json.dumps({"id": pid, "quantity": 2}).encode(), H)
body = json.loads(r["body"]) if r["code"] == 201 else {}
check("guest: add 2 to cart", r["code"] == 201 and body.get("items_count") == 2, r, f"total {body.get('totals', {}).get('total_price')}")
r = req(g, "/?rest_route=/wc/store/v1/cart", headers={"Cart-Token": token or ""})
body = json.loads(r["body"]) if r["code"] == 200 else {}
check("guest: cart keeps the items (session in D1)", body.get("items_count") == 2, r)
addr = {"first_name": "Ada", "last_name": "Edge", "address_1": "1 Worker Way", "city": "Austin", "state": "TX", "postcode": "78701", "country": "US", "email": "ada@example.com", "phone": "5555550100"}
r = req(g, "/?rest_route=/wc/store/v1/checkout", json.dumps({"billing_address": addr, "shipping_address": {k: v for k, v in addr.items() if k not in ("email",)}, "payment_method": "cod"}).encode(), H)
order = json.loads(r["body"]) if r["code"] == 200 else {}
check("guest: checkout with cash on delivery", r["code"] == 200 and order.get("order_id"), r, f"order {order.get('order_id')} status {order.get('status')}")
if order.get("order_id"):
    r = rest(o, f"/wc/v3/orders/{order['order_id']}")
    od = json.loads(r["body"]) if r["code"] == 200 else {}
    check("admin: the order is in WooCommerce", r["code"] == 200 and od.get("total") == "25.00", r, f"total {od.get('total')} status {od.get('status')}")
    r = rest(o, f"/wc/v3/products/{pid}")
    check("admin: stock went down by 2", json.loads(r["body"]).get("stock_quantity") == 18, r)
    r = req(o, "/wp-admin/admin.php?page=wc-orders")
    if r["code"] in (301, 302):
        r = req(o, "/wp-admin/edit.php?post_type=shop_order")
    check("admin: orders screen", r["code"] == 200 and str(order["order_id"]).encode() in r["body"], r)
print(f"{results.count(True)} pass, {results.count(False)} fail")
sys.exit(0 if all(results) else 1)
