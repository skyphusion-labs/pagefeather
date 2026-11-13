#!/usr/bin/env python3
"""Gate 2 (#422, #426): the plugin compatibility harness. Target-neutral: it uses what any
WordPress site gives a client (the login form, wp-admin, the REST API), plus the b-dosql
spike endpoint /_evict for the isolate reset. Use it on a THROWAWAY only: it installs,
activates and deactivates plugins and themes, saves their settings and places an order.

    B=https://<throwaway> SPIKE_TOKEN=... ADMIN_USER=... ADMIN_PASSWORD=... \\
      TURNSTILE_TEST_TOKEN=XXXX.DUMMY.TOKEN.XXXX TRACK=I \\
      python3 tests/plugins/gate2.py <phase> [--only a,b] > <label>.jsonl

Phases:
  install   track I: for each item, install it from wp-admin (wordpress.org; if that fails, the
            upload form with the pinned zip), read it back, POST /_evict, read it back again.
  check     after the lead's redeploy (deploy/wfp/site update): is each item still installed?
  function  for each installed item: activate, its admin screens, a settings save, its visible
            job, then deactivate (solo profile: WooCommerce plus this one item).
  fetch     download the pinned zips into the build cache, checked against gate2.txt.
  stack-activate  tier 1 (#422): activate every item of the list and leave it active
            (the one-SEO guard holds).
  report    read JSONL files (and an optional Workers Logs export) and print the matrix, with
            the prediction next to each measurement: gate2.py report run1.jsonl ... [--logs f]
TRACK labels the run: I (installed from wp-admin) or B (built in with PLUGINS=). The default
item list is gate2.txt, with the WooCommerce control item first. GATE2_LIST=tier1.txt (or
tier1-alt.txt) runs tier 1: plain WordPress, no WooCommerce control. STACK=1 keeps every item
active together (the function phase never deactivates). Every request row carries a class
(request_class): operator, login, admin-ajax:<action>, editor-save, admin-page, admin-write,
rest-read, rest-write or front; the report adds a table of the classes.

Every request is recorded as ONE JSON line on stdout, headers only (never a body or a
cookie), as tests/.../measure394.py does (#424). Every write is read back and classed:
  ok/ok         the answer said success and the state changed
  fail/fail     the answer said failure and the state did not change
  fail/changed  the answer said failure, yet the state changed      (a disagreement, #394)
  ok/unchanged  the answer said success, yet the state did not change (a disagreement, #350)
write-loss is counted from x-write-loss on any answer, and from the Workers Logs export."""
import json, os, re, sys, time, urllib.parse, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plugins as P  # noqa: E402  (the Nov 5 suite helpers: admin_get, page_ok, fn_check, ADMIN, BAD)
L = P.L

OUT = sys.stdout
ROWS = []
CTX = {}
RAW = L.req
TRACK = os.environ.get("TRACK", "I")

# ---- recording ---------------------------------------------------------------------------
PERF_KEEP = ("iso", "rt", "rtServed", "boot", "wasm0MiB", "wasm1MiB", "inflates", "inflateKiB", "phpMs")


def hget(r, k):
    h = r.get("h") or {}
    try:
        return h.get(k)
    except AttributeError:
        return None


