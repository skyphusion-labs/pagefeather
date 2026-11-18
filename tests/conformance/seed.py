#!/usr/bin/env python3
"""Seed a conformance throwaway (#759): ALL setup the upstream suites need, then check each item.

The lead's ruling: this seed owns every write to the shared throwaway, and reruns for the reseed between the API
half and the browser half. runner.py (the browser half) only checks. It writes, in order:

  1. permalinks /%postname%/ (Settings > Permalinks, which rebuilds the rewrite rules), and checks that a raw
     GET /wp-json/ is the REST index, not the home page (#760);
  2. blogname "WooCommerce Core E2E Test Suite" (/wp/v2/settings title), and timezone_string America/Detroit
     (the VPS and laptop runners use US Eastern; sales reports group by site day, #759 conf759 2331z);
  3. woocommerce_allow_tracking = yes (/wc/v3/settings/advanced/woocommerce_allow_tracking; read back there and
     at /wc-admin/options). WOO_EXTRAS=off forces it off, so a throwaway must not set that;
  4. the user "customer": role customer, customer@woocommercecoree2etestsuite.com, Jane Smith, a new generated
     password; checked by a form login;
  5. the media items image-01, image-02 and image-03 from WooCommerce's test-data/images at WC_SHA (the files
     image-0N.png), each checked against the upstream git blob sha before upload, found by search after. Upstream's
     image-01.png is a JPEG (its first bytes are FF D8 FF E0), so WordPress stores it as image-01.jpg, on stock too
     (wp_check_filetype_and_ext names a file by its content; WP-CLI's media import goes through the same code). So
     an item is matched by its stem, and seed.json records the name WordPress gave it;
  6. the admin's ACCOUNT password = a new application password (one value passes both the wp-login.php form and
     HTTP Basic on the unmodified suite). Older "conformance-" application passwords are revoked. Checked: the
     form login; Basic on /wp/v2/users/me answers 200 (#761); a wrong password gets 401.

  7. the upstream test plugins prepare-content.sh copied into the build are ACTIVATED over REST (IMPORT_PLUGINS only
     copies them): woocommerce-e2e-test-helper and woocommerce-cleanup. gutenberg-test-plugins stays inactive (the
     Gutenberg specs toggle each one). On a marked throwaway a missing one fails; on a local site without the
     content (SEED_ALLOW_LOCAL=1) it is reported and skipped.

  8. the block editor welcome guide is dismissed (wp_persisted_preferences / REST meta persisted_preferences), so post-new.php opens an interactable canvas (#759, #605).

  9. --theme <slug> (optional): activates that installed theme (the admin's own activation link on themes.php) and
     checks it is the active stylesheet. joan's runner asks twentytwentythree before wc and wc-api: WooCommerce's
     external setup activates it, and the wp and gb global setups switch to twentytwentyone before.

It refuses (exit 2, before any write) a site that is not a throwaway: one whose
GET ?rest_route=/pf-conformance/v1/throwaway does not answer {"throwaway": true, "host": <its own host>} (the
marker mu-plugin from prepare-content.sh). A local wrangler dev site (host localhost or 127.0.0.1) has no
marker; it is accepted only with SEED_ALLOW_LOCAL=1, so the gate fails closed.

  B=<site> ADMIN_PASSWORD=<current admin password> python3 -I tests/conformance/seed.py <out-dir> [--theme <slug>]

  ADMIN_USER (default admin). ADMIN_PASSWORD is the admin's current password: the workspace's on a first seed,
  or the WP_PASSWORD of <out-dir>/creds.env on a reseed (read from there when ADMIN_PASSWORD is unset).
  WC_SHA: the WooCommerce pin (default: tests/conformance/pins.env, else 11.2.1's commit).
  TURNSTILE_TEST_TOKEN: sent as cf-turnstile-response on a login, if set (the throwaway runs TURNSTILE_LOGIN=off).

Writes <out-dir>/creds.env (mode 600; `export` lines, so `. creds.env` hands them to runner.py: WP_USERNAME,
WP_PASSWORD, CUSTOMER_USERNAME, CUSTOMER_PASSWORD) and
<out-dir>/seed.json (every check, no secret). Prints one @event JSON line per step and never a secret.
Exit 0: every item is set and checked. 1: an item failed. 2: refused.
"""
import base64, hashlib, http.cookiejar, json, os, re, secrets, sys, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
B = os.environ.get("B", "").rstrip("/")
OUT = sys.argv[1] if len(sys.argv) > 1 else ""
THEME = sys.argv[sys.argv.index("--theme") + 1] if "--theme" in sys.argv[2:] and sys.argv.index("--theme") + 1 < len(sys.argv) else ""
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
BLOGNAME = "WooCommerce Core E2E Test Suite"
SEED_TIMEZONE = "America/Detroit"
CUSTOMER = {"username": "customer", "email": "customer@woocommercecoree2etestsuite.com", "first_name": "Jane", "last_name": "Smith"}
IMAGES = ("image-01.png", "image-02.png", "image-03.png")
IMG_PATH = "plugins/woocommerce/tests/e2e/test-data/images/"
WC_TAG_SHA = "67e007c3c4cca5725e056ddaaa2ed2fb0e282045"  # woocommerce 11.2.1
UA = {"User-Agent": "pagefeather-conformance-seed"}
TEST_PLUGINS = ("woocommerce-e2e-test-helper/woocommerce-e2e-test-helper", "woocommerce-cleanup/woocommerce-cleanup")
report = {"site": B, "checks": {}}
failed = []


