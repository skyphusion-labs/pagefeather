#!/usr/bin/env python3
"""Where a WooCommerce admin request spends its time, one request at a time (#1078, Hyperdrive approach A).

  B=https://<site> ADMIN_PASSWORD=... SPIKE_TOKEN=... [REPS=3] [TURNSTILE_TEST_TOKEN=...] \\
    python3 -I tests/load/admin-timing.py

The admin actions of the slow suite tests (#1078: edit, Quick Edit, Trash, Empty Trash), each as single requests:
the product list and the post list, a product's and a post's edit screen, Quick Edit (admin-ajax inline-save) on
each, and Trash then Empty Trash on a throwaway post. Per request it records the client wall time and the Worker's
own split, from the spike-gated timing headers: x-boot (1 = this request booted PHP), x-php-ms, x-d1-calls and
x-d1-ms (on approach A every MySQL query through Hyperdrive is one bridge call, so these are the query count and
their total round trip), x-runtime-recycled and the isolate. Then the medians per step. Run it on a WooCommerce site
and on its WordPress-only twin to split WooCommerce's cost from placement's. It makes one product and REPS posts,
all deleted at the end. On a site without WooCommerce (/wc/v3 answers 404) the product steps are skipped and said
so, so the WordPress-only twin gives its post numbers. Needs the spike token: it never runs on a visitor's terms.
Exit 1 on a step that answers outside 2xx/3xx.
"""
import json, os, re, statistics, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "spikes", "b2-wordpress", "tests"))
for k in ("B", "ADMIN_PASSWORD", "SPIKE_TOKEN"):
    if not os.environ.get(k):
        sys.exit("admin-timing: set %s" % k)
os.environ.setdefault("PERF_RUN", "at1078")
import break_lib as BL
REPS = int(os.environ.get("REPS", "3"))
o = BL.login()
rows, bad = [], []


def iso_of(h):
    try:
        return json.loads(h.get("x-perf-worker") or "{}").get("iso")
    except Exception:
        return None


def step(name, path, data=None, ok=(200, 302)):
    x = BL.req(o, path, data, timeout=300)
    h = x["h"] or {}
    row = {"step": name, "code": x["code"], "s": x["s"], "boot": h.get("x-boot"), "phpMs": h.get("x-php-ms"), "dbN": h.get("x-d1-calls"),
           "dbMs": h.get("x-d1-ms"), "recycled": h.get("x-runtime-recycled"), "iso": iso_of(h) or h.get("x-isolate"), "id": BL.LAST_ID[0]}
    rows.append(row)
    print(json.dumps(row), flush=True)
    if x["code"] not in ok:
        bad.append(row)
    return x


def text(x):
    return (x["body"] or b"").decode("utf-8", "replace")


def field(body, name):
    m = re.search(r'name="%s"\s+value="([^"]+)"' % re.escape(name), body) or re.search(r'id="%s"\s+name="[^"]*"\s+value="([^"]+)"' % re.escape(name), body)
    return m.group(1) if m else None


def product_steps(rep, prod):
    """The product list, a product's editor, and product Quick Edit."""
    b = text(step("list products", "/wp-admin/edit.php?post_type=product"))
    step("edit product", "/wp-admin/post.php?post=%d&action=edit" % prod)
    qe = {"action": "inline-save", "_inline_edit": field(b, "_inline_edit") or "", "post_ID": prod, "post_type": "product", "screen": "edit-product",
          "post_title": "admin timing product %d" % rep, "post_name": "", "_status": "publish", "edit_date": "", "comment_status": "", "ping_status": ""}
    wq = field(b, "woocommerce_quick_edit_nonce")
    if wq:
        qe.update({"woocommerce_quick_edit": "1", "woocommerce_quick_edit_nonce": wq, "_regular_price": "9.99"})
    step("quick edit product", "/wp-admin/admin-ajax.php", qe)


def post_steps(rep, post):
    """The post list, a post's editor, its Quick Edit, then Trash and Empty Trash. True when the post was emptied."""
    b = text(step("list posts", "/wp-admin/edit.php"))
    step("edit post", "/wp-admin/post.php?post=%d&action=edit" % post)
    step("quick edit post", "/wp-admin/admin-ajax.php", {"action": "inline-save", "_inline_edit": field(b, "_inline_edit") or "", "post_ID": post, "post_type": "post",
                                                          "screen": "edit-post", "post_title": "admin timing post %d" % rep, "post_name": "", "_status": "publish", "edit_date": ""})
    m = re.search(r'post\.php\?post=%d&(?:amp;)?action=trash&(?:amp;)?_wpnonce=([0-9a-f]+)' % post, b)
    if m:
        step("trash post", "/wp-admin/post.php?post=%d&action=trash&_wpnonce=%s" % (post, m.group(1)))
    else:
        print(json.dumps({"step": "trash post", "skipped": "no trash link for the post on the list page"}), flush=True)
    b = text(step("list trash", "/wp-admin/edit.php?post_status=trash&post_type=post"))
    n = field(b, "_wpnonce")
    if n:
        step("empty trash", "/wp-admin/edit.php?post_status=trash&post_type=post&_wpnonce=%s&delete_all=%s" % (n, "Empty+Trash"))
        return True
    return False


r = BL.rest(o, "/wc/v3/products", {"name": "admin timing %d" % time.time(), "type": "simple", "regular_price": "9.99"}, "POST")
prod = None
if r["code"] == 201:
    prod = json.loads(r["body"])["id"]
elif r["code"] == 404:
    print(json.dumps({"skipped": "the product steps: /wc/v3 answered 404, so WooCommerce is not active on this site"}), flush=True)
else:
    sys.exit("admin-timing: making a product answered %s" % r["code"])
made_posts = []
try:
    for rep in range(REPS):
        r = BL.rest(o, "/wp/v2/posts", {"title": "admin timing %d %d" % (time.time(), rep), "status": "publish", "content": "x"}, "POST")
        if r["code"] != 201:
            sys.exit("admin-timing: making a post answered %s" % r["code"])
        post = json.loads(r["body"])["id"]
        made_posts.append(post)
        if prod is not None:
            product_steps(rep, prod)
        if post_steps(rep, post):
            made_posts.remove(post)
finally:
    for p in made_posts:
        BL.rest(o, "/wp/v2/posts/%d?force=true" % p, None, "DELETE")
    if prod is not None:
        BL.rest(o, "/wc/v3/products/%d?force=true" % prod, None, "DELETE")


def med(vals):
    v = [float(x) for x in vals if x not in (None, "")]
    return round(statistics.median(v), 1) if v else None


print("\n%-20s %4s %8s %8s %6s %8s %5s %4s" % ("step", "n", "wall s", "php ms", "dbN", "db ms", "boots", "isos"))
for name in dict.fromkeys(r["step"] for r in rows):
    rs = [r for r in rows if r["step"] == name]
    print("%-20s %4d %8s %8s %6s %8s %5d %4d" % (name, len(rs), med(r["s"] for r in rs), med(r["phpMs"] for r in rs), med(r["dbN"] for r in rs),
                                              med(r["dbMs"] for r in rs), sum(1 for r in rs if r["boot"] == "1"), len({r["iso"] for r in rs})))
if bad:
    print("admin-timing: %d step(s) answered outside 2xx/3xx" % len(bad))
    sys.exit(1)