def ajax_action(path, data):
    """The admin-ajax action, from the query or the form body (never anything else of the body)."""
    m = re.search(r"[?&]action=([A-Za-z0-9_-]{1,64})", path)
    if m:
        return m.group(1)
    if isinstance(data, dict):
        a = data.get("action")
        return a if isinstance(a, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", a) else None
    if isinstance(data, (bytes, bytearray)):
        m = re.search(rb"(?:^|&)action=([A-Za-z0-9_-]{1,64})(?:&|$)", bytes(data[:4096]))
        return m.group(1).decode() if m else None
    return None


def request_class(method, path, data=None):
    """The request class for the admin-container classifier (#422 tier 1). One of:
    operator, login, admin-ajax:<action>, editor-save, admin-page, admin-write, rest-read,
    rest-write, front."""
    m = (method or ("POST" if data is not None else "GET")).upper()
    p = path.split("?")[0]
    route = (re.search(r"rest_route=([^&]+)", path) or [None, None])[1] or (p[len("/wp-json"):] if p.startswith("/wp-json/") else None)
    if p.startswith("/_"):
        return "operator"
    if p == "/wp-login.php":
        return "login"
    if p == "/wp-admin/admin-ajax.php":
        a = ajax_action(path, data)
        if a == "elementor_ajax" and isinstance(data, (dict, bytes, bytearray)) and b"save_builder" in (data if isinstance(data, (bytes, bytearray)) else json.dumps(data).encode()):
            return "editor-save"
        return "admin-ajax:%s" % (a or "unknown")
    if route:
        if m in ("POST", "PUT", "PATCH") and re.match(r"^/wp/v2/(posts|pages)/\d+/?$", urllib.parse.unquote(route)):
            return "editor-save"
        return "rest-read" if m in ("GET", "HEAD") else "rest-write"
    if p.startswith("/wp-admin/"):
        return "admin-page" if m in ("GET", "HEAD") else "admin-write"
    return "front"


def recorded(o, path, data=None, headers=None, method=None, timeout=120):
    r = RAW(o, path, data, headers, method, timeout)
    perf = None
    try:
        perf = json.loads(hget(r, "x-perf")) if hget(r, "x-perf") else None
    except ValueError:
        perf = None
    row = {"t": round(time.time(), 3), "track": TRACK, **CTX, "class": request_class(method, path, data),
           "method": method or ("POST" if data is not None else "GET"), "path": path.split("?")[0],
           "route": (re.search(r"rest_route=([^&]+)", path) or [None, None])[1],
           "code": r.get("code"), "s": r.get("s"), "boot": hget(r, "x-boot"), "wasm": hget(r, "x-wasm-mib"),
           "recycled": hget(r, "x-runtime-recycled"), "writeLoss": hget(r, "x-write-loss"),
           "reset": hget(r, "x-isolate-reset"), "perf": {k: perf.get(k) for k in PERF_KEEP} if perf else None}
    if r.get("err"):
        row["err"] = r["err"]
    # A REST error's own machine code (for example woocommerce_rest_missing_nonce): a short
    # identifier WordPress returns, never the message or any other part of the body.
    if isinstance(r.get("code"), int) and r["code"] >= 400 and (r.get("body") or b"")[:1] == b"{":
        try:
            c = json.loads(r["body"]).get("code")
            if isinstance(c, str) and re.fullmatch(r"[a-z0-9_]{1,64}", c):
                row["errCode"] = c
        except (ValueError, AttributeError):
            pass
    ROWS.append(row)
    OUT.write(json.dumps({"ev": "req", **row}) + "\n")
    OUT.flush()
    return r


def instrument(raw=None):
    """Record every request, including the ones plugins.py's helpers make."""
    global RAW
    if raw is not None:
        RAW = raw
    L.req = recorded


def event(kind, **f):
    row = {"ev": kind, "t": round(time.time(), 3), "track": TRACK, **CTX, **f}
    OUT.write(json.dumps(row) + "\n")
    OUT.flush()
    return row


def classify(answer_ok, changed):
    if answer_ok and changed:
        return "ok/ok"
    if not answer_ok and not changed:
        return "fail/fail"
    return "fail/changed" if changed else "ok/unchanged"


def write(what, answer_ok, changed, **info):
    """Record one write and its read-back class."""
    return event("write", what=what, answer_ok=bool(answer_ok), changed=bool(changed), cls=classify(answer_ok, changed), **info)


# ---- the item list -------------------------------------------------------------------------
CONTROL = {"kind": "control", "slug": "woocommerce", "version": "", "sha": ""}


LIST = os.environ.get("GATE2_LIST")  # tier1.txt, tier1-alt.txt (#422); default gate2.txt
# STACK=1 (tier 1, #422): every item stays active together. The function phase activates and runs
# each one but never deactivates it or restores the previous theme; the stack-activate phase
# activates the whole list first. WooCommerce is the control item of gate2.txt only.
STACK = os.environ.get("STACK") == "1"


def items(path=None, only=None):
    path = path or (os.path.join(HERE, LIST) if LIST else os.path.join(HERE, "gate2.txt"))
    out = [CONTROL] if os.path.basename(path) == "gate2.txt" else []
    for line in open(path):
        if not line.strip() or line.startswith("#"):
            continue
        kind, slug, ver, sha = line.split()[:4]
        out.append({"kind": kind, "slug": slug, "version": ver, "sha": sha})
    if only:
        out = [i for i in out if i["slug"] in only]
    return out


# ---- session -------------------------------------------------------------------------------
def login():
    o = L.opener()
    L.req(o, "/wp-login.php")
    form = {"log": os.environ.get("ADMIN_USER", "admin"), "pwd": os.environ["ADMIN_PASSWORD"], "wp-submit": "Log In",
            "redirect_to": "/wp-admin/", "testcookie": "1"}
    if os.environ.get("TURNSTILE_TEST_TOKEN"):
        form["cf-turnstile-response"] = os.environ["TURNSTILE_TEST_TOKEN"]
    r = L.req(o, "/wp-login.php", form)
    if r["code"] != 302:
        raise RuntimeError("login answered %s" % r["code"])
    n = L.req(o, "/wp-admin/admin-ajax.php?action=rest-nonce")
    o.nonce = (n.get("body") or b"").decode(errors="replace").strip()
    if not re.fullmatch(r"[a-f0-9]{10}", o.nonce):
        raise RuntimeError("no REST nonce (answer %s)" % n["code"])
    return o


def jbody(r):
    try:
        return json.loads(r.get("body") or b"null")
    except ValueError:
        return None


def ok2xx(r):
    return isinstance(r.get("code"), int) and 200 <= r["code"] < 300


# ---- state read-backs ----------------------------------------------------------------------
def plugin_entry(o, slug):
    r = L.rest(o, "/wp/v2/plugins")
    data = jbody(r)
    if not isinstance(data, list):
        raise RuntimeError("plugin list answered %s" % r["code"])
    for p in data:
        if p.get("plugin", "").split("/")[0] == slug:
            return p
    return None


def theme_entry(o, slug):
    r = L.rest(o, "/wp/v2/themes")
    data = jbody(r)
    if not isinstance(data, list):
        raise RuntimeError("theme list answered %s" % r["code"])
    for t in data:
        if t.get("stylesheet") == slug:
            return t
    return None


def present(o, item):
    if item["kind"] == "theme":
        return theme_entry(o, item["slug"]) is not None
    return plugin_entry(o, item["slug"]) is not None


def active(o, item):
    if item["kind"] == "theme":
        t = theme_entry(o, item["slug"])
        return bool(t) and t.get("status") == "active"
    p = plugin_entry(o, item["slug"])
    return bool(p) and p.get("status") == "active"


# ---- install (track I) ---------------------------------------------------------------------
def ajax_nonce(o, page):
    r = L.req(o, page)
    m = re.search(rb'"ajax_nonce":"([a-f0-9]{10})"', r.get("body") or b"")
    return m.group(1).decode() if m else None


def install_wporg(o, item):
    """wp-admin's own install from wordpress.org: the REST route the plugin directory uses for a
    plugin, the admin-ajax install-theme action the theme screen uses for a theme."""
    if item["kind"] == "theme":
        nonce = ajax_nonce(o, "/wp-admin/theme-install.php")
        if not nonce:
            return False, {"via": "ajax install-theme", "why": "no updates nonce on theme-install.php"}
        r = L.req(o, "/wp-admin/admin-ajax.php", {"action": "install-theme", "slug": item["slug"], "_ajax_nonce": nonce})
        b = jbody(r) or {}
        info = {"via": "ajax install-theme", "code": r["code"]}
        d = b.get("data") if isinstance(b, dict) else None
        ec = d.get("errorCode") if isinstance(d, dict) else None
        if isinstance(ec, str) and re.fullmatch(r"[a-z0-9_]{1,64}", ec):
            info["errorCode"] = ec  # admin-ajax answers 200 with success false and a machine code
        em = d.get("errorMessage") if isinstance(d, dict) else None
        if isinstance(em, str):
            info["errorMessage"] = re.sub(r"<[^>]+>", "", em)[:120]  # WordPress core's own text, short
        raw = (r.get("body") or b"").strip()
        if not isinstance(b, dict) and re.fullmatch(rb"-?[0-9]{1,2}", raw or b"x"):
            info["ajaxAnswer"] = raw.decode()  # admin-ajax's bare -1 (bad nonce) or 0 (no handler)
        elif not isinstance(b, dict):
            info["ajaxAnswer"] = "not json (%d bytes)" % len(raw)
        return ok2xx(r) and b.get("success") is True, info
    r = L.rest(o, "/wp/v2/plugins", {"slug": item["slug"]}, "POST")
    return ok2xx(r), {"via": "rest /wp/v2/plugins", "code": r["code"], "error": (jbody(r) or {}).get("code") if not ok2xx(r) else None}


def multipart(fields, file_field, filename, content):
    boundary = "----gate2" + uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, k, v)).encode())
    parts.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\nContent-Type: application/zip\r\n\r\n"
                  % (boundary, file_field, filename)).encode() + content + b"\r\n")
    parts.append(("--%s--\r\n" % boundary).encode())
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


