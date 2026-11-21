#!/usr/bin/env python3
"""CLEANUP cancels queued order emails for the orders it deletes (#1145). No site.

WooCommerce queues one woocommerce_send_queued_transactional_email action per
order email. load.py CLEANUP deletes the orders it placed. Those actions stay
pending unless CLEANUP cancels them. A later read of the pending list must
show none for the deleted orders.

The stub keeps two actions CLEANUP must not cancel. One is an email for order
500000 (this run starts at order 500, so 500 is a digit prefix of 500000). Its
hook cell also shows the first deleted order id, which is not an argument.
The other is a wc-admin_import_orders action whose text names a deleted order
and the email hook. The email hook is not its hook.

Run: python3 -I tests/load/cleanup-emails-test.py
"""
import json, os, re, subprocess, sys, threading, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

LOAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
HOOK = "woocommerce_send_queued_transactional_email"
lock = threading.Lock()
S = {
    "next_order": 500,
    "next_action": 1000,
    "deleted": [],
    "email_orders": [],
    "bad": [],
    "events": [],
    "actions": {
        66: {"id": 66, "hook": HOOK, "args": "0 => 500000", "status": "pending", "order": 500000},
        88: {
            "id": 88,
            "hook": "wc-admin_import_orders",
            "args": "0 => 500 note " + HOOK,
            "status": "pending",
            "order": 500,
        },
    },
}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", headers=None):
        if isinstance(body, bytes):
            raw = body
        elif isinstance(body, str):
            raw = body.encode()
        else:
            raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(raw)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        n = int(self.headers.get("content-length", 0))
        return self.rfile.read(n) if n else b""

    def route(self):
        q = urllib.parse.urlparse(self.path)
        return q.path, urllib.parse.parse_qs(q.query)

    def do_GET(self):
        path, params = self.route()
        if path == "/wp-login.php":
            return self.send(200, "login", "text/html")
        if path == "/wp-admin/admin-ajax.php":
            return self.send(200, "abcdef0123", "text/plain")
        if path == "/wp-admin/admin.php" and params.get("page") == ["wc-status"] and params.get("tab") == ["action-scheduler"]:
            if params.get("row_action") == ["cancel"]:
                return self.cancel(params)
            return self.listing(params)
        if "rest_route=/wc/store/v1/products" in self.path:
            return self.send(200, [{"id": i, "permalink": "http://s.example/product/p%d/" % i, "is_purchasable": True, "is_in_stock": True} for i in (1, 2)])
        if "rest_route=/wc/store/v1/cart" in self.path:
            return self.send(200, {"items": []}, headers={"Nonce": "n1", "Cart-Token": "t1"})
        if re.search(r"rest_route=/wc/v3/products/\d+", self.path):
            return self.send(200, {"manage_stock": False, "stock_quantity": None})
        if "rest_route=/wp/v2/pages" in self.path:
            return self.send(200, [])
        with lock:
            S["bad"].append("GET " + self.path)
        self.send(404, {})

    def do_POST(self):
        path, params = self.route()
        self.body()
        if path == "/wp-login.php":
            return self.send(302, "", "text/html", {"Set-Cookie": "wordpress_logged_in_x=a; Path=/", "Location": "/wp-admin/"})
        if "rest_route=/wc/store/v1/cart/add-item" in self.path:
            return self.send(201, {})
        if "rest_route=/wc/store/v1/checkout" in self.path:
            with lock:
                oid = S["next_order"]
                S["next_order"] += 1
                # A long second can place hundreds of orders. Queue emails for the
                # first three only, so the paged list stays short and the test still
                # has a next page to follow.
                if len(S["email_orders"]) < 3:
                    self.queue(oid, "woocommerce_order_status_processing")
                    self.queue(oid, "woocommerce_new_order")
                    S["email_orders"].append(oid)
            return self.send(200, {"order_id": oid})
        with lock:
            S["bad"].append("POST " + self.path)
        self.send(404, {})

    def do_DELETE(self):
        m = re.search(r"rest_route=/wc/v3/orders/(\d+)", self.path)
        if m:
            with lock:
                S["deleted"].append(int(m.group(1)))
            return self.send(200, {"deleted": True})
        with lock:
            S["bad"].append("DELETE " + self.path)
        self.send(404, {})

    def queue(self, oid, label):
        aid = S["next_action"]
        S["next_action"] += 1
        S["actions"][aid] = {
            "id": aid,
            "hook": HOOK,
            "args": "0 => '%s', 1 => array ( 0 => %d, )" % (label, oid),
            "status": "pending",
            "order": oid,
        }

    def cancel(self, params):
        try:
            rid = int(params.get("row_id", ["0"])[0])
        except ValueError:
            rid = 0
        nonce = (params.get("nonce") or [""])[0]
        with lock:
            row = S["actions"].get(rid)
            if row is None or nonce != "n%d" % rid or row["status"] != "pending":
                S["bad"].append("cancel %s" % self.path)
                ok = False
            else:
                row["status"] = "canceled"
                S["events"].append(("cancel", rid))
                ok = True
        if not ok:
            return self.send(404, {})
        return self.send(302, "", "text/html", {"Location": "/wp-admin/admin.php?page=wc-status&tab=action-scheduler"})

    def listing(self, params):
        s = (params.get("s") or [""])[0]
        try:
            paged = max(1, int((params.get("paged") or ["1"])[0]))
        except ValueError:
            paged = 1
        with lock:
            S["events"].append(("list", paged))
            deleted = list(S["deleted"])
            pairs = sorted(
                ((aid, row) for aid, row in S["actions"].items() if row["status"] == "pending" and (not s or s in row["hook"] or s in row["args"])),
                key=lambda item: item[0],
            )
            decoy = str(min(deleted)) if deleted else "0"
            one = pairs[paged - 1:paged]
            more = paged < len(pairs)
        html = ["<h1>Scheduled Actions</h1><form id=\"action-scheduler-filter\"><table>"]
        for aid, row in one:
            shown = decoy if aid == 66 and deleted else str(aid)
            href = "/wp-admin/admin.php?page=wc-status&#038;tab=action-scheduler&#038;row_action=cancel&#038;row_id=%d&#038;nonce=n%d" % (aid, aid)
            html.append(
                "<tr><td class=\"hook column-hook\">%s<br><small>ID: %s</small>"
                "<div class=\"row-actions\"><span class=\"cancel\"><a href=\"%s\">Cancel</a></span></div></td>"
                "<td class=\"args column-args\"><ul><li><code>%s</code></li></ul></td></tr>"
                % (row["hook"], shown, href, row["args"])
            )
        html.append("</table></form>")
        if more:
            nxt = "/wp-admin/admin.php?page=wc-status&#038;tab=action-scheduler&#038;status=pending&#038;s=%s&#038;paged=%d" % (urllib.parse.quote(s), paged + 1)
            html.append('<a class="next-page button" href="%s">Next</a>' % nxt)
        self.send(200, "".join(html), "text/html")


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "B": "http://127.0.0.1:%d" % srv.server_address[1],
    "WOO": "1",
    "SETUP": "0",
    "LEVELS": "1",
    "SECONDS": "2",
    "BUYERS": "1",
    "ADMINS": "0",
    "CLEANUP": "1",
    "ADMIN_PASSWORD": "pw-" + "q" * 10,
    "LOAD_MODE": "cached",
}
p = subprocess.run([sys.executable, "-I", LOAD], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=180)
srv.shutdown()
fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(name)
        print("FAIL", name, str(detail)[:400])