EDITOR_WELCOME_PREFS = {
    "core/edit-post": {"welcomeGuide": False},
    "core/edit-site": {"welcomeGuide": False},
}


def welcome_guide_dismissed(prefs):
    """True when core/edit-post welcomeGuide is false. prefs may be dict or JSON string from REST."""
    if isinstance(prefs, str):
        try:
            prefs = json.loads(prefs)
        except ValueError:
            return False
    if not isinstance(prefs, dict):
        return False
    ep = prefs.get("core/edit-post") or {}
    return ep.get("welcomeGuide") is False



def event(kind, **kw):
    print("@event %s %s" % (kind, json.dumps(kw, sort_keys=True)), flush=True)


def check(name, ok, **detail):
    report["checks"][name] = dict(ok=bool(ok), **detail)
    event("check", name=name, ok=bool(ok), **detail)
    if not ok:
        failed.append(name)
    return ok


def wc_sha():
    if os.environ.get("WC_SHA"):
        return os.environ["WC_SHA"]
    try:
        for line in open(os.path.join(HERE, "pins.env")):
            m = re.match(r"^WC_SHA=([0-9a-f]{40})\s*$", line)
            if m:
                return m.group(1)
    except OSError:
        pass
    return WC_TAG_SHA


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def jar():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect)


def req(o, path, data=None, headers=None, method=None, timeout=120):
    h = dict(UA, **(headers or {}))
    url = path if path.startswith("http") else B + path
    try:
        r = o.open(urllib.request.Request(url, data=data, headers=h, method=method), timeout=timeout)
        return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers
    except Exception as e:  # a network failure is a result, never a pass
        return 0, repr(e).encode(), {}


def js(body):
    try:
        return json.loads(body or b"null")
    except ValueError:
        return None


def rest(o, nonce, route, data=None, method=None):
    q = route.split("?", 1)
    path = "/?rest_route=" + q[0] + ("&" + q[1] if len(q) > 1 else "")
    hd = {"X-WP-Nonce": nonce}
    if data is not None and not isinstance(data, bytes):
        data = json.dumps(data).encode()
        hd["Content-Type"] = "application/json"
    c, b, h = req(o, path, data, hd, method)
    return c, js(b)