def zip_bytes(item):
    """The pinned zip from the fetch.sh cache, checked against its SHA-256 (or None)."""
    import hashlib
    sub = "themes" if item["kind"] == "theme" else "plugins"
    z = os.path.join(HERE, "../../spikes/b2-wordpress/build/cache", sub, "%s-%s.zip" % (item["slug"], item["version"]))
    if not os.path.isfile(z):
        return None
    data = open(z, "rb").read()
    return data if hashlib.sha256(data).hexdigest() == item["sha"] else None


def install_upload(o, item, data):
    theme = item["kind"] == "theme"
    page = "/wp-admin/theme-install.php?browse=upload" if theme else "/wp-admin/plugin-install.php?tab=upload"
    r = L.req(o, page)
    m = re.search(rb'name="_wpnonce" value="([a-f0-9]{10})"', r.get("body") or b"")
    if not m:
        return False, {"via": "upload form", "why": "no _wpnonce on the upload page", "code": r["code"]}
    body, ctype = multipart({"_wpnonce": m.group(1).decode(), "_wp_http_referer": page},
                            "themezip" if theme else "pluginzip", "%s.zip" % item["slug"], data)
    action = "upload-theme" if theme else "upload-plugin"
    r = L.req(o, "/wp-admin/update.php?action=" + action, body, {"Content-Type": ctype}, "POST", 300)
    done = b"installed successfully" in (r.get("body") or b"")
    return ok2xx(r) and done, {"via": "upload form", "code": r["code"], "bytes": len(data)}


