#!/usr/bin/env python3
"""Seed a conformance throwaway (#759): ALL setup the upstream suites need, then check each item.

The lead's ruling: this seed owns every write to the shared throwaway, and reruns for the reseed between the API
half and the browser half. runner.py (the browser half) only checks. It writes, in order:

  1. permalinks /%postname%/ (Settings > Permalinks, which rebuilds the rewrite rules), and checks that a raw
     GET /wp-json/ is the REST index, not the home page (#760).
     When no published post exists, the seed publishes "Permalink probe" so the link check can run.
  1b. the four WooCommerce pages (shop, cart, checkout, my-account). A dead page id
     makes /cart/ and /checkout/ a 404, and a checkout link lands on the home page (#936).
     The seed runs the WooCommerce install_pages tool when a page is missing, then checks the link.
  2. blogname "WooCommerce Core E2E Test Suite" (/wp/v2/settings title), and timezone America/Detroit (settings key timezone, or timezone_string on older WordPress; INSTALL sets this at /_install, #894; the seed sets it again on a remount);
     SEED_ADMIN_EMAIL=<address> (optional) also sets the site admin_email AND the admin user's email, before any
     password write, so a "password changed" notice reaches that inbox (#1065, #1285).
  3. woocommerce_allow_tracking = yes (/wc/v3/settings/advanced/woocommerce_allow_tracking; read back there and
     at /wc-admin/options). WOO_EXTRAS=off forces it off, so a throwaway must not set that;
  3b. woocommerce_feature_block_email_editor_enabled = no.
     WooCommerce 11.2.1 defaults this feature to no.
     Install stores that default with add_option, so a stored yes stays.
     The email editor spec checks the box and saves.
     A box that is already on leaves Save disabled (#916).
     The seed writes no and reads it back on wc/v3 settings.
     Woo 11.2.1 does not list this option on wc-admin/options.
     That route answers 403 woocommerce_rest_cannot_view.
     The seed skips that 403 only after wc/v3 returns no.
  4. the user "customer": role customer, customer@woocommercecoree2etestsuite.com, Jane Smith, a new generated
     password; checked by a form login;
  5. the media items image-01, image-02 and image-03 from WooCommerce's test-data/images at WC_SHA (the files
     image-0N.png), each checked against the upstream git blob sha before upload, found by search after. Upstream's
     image-01.png is a JPEG (its first bytes are FF D8 FF E0), so WordPress stores it as image-01.jpg, on stock too
     (wp_check_filetype_and_ext names a file by its content; WP-CLI's media import goes through the same code). So
     an item is matched by its stem, and seed.json records the name WordPress gave it. A found item whose full file
     or any sub-size file does not answer 200 is deleted and uploaded again (woocommerce-cleanup's reset deletes the
     sub-size files);
  6. the admin's ACCOUNT password = a new application password (one value passes both the wp-login.php form and
     HTTP Basic on the unmodified suite). Older "conformance-" application passwords are revoked. After the
     password write, the first form login can get rest-nonce HTTP 500; the seed retries (#924). Checked: the
     form login; Basic on /wp/v2/users/me answers 200 (#761); a wrong password gets 401.

  7. the upstream test plugins prepare-content.sh copied into the build are ACTIVATED over REST (IMPORT_PLUGINS only
     copies them): woocommerce-e2e-test-helper, woocommerce-cleanup, wp-mail-logging, and wc-email-template-sync-test-helper. gutenberg-test-plugins stays inactive (the
     Gutenberg specs toggle each one). On a marked throwaway a missing one fails; on a local site without the
     content (SEED_ALLOW_LOCAL=1) it is reported and skipped.

  8. the block editor welcome guide is dismissed (wp_persisted_preferences / REST meta persisted_preferences), so post-new.php opens an interactable canvas (#759, #605).

  0. SEED_RESET_STORE=1 (the wc and wc-api seeds): before item 1, restore Basic with a new
     application password, then reset the store with GET wc-cleanup/v1/reset. A wp run's
     revoke-all spec deletes every application password. The form login still works. Basic
     with the creds password is 401 (#1151). The reset uses the new password, on a marked
     throwaway only, and is recorded as store_reset in seed.json. As soon as the reset
     answers, success or failure, the seed revokes that password
     (DELETE /wp/v2/users/<id>/application-passwords/<uuid>). If the revoke fails, the seed
     stops and says so. The password is not left on the site.
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
# SEED_ADMIN_EMAIL (optional, #1065, #1285): the throwaway's admin addresses, the site's admin_email AND the admin
# user's own email, set before the seed writes any password. WordPress sends "password changed" to the USER's email,
# not to admin_email, so both are needed for that notice to reach the allowed inbox (the second line behind
# MAIL_ALLOWED_TO).
ADMIN_EMAIL = os.environ.get("SEED_ADMIN_EMAIL", "").strip()
RESET_STORE = os.environ.get("SEED_RESET_STORE") == "1"
CUSTOMER = {"username": "customer", "email": "customer@woocommercecoree2etestsuite.com", "first_name": "Jane", "last_name": "Smith"}
IMAGES = ("image-01.png", "image-02.png", "image-03.png")
IMG_PATH = "plugins/woocommerce/tests/e2e/test-data/images/"
# Where the pinned test images come from. The defaults are GitHub; seed-test.py points both at its stub, so the test
# never depends on the network (an unauthenticated API call is rate limited on a shared CI runner: a flaky gate).
GH_API = os.environ.get("SEED_GH_API", "https://api.github.com").rstrip("/")
GH_RAW = os.environ.get("SEED_GH_RAW", "https://raw.githubusercontent.com").rstrip("/")
WC_TAG_SHA = "67e007c3c4cca5725e056ddaaa2ed2fb0e282045"  # woocommerce 11.2.1
UA = {"User-Agent": "pagefeather-conformance-seed"}
TEST_PLUGINS = ("woocommerce-e2e-test-helper/woocommerce-e2e-test-helper", "woocommerce-cleanup/woocommerce-cleanup", "wp-mail-logging/wp-mail-logging", "wc-email-template-sync-test-helper/wc-email-template-sync-test-helper")
NO_WOO = os.environ.get("SEED_NO_WOO") == "1"
WOO = True
report = {"site": B, "checks": {}, "no_woo": NO_WOO}
failed = []


EDITOR_WELCOME_PREFS = {
    "core/edit-post": {"welcomeGuide": False},
    "core/edit-site": {"welcomeGuide": False},
}


def skip_woo(name):
    report["checks"][name] = {"ok": None, "skipped": "SEED_NO_WOO=1: this site carries no WooCommerce"}
    event("skip", name=name, why="SEED_NO_WOO=1")


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




WC_STORE_PAGES = (
    ("products", "woocommerce_shop_page_id", "shop"),
    ("advanced", "woocommerce_cart_page_id", "cart"),
    ("advanced", "woocommerce_checkout_page_id", "checkout"),
    ("advanced", "woocommerce_myaccount_page_id", "my-account"),
)


def wc_store_page_ok(option_value, page, slug):
    """True when the option names this published page and the link path ends in the slug."""
    try:
        oid = int(option_value)
    except (TypeError, ValueError):
        return False
    if oid <= 0 or not isinstance(page, dict):
        return False
    if page.get("id") != oid or page.get("status") != "publish" or page.get("slug") != slug:
        return False
    path = urllib.parse.urlparse(page.get("link") or "").path
    return path.rstrip("/").rsplit("/", 1)[-1] == slug


def wc_store_pages_missing(rows):
    """Slugs whose option does not name a live page. rows are (option value, page, slug)."""
    return [slug for val, page, slug in rows if not wc_store_page_ok(val, page, slug)]


def fetch_wc_store_pages(rest_call):
    """Read the four WooCommerce page options and the page each id names."""
    rows = []
    for group, opt, slug in WC_STORE_PAGES:
        _c, setting = rest_call("/wc/v3/settings/%s/%s" % (group, opt))
        val = setting.get("value") if isinstance(setting, dict) else None
        page = None
        try:
            pid = int(val)
        except (TypeError, ValueError):
            pid = 0
        if pid > 0:
            _c2, got = rest_call("/wp/v2/pages/%d" % pid)
            if isinstance(got, dict) and got.get("id") == pid:
                page = got
        rows.append((val, page, slug))
    return rows



def wc_public_page_ok(slug, status, location):
    """True when the public URL is the page. An empty cart makes /checkout/ redirect to /cart/."""
    if slug != "checkout":
        return status == 200
    if status == 200:
        return True
    if status not in (301, 302, 303, 307, 308):
        return False
    path = urllib.parse.urlparse(location or "").path.rstrip("/")
    return path in ("/cart", "/checkout")


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
        record_network_error(method or ("POST" if data is not None else "GET"), url, e)
        return 0, repr(e).encode(), {}


def record_network_error(method, url, e):
    """A request that got no HTTP answer (status 0) is evidence: seed.json network_errors keeps its exception text,
    so a transient platform fault can be classified (sb1120: a raw GET /wp-json/ with status 0 on cf759a). No response
    exists, so there is no x-pf-call; the time and the path let Workers Logs find it. Query values are scrubbed."""
    path = url[len(B):] if url.startswith(B) else url
    path = re.sub(r"=([^&]*)", "=_", path)
    row = {"t": time.strftime("%H:%M:%SZ", time.gmtime()), "method": method, "path": path[:160],
           "error": scrub(repr(e)[:300])}
    report.setdefault("network_errors", []).append(row)
    event("network-error", **row)



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
        record_nonce_failure(user, pw, c, b, h, step="wp-login")
        return None, "wp-login.php answered %s, not a redirect" % c
    c, b, h = req(o, "/wp-admin/admin-ajax.php?action=rest-nonce")
    n = (b or b"").decode("utf-8", "replace").strip()
    if c != 200 or not re.fullmatch(r"[0-9a-f]{10}", n):
        record_nonce_failure(user, pw, c, b, h)
        return None, "no REST nonce after the login (%s)" % c
    return o, n


NONCE_HEADERS = ("x-pf-call", "x-wasm-mib", "x-isolate-reset", "x-write-loss", "x-sql-failure")


def scrub(text, secrets_=()):
    """text with each given secret, and anything shaped like a nonce or a token (10+ hex, 20+ base64-ish), removed."""
    for sec in secrets_:
        if sec:
            text = text.replace(sec, "[secret]")
    text = re.sub(r"\b[0-9a-f]{10,}\b", "[hex]", text)
    return re.sub(r"[A-Za-z0-9+/_-]{20,}={0,2}", "[token]", text)


def record_nonce_failure(user, pw, status, body, headers, step="rest-nonce"):
    """#924: every failed form login attempt, admin retries included, becomes evidence in seed.json: a POST
    wp-login.php that is not a redirect (step wp-login) or a rest-nonce that is not a nonce (step rest-nonce). On
    cf759a (2026-11-22) a retry left login_attempts 2 and no row, because only the rest-nonce step recorded."""
    row = {"who": user, "step": step, "status": status, "body": scrub((body or b"")[:200].decode("utf-8", "replace"), (pw,))}
    for k in NONCE_HEADERS:
        v = headers.get(k) if headers else None
        if v:
            row[k] = v
    report.setdefault("rest_nonce_failures", []).append(row)
    event("rest-nonce-failed", **row)


def stem(url):
    return (url or "").rsplit("/", 1)[-1].rsplit(".", 1)[0]

def image_files_missing(item, get=None):
    """The file names of a media item (the full file and each sub-size) that do not answer 200 to a guest GET."""
    get = get or (lambda url: req(jar(), url)[0])
    src = (item or {}).get("source_url") or ""
    base = src.rsplit("/", 1)[0]
    names = [src.rsplit("/", 1)[-1]] if src else []
    for v in (((item or {}).get("media_details") or {}).get("sizes") or {}).values():
        f = (v or {}).get("file")
        if f and f not in names:
            names.append(f)
    return [f for f in names if get(base + "/" + f) != 200]


def basic(user, pw, route="/wp/v2/users/me"):
    tok = base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()
    c, _, _ = req(jar(), "/?rest_route=" + route, headers={"Authorization": "Basic " + tok})
    return c


def fresh_application_password(opener, nonce):
    """A new application password for this logged-in admin.

    Returns (user id, uuid, password). The password has its spaces removed. The
    uuid is the one the POST response returned. A missing piece is None. The
    caller revokes that uuid as soon as the store reset answers (#1151).

    A wp suite revoke-all deletes every application password. The account password
    still passes the form. Basic with it answers 401 until a new one exists.
    """
    _c, me = rest(opener, nonce, "/wp/v2/users/me?context=edit")
    uid = me.get("id") if isinstance(me, dict) else None
    if not uid:
        return None, None, None
    _c, made = rest(opener, nonce, "/wp/v2/users/%s/application-passwords" % uid,
                    {"name": "conformance-reset-%d" % int(time.time())}, "POST")
    if not isinstance(made, dict):
        return None, None, None
    app = made.get("password")
    uuid = made.get("uuid")
    if not isinstance(app, str) or not app:
        return None, None, None
    pw = app.replace(" ", "")
    if not isinstance(uuid, str) or not uuid:
        return uid, None, pw
    return uid, uuid, pw



def first_published_link(posts):
    """The link of the first REST post, or empty when the list has no post."""
    if isinstance(posts, list) and posts and isinstance(posts[0], dict):
        return posts[0].get("link") or ""
    return ""




def settings_timezone(settings):
    """Site timezone from /wp/v2/settings. Prefer timezone; accept timezone_string."""
    if not isinstance(settings, dict):
        return ""
    return settings.get("timezone") or settings.get("timezone_string") or ""


EMAIL_EDITOR_OPT = "woocommerce_feature_block_email_editor_enabled"
WC_ADMIN_CANNOT_VIEW = "woocommerce_rest_cannot_view"


def email_editor_option_ok(wcv3, wcadmin_status, wcadmin_body):
    """True when wc/v3 settings advanced is no.

    Woo 11.2.1 does not list this option on wc-admin/options.
    That route answers 403 woocommerce_rest_cannot_view.
    Skip that 403 only after wc/v3 is no.
    Any other wc-admin answer must also be no.
    """
    if not (isinstance(wcv3, dict) and wcv3.get("value") == "no"):
        return False
    hidden = (
        wcadmin_status == 403
        and isinstance(wcadmin_body, dict)
        and wcadmin_body.get("code") == WC_ADMIN_CANNOT_VIEW
    )
    if hidden:
        return True
    return isinstance(wcadmin_body, dict) and wcadmin_body.get(EMAIL_EDITOR_OPT) == "no"


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


def halt(why):
    """Stop the seed after a write. Exit 1. why is the operator message, and it holds no secret."""
    check("seed stopped", False, why=why)
    sys.stderr.write("seed: %s\n" % why)
    report["failed"] = failed
    with open(os.path.join(OUT, "seed.json"), "w") as f:
        json.dump(report, f, indent=1, sort_keys=True)
    event("done", failed=failed, report=os.path.join(OUT, "seed.json"))
    sys.exit(1)


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

    # 0. SEED_RESET_STORE=1 (the wc and wc-api seeds): reset the store before any content step, as upstream's
    # "reset" project does before its setup (fixtures/reset.setup.ts: GET wc-cleanup/v1/reset). Without it the
    # store grows run after run (cf759hl, 2026-11-20: 26 leftover products made WooCommerce's result count a
    # second role=alert, 6 strict-mode failures). Only on a marked throwaway: the reset deletes every order,
    # product, coupon, term and media file.
    # The route checks Authorization: Basic itself (wp_authenticate, then manage_woocommerce). A cookie session
    # gets 403 (measured on cf759p). A wp run's revoke-all spec deletes every application password. The account
    # password from creds.env still passes the form, and Basic with it answers 401 (#1151). Mint a new
    # application password on this form session, then send that. Do not send the creds password.
    # Keep the uuid from that POST. As soon as the reset answers, success or failure, revoke it.
    # If the revoke fails, stop. A live credential must not be left in silence.
    if RESET_STORE:
        if not marked:
            refuse("SEED_RESET_STORE=1 needs the throwaway marker (a local site without it is never reset)")
        uid, fresh_uuid, fresh = fresh_application_password(a, n)
        t0 = time.time()
        c = 0
        try:
            if fresh and fresh_uuid:
                tok = base64.b64encode(("%s:%s" % (ADMIN_USER, fresh)).encode()).decode()
                c, _b, _h = req(jar(), "/?rest_route=/wc-cleanup/v1/reset", headers={"Authorization": "Basic " + tok})
            check("store reset first (SEED_RESET_STORE, wc-cleanup/v1/reset)", c == 200, status=c, s=round(time.time() - t0, 1))
            report["store_reset"] = {"status": c, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        finally:
            if fresh_uuid:
                rc, _gone = rest(a, n, "/wp/v2/users/%s/application-passwords/%s" % (uid, fresh_uuid), None, "DELETE")
                if rc != 200:
                    # #1151: name no field of the application-password response here (CodeQL py/clear-text-logging-sensitive-data):
                    # the uuid comes from the object that holds the password. The HTTP status is enough to act on.
                    # The name prefix is our own (fresh_application_password), never a response field.
                    halt("the application password minted for the store reset is still on the site (its DELETE answered %s). Revoke the one named conformance-reset-<time> in Users > Profile > Application Passwords. The seed is stopping." % rc)
            elif fresh:
                halt("the application password minted for the store reset came back with no uuid, so it was not revoked. The seed is stopping.")

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
    # SEED_NO_WOO=1 states that this site carries no WooCommerce (a WordPress-only tier, e.g. Workers Free). Then the
    # WooCommerce items are reported as skipped, never as passed. The statement must match the site: wc/v3 absent.
    # Without it, a site with no wc/v3 fails the WooCommerce items as before.
    woo_here = isinstance(idx, dict) and "wc/v3" in (idx.get("namespaces") or [])
    global WOO
    WOO = not NO_WOO
    if NO_WOO:
        check("SEED_NO_WOO=1: the site has no WooCommerce (no wc/v3 namespace)", not woo_here, wc_v3=woo_here)
    c3, posts = rest(a, n, "/wp/v2/posts?per_page=1&status=publish")
    made = None
    if not first_published_link(posts):
        # Another suite can delete every post. This check needs one published post.
        made, created = rest(a, n, "/wp/v2/posts", {"title": "Permalink probe", "status": "publish", "slug": "permalink-probe"}, "POST")
        if isinstance(created, dict) and created.get("link"):
            posts = [created]
        else:
            c3, posts = rest(a, n, "/wp/v2/posts?per_page=1&status=publish")
    link = first_published_link(posts)
    detail = {"link": link}
    if made is not None:
        detail["probe_status"] = made
    check("permalinks: /%postname%/ (a post link has no ?p= and no date)", bool(wn) and bool(link) and "?p=" not in link and not re.search(r"/\d{4}/\d{2}/", link), **detail)

    if WOO:
        # 1b. Shop, cart, checkout, and my account. A dead page id sends those links to the home page (#936).
        def rest_get(route):
            return rest(a, n, route)

        page_rows = fetch_wc_store_pages(rest_get)
        missing = wc_store_pages_missing(page_rows)
        tool_status = None
        if missing:
            tool_status, _tool = rest(a, n, "/wc/v3/system_status/tools/install_pages", {}, "PUT")
            page_rows = fetch_wc_store_pages(rest_get)
            missing = wc_store_pages_missing(page_rows)
        check("woocommerce pages: shop, cart, checkout, and my-account name a published page", not missing, missing=missing, tool=tool_status)
        public = {}
        public_ok = True
        for slug in ("shop", "cart", "checkout", "my-account"):
            status, _body, headers = req(jar(), "/%s/" % slug)
            loc = ""
            if headers:
                loc = headers.get("Location") or headers.get("location") or ""
            public[slug] = status
            if not wc_public_page_ok(slug, status, loc):
                public_ok = False
        check("woocommerce pages: /shop/ /cart/ /my-account/ answer 200, and /checkout/ is the store", public_ok, status=public)
    else:
        skip_woo('1b. the WooCommerce store pages')

    # 2. blogname, then site timezone. INSTALL sets America/Detroit at /_install (#894).
    # The seed sets it again so a remount of an old site matches.
    rest(a, n, "/wp/v2/settings", {"title": BLOGNAME}, "POST")
    c, s = rest(a, n, "/wp/v2/settings")
    check("blogname", isinstance(s, dict) and s.get("title") == BLOGNAME, got=s.get("title") if isinstance(s, dict) else c)

    # WP settings REST exposes timezone (measured on cf759a 2026-11-18). Older
    # WordPress used timezone_string. POST either; read whichever is present.
    rest(a, n, "/wp/v2/settings", {"timezone_string": SEED_TIMEZONE, "timezone": SEED_TIMEZONE}, "POST")
    c, s = rest(a, n, "/wp/v2/settings")
    got_tz = settings_timezone(s)
    check("timezone", got_tz == SEED_TIMEZONE, got=got_tz or c)

    # 2b. SEED_ADMIN_EMAIL: both admin addresses, written and read back, BEFORE any password write (the customer in
    # step 4, the admin's own below). On every path, the store reset or not, so a password-only reseed has it too.
    if ADMIN_EMAIL:
        rest(a, n, "/wp/v2/settings", {"email": ADMIN_EMAIL}, "POST")
        rest(a, n, "/wp/v2/users/me", {"email": ADMIN_EMAIL}, "POST")
        c, s = rest(a, n, "/wp/v2/settings")
        site_email = s.get("email") if isinstance(s, dict) else None
        c2, me = rest(a, n, "/wp/v2/users/me?context=edit")
        user_email = me.get("email") if isinstance(me, dict) else None
        check("admin email (SEED_ADMIN_EMAIL): the site admin_email and the admin user's email",
              site_email == ADMIN_EMAIL and user_email == ADMIN_EMAIL,
              site=site_email if site_email else c, user=user_email if user_email else c2)

    if WOO:
        # 3. woocommerce_allow_tracking = yes
        rest(a, n, "/wc/v3/settings/advanced/woocommerce_allow_tracking", {"value": "yes"}, "PUT")
        c, t = rest(a, n, "/wc/v3/settings/advanced/woocommerce_allow_tracking")
        c2, o2 = rest(a, n, "/wc-admin/options?options=woocommerce_allow_tracking")
        check("woocommerce_allow_tracking = yes (wc/v3 settings and wc-admin/options)",
              isinstance(t, dict) and t.get("value") == "yes" and isinstance(o2, dict) and o2.get("woocommerce_allow_tracking") == "yes",
              wcv3=t.get("value") if isinstance(t, dict) else c, wcadmin=o2.get("woocommerce_allow_tracking") if isinstance(o2, dict) else c2)

        # 3b. Block email editor stays at Woo default, no (#916).
        # WC 11.2.1 registers block_email_editor with enabled_by_default false.
        # WC_Install::create_options uses add_option, so a stored yes is kept.
        # The enable spec checks the box. An already checked box leaves Save disabled.
        # Proof is wc/v3 settings advanced value no.
        # wc-admin/options does not list this option on Woo 11.2.1.
        # A 403 woocommerce_rest_cannot_view is skipped only after wc/v3 is no.
        email_opt = EMAIL_EDITOR_OPT
        rest(a, n, "/wc/v3/settings/advanced/" + email_opt, {"value": "no"}, "PUT")
        c, t = rest(a, n, "/wc/v3/settings/advanced/" + email_opt)
        c2, o2 = rest(a, n, "/wc-admin/options?options=" + email_opt)
        wcadmin_detail = c2
        if isinstance(o2, dict) and email_opt in o2:
            wcadmin_detail = o2.get(email_opt)
        elif isinstance(o2, dict) and o2.get("code"):
            wcadmin_detail = o2.get("code")
        check(email_opt + " = no (wc/v3 settings)",
              email_editor_option_ok(t, c2, o2),
              wcv3=t.get("value") if isinstance(t, dict) else c, wcadmin=wcadmin_detail, wcadmin_status=c2)

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
        # My Account greets by display name. wp user create sets that from the first
        # and last name. The WooCommerce customer route leaves it as the login (#965).
        display = "%s %s" % (CUSTOMER["first_name"], CUSTOMER["last_name"])
        if cid:
            rest(a, n, "/wp/v2/users/%s" % cid, {"name": display}, "POST")
        c, u = rest(a, n, "/wp/v2/users/%s?context=edit" % cid) if cid else (0, None)
        u = u if isinstance(u, dict) else {}
        co, cwhy = login(CUSTOMER["username"], cpw)
        check("customer: role customer, the email, Jane Smith, and a form login",
              u.get("username") == CUSTOMER["username"] and u.get("roles") == ["customer"] and u.get("email") == CUSTOMER["email"]
              and u.get("first_name") == "Jane" and u.get("last_name") == "Smith" and u.get("name") == display and co is not None,
              id=cid, roles=u.get("roles"), display=u.get("name"), login=("ok" if co else cwhy))
    else:
        skip_woo('3, 3b, 4. woocommerce_allow_tracking, the block email editor option, the customer')

    if WOO:
        # 5. the three test images, pinned
        sha = wc_sha()
        have, stored = [], {}
        for name in IMAGES:
            st_ = name.rsplit(".", 1)[0]
            c, hits = rest(a, n, "/wp/v2/media?search=%s&per_page=20" % urllib.parse.quote(st_))
            match = [h for h in hits if stem(h.get("source_url")) == st_] if isinstance(hits, list) else []
            if match:
                # A found item is kept only if its files load: woocommerce-cleanup's reset deletes every sub-size file and
                # keeps the attachment, so a product thumbnail then answers 404 (sb1120, cf759a). Such an item is deleted
                # (force) and uploaded again below, which makes the sizes again.
                broken = image_files_missing(match[0])
                if not broken:
                    have.append(name); stored[st_] = match[0]["source_url"].rsplit("/", 1)[-1]
                    continue
                cd, _ = rest(a, n, "/wp/v2/media/%s?force=true" % match[0].get("id"), None, "DELETE")
                event("reupload", name=name, missing=broken[:4], deleted=cd)
            c, meta, _ = req(jar(), "%s/repos/woocommerce/woocommerce/contents/%s%s?ref=%s" % (GH_API, IMG_PATH, name, sha), headers={"Accept": "application/vnd.github+json"})
            want = (js(meta) or {}).get("sha") if c == 200 else None
            c, data, _ = req(jar(), "%s/woocommerce/woocommerce/%s/%s%s" % (GH_RAW, sha, IMG_PATH, name))
            blob = hashlib.sha1(b"blob %d\0" % len(data or b"") + (data or b"")).hexdigest() if c == 200 else None
            if not (want and blob == want):
                check("image %s matches the pin" % name, False, wc_sha=sha, upstream_blob=want, got_blob=blob)
                continue
            c, b, uh = req(a, "/?rest_route=/wp/v2/media", data, {"X-WP-Nonce": n, "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="%s"' % name}, "POST")
            r = js(b)
            if c == 201 and isinstance(r, dict) and stem(r.get("source_url")) == st_:
                have.append(name); stored[st_] = r["source_url"].rsplit("/", 1)[-1]
            else:
                # The engine's headers name the request for its logs (sb1120: a 500 upload left its files behind).
                pf = {k: uh.get(k) for k in ("x-pf-call", "x-write-loss", "x-isolate-reset", "x-wasm-mib", "x-sql-failure") if uh and uh.get(k)}
                check("image %s uploads under its own stem" % name, False, status=c, source=r.get("source_url") if isinstance(r, dict) else None, **pf)
        check("the three test images, found by search under their own stems", sorted(have) == sorted(IMAGES), stored=stored, wc_sha=sha)
    else:
        skip_woo('5. the three WooCommerce test images')

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
            if marked and WOO:
                check("test plugin %s is in the build" % pid, False, listed=c)
            else:
                report["checks"]["test plugin %s" % pid] = {"ok": None, "skipped": "not in this build (%s)" % ("SEED_NO_WOO=1" if marked else "a local site without the content")}
                event("skip", name="test plugin %s" % pid, why="not in this build")
            continue
        if have[pid] != "active":
            rest(a, n, "/wp/v2/plugins/%s" % pid, {"status": "active"}, "POST")
        c, st = rest(a, n, "/wp/v2/plugins/%s?context=edit" % pid)
        check("test plugin %s is active" % pid, isinstance(st, dict) and st.get("status") == "active", status=st.get("status") if isinstance(st, dict) else c)
    # A spec that stopped mid-run can leave one active (sb1120: default-post-content). The seed owns setup, so it
    # deactivates each one, then reads the list back.
    gb = [k for k, v in have.items() if (k or "").startswith("gutenberg-test-plugins/") and v == "active"]
    for pid in gb:
        rest(a, n, "/wp/v2/plugins/%s" % pid, {"status": "inactive"}, "POST")
    if gb:
        c, plist = rest(a, n, "/wp/v2/plugins?context=edit")
        still = [p.get("plugin") for p in plist if (p.get("plugin") or "").startswith("gutenberg-test-plugins/") and p.get("status") == "active"] if isinstance(plist, list) else None
        check("gutenberg-test-plugins stay inactive (the specs toggle them)", still == [], deactivated=gb, still_active=still, listed=c)
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
        # After the password write, the first rest-nonce can answer 500 (measured on cf759a
        # 2026-11-18). Basic already works. Retry the form login a few times.
        a2, why = None, "not attempted"
        whys = []  # #924: every attempt's reason, not only the last ("ok" for the one that logged in)
        for attempt in range(4):
            a2, why = login(ADMIN_USER, newpw)
            whys.append("ok" if a2 is not None else why)
            if a2 is not None:
                break
            time.sleep(2)
        check("admin: the account password IS the application password (form login)", c == 200 and a2 is not None, set_status=c, login=("ok" if a2 else why), revoked_old=revoked, login_attempts=attempt + 1, login_whys=whys)
        st = basic(ADMIN_USER, newpw)
        check("admin: Basic with it on /wp/v2/users/me answers 200 (#761)", st == 200, status=st)
        wrong = basic(ADMIN_USER, newpw[:-1] + ("x" if newpw[-1] != "x" else "y"))
        check("admin: a wrong password over Basic gets 401", wrong == 401, status=wrong)
        if a2 is not None and not all(re.fullmatch(r"[A-Za-z0-9_-]+", v) for v in ((ADMIN_USER, newpw, CUSTOMER["username"], cpw) if WOO else (ADMIN_USER, newpw))):
            check("creds.env values are shell-safe ([A-Za-z0-9_-])", False)
        elif a2 is not None:
            fd = os.open(credsf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                # export lines: after `. creds.env` the values reach a child process (runner.py prepare reads os.environ).
                # Every value is [A-Za-z0-9_-] (an application password, a token_urlsafe, a user name): no quoting needed.
                f.write("export WP_USERNAME=%s\nexport WP_PASSWORD=%s\n" % (ADMIN_USER, newpw))
                if WOO:
                    f.write("export CUSTOMER_USERNAME=%s\nexport CUSTOMER_PASSWORD=%s\n" % (CUSTOMER["username"], cpw))
            report["creds"] = credsf
    report["failed"] = failed
    with open(os.path.join(OUT, "seed.json"), "w") as f:
        json.dump(report, f, indent=1, sort_keys=True)
    event("done", failed=failed, report=os.path.join(OUT, "seed.json"))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