def login(user, pw):
    """A form login on a fresh cookie jar. Returns (opener, rest nonce) or (None, why)."""
    o = jar()
    req(o, "/wp-login.php")  # the test cookie
    form = {"log": user, "pwd": pw, "wp-submit": "Log In", "redirect_to": "/wp-admin/", "testcookie": "1"}
    if os.environ.get("TURNSTILE_TEST_TOKEN"):
        form["cf-turnstile-response"] = os.environ["TURNSTILE_TEST_TOKEN"]
    c, b, h = req(o, "/wp-login.php", urllib.parse.urlencode(form).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
    if c not in (302, 303):
        return None, "wp-login.php answered %s, not a redirect" % c
    c, b, _ = req(o, "/wp-admin/admin-ajax.php?action=rest-nonce")
    n = (b or b"").decode("utf-8", "replace").strip()
    if c != 200 or not re.fullmatch(r"[0-9a-f]{10}", n):
        return None, "no REST nonce after the login (%s)" % c
    return o, n


def stem(url):
    return (url or "").rsplit("/", 1)[-1].rsplit(".", 1)[0]


def basic(user, pw, route="/wp/v2/users/me"):
    tok = base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()
    c, _, _ = req(jar(), "/?rest_route=" + route, headers={"Authorization": "Basic " + tok})
    return c


def activation_nonce(page, slug):
    """The _wpnonce of themes.php's activation link for slug, or None. The theme list is rendered from JSON on the
    page, so the link may be plain (&), HTML-escaped (&amp;) or JSON-escaped (\\u0026): match the query string itself.
    Tested in seed-test.py."""
    amp = rb'(?:&|&amp;|\\u0026)'
    m = re.search(rb'action=activate' + amp + rb'stylesheet=' + re.escape(slug.encode()) + amp + rb'_wpnonce=([0-9a-f]+)', page)
    return m.group(1).decode() if m else None

def refuse(why):
    event("refused", why=why)
    sys.stderr.write("seed: refused: %s\n" % why)
    sys.exit(2)


def main():
    if not B or not OUT:
        refuse("usage: B=<site> ADMIN_PASSWORD=... seed.py <out-dir>")
    os.makedirs(OUT, exist_ok=True)
    credsf = os.path.join(OUT, "creds.env")
    old = {}
    if os.path.exists(credsf):
        for line in open(credsf):
            line = line.rstrip("\n")
            if line.startswith("export "):
                line = line[len("export "):]
            if "=" in line:
                k, v = line.split("=", 1)
                old[k] = v
    host = urllib.parse.urlparse(B).hostname or ""
    c, b, _ = req(jar(), "/?rest_route=/pf-conformance/v1/throwaway")
    m = js(b) if c == 200 else None
    local = host in ("localhost", "127.0.0.1") and os.environ.get("SEED_ALLOW_LOCAL") == "1"
    marked = isinstance(m, dict) and m.get("throwaway") is True and m.get("host") == host
    if not (marked or local):
        refuse("%s has no throwaway marker (GET pf-conformance/v1/throwaway answered %s); the seed writes users and passwords" % (host, c))
    report["throwaway"] = "marker" if marked else "localhost"
    pw = os.environ.get("ADMIN_PASSWORD") or old.get("WP_PASSWORD") or ""
    if not pw:
        refuse("no ADMIN_PASSWORD and no creds.env WP_PASSWORD")
    a, n = login(ADMIN_USER, pw)
    if not a:
        refuse("the admin cannot log in through the form: %s" % n)

    # 1. permalinks /%postname%/
    c, b, _ = req(a, "/wp-admin/options-permalink.php")
    wn = re.search(rb'name="_wpnonce" value="([0-9a-f]+)"', b or b"")
    if wn:
        form = {"_wpnonce": wn.group(1).decode(), "_wp_http_referer": "/wp-admin/options-permalink.php", "selection": "/%postname%/",
                "permalink_structure": "/%postname%/", "category_base": "", "tag_base": "", "submit": "Save Changes"}
        req(a, "/wp-admin/options-permalink.php", urllib.parse.urlencode(form).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
    c2, b2, _ = req(jar(), "/wp-json/")
    idx = js(b2)
    check("permalinks: a raw GET /wp-json/ is the REST index", c2 == 200 and isinstance(idx, dict) and "routes" in idx, status=c2)
    c3, posts = rest(a, n, "/wp/v2/posts?per_page=1&status=publish")
    link = posts[0].get("link", "") if isinstance(posts, list) and posts else ""
    check("permalinks: /%postname%/ (a post link has no ?p= and no date)", bool(wn) and bool(link) and "?p=" not in link and not re.search(r"/\d{4}/\d{2}/", link), link=link)

    # 2. blogname
    rest(a, n, "/wp/v2/settings", {"title": BLOGNAME}, "POST")
    c, s = rest(a, n, "/wp/v2/settings")
    check("blogname", isinstance(s, dict) and s.get("title") == BLOGNAME, got=s.get("title") if isinstance(s, dict) else c)

    rest(a, n, "/wp/v2/settings", {"timezone_string": SEED_TIMEZONE}, "POST")
    c, s = rest(a, n, "/wp/v2/settings")
    check("timezone", isinstance(s, dict) and s.get("timezone_string") == SEED_TIMEZONE,
          got=(s.get("timezone_string") if isinstance(s, dict) else c))

    # 3. woocommerce_allow_tracking = yes
    rest(a, n, "/wc/v3/settings/advanced/woocommerce_allow_tracking", {"value": "yes"}, "PUT")
    c, t = rest(a, n, "/wc/v3/settings/advanced/woocommerce_allow_tracking")
    c2, o2 = rest(a, n, "/wc-admin/options?options=woocommerce_allow_tracking")
    check("woocommerce_allow_tracking = yes (wc/v3 settings and wc-admin/options)",
          isinstance(t, dict) and t.get("value") == "yes" and isinstance(o2, dict) and o2.get("woocommerce_allow_tracking") == "yes",
          wcv3=t.get("value") if isinstance(t, dict) else c, wcadmin=o2.get("woocommerce_allow_tracking") if isinstance(o2, dict) else c2)

    # 4. the customer
    cpw = secrets.token_urlsafe(18)
    c, found = rest(a, n, "/wc/v3/customers?email=" + urllib.parse.quote(CUSTOMER["email"]) + "&role=all")
    fields = {"first_name": CUSTOMER["first_name"], "last_name": CUSTOMER["last_name"], "password": cpw}
    if isinstance(found, list) and found:
        cid = found[0].get("id")
        rest(a, n, "/wc/v3/customers/%s" % cid, fields, "PUT")
    else:
        c, r = rest(a, n, "/wc/v3/customers", dict(fields, email=CUSTOMER["email"], username=CUSTOMER["username"]), "POST")
        cid = r.get("id") if isinstance(r, dict) else None
    c, u = rest(a, n, "/wp/v2/users/%s?context=edit" % cid) if cid else (0, None)
    u = u if isinstance(u, dict) else {}
    co, cwhy = login(CUSTOMER["username"], cpw)
    check("customer: role customer, the email, Jane Smith, and a form login",
          u.get("username") == CUSTOMER["username"] and u.get("roles") == ["customer"] and u.get("email") == CUSTOMER["email"]
          and u.get("first_name") == "Jane" and u.get("last_name") == "Smith" and co is not None,
          id=cid, roles=u.get("roles"), login=("ok" if co else cwhy))

    # 5. the three test images, pinned
    sha = wc_sha()
    have, stored = [], {}
    for name in IMAGES:
        st_ = name.rsplit(".", 1)[0]
        c, hits = rest(a, n, "/wp/v2/media?search=%s&per_page=20" % urllib.parse.quote(st_))
        match = [h for h in hits if stem(h.get("source_url")) == st_] if isinstance(hits, list) else []
        if match:
            have.append(name); stored[st_] = match[0]["source_url"].rsplit("/", 1)[-1]
            continue
        c, meta, _ = req(jar(), "https://api.github.com/repos/woocommerce/woocommerce/contents/%s%s?ref=%s" % (IMG_PATH, name, sha), headers={"Accept": "application/vnd.github+json"})
        want = (js(meta) or {}).get("sha") if c == 200 else None
        c, data, _ = req(jar(), "https://raw.githubusercontent.com/woocommerce/woocommerce/%s/%s%s" % (sha, IMG_PATH, name))
        blob = hashlib.sha1(b"blob %d\0" % len(data or b"") + (data or b"")).hexdigest() if c == 200 else None
        if not (want and blob == want):
            check("image %s matches the pin" % name, False, wc_sha=sha, upstream_blob=want, got_blob=blob)
            continue
        c, b, _ = req(a, "/?rest_route=/wp/v2/media", data, {"X-WP-Nonce": n, "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="%s"' % name}, "POST")
        r = js(b)
        if c == 201 and isinstance(r, dict) and stem(r.get("source_url")) == st_:
            have.append(name); stored[st_] = r["source_url"].rsplit("/", 1)[-1]
        else:
            check("image %s uploads under its own stem" % name, False, status=c, source=r.get("source_url") if isinstance(r, dict) else None)
    check("the three test images, found by search under their own stems", sorted(have) == sorted(IMAGES), stored=stored, wc_sha=sha)

    # 6b. dismiss the block editor welcome guide (#759 conf759: it blocks the canvas until closed)
    c, me = rest(a, n, "/wp/v2/users/me?context=edit")
    uid = me.get("id") if isinstance(me, dict) else None
    if uid:
        rest(a, n, "/wp/v2/users/%s" % uid, {"meta": {"persisted_preferences": EDITOR_WELCOME_PREFS}}, "POST")
        c2, me2 = rest(a, n, "/wp/v2/users/me?context=edit")
        prefs = (me2 or {}).get("meta", {}).get("persisted_preferences") if isinstance(me2, dict) else None
        check("block editor: welcome guide dismissed (persisted_preferences)",
              welcome_guide_dismissed(prefs), http=c2, got=type(prefs).__name__)

    # 7. activate the upstream test plugins the build carries (the code lock allows activation)
    c, plist = rest(a, n, "/wp/v2/plugins?context=edit")
    have = {p.get("plugin"): p.get("status") for p in plist} if isinstance(plist, list) else {}
    for pid in TEST_PLUGINS:
        if pid not in have:
            if marked:
                check("test plugin %s is in the build" % pid, False, listed=c)
            else:
                report["checks"]["test plugin %s" % pid] = {"ok": None, "skipped": "not in this build (a local site without the content)"}
                event("skip", name="test plugin %s" % pid, why="not in this build")
            continue
        if have[pid] != "active":
            rest(a, n, "/wp/v2/plugins/%s" % pid, {"status": "active"}, "POST")
        c, st = rest(a, n, "/wp/v2/plugins/%s?context=edit" % pid)
        check("test plugin %s is active" % pid, isinstance(st, dict) and st.get("status") == "active", status=st.get("status") if isinstance(st, dict) else c)
    gb = [k for k, v in have.items() if (k or "").startswith("gutenberg-test-plugins/") and v == "active"]
    if gb:
        check("gutenberg-test-plugins stay inactive (the specs toggle them)", False, active=gb)
    # 8. --theme: activate an installed theme through its own link (the nonce is on themes.php), then read it back
    if THEME:
        if not re.fullmatch(r"[a-z0-9-]{1,64}", THEME):
            check("theme %s: a theme slug" % THEME, False)
        else:
            c, b, _ = req(a, "/wp-admin/themes.php")
            nonce = activation_nonce(b or b"", THEME)
            if nonce:
                req(a, "/wp-admin/themes.php?action=activate&stylesheet=%s&_wpnonce=%s" % (THEME, nonce))
            c, act = rest(a, n, "/wp/v2/themes?status=active")
            active = act[0].get("stylesheet") if isinstance(act, list) and act else None
            check("theme %s is active" % THEME, active == THEME, active=active, link_found=bool(nonce) or "already active or not installed")

    # 6. the admin's account password = a new application password
    c, me = rest(a, n, "/wp/v2/users/me?context=edit")
    uid = me.get("id") if isinstance(me, dict) else None
    c, made = rest(a, n, "/wp/v2/users/%s/application-passwords" % uid, {"name": "conformance-%d" % int(time.time())}, "POST") if uid else (0, None)
    app = made.get("password") if isinstance(made, dict) else None
    if not app:
        check("admin: an application password is made", False, status=c, code=made.get("code") if isinstance(made, dict) else None)
    else:
        newpw = app.replace(" ", "")
        keep = made.get("uuid")
        c, lst = rest(a, n, "/wp/v2/users/%s/application-passwords" % uid)
        revoked = 0
        for p in lst if isinstance(lst, list) else []:
            if (p.get("name") or "").startswith("conformance-") and p.get("uuid") != keep:
                cc, _ = rest(a, n, "/wp/v2/users/%s/application-passwords/%s" % (uid, p["uuid"]), None, "DELETE")
                revoked += 1 if cc == 200 else 0
        c, r = rest(a, n, "/wp/v2/users/%s" % uid, {"password": newpw}, "POST")
        a2, why = login(ADMIN_USER, newpw)
        check("admin: the account password IS the application password (form login)", c == 200 and a2 is not None, set_status=c, login=("ok" if a2 else why), revoked_old=revoked)
        st = basic(ADMIN_USER, newpw)
        check("admin: Basic with it on /wp/v2/users/me answers 200 (#761)", st == 200, status=st)
        wrong = basic(ADMIN_USER, newpw[:-1] + ("x" if newpw[-1] != "x" else "y"))
        check("admin: a wrong password over Basic gets 401", wrong == 401, status=wrong)
        if a2 is not None and not all(re.fullmatch(r"[A-Za-z0-9_-]+", v) for v in (ADMIN_USER, newpw, CUSTOMER["username"], cpw)):
            check("creds.env values are shell-safe ([A-Za-z0-9_-])", False)
        elif a2 is not None:
            fd = os.open(credsf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                # export lines: after `. creds.env` the values reach a child process (runner.py prepare reads os.environ).
                # Every value is [A-Za-z0-9_-] (an application password, a token_urlsafe, a user name): no quoting needed.
                f.write("export WP_USERNAME=%s\nexport WP_PASSWORD=%s\nexport CUSTOMER_USERNAME=%s\nexport CUSTOMER_PASSWORD=%s\n" % (ADMIN_USER, newpw, CUSTOMER["username"], cpw))
            report["creds"] = credsf
    report["failed"] = failed
    with open(os.path.join(OUT, "seed.json"), "w") as f:
        json.dump(report, f, indent=1, sort_keys=True)
    event("done", failed=failed, report=os.path.join(OUT, "seed.json"))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