def evict(o):
    r = L.req(o, "/_evict", b"", None, "POST")
    return {"evict": r["code"]}


def phase_install(o, item, state):
    slug = item["slug"]
    if item["kind"] == "control":
        return
    if present(o, item):
        event("step", step="install", ok=None, note="already installed before the run (built in?)")
        state[slug] = {"installed": True, "before": True}
    else:
        ok, info = install_wporg(o, item)
        changed = present(o, item)
        write("install", ok, changed, **info)
        if not changed:
            data = zip_bytes(item)
            if data is None:
                event("step", step="install-upload", ok=None, note="no pinned zip in the cache (run fetch.sh)")
            else:
                ok, info = install_upload(o, item, data)
                changed = present(o, item)
                write("install", ok, changed, **info)
        event("step", step="install", ok=changed)
        state[slug] = {"installed": changed}
    if state[slug]["installed"]:
        info = evict(o)
        # /_evict is a b-dosql (Durable Object) endpoint. On an approach-A site (PHP in the
        # Worker, MySQL through Hyperdrive) it does not exist: the step is "not on this path",
        # never a pass or a fail. A 501 means the object could not abort: "could not measure".
        if info["evict"] in (404, 405):
            event("step", step="reset", ok=None, note="not on this path (no /_evict)", **info)
            return
        if info["evict"] == 501 or not (isinstance(info["evict"], int) and 200 <= info["evict"] < 300):
            event("step", step="reset", ok=None, note="could not measure: /_evict answered %s" % info["evict"], **info)
            return
        after = present(o, item)
        event("step", step="reset", ok=after, **info)
        state[slug]["afterReset"] = after


def phase_check(o, item, state):
    if item["kind"] == "control":
        return
    was = (state.get(item["slug"]) or {}).get("installed")
    now = present(o, item)
    event("step", step="deploy", ok=now if was else None, installedBefore=was, present=now)


# ---- function ------------------------------------------------------------------------------
SCREENS = {
    "woocommerce": ["/wp-admin/edit.php?post_type=product", "/wp-admin/admin.php?page=wc-orders", "/wp-admin/admin.php?page=wc-settings"],
    "advanced-custom-fields": ["/wp-admin/edit.php?post_type=acf-field-group"],
    "astra": ["/wp-admin/themes.php"],
    "storefront": ["/wp-admin/themes.php"],
}
SETTINGS = {
    "woocommerce": "/wp-admin/admin.php?page=wc-settings",
    "wordpress-seo": "/wp-admin/admin.php?page=wpseo_dashboard",
    "contact-form-7": None,
    "wordfence": "/wp-admin/admin.php?page=WordfenceOptions",
    "litespeed-cache": "/wp-admin/admin.php?page=litespeed-general",
    "updraftplus": "/wp-admin/options-general.php?page=updraftplus",
}


def screens_of(slug):
    if slug in SCREENS:
        return SCREENS[slug]
    a = P.ADMIN.get(slug)
    return a if isinstance(a, list) else ([a] if a else [])


FORM_RE = re.compile(rb"<form\b([^>]*)>(.*?)</form>", re.S | re.I)


def form_fields(html):
    """The first POST form on a page, its action and its current field values (unchanged)."""
    for m in FORM_RE.finditer(html or b""):
        attrs, inner = m.group(1), m.group(2)
        if not re.search(rb'method=["\']?post', attrs, re.I):
            continue
        action = (re.search(rb'action=["\']([^"\']*)', attrs) or [None, b""])[1].decode().replace("&amp;", "&")
        f = {}
        for i in re.finditer(rb"<input\b([^>]*)>", inner, re.I):
            a = i.group(1)
            name = re.search(rb'name=["\']([^"\']+)', a)
            if not name:
                continue
            typ = (re.search(rb'type=["\']([^"\']+)', a) or [None, b"text"])[1].lower()
            if typ in (b"checkbox", b"radio") and not re.search(rb"\bchecked\b", a):
                continue
            if typ in (b"file", b"image", b"button"):
                continue
            f[name.group(1).decode()] = (re.search(rb'value=["\']([^"\']*)', a) or [None, b""])[1].decode()
        for t in re.finditer(rb'<textarea\b[^>]*name=["\']([^"\']+)[^>]*>(.*?)</textarea>', inner, re.S | re.I):
            f[t.group(1).decode()] = t.group(2).decode(errors="replace")
        for s in re.finditer(rb'<select\b[^>]*name=["\']([^"\']+)[^>]*>(.*?)</select>', inner, re.S | re.I):
            sel = re.search(rb'<option\b[^>]*value=["\']([^"\']*)["\'][^>]*\bselected', s.group(2))
            if sel:
                f[s.group(1).decode()] = sel.group(1).decode()
        return action, f
    return None, None