lines = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
summary = lines[-1] if lines else {}
cl = summary.get("cleanup") or {}
with lock:
    deleted = set(S["deleted"])
    email_orders = list(S["email_orders"])
    pending_left = [
        (aid, row["order"], row["hook"])
        for aid, row in S["actions"].items()
        if row["status"] == "pending" and row["hook"] == HOOK and row["order"] in deleted
    ]
    canceled = [aid for aid, row in S["actions"].items() if row["status"] == "canceled"]
    events = list(S["events"])
    bad = list(S["bad"])

check("load.py ran", p.returncode == 0, p.stderr[-400:])
check("no unknown request", not bad, bad[:3])
check("the run deleted at least one order", len(deleted) > 0, deleted)
check("emails were queued for three orders", len(email_orders) == 3, email_orders)
check("those orders were deleted", set(email_orders) <= deleted, (email_orders, sorted(deleted)[:8]))
check("order 500000 was not an order this run placed", 500000 not in deleted, sorted(deleted)[:8])
check("no pending email remains for a deleted order", not pending_left, pending_left[:5])
check("the other order's email is still pending", S["actions"][66]["status"] == "pending", S["actions"][66]["status"])
check("an import action that names a deleted order is still pending", S["actions"][88]["status"] == "pending", S["actions"][88]["status"])
check("every cancel is an email for a deleted order", all(S["actions"][aid]["hook"] == HOOK and S["actions"][aid]["order"] in deleted for aid in canceled), canceled[:8])
check("two emails were canceled per emailed order", len(canceled) == 2 * len(email_orders), (len(canceled), email_orders))
cancel_at = [i for i, ev in enumerate(events) if ev[0] == "cancel"]
list_at = [i for i, ev in enumerate(events) if ev[0] == "list"]
check("a later read of the list follows the last cancel", bool(cancel_at) and bool(list_at) and max(list_at) > max(cancel_at), (cancel_at[-3:], list_at[-3:]))
check("the summary says 0 pending emails for the deleted orders", cl.get("emails_still_pending") == 0, cl)
check("the summary counts each canceled email", cl.get("emails_canceled") == 2 * len(email_orders), cl)
if fails:
    print("%d FAILED" % len(fails))
    sys.exit(1)
print("cleanup-emails-test: all pass")