def settings_save(o, item):
    """Submit the item's own settings form with its values UNCHANGED. Answer: a redirect or a 200
    page without an error. State: the page reads back the same values. A per-plugin marker value
    is the 10-round matrix's job (deferred)."""
    page = SETTINGS.get(item["slug"], screens_of(item["slug"])[0] if screens_of(item["slug"]) else None)
    if not page:
        return event("step", step="settings", ok=None, note="no settings page in this pass")
    r = P.admin_get(o, page)
    if r.get("code") != 200:
        # The settings page itself did not open: the save cannot be tried, and that is a fail.
        return event("step", step="settings", ok=False, note="the settings page answered %s" % r.get("code"), page=page, **P.code_info(r))
    action, f = form_fields(r.get("body") or b"")
    if f is None:
        return event("step", step="settings", ok=None, note="no POST form on %s" % page, code=r["code"])
    target = action if action.startswith("/") else ("/wp-admin/" + action if action else page)
    s = L.req(o, target or page, f, {"Referer": L.B + page})
    answer_ok = s["code"] in (200, 302) and not any(x in (s.get("body") or b"") for x in P.BAD)
    back = P.admin_get(o, page)
    _, f2 = form_fields(back.get("body") or b"")
    same = f2 is not None and all(f2.get(k) == v for k, v in f.items() if not k.startswith("_"))
    write("settings", answer_ok, same, page=page, fields=len(f), code=s["code"])
    return event("step", step="settings", ok=answer_ok and same)


def theme_activate(o, slug):
    r = L.req(o, "/wp-admin/themes.php")
    b = (r.get("body") or b"").replace(b"\\/", b"/").replace(b"&amp;", b"&")
    m = re.search(rb"themes\.php\?action=activate&stylesheet=" + re.escape(slug.encode()) + rb"&_wpnonce=([a-f0-9]{10})", b)
    if not m:
        return False, {"why": "no activate link for %s" % slug}
    a = L.req(o, "/wp-admin/themes.php?action=activate&stylesheet=%s&_wpnonce=%s" % (slug, m.group(1).decode()))
    return a["code"] in (200, 302), {"code": a["code"]}


def woo_checkout(o):
    anon = L.opener()
    pr = L.req(anon, "/?rest_route=/wc/store/v1/products&per_page=1&stock_status[]=instock")
    items_ = jbody(pr) or []
    if not items_:
        return False, {"why": "no product from the Store API", "code": pr["code"]}
    cart = L.req(anon, "/?rest_route=/wc/store/v1/cart")
    nonce = hget(cart, "Nonce") or hget(cart, "X-WC-Store-API-Nonce") or ""
    h = {"Content-Type": "application/json", "Nonce": nonce}
    if os.environ.get("TURNSTILE_TEST_TOKEN"):
        h["cf-turnstile-response"] = os.environ["TURNSTILE_TEST_TOKEN"]
    add = L.req(anon, "/?rest_route=/wc/store/v1/cart/add-item", json.dumps({"id": items_[0]["id"], "quantity": 1}).encode(), h, "POST")
    addr = {"first_name": "Gate", "last_name": "Two", "address_1": "1 Test St", "city": "Austin", "state": "TX",
            "postcode": "78701", "country": "US", "email": "gate2@example.com", "phone": "5550100"}
    order = {"billing_address": addr, "shipping_address": addr, "payment_method": "cod"}
    if os.environ.get("TURNSTILE_TEST_TOKEN"):
        # The block checkout's Turnstile token rides in the Store API extension data
        # (spikes/b2-wordpress/php/turnstile-forms.php, SKYPHUSION_TURNSTILE_BLOCK_NS).
        order["extensions"] = {"skyphusion-turnstile": {"token": os.environ["TURNSTILE_TEST_TOKEN"]}}
    co = L.req(anon, "/?rest_route=/wc/store/v1/checkout", json.dumps(order).encode(), h, "POST")
    oid = (jbody(co) or {}).get("order_id")
    answer_ok = ok2xx(co) and bool(oid)
    exists = False
    if oid:
        g = L.rest(o, "/wc/v3/orders/%s" % oid)
        exists = ok2xx(g)
    write("order", answer_ok, exists, add=add["code"], checkout=co["code"], order=oid)
    return answer_ok and exists, {"what": "Store API cart and checkout (cash on delivery), then the order exists"}


ELEMENTOR_NONCE_RE = re.compile(rb'"ajax":\{"url":"[^"]*","nonce":"([a-f0-9]{10})"')


def elementor_job(o):
    """Elementor's own path: a new page, its editor, a save through elementor_ajax save_builder
    (one container with one heading carrying a marker), then the page renders the marker inside
    Elementor's markup. The write is read back by the render."""
    marker = "gate2-tier1-" + uuid.uuid4().hex[:10]
    pg = L.rest(o, "/wp/v2/pages", {"title": "Tier 1 Elementor " + marker[-6:], "status": "publish"}, "POST")
    pid = (jbody(pg) or {}).get("id")
    if not pid:
        return False, {"what": "an Elementor page", "why": "the page create answered %s" % pg["code"]}
    ed = L.req(o, "/wp-admin/post.php?post=%d&action=elementor" % pid)
    m = ELEMENTOR_NONCE_RE.search((ed.get("body") or b"").replace(b"\\/", b"/"))
    event("step", step="screen", ok=bool(ed["code"] == 200 and m), page="/wp-admin/post.php?action=elementor", code=ed["code"])
    if not m:
        return False, {"what": "the Elementor editor", "why": "no editor nonce (editor answered %s)" % ed["code"]}
    elements = [{"id": uuid.uuid4().hex[:7], "elType": "container", "settings": {}, "elements": [
        {"id": uuid.uuid4().hex[:7], "elType": "widget", "widgetType": "heading", "settings": {"title": marker}, "elements": []}]}]
    actions = {"save_builder": {"action": "save_builder", "data": {"status": "publish", "elements": elements, "settings": {"post_title": "Tier 1 Elementor"}}}}
    sv = L.req(o, "/wp-admin/admin-ajax.php", {"action": "elementor_ajax", "_nonce": m.group(1).decode(), "editor_post_id": str(pid),
                                               "initial_document_id": str(pid), "actions": json.dumps(actions)})
    b = jbody(sv) or {}
    resp = ((b.get("data") or {}).get("responses") or {}).get("save_builder") if isinstance(b, dict) else None
    answer_ok = ok2xx(sv) and b.get("success") is True and isinstance(resp, dict) and resp.get("success") is True
    fr = L.req(L.opener(), P.nc("/?page_id=%d" % pid))
    body = fr.get("body") or b""
    rendered = fr["code"] == 200 and marker.encode() in body and b"elementor-widget-heading" in body
    write("elementor save", answer_ok, rendered, page=pid, save=sv["code"], render=fr["code"])
    return answer_ok and rendered, {"what": "Elementor: editor, save_builder, the page renders the saved heading"}


def job(o, item):
    slug = item["slug"]
    if slug == "elementor":
        return elementor_job(o)
    if slug == "woocommerce":
        return woo_checkout(o)
    if item["kind"] == "theme":
        anon = L.opener()
        hs = [L.req(anon, P.nc(p)) for p in ("/", "/?post_type=product")]
        mark = ("/wp-content/themes/%s/" % slug).encode()
        return all(h["code"] == 200 and mark in (h.get("body") or b"") for h in hs), {"what": "home and shop render with the theme"}
    if slug in ("wordpress-seo", "seo-by-rank-math", "contact-form-7", "elementor", "wpforms-lite"):
        try:
            return P.fn_check(o, slug)
        except KeyError:
            pass
    return None, {"what": "not in this pass"}


# One SEO plugin per site (Conrad, 2026-11-13: "a normal developer wouldn't do that"). Each is
# tested ALONE. The solo profile deactivates every item after its run, but a run that stopped
# midway can leave one active, so this is checked, never assumed.
SEO = ("wordpress-seo", "seo-by-rank-math")


def active_option(o):
    """The slugs in the active_plugins OPTION (#422), or None when it cannot be read.
    The REST plugin list leaves out a plugin whose files are gone (a build without it), but the
    option keeps it until wp-admin/plugins.php validates the list, and is_plugin_active() reads
    the option. Measured on pft1a, 2026-11-13: the REST list had no Yoast, the option had
    wordpress-seo/wp-seo.php beside Rank Math. Read by the b-dosql spike export /_dbexport
    (SPIKE_TOKEN); any other site gives None and the guard says so."""
    r = L.req(o, "/_dbexport")
    if r.get("code") != 200:
        return None
    for line in (r.get("body") or b"").splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        p = d.get("params") or []
        if "wp_options" in d.get("sql", "") and "active_plugins" in p:
            i = p.index("active_plugins")
            v = p[i + 1] if i + 1 < len(p) else None
            if isinstance(v, str):
                return sorted({m.split("/")[0] for m in re.findall(r's:\d+:"([^"]+)"', v)})
    return None


def other_seo_active(o, slug):
    """The other SEO plugins WordPress counts as active: by the REST list, and by the
    active_plugins option (a plugin with no files is in the option only)."""
    if slug not in SEO:
        return []
    out = []
    for other in SEO:
        if other != slug:
            p = plugin_entry(o, other)
            if p and p.get("status") == "active":
                out.append(other)
    opt = active_option(o)
    if opt is None:
        event("guard", note="active_plugins option not read: the one-SEO guard used the REST list only")
        return out
    for other in SEO:
        if other != slug and other in opt and other not in out:
            out.append(other + " (in the active_plugins option, not in the REST list)")
    return out


def phase_stack_activate(o, item, state):
    """Tier 1 (#422): activate one item of the stack, and leave it active. The one-SEO guard holds."""
    slug = item["slug"]
    if not present(o, item):
        return event("step", step="activate", ok=None, note="not installed: nothing to activate")
    clash = other_seo_active(o, slug)
    if clash:
        return event("step", step="activate", ok=None, refused="another SEO plugin is active: %s" % ",".join(clash))
    if active(o, item):
        return event("step", step="activate", ok=True, note="already active")
    if item["kind"] == "theme":
        ok, info = theme_activate(o, slug)
    else:
        p = plugin_entry(o, slug)
        r = L.rest(o, "/wp/v2/plugins/" + p["plugin"].replace(".php", ""), {"status": "active"}, "POST")
        ok, info = ok2xx(r), {"code": r["code"]}
    now = active(o, item)
    write("activate", ok, now, **info)
    event("step", step="activate", ok=now)


def phase_function(o, item, state):
    slug = item["slug"]
    if item["kind"] != "control" and not present(o, item):
        return event("step", step="function", ok=None, note="not installed: nothing to run")
    clash = other_seo_active(o, slug)
    if clash:
        # Refused, not run: a result on two SEO plugins would not be a result on this one.
        return event("step", step="activate", ok=None, refused="another SEO plugin is active: %s" % ",".join(clash))
    prev_theme = None
    if item["kind"] == "theme":
        cur = [t for t in (jbody(L.rest(o, "/wp/v2/themes?status=active")) or []) if isinstance(t, dict)]
        prev_theme = cur[0]["stylesheet"] if cur else None
        ok, info = theme_activate(o, slug)
        write("activate", ok, active(o, item), **info)
    elif item["kind"] == "plugin" and not active(o, item):
        p = plugin_entry(o, slug)
        r = L.rest(o, "/wp/v2/plugins/" + p["plugin"].replace(".php", ""), {"status": "active"}, "POST")
        write("activate", ok2xx(r), active(o, item), code=r["code"])
    event("step", step="activate", ok=item["kind"] == "control" or active(o, item))
    for path in screens_of(slug):
        r = P.admin_get(o, path)
        event("step", step="screen", ok=P.page_ok(r, admin=True), page=path, **P.code_info(r))
    settings_save(o, item)
    ok, info = job(o, item)
    event("step", step="job", ok=ok, **info)
    if STACK:
        return  # tier 1: the stack stays active together
    if item["kind"] == "plugin":
        p = plugin_entry(o, slug)
        if p and p.get("status") == "active":
            r = L.rest(o, "/wp/v2/plugins/" + p["plugin"].replace(".php", ""), {"status": "inactive"}, "POST")
            write("deactivate", ok2xx(r), not active(o, item), code=r["code"])
    if prev_theme and prev_theme != slug:
        ok, info = theme_activate(o, prev_theme)
        write("restore theme", ok, theme_entry(o, prev_theme) and theme_entry(o, prev_theme).get("status") == "active", theme=prev_theme, **info)


# ---- report --------------------------------------------------------------------------------
# What each item is predicted to do today (#422, design comment, 2026-11-13). A prediction,
# never a result; the report prints the measurement next to it.
PREDICT = {
    ("I", "*"): "install or reset fails (#407; 2 MiB upload body; admin memory #394)",
    ("B", "elementor"): "absent: the bundle with it is 83.84 MiB, over 64 (#293)",
    ("B", "wordpress-seo"): "absent: the bundle with it is 67.94 MiB, over the 62 gate (#293)",
    ("B", "seo-by-rank-math"): "screens or settings flaky: the store goes to 119 MiB (#279)",
    ("B", "contact-form-7"): "job: no mail transport on workers.dev",
    ("B", "wpforms-lite"): "job: no mail transport on workers.dev",
    ("B", "litespeed-cache"): "no harm; its cache is not needed (edge page cache)",
    ("B", "woocommerce"): "screens flaky (#394: dashboard up to 9 of 10 failed)",
}

ORDER = ["install", "reset", "deploy", "activate", "screen", "settings", "job"]


def report(files, logs=None):
    steps, writes, reqs = {}, {}, []
    for fn in files:
        for line in open(fn):
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            key = (ev.get("track"), ev.get("item"))
            if ev.get("ev") == "step":
                steps.setdefault(key, []).append(ev)
            elif ev.get("ev") == "write":
                writes.setdefault(key, []).append(ev)
            elif ev.get("ev") == "req":
                reqs.append(ev)
    out = {"items": [], "totals": {}}
    for key in sorted(set(steps) | set(writes), key=lambda k: (str(k[0]), str(k[1]))):
        st = steps.get(key, [])
        first_fail = next((s["step"] for s in sorted(st, key=lambda s: ORDER.index(s["step"]) if s["step"] in ORDER else 99) if s.get("ok") is False), None)
        ws = writes.get(key, [])
        rq = [r for r in reqs if (r.get("track"), r.get("item")) == key]
        out["items"].append({
            "track": key[0], "item": key[1],
            "firstFail": first_fail, "allPassed": first_fail is None and any(s.get("ok") for s in st),
            "refused": next((s["refused"] for s in st if s.get("refused")), None),
            "predicted": PREDICT.get((key[0], key[1])) or PREDICT.get((key[0], "*")),
            "disagreements": sum(1 for w in ws if w["cls"] in ("fail/changed", "ok/unchanged")),
            "writes": {c: sum(1 for w in ws if w["cls"] == c) for c in ("ok/ok", "fail/fail", "fail/changed", "ok/unchanged")},
            "writeLossHeaders": sum(1 for r in rq if r.get("writeLoss")),
            "resetHeaders": sum(1 for r in rq if r.get("reset")),
            "requests": len(rq),
        })
    classes = {}
    for r in reqs:
        c = r.get("class") or "unknown"
        e = classes.setdefault(c, {"n": 0, "fail": 0, "resets": 0, "writeLoss": 0, "wasm": []})
        e["n"] += 1
        e["fail"] += 1 if (not isinstance(r.get("code"), int) or r["code"] >= 500) else 0
        e["resets"] += 1 if r.get("reset") else 0
        e["writeLoss"] += 1 if r.get("writeLoss") else 0
        if r.get("wasm") not in (None, ""):
            try:
                e["wasm"].append(float(r["wasm"]))
            except ValueError:
                pass
    for c, e in classes.items():
        w = sorted(e.pop("wasm"))
        e["wasmMedian"] = w[len(w) // 2] if w else None
        e["wasmMax"] = w[-1] if w else None
        e["failRate"] = round(e["fail"] / e["n"], 3) if e["n"] else None
    out["classes"] = classes
    out["totals"] = {
        "requests": len(reqs),
        "writeLossHeaders": sum(1 for r in reqs if r.get("writeLoss")),
        "disagreements": sum(i["disagreements"] for i in out["items"]),
    }
    if logs:
        lines = open(logs, errors="replace").read().splitlines()
        out["totals"]["memoryResetLogLines"] = sum(1 for l in lines if "exceeded its memory limit" in l)
        out["totals"]["writeLossLogLines"] = sum(1 for l in lines if "write-loss" in l or "write_loss" in l)
    return out


def fetch(its):
    """Download each pinned zip into the build cache and check its SHA-256 (as fetch.sh does,
    for themes too). Exit 1 on a mismatch; nothing is kept that does not match."""
    import hashlib, urllib.request
    bad = 0
    for it in its:
        if it["kind"] == "control":
            continue
        sub = "themes" if it["kind"] == "theme" else "plugins"
        d = os.path.join(HERE, "../../spikes/b2-wordpress/build/cache", sub)
        os.makedirs(d, exist_ok=True)
        z = os.path.join(d, "%s-%s.zip" % (it["slug"], it["version"]))
        if not os.path.isfile(z):
            url = "https://downloads.wordpress.org/%s/%s.%s.zip" % (sub[:-1], it["slug"], it["version"])
            urllib.request.urlretrieve(url, z + ".part")
            os.replace(z + ".part", z)
        if hashlib.sha256(open(z, "rb").read()).hexdigest() != it["sha"]:
            os.remove(z)
            print("fetch: %s does not match its pinned sha256; removed" % it["slug"], file=sys.stderr)
            bad += 1
    return 1 if bad else 0


# ---- main ----------------------------------------------------------------------------------
def main(argv):
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    phase = argv[0]
    if phase == "fetch":
        return fetch(items(only=argv[argv.index("--only") + 1].split(",") if "--only" in argv else None))
    if phase == "report":
        files = [a for a in argv[1:] if not a.startswith("--")]
        logs = argv[argv.index("--logs") + 1] if "--logs" in argv else None
        files = [f for f in files if f != logs]
        print(json.dumps(report(files, logs), indent=1))
        return 0
    only = argv[argv.index("--only") + 1].split(",") if "--only" in argv else None
    state_file = os.environ.get("GATE2_STATE", "gate2-state.json")
    state = json.load(open(state_file)) if os.path.isfile(state_file) else {}
    instrument()
    o = login()
    fn = {"install": phase_install, "check": phase_check, "function": phase_function, "stack-activate": phase_stack_activate}[phase]
    for item in items(only=only):
        CTX.clear()
        CTX.update({"phase": phase, "item": item["slug"], "kind": item["kind"]})
        try:
            fn(o, item, state)
        except Exception as e:  # a failed item is a result; the run goes on
            event("step", step=phase, ok=False, err=repr(e)[:200])
            try:
                o = login()
            except Exception as e2:
                event("step", step="login", ok=False, err=repr(e2)[:200])
    json.dump(state, open(state_file, "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
