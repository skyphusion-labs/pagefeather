#!/usr/bin/env python3
"""Test runner.py against a stub WordPress (local http, no network, no real site).

    python3 -I tests/conformance/runner_test.py

The stub can play: no marker, a marker for another host, Basic always 401 (#761), Basic that
ignores the password, the page cache on or off. Every STOP must name its reason, and no
password may reach stdout or stderr.
"""
import base64, http.server, io, json, os, re, shutil, subprocess, sys, tempfile, threading, contextlib, stat

HERE = os.path.dirname(os.path.abspath(__file__))
PINS_WC_SHA = next(l.split("=", 1)[1].strip() for l in open(os.path.join(HERE, "pins.env")) if l.startswith("WC_SHA="))
sys.path.insert(0, HERE)
import runner  # noqa: E402

runner.REQUIRE_HTTPS = False
FAILS = []


def ok(m):
    print("ok   " + m)


def bad(m):
    print("FAIL " + m)
    FAILS.append(m)


class Stub:
    def __init__(self):
        self.password = "SeedAppPass24CharsAbCdEf"  # the seed made the account password an app password
        self.customer_pw = "Cust-Pass-9"
        self.blogname = "WooCommerce Core E2E Test Suite"
        self.admin_email = "owner@throwaway.example"
        self.timezone = "America/Detroit"
        self.images = ["image-01", "image-02", "image-03"]
        self.customer_role = "customer"
        self.cuser = "customer"
        self.tracking = "yes"        # None: the route answers 404
        self.theme = "twentytwentythree"
        self.basic_ok_pw = None          # None: Basic accepts self.password
        self.marker = "self"     # self | none | other
        self.basic = "ok"        # ok | always401 | ignores
        self.cache = "HIT"       # what cf-cache-status says on the 2nd and 3rd guest GET
        # x-pf-rendered on the guest GETs of / (#1336): "same" (a stored body, the stamp repeats), "new" (a render each
        # time), "none" (no stamp). None: "same" when self.cache is a cached status, else "new", as a real site does.
        self.stamp = None
        self.app = None
        self.calls = []
        self.options = {}
        self.media = 0
        self.users = {}
        self.nonce = "0a1b2c3d4e"
        self.plain = False       # True: plain permalinks (#760), /wp-json/ answers the home page
        self.admin_form = False  # True: /wp-admin/ answers 200 with the login form (no redirect)
        self.editor_prefs = {"core/edit-post": {"welcomeGuide": False}}  # seed dismiss (#759)
        stub = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body=b"", headers=None, ctype="application/json"):
                if isinstance(body, (dict, list)):
                    body = json.dumps(body).encode()
                elif isinstance(body, str):
                    body = body.encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                for k, v in (headers or []):
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def logged_in(self):
                return re.search(r"wordpress_logged_in_x=\w+", self.headers.get("Cookie") or "") is not None

            def rest_ok(self):
                return "wordpress_logged_in_x=admin" in (self.headers.get("Cookie") or "") and self.headers.get("X-WP-Nonce") == stub.nonce

            def body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(n)

            def norm(self):
                # ?rest_route=/x&q -> /wp-json/x?q. A /wp-json/ path on plain permalinks gets the home page.
                from urllib.parse import urlsplit, parse_qsl, urlencode
                u = urlsplit(self.path)
                if u.path == "/" and u.query.startswith("rest_route="):
                    qs = parse_qsl(u.query, keep_blank_values=True)
                    route = qs[0][1]
                    rest = urlencode(qs[1:], safe="/%")
                    self.path = "/wp-json" + route + ("?" + rest if rest else "")
                    return True
                if self.path.startswith("/wp-json/") and stub.plain:
                    self.send(200, "<html>home</html>", ctype="text/html")
                    return False
                return True

            def do_GET(self):
                if not self.norm():
                    return
                stub.calls.append(("GET", self.path))
                if self.path == "/wp-json/pf-conformance/v1/throwaway":
                    if stub.marker == "none":
                        return self.send(404, {"code": "rest_no_route"})
                    host = "127.0.0.1" if stub.marker == "self" else "other.example"
                    return self.send(200, {"throwaway": True, "host": host})
                if self.path == "/wp-admin/admin-ajax.php?action=rest-nonce":
                    return self.send(200, stub.nonce if self.logged_in() else "0", ctype="text/plain")
                if self.path.startswith("/wp-json/wp/v2/users/me"):
                    a = self.headers.get("Authorization")
                    if a and a.startswith("Basic "):
                        u, _, p = base64.b64decode(a[6:]).decode().partition(":")
                        if stub.basic == "always401":
                            return self.send(401, {"code": "rest_not_logged_in"})
                        if stub.basic == "ignores" or (u == "admin" and p == stub.password):
                            return self.send(200, {"id": 1, "meta": {"persisted_preferences": stub.editor_prefs}})
                        return self.send(401, {"code": "incorrect_password"})
                    if self.rest_ok():
                        return self.send(200, {"id": 1, "meta": {"persisted_preferences": stub.editor_prefs}})
                    return self.send(401, {"code": "rest_not_logged_in"})
                if self.path == "/wp-admin/":
                    c = self.headers.get("Cookie") or ""
                    if stub.admin_form:
                        return self.send(200, '<form name="loginform" id="loginform">', ctype="text/html")
                    if "wordpress_logged_in_x=admin" in c:
                        return self.send(200, "<html>Dashboard</html>", ctype="text/html")
                    if "wordpress_logged_in_x=%s" % stub.cuser in c:
                        return self.send(302, "", [("Location", "/my-account/")])
                    return self.send(302, "", [("Location", "/wp-login.php?redirect_to=%2Fwp-admin%2F&reauth=1")])
                if self.path == "/wp-json/":
                    return self.send(200, {"namespaces": ["wp/v2", "wc/v3"]})
                if self.path.startswith("/wp-json/wp/v2/users?search="):
                    if not self.rest_ok():
                        return self.send(401, {})
                    q = self.path.split("search=")[1].split("&")[0]
                    hit = q == stub.cuser and stub.customer_role
                    return self.send(200, [{"id": 7, "username": stub.cuser, "roles": [stub.customer_role]}] if hit else [])
                if self.path == "/wp-json/wp/v2/themes?status=active":
                    if not self.rest_ok():
                        return self.send(401, {})
                    return self.send(200, [{"stylesheet": stub.theme, "status": "active"}])
                if self.path == "/wp-json/wc/v3/settings/advanced/woocommerce_allow_tracking":
                    if not self.rest_ok():
                        return self.send(401, {})
                    if stub.tracking is None:
                        return self.send(404, {"code": "rest_setting_setting_invalid"})
                    return self.send(200, {"id": "woocommerce_allow_tracking", "value": stub.tracking})
                if self.path == "/wp-json/wp/v2/settings":
                    body = {"title": stub.blogname, "timezone": stub.timezone}
                    if stub.admin_email is not None:
                        body["email"] = stub.admin_email
                    return self.send(200, body) if self.rest_ok() else self.send(401, {})
                if self.path.startswith("/wp-json/wp/v2/media?search="):
                    q = self.path.split("search=")[1].split("&")[0]
                    ext = "jpg" if q == "image-01" else "png"
                    return self.send(200, [{"source_url": "https://x/wp-content/uploads/%s.%s" % (q, ext)}] if q in stub.images else [])
                if self.path == "/":
                    n = sum(1 for c in stub.calls if c == ("GET", "/"))
                    mode = stub.stamp or ("same" if stub.cache in ("HIT", "EXPIRED", "STALE", "REVALIDATED", "UPDATING") else "new")
                    hs = [("cf-cache-status", "MISS" if n == 1 else stub.cache)]
                    if mode != "none":
                        hs.append(("x-pf-rendered", str(1795000000000 + (1 if mode == "same" else n))))
                    return self.send(200, "<html>", hs, "text/html")
                self.send(404, {})

            def do_POST(self):
                b = self.body()
                if not self.norm():
                    return
                stub.calls.append(("POST", self.path))
                if self.path == "/wp-login.php":
                    f = dict(x.split("=", 1) for x in b.decode().split("&"))
                    from urllib.parse import unquote_plus
                    log, pwd = unquote_plus(f.get("log", "")), unquote_plus(f.get("pwd", ""))
                    if (log, pwd) in (("admin", stub.password), (stub.cuser, stub.customer_pw)):
                        return self.send(302, "", [("Set-Cookie", "wordpress_logged_in_x=%s; Path=/" % log), ("Location", "/wp-admin/")])
                    return self.send(200, "<form>ERROR</form>", ctype="text/html")
                if not self.rest_ok():
                    return self.send(401, {"code": "rest_cookie_invalid_nonce"})
                j = json.loads(b or b"null") if self.headers.get("Content-Type") == "application/json" else None
                if self.path == "/wp-json/wp/v2/users/me/application-passwords":
                    stub.app = "AbCdEfGhIjKlMnOpQrStUvWx"
                    return self.send(201, {"password": stub.app, "uuid": "u"})
                if self.path == "/wp-json/wp/v2/users/me":
                    stub.password = j["password"]
                    return self.send(200, {"id": 1})
                if self.path == "/wp-json/wp/v2/users":
                    if j["username"] in stub.users:
                        return self.send(400, {"code": "existing_user_login"})
                    stub.users[j["username"]] = j
                    return self.send(201, {"id": 7})
                if self.path == "/wp-json/wp/v2/users/7":
                    stub.users["customer"]["password"] = j["password"]
                    return self.send(200, {"id": 7})
                if self.path == "/wp-json/e2e-options/update":
                    stub.options[j["option_name"]] = j["option_value"]
                    return self.send(200, "ok")
                if self.path == "/wp-json/e2e-options/delete":
                    stub.options[j["option_name"]] = None
                    return self.send(200, "ok")
                if self.path == "/wp-json/wp/v2/media":
                    if self.headers.get("Content-Type") == "image/png" and b.startswith(b"\x89PNG"):
                        stub.media += 1
                        return self.send(201, {"id": 100 + stub.media})
                    return self.send(400, {})
                self.send(404, {})

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


def pins_agree(root=None):
    """#1201: the suites follow the WordPress version the sites run. pins.env WP_VERSION must equal build.sh's, and
    vps-run.sh names no core version of its own, so the site build and the test pins cannot disagree on main."""
    root = root or os.path.dirname(os.path.dirname(HERE))
    def first(path, key):
        for l in open(path, encoding="utf8"):
            if l.startswith(key + "="):
                return l.split("=", 1)[1].strip()
        return None
    pv = first(os.path.join(HERE, "pins.env"), "WP_VERSION")
    bv = first(os.path.join(root, "spikes", "b2-wordpress", "build.sh"), "WP_VERSION")
    if pv and bv and pv == bv:
        ok("pins.env WP_VERSION %s equals spikes/b2-wordpress/build.sh WP_VERSION" % pv)
    else:
        bad("pins.env WP_VERSION %r and spikes/b2-wordpress/build.sh WP_VERSION %r disagree (#1201)" % (pv, bv))
    vps = open(os.path.join(HERE, "vps-run.sh"), encoding="utf8").read()
    hard = re.findall(r"WordPress/WordPress#[0-9][^ \"]*", vps)
    ok("vps-run.sh takes the stock core from pins.env WP_VERSION") if not hard and "WordPress/WordPress#$WP_VERSION" in vps else bad("vps-run.sh hardcodes a core version: %s" % hard)


def path_shim(d, dirs, leave_out=(), stubs=()):
    """A PATH dir holding every tool of dirs except leave_out, plus a stub (exit 0) per name in stubs. The FIRST dir that
    holds a name wins, as PATH lookup does. lexists, not exists: a dangling link counts as taken (CI's ubuntu has
    /bin -> /usr/bin, so every name comes twice, and some are dangling links such as grub-ntldr-img)."""
    os.makedirs(d, exist_ok=True)
    for bd in dirs:
        if not os.path.isdir(bd):
            continue
        for n in os.listdir(bd):
            if n in leave_out or n in stubs or os.path.lexists(os.path.join(d, n)):
                continue
            os.symlink(os.path.join(bd, n), os.path.join(d, n))
    for n in stubs:
        p = os.path.join(d, n)
        if os.path.lexists(p):
            os.remove(p)
        open(p, "w").write("#!/bin/sh\nexit 0\n")
        os.chmod(p, 0o755)
    return d


def run(argv, env):
    out, err = io.StringIO(), io.StringIO()
    old = dict(os.environ)
    os.environ.clear()
    os.environ.update(env)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = runner.main(argv)
    finally:
        os.environ.clear()
        os.environ.update(old)
    return rc, out.getvalue(), err.getvalue()


def main():
    t = tempfile.mkdtemp(prefix="conf-runner.")
    try:

        def case(label, why, suite_name="wc", cache="on", setup=None, env_extra=None, expect_rc=3, extra=(), want_out=None):
            s = Stub()
            if setup:
                setup(s)
            env = {"WP_USERNAME": "admin", "WP_PASSWORD": s.password, "CUSTOMER_PASSWORD": s.customer_pw, "PATH": os.environ.get("PATH", "")}
            env.update(env_extra or {})
            rd = os.path.join(t, "run-" + re.sub(r"\W+", "-", label))
            rc, o, e = run(["prepare", "--suite", suite_name, "--base-url", s.url, "--cache", cache, "--run-dir", rd] + list(extra), env)
            s.close()
            writes = [c for c in s.calls if c[0] == "POST" and c[1] != "/wp-login.php"]
            if writes:
                bad("%s: the runner WROTE to the site (%s); the seed owns setup" % (label, writes[:2]))
            secrets = [x for x in (s.password, s.customer_pw) if x]
            leaked = [x for x in secrets if x in o or x in e]
            if leaked:
                bad("%s: a password reached the output" % label)
            if rc != expect_rc:
                bad("%s: rc %d, expected %d (stderr: %s)" % (label, rc, expect_rc, e.strip()[:160]))
            elif expect_rc == 3 and not re.search(why, e):
                bad("%s: stopped for another reason: %s" % (label, e.strip()[:160]))
            elif want_out and not all(re.search(w, o + e) for w in want_out):
                bad("%s: the output lacks %s" % (label, [w for w in want_out if not re.search(w, o + e)]))
            else:
                ok("%s%s" % (label, (": " + e.strip()[:110]) if expect_rc == 3 else ""))
            return s, rd

        # Refusals before any change.
        s, _ = case("deny list (PF_CONFORMANCE_DENY)", r"deny list", env_extra={"PF_CONFORMANCE_DENY": "127.0.0.1"})
        if any(c[0] == "POST" for c in s.calls) or s.calls:
            bad("deny list: the stub was contacted %d times" % len(s.calls))
        else:
            ok("deny list: the site was never contacted")
        if {"ggc.sh", "www.ggc.sh"} <= runner.DENY:
            ok("ggc.sh is on the built-in deny list")
        else:
            bad("ggc.sh is not on the built-in deny list")
        s, _ = case("no throwaway marker", r"no throwaway marker", setup=lambda s: setattr(s, "marker", "none"))
        if any(c[0] == "POST" for c in s.calls):
            bad("no marker: the runner POSTed before it stopped")
        else:
            ok("no marker: nothing was POSTed")
        case("a marker for another host", r"names host 'other.example'", setup=lambda s: setattr(s, "marker", "other"))
        case("a wrong admin password", r"form did not log the admin in.*TURNSTILE_LOGIN=off", env_extra={"WP_PASSWORD": "wrong"})
        case("no WP_PASSWORD", r"WP_PASSWORD is not set", env_extra={"WP_PASSWORD": ""})
        case("cache on, but nothing cached", r"--cache on, but no stored body was served", setup=lambda s: setattr(s, "cache", "DYNAMIC"))
        case("cache off, but HIT", r"--cache off, but the page cache answered", cache="off")
        # #1336: the stamp, not cf-cache-status, says whether a stored body was served.
        case("cache on, EXPIRED but a new render each time (#1336)", r"--cache on, but no stored body was served",
             setup=lambda s: (setattr(s, "cache", "EXPIRED"), setattr(s, "stamp", "new")))
        case("cache on, no x-pf-rendered at all (#1336)", r"could not measure.*x-pf-rendered",
             setup=lambda s: setattr(s, "stamp", "none"))
        case("cache off, DYNAMIC but the stamp repeats (#1336)", r"--cache off, but the page cache answered", cache="off",
             setup=lambda s: (setattr(s, "cache", "DYNAMIC"), setattr(s, "stamp", "same")))
        # #1277 round 2 (the lead's ruling): --cache on-unverified, for arm (a) only.
        NEW = lambda s: (setattr(s, "cache", "EXPIRED"), setattr(s, "stamp", "new"))
        rs, _ = case("on-unverified without --arm stops", r"on-unverified is declared for #1277 round 2 arm \(a\) only.*--arm \(none\)",
                     cache="on-unverified", setup=NEW)
        if rs.calls:
            bad("on-unverified refusal: the site was contacted %d times (from rollins's #1391)" % len(rs.calls))
        else:
            ok("on-unverified refusal: the site was never contacted")
        case("on-unverified with --arm b stops", r"on-unverified is declared for #1277 round 2 arm \(a\) only.*--arm b",
             cache="on-unverified", setup=NEW, extra=["--arm", "b"])
        _, urd = case("on-unverified with --arm a and no stored body goes on, loudly", None, cache="on-unverified", setup=NEW,
                      extra=["--arm", "a"], expect_rc=0, want_out=[r"UNVERIFIED: --cache on-unverified", r"a stored body served: no"])
        uenv = open(os.path.join(urd, "env")).read() if os.path.exists(os.path.join(urd, "env")) else ""
        if "PF_CONFORMANCE_CACHE=on-unverified" in uenv and "PF_CONFORMANCE_ARM=a" in uenv and "PF_CONFORMANCE_CACHE_SERVED=no" in uenv:
            ok("on-unverified: the run's env records the mode, the arm and the result (served: no)")
        else:
            bad("on-unverified: the run's env does not record PF_CONFORMANCE_CACHE=on-unverified, PF_CONFORMANCE_ARM=a and PF_CONFORMANCE_CACHE_SERVED=no")
        # The lead's changed ruling (2026-11-23): for arm (a) only, "could not measure" also goes on, recorded as unknown,
        # with the guard's 3 raw lines. Every other mode keeps BOTH stops.
        NOSTAMP = lambda s: (setattr(s, "cache", "UPDATING"), setattr(s, "stamp", "none"))
        _, nrd = case("on-unverified with --arm a and no stamp at all goes on, loudly", None, cache="on-unverified",
                      setup=NOSTAMP, extra=["--arm", "a"], expect_rc=0,
                      want_out=[r"UNVERIFIED: --cache on-unverified.*could not measure.*UNKNOWN", r"page cache: GET / #3: HTTP 200"])
        nenv = open(os.path.join(nrd, "env")).read() if os.path.exists(os.path.join(nrd, "env")) else ""
        raws = re.findall(r"^export PF_CONFORMANCE_CACHE_RAW_(\d)=(.*)$", nenv, re.M)
        if "PF_CONFORMANCE_CACHE_SERVED=unknown" in nenv and [r[0] for r in raws] == ["1", "2", "3"] and \
                all("x-pf-rendered -" in r[1] and "cf-cache-status" in r[1] for r in raws):
            ok("on-unverified, could not measure: the env records served=unknown and the 3 raw guard lines")
        else:
            bad("on-unverified, could not measure: the env lacks PF_CONFORMANCE_CACHE_SERVED=unknown or the 3 raw lines (%s)" % raws)
        case("every other mode keeps the could-not-measure stop: --cache on, even with --arm a", r"--cache on: could not measure",
             setup=NOSTAMP, extra=["--arm", "a"])
        case("every other mode keeps the could-not-measure stop: --cache on, no arm", r"--cache on: could not measure", setup=NOSTAMP)
        case("on-unverified with no stamp but --arm b still stops (the arm refusal comes first)", r"on-unverified is declared for #1277 round 2 arm \(a\) only",
             cache="on-unverified", setup=NOSTAMP, extra=["--arm", "b"])
        case("on-unverified with --arm a and a stored body: no UNVERIFIED line needed", None, cache="on-unverified",
             setup=lambda s: (setattr(s, "cache", "EXPIRED"), setattr(s, "stamp", "same")), extra=["--arm", "a"], expect_rc=0,
             want_out=[r"a stored body served: yes"])
        case("cache on is unchanged: no stored body still stops, even with --arm a", r"--cache on, but no stored body was served",
             setup=NEW, extra=["--arm", "a"])
        case("cache on, EXPIRED with the same stamp is served (#1336)", None,
             setup=lambda s: (setattr(s, "cache", "EXPIRED"), setattr(s, "stamp", "same")), expect_rc=0)
        # Basic auth (#761).
        case("Basic always 401 (#761)", r"returned 401, not 200.*#761", setup=lambda s: setattr(s, "basic", "always401"))
        case("Basic ignores the password", r"WRONG password returned 200, not 401", setup=lambda s: setattr(s, "basic", "ignores"))
        # The seed's setup, verified one item at a time (the seed owns it; the runner only reads).
        case("no customer user", r"no user 'customer'", setup=lambda s: setattr(s, "customer_role", None))
        case("customer without the customer role", r"no user 'customer' with the role", setup=lambda s: setattr(s, "customer_role", "subscriber"))
        case("no CUSTOMER_PASSWORD", r"CUSTOMER_PASSWORD is not set", env_extra={"CUSTOMER_PASSWORD": ""})
        case("a wrong CUSTOMER_PASSWORD", r"the customer 'customer' cannot log in", env_extra={"CUSTOMER_PASSWORD": "nope"})
        case("the wrong blogname", r"blogname is 'My Site'", setup=lambda s: setattr(s, "blogname", "My Site"))
        case("the wrong timezone", r"timezone is 'UTC'.*America/Detroit", setup=lambda s: setattr(s, "timezone", "UTC"))
        case("no admin email in the settings", r"site admin email .* is None", setup=lambda s: setattr(s, "admin_email", None))
        case("a malformed admin email", r"site admin email .* is 'not-an-email'", setup=lambda s: setattr(s, "admin_email", "not-an-email"))
        case("plain permalinks (#760)", r"pretty permalinks are not active", setup=lambda s: setattr(s, "plain", True))
        case("a missing test image", r"no media image-02\.\* ", setup=lambda s: setattr(s, "images", ["image-01", "image-03"]))
        case("the wrong theme (after a wp or gb pass)", r"active theme is \['twentytwentyone'\].*not 'twentytwentythree'", setup=lambda s: setattr(s, "theme", "twentytwentyone"))
        case("tracking is no", r"woocommerce_allow_tracking is 'no'.*WOO_EXTRAS=off", setup=lambda s: setattr(s, "tracking", "no"))
        case("no tracking route", r"woocommerce_allow_tracking is None \(HTTP 404\)", setup=lambda s: setattr(s, "tracking", None))
        case("a malformed CUSTOMER_USERNAME", r"is not a plain user name", env_extra={"CUSTOMER_USERNAME": "x y;z"})
        s2, rd2 = case("a seed customer named jane (CUSTOMER_USERNAME)", None, setup=lambda s: setattr(s, "cuser", "jane"),
                       env_extra={"CUSTOMER_USERNAME": "jane"}, expect_rc=0)
        ok("CUSTOMER_USER in env is the seed's name") if "export CUSTOMER_USER=jane\n" in open(os.path.join(rd2, "env")).read() else bad("CUSTOMER_USER is not jane")
        case("the seed's customer is jane but CUSTOMER_USERNAME is unset", r"no user 'customer' with the role", setup=lambda s: setattr(s, "cuser", "jane"))
        # The happy paths.
        s, rd = case("wc happy path (a seeded site)", None, expect_rc=0)
        envf = os.path.join(rd, "env")
        mode = stat.S_IMODE(os.stat(envf).st_mode) if os.path.exists(envf) else None
        ok("env is mode 600") if mode == 0o600 else bad("env mode is %r" % (oct(mode) if mode else None))
        env_text = open(envf).read() if mode else ""
        # Checked by (key, value); only the literal KEY is ever printed, never a value.
        for key, val in (("ADMIN_PASSWORD", s.password), ("WP_PASSWORD", s.password), ("ADMIN_USER", "admin"),
                         ("BASE_URL", s.url), ("CUSTOMER_USER", "customer"), ("CUSTOMER_PASSWORD", s.customer_pw),
                         ("PF_CONFORMANCE_CACHE", "on"), ("ADMIN_USER_EMAIL", "owner@throwaway.example")):
            has = ("export %s=%s\n" % (key, val)) in env_text
            ok("env has " + key) if has else bad("env lacks " + key)
        ok("no application password was created") if s.app is None else bad("the runner created an application password")
        case("the welcome guide is not dismissed (#759)", r"welcome guide is not dismissed", suite_name="wp", setup=lambda s: setattr(s, "editor_prefs", {"core/edit-post": {"welcomeGuide": True}}))
        s, rd = case("wp happy path (cache off, plain permalinks, no WooCommerce checks)", None, suite_name="wp", cache="off",
                     setup=lambda s: (setattr(s, "cache", "DYNAMIC"), setattr(s, "plain", True), setattr(s, "customer_role", None)), expect_rc=0)
        env_text = open(os.path.join(rd, "env")).read()
        ok("wp: WP_PASSWORD is the operator's own") if "export WP_PASSWORD=SeedAppPass24CharsAbCdEf" in env_text else bad("wp: WP_PASSWORD wrong")
        wc_only = [c for c in s.calls if c[1].startswith("/wp-json/wp/v2/users?") or c[1].startswith("/wp-json/wc/")]
        ok("wp: no WooCommerce setup checks") if not wc_only else bad("wp: it ran WooCommerce checks: %s" % wc_only[:2])
        wp_art, wp_st = runner.conformance_artifact_paths(rd)
        ok("wp prepare exports STORAGE_STATE_PATH") if ("export STORAGE_STATE_PATH=%s\n" % wp_st) in env_text else bad("wp: env lacks STORAGE_STATE_PATH")
        ok("wp prepare exports WP_ARTIFACTS_PATH") if ("export WP_ARTIFACTS_PATH=%s\n" % wp_art) in env_text else bad("wp: env lacks WP_ARTIFACTS_PATH")

        # check-state: a saved login is asserted before any test (lead ruling).
        def state(name, cookies):
            p = os.path.join(t, name)
            json.dump({"cookies": cookies, "origins": []}, open(p, "w"))
            return p
        ck = lambda name, value, domain="127.0.0.1": {"name": name, "value": value, "domain": domain, "path": "/"}
        sa = state("admin.json", [ck("wordpress_logged_in_x", "admin"), ck("wordpress_sec_x", "S3CRET-COOKIE-VALUE")])
        sc = state("customer.json", [ck("wordpress_logged_in_x", "customer")])
        empty = state("empty.json", [])
        bogus = state("bogus.json", [ck("wordpress_logged_in_x", "bogus")])
        foreign = state("foreign.json", [ck("wordpress_logged_in_x", "admin", "elsewhere.example")])
        def cs(label, paths, why, expect=3, setup=None):
            st = Stub()
            if setup:
                setup(st)
            argv = ["check-state", "--base-url", st.url]
            for x in paths:
                argv += ["--state", x]
            rc, o, e = run(argv, {})
            st.close()
            if "S3CRET-COOKIE-VALUE" in o + e:
                bad("check-state %s: a cookie value reached the output" % label)
            if rc != expect:
                bad("check-state %s: rc %d, expected %d (%s)" % (label, rc, expect, (e or o).strip()[:120]))
            elif expect == 3 and not re.search(why, e):
                bad("check-state %s: stopped for another reason: %s" % (label, e.strip()[:120]))
            else:
                ok("check-state %s%s" % (label, (": " + e.strip()[:100]) if expect == 3 else ""))
            return st
        st = cs("admin and customer logged in", [sa, sc], None, expect=0)
        sent = [c for c in st.calls if c[1] == "/wp-admin/"]
        ok("check-state asked /wp-admin/ once per state") if len(sent) == 2 else bad("check-state made %d /wp-admin/ calls" % len(sent))
        cs("an empty storage state", [sa, empty], r"empty.json has no login cookie")
        cs("a login cookie the site rejects", [bogus], r"bogus.json is not logged in: /wp-admin/ answers with the login page \(HTTP 302\)")
        cs("a cookie for another domain", [foreign], r"foreign.json has no login cookie for 127.0.0.1")
        cs("a missing storage state", [os.path.join(t, "nope.json")], r"cannot read the storage state")
        cs("a 200 that shows the login form", [sa], r"admin.json is not logged in: /wp-admin/ answers with the login page \(HTTP 200\)", setup=lambda s: setattr(s, "admin_form", True))

        # conformance artifact paths: anchored on run-dir, never upstream cwd.
        rd_art = os.path.join(t, "run-artifacts")
        artifacts, storage = runner.conformance_artifact_paths(rd_art)
        want_art = os.path.join(os.path.abspath(rd_art), "artifacts")
        want_st = os.path.join(want_art, "storage-states", "admin.json")
        ok("conformance_artifact_paths: artifacts dir") if artifacts == want_art else bad("artifacts %r want %r" % (artifacts, want_art))
        ok("conformance_artifact_paths: admin.json") if storage == want_st else bad("storage %r want %r" % (storage, want_st))

        # rest_path, directly.
        for got, want in ((runner.rest_path("/wp-json/wp/v2/users/me?context=edit"), "/?rest_route=/wp/v2/users/me&context=edit"),
                          (runner.rest_path("/wp-json/pf-conformance/v1/throwaway"), "/?rest_route=/pf-conformance/v1/throwaway"),
                          (runner.rest_path("/wp-login.php"), "/wp-login.php")):
            ok("rest_path %s" % want) if got == want else bad("rest_path gave %s, want %s" % (got, want))

        try:
            runner.parse_exclude_line("email/settings-email.spec.ts :: Send email preview only-one-space")
            bad("a title row with one space before the reason was accepted")
        except runner.Stop:
            ok("a title row with one space before the reason is refused")
        # Tier-scoped rows (#1119): "[Hyperdrive] <path>  <reason>" skips only on that tier.
        tr = runner.parse_exclude_line("[Hyperdrive] api-tests/products/product-list.test.ts  LIMIT, not a pass")
        ok("a tier-scoped row parses: kind file, its path, its tier") if (tr.kind, tr.path, tr.tier) == ("file", "api-tests/products/product-list.test.ts", "Hyperdrive") else bad("tier row: %s" % (tr,))
        ttr = runner.parse_exclude_line("[Paid DO] a.spec.ts :: Group > a title  reason")
        ok("a tier-scoped title row parses") if (ttr.kind, ttr.path, ttr.title, ttr.tier) == ("title", "a.spec.ts", "Group > a title", "Paid DO") else bad("tier title row: %s" % (ttr,))
        try:
            runner.parse_exclude_line("[Moon] x.spec.ts  reason"); bad("an unknown tier was accepted")
        except runner.Stop:
            ok("an unknown tier stops")
        pl = "api-tests/products/product-list.test.ts"
        on = {t: [r.path for r in runner.read_excludes("wc-api", t)] for t in (None,) + runner.TIERS}
        ok("the Hyperdrive product-list row is skipped on Hyperdrive only") if pl in on["Hyperdrive"] and all(pl not in on[t] for t in (None, "Free DO", "Paid DO", "WfP")) else bad("tier filter: %s" % on)
        cfg_h = runner.config_text("wc-api", os.path.join(t, "th"), os.path.join(t, "sh"), tier="Hyperdrive")
        cfg_p = runner.config_text("wc-api", os.path.join(t, "tp"), os.path.join(t, "sp"), tier="Paid DO")
        ok("wc-api config: Hyperdrive ignores product-list, Paid DO runs it") if pl in cfg_h and pl not in cfg_p else bad("tier config")
        kept = runner.parse_exclude_line("paypal/paypal.spec.ts  calls wpCLI")
        ok("a file row stays a file exclude") if kept.kind == "file" and kept.path == "paypal/paypal.spec.ts" else bad("file row parsed as %s" % (kept,))
        parsed = runner.parse_exclude_line("email/settings-email.spec.ts :: WooCommerce Email Settings > Send email preview  suite asserts a PHP mail() failure.")
        ok("a title row parses the file, the title, and the reason") if parsed.kind == "title" and parsed.path == "email/settings-email.spec.ts" and parsed.title == "WooCommerce Email Settings > Send email preview" and parsed.reason == "suite asserts a PHP mail() failure." else bad("title parse: %s" % (parsed,))

        # config: one file per suite, it parses, and it carries the exclusions.
        node = shutil.which("node")
        for sn, up in runner.UPSTREAM_CONFIG.items():
            d = os.path.join(t, "cfg-" + sn)
            os.makedirs(d)
            open(os.path.join(d, up), "w").write("export default {};\n")
            rc, o, e = run(["config", "--suite", sn, "--suite-dir", d, "--run-dir", os.path.join(t, "r")], {"PATH": os.environ.get("PATH", "")})
            p = os.path.join(d, "pf-conformance.config.mjs")
            txt = open(p).read() if os.path.exists(p) else ""
            files = [r.path for r in runner.read_excludes(sn) if r.kind == "file"]
            if rc == 0 and all(json.dumps(x) in txt for x in files) and "webServer: undefined" in txt and "workers: 1" in txt:
                ok("config %s: %d file exclusions, webServer off, one worker" % (sn, len(files)))
            else:
                bad("config %s: rc %d or content wrong" % (sn, rc))
            if node:
                r = subprocess.run([node, "--check", p], capture_output=True, text=True)
                ok("config %s: node --check" % sn) if r.returncode == 0 else bad("config %s: node --check: %s" % (sn, r.stderr.strip()[:120]))
            else:
                bad("config %s: no node to check the syntax (could not measure)" % sn)
        rc, o, e = run(["config", "--suite", "wp", "--suite-dir", os.path.join(t, "nowhere"), "--run-dir", t], {})
        ok("config refuses a dir without the upstream config") if rc == 3 and "no upstream config" in e else bad("config: no refusal (%d)" % rc)
        wct = open(os.path.join(t, "cfg-wc", "pf-conformance.config.mjs")).read()
        ok("wc config drops blocks/**") if '"blocks/**"' in wct else bad("wc config lacks blocks/**")
        ok("wc config has NO reset project (it would wipe the seed)") if "reset" not in wct else bad("wc config still runs reset")
        ok("wc e2e-pf depends on site setup only") if "dependencies: [ 'site setup' ]" in wct else bad("wc e2e-pf dependencies wrong")
        ok("wc config drops install wc") if "p.name !== 'install wc'" in wct else bad("wc config still keeps install wc")
        ok("wc config sets use.baseURL") if "baseURL: url" in wct and "BASE_URL" in wct else bad("wc config missing baseURL")
        # wc-api (the API half): no reset project, api-pf depends on 'site setup' only, runs ONLY the api-tests,
        # and does not carry the wc exclusion of api-tests/**. The setup map clears global authentication's
        # install-wc dependency (one 'dependencies:' there) plus api-pf's site-setup dependency.
        wat = open(os.path.join(t, "cfg-wc-api", "pf-conformance.config.mjs")).read()
        ok("wc-api config has NO reset project") if "reset" not in wat else bad("wc-api config runs reset")
        ok("wc-api api-pf depends on site setup only") if wat.count("dependencies: [ 'site setup' ]") == 1 and "p.name !== 'install wc'" in wat else bad("wc-api dependencies wrong")
        ok("wc-api runs only the api-tests") if "name: 'api-pf', testMatch: [ '**/api-tests/**' ]" in wat and "e2e-pf" not in wat else bad("wc-api project wrong")
        ok("wc-api does not ignore the api-tests") if '"api-tests/**"' not in wat else bad("wc-api ignores api-tests/**")
        ok("wc-api config sets use.baseURL") if "baseURL: url" in wat else bad("wc-api config missing baseURL")
        # vps-run.sh run wc-api (DRY): the wc checkout, site setup, then check-state, then api-pf alone.
        vr = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "wc-api", os.path.join(t, "w"), os.path.join(t, "rr")],
                            env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        lines = vr.stdout.splitlines()
        idx = lambda pat: next((i for i, l in enumerate(lines) if pat in l), -1)
        s_, c_, a_ = idx('--project="site setup"') if idx('--project="site setup"') >= 0 else idx("--project=site setup"), idx("runner.py check-state"), idx("--project=api-pf --no-deps")
        ok("vps-run run wc-api: site setup, then check-state, then api-pf --no-deps") if vr.returncode == 0 and 0 <= s_ < c_ < a_ else bad("vps-run wc-api order (rc %d, %d %d %d): %s" % (vr.returncode, s_, c_, a_, vr.stderr[-200:]))
        ok("vps-run wc-api uses the wc checkout") if any("/wc-" in l and "wc-api-" not in l for l in lines) else bad("vps-run wc-api checkout: %s" % lines[:3])
        # wc-cpt (#759 gap 2): upstream's envs/default-hpos-disabled. HPOS OFF in site setup, only the @hpos tests,
        # the wc exclusions (one list, never a copy), no reset project.
        if "wc-cpt" in runner.UPSTREAM_CONFIG:
            wcc = open(os.path.join(t, "cfg-wc-cpt", "pf-conformance.config.mjs")).read()
            ok("wc-cpt config turns HPOS off for site setup") if "process.env.DISABLE_HPOS = '1';" in wcc else bad("wc-cpt config does not set DISABLE_HPOS")
            ok("wc-cpt runs only the @hpos tests, as e2e-cpt") if "name: 'e2e-cpt', grep: new RegExp( \"@hpos\" )" in wcc and "e2e-pf" not in wcc and "api-pf" not in wcc else bad("wc-cpt project wrong")
            ok("wc-cpt has NO reset project and depends on site setup") if "reset" not in wcc and "dependencies: [ 'site setup' ]" in wcc else bad("wc-cpt reset or dependencies wrong")
            ok("wc-cpt carries the wc exclusions") if '"blocks/**"' in wcc and '"api-tests/**"' in wcc else bad("wc-cpt lacks the wc exclusions")
            want_title = "WooCommerce Email Settings > Send email preview"
            wc_rows = runner.read_excludes("wc")
            paypal = [r for r in wc_rows if r.path == "paypal/paypal.spec.ts"]
            ok("paypal is a file exclude for wpCLI") if len(paypal) == 1 and paypal[0].kind == "file" and paypal[0].reason == "calls wpCLI / needs wp-env (not the deployed site)" else bad("paypal row: %s" % (paypal,))
            title_rows = [r for r in wc_rows if r.kind == "title"]
            mk_title = "can load Marketing > Overview page"
            ok("the title excludes are send email preview and Marketing Overview") if [(r.path, r.title) for r in title_rows] == [("email/settings-email.spec.ts", want_title), ("basic/page-loads.spec.ts", mk_title)] else bad("title rows: %s" % (title_rows,))
            try:
                ign = json.loads(wct.split("const ignore = ", 1)[1].split(";", 1)[0])
            except (ValueError, IndexError) as e:
                ign = None
                bad("wc ignore list did not parse: %s" % e)
            if ign is not None:
                ok("wc testIgnore lists paypal/paypal.spec.ts") if "paypal/paypal.spec.ts" in ign else bad("paypal missing from testIgnore: %s" % ign)
                ok("wc testIgnore does not drop the email settings file") if not any("settings-email" in x for x in ign) else bad("email file was file-ignored: %s" % ign)
            full = runner.grep_invert_source([("email/settings-email.spec.ts", want_title), ("basic/page-loads.spec.ts", mk_title)])
            # A title that holds " > " itself matches as one part (the Marketing row), and the describe split still works.
            mk_rx = re.compile(runner.title_grep_source("basic/page-loads.spec.ts", mk_title))
            ok("a title holding ' > ' matches the Playwright title line") if mk_rx.search("e2e-pf basic/page-loads.spec.ts can load Marketing > Overview page") and not mk_rx.search("e2e-pf basic/page-loads.spec.ts can load Marketing > Coupons page") else bad("Marketing title regex")
            em_rx = re.compile(runner.title_grep_source("email/settings-email.spec.ts", want_title))
            ok("a describe > title row still matches as before") if em_rx.search("e2e-pf email/settings-email.spec.ts WooCommerce Email Settings Send email preview") else bad("email title regex")
            # gb rows name the file from test/e2e (specs/...), but Playwright greps the path relative to the project testDir,
            # which for gb is specs/: the line reads "chromium interactivity/...". A row with specs/ must still match it.
            gb_rx = re.compile(runner.title_grep_source("specs/interactivity/directive-context.spec.ts", "data-wp-context > is correctly initialized"))
            gb_line = "chromium interactivity/directive-context.spec.ts data-wp-context is correctly initialized"
            gb_sib = "chromium interactivity/directive-context.spec.ts data-wp-context is correctly extended (shallow)"
            ok("a gb row with specs/ matches Playwright's testDir-relative title line") if gb_rx.search(gb_line) and not gb_rx.search(gb_sib) else bad("gb title regex does not match %r (the specs/ prefix)" % gb_line)
            # #1349 guard: a dead title row must not hide again. STATIC, not playwright --list: CI checks out no suite at
            # GB_SHA, so it cannot list. For every title row of every exclude list, the line Playwright greps is built
            # from the row itself (the project, the file path relative to that suite's testDir, the describes and the
            # title) and the row's regex must match it. This catches a row written from a base other than the testDir
            # (the #1349 bug: gb rows say specs/..., gb's testDir is specs/). It cannot catch a mistyped title; that
            # needs --list on a box (measured 2026-11-22: all 28 gb title rows matched exactly one listed test).
            TESTDIR_STRIP = {"gb": "specs/", "wc": "", "wp": "", "wc-api": ""}
            PROJECT = {"gb": "chromium", "wc": "e2e-pf", "wp": "chromium", "wc-api": "api"}
            dead = []
            n_rows = 0
            for sx in ("gb", "wc", "wp", "wc-api"):
                with open(os.path.join(os.path.dirname(os.path.abspath(runner.__file__)), "exclude", sx + ".txt")) as fx:
                    for raw in fx:
                        raw = raw.strip()
                        if not raw or raw.startswith("#"):
                            continue
                        rw = runner.parse_exclude_line(raw)
                        if rw.kind != "title":
                            continue
                        n_rows += 1
                        strip = TESTDIR_STRIP[sx]
                        rel = rw.path[len(strip):] if strip and rw.path.startswith(strip) else rw.path
                        pw_line = " ".join([PROJECT[sx], rel] + [x.strip() for x in rw.title.split(" > ") if x.strip()])
                        if not re.search(runner.title_grep_source(rw.path, rw.title), pw_line):
                            dead.append("%s: %s :: %s" % (sx, rw.path, rw.title[:60]))
            ok("every title-row exclude matches the line Playwright greps (%d rows, static check)" % n_rows) if n_rows and not dead else bad("dead title-row excludes (they match no Playwright title line): %s" % dead[:5])
            ok("wc grepInvert is the tag filter plus the title") if json.dumps(full) in wct else bad("title grep missing from wc config")
            ok("wc-cpt grepInvert carries the same title") if json.dumps(full) in wcc else bad("title grep missing from wc-cpt config")
            ok("wc-api grepInvert does not carry the email title") if json.dumps(runner.title_grep_source("email/settings-email.spec.ts", want_title)) not in wat else bad("wc-api carries the email title")
            if node:
                js = "\n".join([
                    "const re = new RegExp(process.argv[1]);",
                    "function g(file, parts) { return [\"\", \"e2e-pf\", file].concat(parts).join(\" \"); }",
                    "const file = \"tests/email/settings-email.spec.ts\";",
                    "const send = g(file, [\"WooCommerce Email Settings\", \"Send email preview\"]);",
                    "const see = g(file, [\"WooCommerce Email Settings\", \"See email preview\"]);",
                    "const reset = g(file, [\"WooCommerce Email Settings\", \"Reset color palette with a feature flag\"]);",
                    "const tagged = g(file, [\"WooCommerce Email Settings\", \"@suite\", \"Send email preview\"]);",
                    "const other = g(\"tests/paypal/paypal.spec.ts\", [\"PayPal\", \"Send email preview\"]);",
                    "const checks = [[send, true], [see, false], [reset, false], [tagged, true], [other, false]];",
                    "if (!re.test(\"plain @skip-on-external-env\")) { console.error(\"tag filter missed\"); process.exit(1); }",
                    "for (const pair of checks) {",
                    "  if (re.test(pair[0]) !== pair[1]) {",
                    "    console.error((pair[1] ? \"missed\" : \"hit\") + \": \" + JSON.stringify(pair[0]));",
                    "    process.exit(1);",
                    "  }",
                    "}",
                ])
                nr = subprocess.run([node, "-e", js, full], capture_output=True, text=True)
                ok("grepInvert skips Send email preview and keeps its siblings") if nr.returncode == 0 else bad("grepInvert match: %s" % (nr.stderr or nr.stdout).strip()[:200])
            else:
                bad("no node to prove the title grep (could not measure)")
        else:
            bad("wc-cpt is not a suite")
        ok("wc-cpt reads the wc exclusion list itself") if runner.read_excludes("wc-cpt") == runner.read_excludes("wc") else bad("wc-cpt excludes differ from wc")
        vr = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "wc-cpt", os.path.join(t, "w"), os.path.join(t, "rc")],
                            env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        lines = vr.stdout.splitlines()
        idx = lambda pat: next((i for i, l in enumerate(lines) if pat in l), -1)
        s_, c_, a_ = max(idx('--project="site setup"'), idx("--project=site setup")), idx("runner.py check-state"), idx("--project=e2e-cpt --no-deps")
        ok("vps-run run wc-cpt: site setup, then check-state, then e2e-cpt --no-deps") if vr.returncode == 0 and 0 <= s_ < c_ < a_ else bad("vps-run wc-cpt order (rc %d, %d %d %d): %s" % (vr.returncode, s_, c_, a_, (vr.stderr or "")[:120]))
        ok("vps-run wc-cpt uses the wc checkout") if lines and any("/wc-" in l for l in lines) and not any("/wc-cpt-" in l for l in lines) else bad("vps-run wc-cpt checkout: %s" % lines[:3])
        pf_setup = json.dumps(os.path.join(HERE, "pf-global-setup.mjs"))
        for sn in ("wp", "gb"):
            txt = open(os.path.join(t, "cfg-" + sn, "pf-conformance.config.mjs")).read()
            want_assert = json.dumps(os.path.join(HERE, "assert-login.mjs"))
            want_upstream_suffix = os.path.join("config", "global-setup.js" if sn == "wp" else "global-setup.ts")
            gs = re.search(r"config\.globalSetup = (\[[^\]]+\])", txt)
            if gs:
                try:
                    paths = json.loads(gs.group(1).replace("'", '"'))
                except json.JSONDecodeError:
                    paths = None
            else:
                paths = None
            ok("config %s: globalSetup is string paths only" % sn) if paths and all(isinstance(p, str) for p in paths) else bad("config %s: globalSetup is not string-only" % sn)
            ok("config %s: pf-global-setup then assert-login" % sn) if paths == [os.path.join(HERE, "pf-global-setup.mjs"), os.path.join(HERE, "assert-login.mjs")] else bad("config %s: globalSetup order wrong: %r" % (sn, paths))
            ok("config %s: no inline setup function in config" % sn) if "async function pfGlobalSetup" not in txt and "pfGlobalSetup" not in txt.replace(pf_setup, "") else bad("config %s: inline globalSetup function" % sn)
            m = re.search(r'PF_CONFORMANCE_UPSTREAM_GLOBAL_SETUP = "([^"]+)"', txt)
            ok("config %s: upstream global-setup is an absolute suite path" % sn) if m and m.group(1).endswith(want_upstream_suffix) and os.path.isabs(m.group(1)) else bad("config %s: upstream env missing or relative" % sn)
            if sn == "wp":
                # #1335: the wp suite installs stock Twenty Twenty-One, so the dashboard file runs.
                dash = "specs/dashboard.test.js"
                dash_title = "Quick Draft > should allow Quick Draft to be created with only the Content"
                rows = [r for r in runner.read_excludes("wp") if r.path == dash or "dashboard.test.js" in r.path]
                ok("wp does not exclude dashboard.test.js") if rows == [] else bad("dashboard exclude remains: %s" % (rows,))
                try:
                    ign = json.loads(txt.split("const ignore = ", 1)[1].split(";", 1)[0])
                except (ValueError, IndexError):
                    ign = None
                ok("wp testIgnore does not drop dashboard.test.js") if ign is not None and dash not in ign else bad("dashboard still file-ignored: %s" % ign)
                src = runner.title_grep_source(dash, dash_title)
                ok("wp config does not grepInvert the Quick Draft content test") if json.dumps(src) not in txt else bad("wp config still hides the dashboard title")
        conn = [r for r in runner.read_excludes("gb") if r.path == "specs/admin/connectors.spec.js"]
        want_why = "code lock denies install_plugins, so connector install stays off"
        ok("gb excludes connectors.spec.js for the code lock") if len(conn) == 1 and conn[0].kind == "file" and conn[0].reason == want_why else bad("connectors row: %s" % (conn,))
        gbt = open(os.path.join(t, "cfg-gb", "pf-conformance.config.mjs")).read()
        ok("gb testIgnore lists connectors.spec.js") if json.dumps("specs/admin/connectors.spec.js") in gbt else bad("gb config lacks connectors.spec.js")
        for path, why in (
            ("specs/admin/user-post-types.spec.js", "Gutenberg plugin not shipped; /wp/v2/user-post-types stays 404"),
            ("specs/admin/user-taxonomies.spec.js", "Gutenberg plugin not shipped; /wp/v2/user-taxonomies stays 404"),
            ("specs/admin/guidelines.spec.js", "Gutenberg plugin not shipped; /wp/v2/knowledge stays 404"),
            ("specs/admin/font-library.spec.js", "needs the Gutenberg plugin: delete-installed-fonts calls WP_Theme_JSON_Resolver_Gutenberg, core 7.1.4 lacks it (#998); stock core not measured"),
        ):
            rows = [r for r in runner.read_excludes("gb") if r.path == path]
            ok("gb excludes %s" % path) if len(rows) == 1 and rows[0].kind == "file" and rows[0].reason == why else bad("%s row: %s" % (path, rows))
            ok("gb testIgnore lists %s" % path) if json.dumps(path) in gbt else bad("gb config lacks %s" % path)
        # #992: the directive-context fixture at GB_SHA binds children; the runtime at GB_SHA refuses it.
        dc = "specs/interactivity/directive-context.spec.ts"
        dc_why = "fixture at GB_SHA uses data-wp-bind--children, which the runtime at GB_SHA refuses; upstream fixed the fixture in the next wp/7.1 commit d1533ce (#992)"
        dc_out = (
            "is correctly initialized",
            "is correctly extended (shallow)",
            "changes in inherited properties are reflected and don't leak down (child)",
            "changes in inherited properties are reflected and don't leak up (parent)",
            "changes in shadowed properties do not leak (child)",
            "changes in shadowed properties do not leak (parent)",
            "new inherited properties update child contexts",
            "Array properties are shadowed",
            "overwritten objects don't inherit values (shallow)",
            "overwritten objects do not inherit values",
            "objects referenced from the context inherit properties where they are originally defined",
        )
        dc_rows = [r for r in runner.read_excludes("gb") if r.path == dc]
        ok("gb directive-context rows are 11 title rows") if len(dc_rows) == 11 and all(r.kind == "title" and r.reason == dc_why for r in dc_rows) else bad("directive-context rows: %s" % (dc_rows,))
        ok("gb directive-context row titles are the pre readers") if sorted(r.title for r in dc_rows) == sorted("data-wp-context > " + x for x in dc_out) else bad("directive-context titles: %s" % ([r.title for r in dc_rows],))
        gm = re.search(r"^const oursInvert = (.*);$", gbt, re.M)
        gsrc = json.loads(gm.group(1)) if gm else None
        ok("gb config has a title grepInvert") if gsrc else bad("gb config lacks a title grepInvert")
        if gsrc:
            for x in dc_out:
                full = "%s data-wp-context %s" % (dc, x)
                ok("gb grepInvert skips: %s" % x) if re.search(gsrc, full) else bad("gb grepInvert misses %r" % full)
            for x in ("can be accessed in other directives on the same element", "should not subscribe to parent context props if those also exist in child", "properties from other namespaces defined in a parent context are inherited"):
                full = "%s data-wp-context %s" % (dc, x)
                ok("gb grepInvert keeps: %s" % x) if not re.search(gsrc, full) else bad("gb grepInvert hides %r" % full)
        wpt = open(os.path.join(t, "cfg-wp", "pf-conformance.config.mjs")).read()
        ok("wp config sets STORAGE_STATE_PATH before import") if wpt.index("process.env.STORAGE_STATE_PATH") < wpt.index("import base") else bad("wp config: env after import")
        ok("wp config forces storageState on projects") if "storageState: state" in wpt and "const state = process.env.STORAGE_STATE_PATH" in wpt else bad("wp config: storageState missing")
        if node:
            r = subprocess.run([node, "--check", os.path.join(HERE, "assert-login.mjs")], capture_output=True, text=True)
            ok("assert-login.mjs: node --check") if r.returncode == 0 else bad("assert-login.mjs: %s" % r.stderr.strip()[:120])

        # #605: Playwright loads the upstream file as { default: config }.
        # A spread of that object drops timeout and use. Upstream sets 100000.
        # The harness must keep that number. It must not raise it.
        unwrap_js = (
            "import cfg from %s;\n"
            "if (cfg.timeout !== 100000) { console.error('timeout ' + cfg.timeout); process.exit(1); }\n"
            "if (!cfg.use || cfg.use.channel !== 'chrome') { console.error('use ' + JSON.stringify(cfg.use)); process.exit(1); }\n"
            "if (cfg.workers !== 1) { console.error('workers ' + cfg.workers); process.exit(1); }\n"
            "if (!String(cfg.use.baseURL || '').includes('unwrap.example')) { console.error('baseURL ' + cfg.use.baseURL); process.exit(1); }\n"
        )

        def prove_unwrap(label, suite, filename, stub):
            d = os.path.join(t, "cfg-unwrap-" + label)
            os.makedirs(d)
            open(os.path.join(d, filename), "w").write(stub)
            rc, o, e = run(["config", "--suite", suite, "--suite-dir", d, "--run-dir", os.path.join(t, "r-unwrap-" + label)],
                           {"PATH": os.environ.get("PATH", "")})
            pth = os.path.join(d, "pf-conformance.config.mjs")
            txt = open(pth).read() if os.path.exists(pth) else ""
            if rc != 0 or "const upstream = base.default || base;" not in txt or "...upstream," not in txt:
                bad("unwrap %s: config did not unwrap default (rc %d)" % (label, rc))
                return
            if not node:
                bad("unwrap %s: no node to load the config (could not measure)" % label)
                return
            env = dict(os.environ)
            env["BASE_URL"] = "https://unwrap.example"
            env["WP_BASE_URL"] = "https://unwrap.example"
            r = subprocess.run([node, "--input-type=module", "-e", unwrap_js % json.dumps(pth)],
                               capture_output=True, text=True, env=env)
            if r.returncode == 0:
                ok("unwrap %s: timeout 100000 and use.channel survive" % label)
            else:
                bad("unwrap %s: %s" % (label, (r.stderr or r.stdout).strip()[:180]))

        prove_unwrap("wp-default", "wp", "playwright.config.js",
                     "exports.default = { timeout: 100000, use: { channel: 'chrome' } };\n")
        prove_unwrap("wp-plain", "wp", "playwright.config.js",
                     "module.exports = { timeout: 100000, use: { channel: 'chrome' } };\n")
        prove_unwrap("wc-default", "wc", "playwright.config.ts",
                     "export const coreSetupProjects = ["
                     "{ name: 'install wc' },"
                     "{ name: 'global authentication', dependencies: ['install wc'] }];\n"
                     "export default { default: { timeout: 100000, use: { channel: 'chrome' } } };\n")

        # A STOP is never a result (1): summarize refuses a report whose global setup failed, or with no test.
        for label, rep, why in (("a report with a global-setup error", {"errors": [{"message": "Error: assert-login: STOP"}], "suites": []}, r"top-level error"),
                                ("a report with no test", {"suites": []}, r"holds no test")):
            rp = os.path.join(t, "stop-%d.json" % len(label))
            json.dump(rep, open(rp, "w"))
            rc, o, e = run(["summarize", "--report", rp, "--out", os.path.join(t, "stop-out.json")], {})
            ok("summarize refuses %s (exit 3)" % label) if rc == 3 and re.search(why, e) else bad("summarize on %s: rc %d %s" % (label, rc, e.strip()[:120]))

        # A STOP is never a result (2): vps-run.sh run wc, for real, with a stub pnpm on PATH. The setup phase writes
        # report.json, as Playwright does. A failed setup, or a login check-state refuses, must exit 3 and leave NO report.
        vw = os.path.join(t, "vw")
        sd = os.path.join(vw, "wc-" + PINS_WC_SHA, "plugins", "woocommerce", "tests", "e2e")
        os.makedirs(sd)
        open(os.path.join(sd, "playwright.config.ts"), "w").write("export default {};\n")
        bindir = os.path.join(t, "bin")
        os.makedirs(bindir)
        open(os.path.join(bindir, "pnpm"), "w").write("#!/bin/bash\n# stub: writes the report, as Playwright does, then exits PNPM_RC\n"
            "for a in \"$@\"; do case \"$a\" in --project=*) ;; esac; done\n"
            "echo '{\"suites\":[]}' > \"$RUN_DIR/report.json\"\nexit ${PNPM_RC:-0}\n")
        os.chmod(os.path.join(bindir, "pnpm"), 0o755)
        # The fake wc checkout is not a git repo: a stub git answers "rev-parse HEAD" with the pin, so these cases reach the
        # setup phase they test (the HEAD check itself is pinned by its own cases below). Any other git call fails loudly.
        wc_pin = [l.split("=", 1)[1].strip() for l in open(os.path.join(HERE, "pins.env")) if l.startswith("WC_SHA=")][0]
        open(os.path.join(bindir, "git"), "w").write('#!/bin/bash\n[ "$3" = rev-parse ] && [ "$4" = HEAD ] && { echo %s; exit 0; }\necho "stub git: unexpected $*" >&2; exit 97\n' % wc_pin)
        os.chmod(os.path.join(bindir, "git"), 0o755)
        for label, pnpm_rc, want in (("the setup phase fails", "1", "the setup projects failed"),
                                     ("the saved login is missing (check-state)", "0", "check-state")):
            rd = os.path.join(t, "vr-" + pnpm_rc)
            os.makedirs(rd, exist_ok=True)
            open(os.path.join(rd, "env"), "w").write("export BASE_URL=http://127.0.0.1:9\nexport PF_CONFORMANCE_SUITE=wc\n")
            vr = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "wc", vw, rd],
                                env={"PATH": bindir + ":" + os.environ.get("PATH", ""), "RUN_DIR": rd, "PNPM_RC": pnpm_rc},
                                capture_output=True, text=True)
            left = os.path.exists(os.path.join(rd, "report.json"))
            if vr.returncode == 3 and want in vr.stderr and not left:
                ok("vps-run run wc: %s: exit 3, no report.json left" % label)
            else:
                bad("vps-run run wc: %s: rc %d, report left %s: %s" % (label, vr.returncode, left, vr.stderr.strip()[-200:]))
        # The baseline never sees our throwaway: exported BASE_URL and ADMIN_PASSWORD are unset, and the env stops on exit.
        vb = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "baseline", "wc", vw, os.path.join(t, "vb")],
                            env={"PATH": os.environ.get("PATH", ""), "DRY": "1", "BASE_URL": "https://cf759a.example", "ADMIN_PASSWORD": "x"},
                            capture_output=True, text=True)
        ok("baseline wc: check-state targets the local wp-env, not an exported BASE_URL") if "check-state --base-url http://localhost:8086" in vb.stdout and "cf759a" not in vb.stdout else bad("baseline wc target: %s" % vb.stdout[-300:])
        ok("baseline wc: its env stops on exit") if "pnpm env:e2e:stop" in vb.stdout else bad("baseline wc: no env stop")
        # #1112: the wp and gb baseline config is --stock: upstream's own baseURL, storageState and globalSetup. Forced
        # ones gave baseURL "/" (Invalid URL in global setup) because the baseline unsets the names (gbbase-gb2).
        for sb in ("gb", "wp"):
            vbs = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "baseline", sb, vw, os.path.join(t, "vb" + sb)],
                                 env={"PATH": os.environ.get("PATH", ""), "DRY": "1", "WP_BASE_URL": "https://cf759hw.example"}, capture_output=True, text=True)
            cfg_line = [l for l in vbs.stdout.splitlines() if "runner.py config" in l]
            ok("baseline %s: the config step is --stock, and the throwaway URL is never named" % sb) if vbs.returncode == 0 and cfg_line and cfg_line[0].rstrip().endswith("--stock") and "cf759hw" not in vbs.stdout else bad("baseline %s stock: rc %d %s" % (sb, vbs.returncode, (vbs.stdout + vbs.stderr)[-300:]))
            vrn = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", sb, vw, os.path.join(t, "vr" + sb)],
                                 env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
            rl = [l for l in vrn.stdout.splitlines() if "runner.py config" in l]
            ok("run %s: the config step is NOT --stock" % sb) if rl and not rl[0].rstrip().endswith("--stock") else bad("run %s config line: %s" % (sb, rl))
            stock_txt = runner.config_text(sb, os.path.join(t, "st" + sb), os.path.join(t, "suite" + sb), stock=True)
            ours_txt = runner.config_text(sb, os.path.join(t, "st" + sb), os.path.join(t, "suite" + sb))
            ok("stock %s config: no forced baseURL, no assert-login, no STORAGE_STATE_PATH, no globalSetup" % sb) if all(x not in stock_txt for x in ("baseURL", "assert-login", "STORAGE_STATE_PATH", "globalSetup")) else bad("stock %s config: %s" % (sb, stock_txt[-400:]))
            ok("stock %s config: keeps the exclusions, workers 1, retries 0 and the JSON report" % sb) if all(x in stock_txt for x in ("config.testIgnore = withIgnore( upstream.testIgnore )", "testIgnore: withIgnore( p.testIgnore )", "workers: 1", "retries: 0", "report.json")) else bad("stock %s keeps: %s" % (sb, stock_txt[-400:]))
            ok("our %s config still forces baseURL, the login assert and STORAGE_STATE_PATH" % sb) if all(x in ours_txt for x in ("baseURL: url", "assert-login", "STORAGE_STATE_PATH")) else bad("our %s config lost a guard" % sb)
        # #1160: wc --stock is upstream's own config and projects, and every map ADDS our rows to upstream's
        # testIgnore and grepInvert (upstream projects partition the specs with their own).
        wcs = runner.config_text("wc", os.path.join(t, "stwc"), os.path.join(t, "suitewc"), stock=True)
        wco = runner.config_text("wc", os.path.join(t, "stwc"), os.path.join(t, "suitewc"))
        ok("stock wc config: no forced baseURL, no coreSetupProjects, no e2e-pf, no install wc filter") if all(x not in wcs for x in ("baseURL", "coreSetupProjects", "e2e-pf", "install wc")) else bad("stock wc config: %s" % wcs[-500:])
        ok("stock wc config: USE_WP_ENV as upstream envs/default, the wc tag filter, workers 1, retries 0, the JSON report") if all(x in wcs for x in ("USE_WP_ENV = 'true'", "@skip-on-external-env", "workers: 1", "retries: 0", "report.json", "testIgnore: withIgnore( p.testIgnore )")) else bad("stock wc keeps: %s" % wcs[-500:])
        ok("our wc config still forces baseURL and drops install wc") if "baseURL: url" in wco and "p.name !== 'install wc'" in wco and "e2e-pf" in wco else bad("our wc config lost a guard")
        try:
            runner.config_text("wc-cpt", t, t, stock=True)
            bad("stock wc-cpt: no refusal")
        except runner.Stop as ex:
            ok("stock wc-cpt is refused (its stock arm needs upstream's HPOS-off env)") if "wc-cpt" in str(ex) else bad("stock wc-cpt: %s" % ex)
        # The wc stock arm builds WooCommerce from source BEFORE env:e2e (its e2e README); the run arm does not.
        vbb = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "baseline", "wc", vw, os.path.join(t, "vbwcb")],
                             env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        bo = vbb.stdout
        ib, ie = bo.find("--filter=@woocommerce/plugin-woocommerce build"), bo.find("pnpm env:e2e")
        ok("baseline wc: builds the WooCommerce plugin, then starts env:e2e") if vbb.returncode == 0 and 0 <= ib < ie else bad("baseline wc build order: build %d env %d: %s" % (ib, ie, bo[-400:]))
        # The stock test phase runs upstream's projects (no e2e-pf there); the run arm keeps ours.
        ok("baseline wc: the tests run upstream's core-serial and core-parallel, not e2e-pf") if "--project=core-serial --project=core-parallel --no-deps" in bo and "e2e-pf" not in bo else bad("baseline wc projects: %s" % [l for l in bo.splitlines() if "--no-deps" in l])
        vba = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "baseline", "wc-api", vw, os.path.join(t, "vbwca")],
                             env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        ok("baseline wc-api: the tests run upstream's api project") if "--project=api --no-deps" in vba.stdout and "api-pf" not in vba.stdout else bad("baseline wc-api projects: %s" % [l for l in vba.stdout.splitlines() if "--no-deps" in l])
        vrw = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "wc", vw, os.path.join(t, "vrwcb")],
                             env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        ok("run wc: no plugin build (our site serves a built WooCommerce)") if "plugin-woocommerce build" not in vrw.stdout else bad("run wc builds the plugin")
        ok("run wc: the tests run our e2e-pf") if "--project=e2e-pf --no-deps" in vrw.stdout else bad("run wc projects: %s" % [l for l in vrw.stdout.splitlines() if "--no-deps" in l])
        # path_shim against two PATH dirs that share names, one a DANGLING link (the CI ubuntu shape): first wins, no crash.
        da, db = os.path.join(t, "pa"), os.path.join(t, "pb")
        os.makedirs(da); os.makedirs(db)
        for dd in (da, db):
            os.symlink(os.path.join(dd, "missing-target"), os.path.join(dd, "dangling"))
            open(os.path.join(dd, "both"), "w").write(dd)
        try:
            sh = path_shim(os.path.join(t, "shimdup"), (da, db))
            ok("path_shim: a name in two PATH dirs (one a dangling link) links once, the first dir wins") if os.readlink(os.path.join(sh, "both")) == os.path.join(da, "both") and os.readlink(os.path.join(sh, "dangling")) == os.path.join(da, "dangling") else bad("path_shim: wrong winner")
        except OSError as ex:
            bad("path_shim: duplicate names crash: %s" % ex)
        # Every tool of /bin and /usr/bin EXCEPT composer (CI's ubuntu has /usr/bin/composer), with a stub php so the
        # case tests composer alone (macOS has no /usr/bin/php).
        nocomp = path_shim(os.path.join(t, "nocomposer"), ("/bin", "/usr/bin"), leave_out=("composer",), stubs=("php",))
        vic = subprocess.run(["/bin/bash", os.path.join(HERE, "vps-run.sh"), "install", "wc", os.path.join(t, "vic")],
                             env={"PATH": nocomp}, capture_output=True, text=True)
        ok("install wc without composer: STOP (exit 3) before any clone, naming composer") if vic.returncode == 3 and "needs composer" in vic.stderr and not os.path.exists(os.path.join(t, "vic")) else bad("install wc no composer: rc %d %s" % (vic.returncode, vic.stderr[-200:]))
        # And without php: a shim with every tool except php and composer, plus a stub composer, names php.
        nophp = path_shim(os.path.join(t, "nophp"), ("/bin", "/usr/bin"), leave_out=("php",), stubs=("composer",))
        vip = subprocess.run(["/bin/bash", os.path.join(HERE, "vps-run.sh"), "install", "wc", os.path.join(t, "vip")],
                             env={"PATH": nophp}, capture_output=True, text=True)
        ok("install wc without php: STOP (exit 3) before any clone, naming php") if vip.returncode == 3 and "needs php" in vip.stderr and not os.path.exists(os.path.join(t, "vip")) else bad("install wc no php: rc %d %s" % (vip.returncode, vip.stderr[-200:]))
        # #1287: and without corepack (Node 25 and later do not bundle it): stub php and composer, no corepack. /bin and
        # /usr/bin hold none on macOS or on CI (its Node is in the toolcache), so the shim has none.
        nocp = path_shim(os.path.join(t, "nocorepack"), ("/bin", "/usr/bin"), leave_out=("corepack",), stubs=("php", "composer"))
        vicp = subprocess.run(["/bin/bash", os.path.join(HERE, "vps-run.sh"), "install", "wc", os.path.join(t, "vicp")],
                              env={"PATH": nocp}, capture_output=True, text=True)
        ok("install wc without corepack: STOP (exit 3) before any clone, naming corepack and why") if vicp.returncode == 3 and "needs corepack" in vicp.stderr and "Node 25" in vicp.stderr and not os.path.exists(os.path.join(t, "vicp")) else bad("install wc no corepack: rc %d %s" % (vicp.returncode, vicp.stderr[-200:]))
        vbw = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "baseline", "wc", vw, os.path.join(t, "vbwc")],
                             env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        cl = [l for l in vbw.stdout.splitlines() if "runner.py config" in l]
        ok("baseline wc: the config step is --stock") if cl and cl[0].rstrip().endswith("--stock") else bad("baseline wc config line: %s" % cl)
        if node:
            # Load each generated config against a stub upstream whose projects carry their own testIgnore,
            # grepInvert and grep, and read what Playwright would get.
            stub = ("export const coreSetupProjects = [ { name: 'install wc' }, { name: 'global authentication' }, { name: 'site setup' } ];\n"
                    "export default { testIgnore: [ '**/up-top/**' ], grepInvert: /-up-top/, projects: [\n"
                    "  { name: 'site setup' },\n"
                    "  { name: 'core-parallel', testIgnore: [ '**/api-tests/**', '**/tests/blocks/**' ] },\n"
                    "  { name: 'chromium', grepInvert: /-chromium/ },\n"
                    "  { name: 'webkit', grep: /@webkit/, grepInvert: /-webkit/ } ] };\n")
            for sn, stk in (("wc", True), ("gb", True), ("gb", False), ("wp", True)):
                d = os.path.join(t, "ev-%s-%s" % (sn, stk))
                os.makedirs(d)
                open(os.path.join(d, "upstream.mjs"), "w").write(stub)
                txt = runner.config_text(sn, os.path.join(d, "r"), d, stock=stk).replace("./" + runner.UPSTREAM_CONFIG[sn], "./upstream.mjs")
                open(os.path.join(d, "w.mjs"), "w").write(txt)
                probe = ("import c from './w.mjs';\n"
                         "const P = Object.fromEntries( c.projects.map( ( p ) => [ p.name, { ti: p.testIgnore, gi: p.grepInvert ? p.grepInvert.source : null, g: p.grep ? p.grep.source : null } ] ) );\n"
                         "console.log( JSON.stringify( { ti: c.testIgnore, gi: c.grepInvert ? c.grepInvert.source : null, P } ) );\n")
                open(os.path.join(d, "probe.mjs"), "w").write(probe)
                r = subprocess.run([node, os.path.join(d, "probe.mjs")], capture_output=True, text=True, cwd=d)
                try:
                    got = json.loads(r.stdout.strip().splitlines()[-1])
                except Exception:
                    bad("eval %s stock=%s: %s" % (sn, stk, (r.stderr or r.stdout).strip()[-200:]))
                    continue
                ours = [x.path for x in runner.read_excludes(sn) if x.kind == "file"]
                cp = (got.get("P") or {}).get("core-parallel", {})
                ch = (got.get("P") or {}).get("chromium", {})
                wk = (got.get("P") or {}).get("webkit", {})
                lab = "eval %s %s" % (sn, "stock" if stk else "run")
                top = got.get("ti") or []
                ok("%s: upstream's top-level testIgnore kept, ours added" % lab) if "**/up-top/**" in top and all(x in top for x in ours) else bad("%s top testIgnore: %s" % (lab, top))
                ok("%s: a project's own testIgnore kept, ours added" % lab) if all(x in (cp.get("ti") or []) for x in ["**/api-tests/**", "**/tests/blocks/**"] + ours) else bad("%s core-parallel testIgnore: %s" % (lab, cp.get("ti")))
                ok("%s: a project's own grepInvert still skips its titles" % lab) if ch.get("gi") and re.search(ch["gi"], "should write over selection (-chromium, -firefox)") else bad("%s chromium grepInvert: %s" % (lab, ch.get("gi")))
                ok("%s: a project's own grep is untouched" % lab) if wk.get("g") == "@webkit" else bad("%s webkit grep: %s" % (lab, wk.get("g")))
                if sn == "gb":
                    full = "specs/interactivity/directive-context.spec.ts data-wp-context overwritten objects do not inherit values"
                    ok("%s: our title rows still skip their tests" % lab) if ch.get("gi") and re.search(ch["gi"], full) else bad("%s: our title row lost: %s" % (lab, ch.get("gi")))
        else:
            bad("eval of the generated configs: no node (could not measure)")
        # The core-only gb stock arm (BASELINE_WITHOUT_GUTENBERG_PLUGIN): upstream's env file (8daba429; unchanged at 89408c2b, verbatim
        # shape) with the Gutenberg plugin not mounted. Our sites ship core alone, so this is the baseline that matches them.
        gb_env = json.loads('{"$schema": "./schemas/json/wp-env.json", "testsEnvironment": false, "port": 8889, "core": "WordPress/WordPress#7.1-branch", "mariadbVersion": "12.3", "plugins": ["."], "themes": ["./test/emptytheme"], "config": {"WP_DEBUG": false, "SCRIPT_DEBUG": false}, "mappings": {"wp-content/plugins/gutenberg": ".", "wp-content/mu-plugins": "./packages/e2e-tests/mu-plugins", "wp-content/plugins/gutenberg-test-plugins": "./packages/e2e-tests/plugins", "wp-content/themes/gutenberg-test-themes": "./test/gutenberg-test-themes", "wp-content/themes/gutenberg-test-themes/twentytwentyone": "https://downloads.wordpress.org/theme/twentytwentyone.2.1.zip", "wp-content/themes/gutenberg-test-themes/twentytwentythree": "https://downloads.wordpress.org/theme/twentytwentythree.1.3.zip", "wp-content/themes/gutenberg-test-themes/twentytwentyfour": "https://downloads.wordpress.org/theme/twentytwentyfour.1.0.zip"}}')
        cut = runner.wp_env_without_gutenberg_plugin(gb_env)
        ok("core-only env: plugins drops the checkout") if cut["plugins"] == [] else bad("core-only plugins: %s" % cut["plugins"])
        ok("core-only env: the wp-content/plugins/gutenberg mapping is gone") if "wp-content/plugins/gutenberg" not in cut["mappings"] else bad("core-only: gutenberg mapping kept")
        ok("core-only env: every other mapping and key is kept") if all(cut["mappings"].get(k) == v for k, v in gb_env["mappings"].items() if k != "wp-content/plugins/gutenberg") and all(cut[k] == gb_env[k] for k in gb_env if k not in ("plugins", "mappings")) else bad("core-only: lost a key")
        ok("core-only env: the input is not changed") if gb_env["plugins"] == [ "." ] else bad("core-only: edited the input")
        for lab, bent in (("no plugins entry", dict(gb_env, plugins=[])),
                          ("no gutenberg mapping", dict(gb_env, mappings={k: v for k, v in gb_env["mappings"].items() if k != "wp-content/plugins/gutenberg"})),
                          ("the checkout mounted under a second name", dict(gb_env, mappings=dict(gb_env["mappings"], **{"wp-content/plugins/gb2": "."})))):
            try:
                runner.wp_env_without_gutenberg_plugin(bent)
                bad("core-only env: %s: no refusal" % lab)
            except runner.Stop:
                ok("core-only env: %s is refused" % lab)
        ce = os.path.join(t, "coreonly"); os.makedirs(ce)
        json.dump(gb_env, open(os.path.join(ce, ".wp-env.test.json"), "w"))
        rc, o, e = run(["wp-env-without-gutenberg-plugin", "--suite-dir", ce], {"PATH": os.environ.get("PATH", "")})
        wrote = os.path.join(ce, runner.CORE_ONLY_WP_ENV)
        ok("wp-env-without-gutenberg-plugin writes the env file beside upstream's") if rc == 0 and os.path.exists(wrote) and json.load(open(wrote)) == cut else bad("wp-env-without-gutenberg-plugin: rc %d" % rc)
        for flag in ("1", "0"):
            vbg = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "baseline", "gb", vw, os.path.join(t, "vbg" + flag)],
                                 env={"PATH": os.environ.get("PATH", ""), "DRY": "1", "BASELINE_WITHOUT_GUTENBERG_PLUGIN": flag}, capture_output=True, text=True)
            out = vbg.stdout
            if flag == "1":
                ok("baseline gb without the plugin: writes the core-only env, starts AND stops wp-env with it") if vbg.returncode == 0 and "wp-env-without-gutenberg-plugin --suite-dir" in out and "wp-env --config .wp-env.test-without-gutenberg-plugin.json start" in out and "WITHOUT THE GUTENBERG PLUGIN" in out and "wp-env-test -- start" not in out else bad("baseline gb core-only: rc %d %s" % (vbg.returncode, out[-400:]))
                ok("baseline gb without the plugin: the stop uses the same env file") if "wp-env --config .wp-env.test-without-gutenberg-plugin.json stop" in out else bad("baseline gb core-only stop: %s" % out[-300:])
            else:
                ok("baseline gb by default: upstream's env, plugin mounted, as before") if vbg.returncode == 0 and "wp-env-test -- start" in out and "without-gutenberg-plugin" not in out else bad("baseline gb default: %s" % out[-300:])
        # vps-run.sh runs a private copy of itself: exactly one re-exec, the copy is gone afterwards, the original is
        # unchanged, and the real tests/conformance is still where it reads pins.env and runner.py from.
        stmp = os.path.join(t, "selftmp"); os.makedirs(stmp)
        orig_sum = open(os.path.join(HERE, "vps-run.sh"), "rb").read()
        try:
            vs = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "wc", vw, os.path.join(t, "vself")],
                                env={"PATH": os.environ.get("PATH", ""), "DRY": "1", "TMPDIR": stmp}, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            vs = subprocess.CompletedProcess([], 124, "", "TIMEOUT: the re-exec looped")
        marks = [l for l in vs.stderr.splitlines() if "running a private copy of itself" in l]
        ok("vps-run: re-execs a private copy exactly once") if vs.returncode == 0 and len(marks) == 1 else bad("vps-run self copy: rc %d marks %d %s" % (vs.returncode, len(marks), vs.stderr[-200:]))
        ok("vps-run: the copy reads the real tests/conformance") if marks and marks[0].endswith("(from %s)" % HERE) and "runner.py config" in vs.stdout and os.path.join(HERE, "runner.py") in vs.stdout else bad("vps-run self copy: here is wrong: %s" % marks)
        ok("vps-run: the copy is removed, the original is unchanged") if os.listdir(stmp) == [] and open(os.path.join(HERE, "vps-run.sh"), "rb").read() == orig_sum else bad("vps-run self copy: left %s" % os.listdir(stmp))
        # A caller-set PF_VPS_RUN_SELF naming another file must not be removed (only the running copy is).
        decoy = os.path.join(t, "decoy.txt"); open(decoy, "w").write("keep")
        vd = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "wc", vw, os.path.join(t, "vdecoy")],
                            env={"PATH": os.environ.get("PATH", ""), "DRY": "1", "TMPDIR": stmp, "PF_VPS_RUN_SELF": decoy, "PF_VPS_RUN_HERE": HERE}, capture_output=True, text=True)
        ok("vps-run: a caller-named PF_VPS_RUN_SELF file is never removed") if os.path.exists(decoy) else bad("vps-run removed a caller-named file")
        # run and baseline refuse a checkout whose HEAD is not the pin (not only install does).
        pins = dict(l.strip().split("=", 1) for l in open(os.path.join(HERE, "pins.env")) if re.match(r"^[A-Z_]+=", l.strip()))
        hw = os.path.join(t, "headwork")
        gsrc = os.path.join(hw, "gb-" + pins["GB_SHA"])
        os.makedirs(gsrc)
        gq = lambda *a: subprocess.run(["git", "-C", gsrc, "-c", "user.name=t", "-c", "user.email=t@t", *a], capture_output=True, text=True)
        gq("init", "-q"); open(os.path.join(gsrc, "f"), "w").write("x"); gq("add", "f"); gq("commit", "-q", "-m", "not the pin")
        for act in ("run", "baseline"):
            vh = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), act, "gb", hw, os.path.join(t, "vh" + act)],
                                env={"PATH": os.environ.get("PATH", "")}, capture_output=True, text=True, timeout=60)
            ok("%s gb: a checkout off the pin is a STOP (exit 3), naming both shas" % act) if vh.returncode == 3 and "not the pin " + pins["GB_SHA"] in vh.stderr else bad("%s gb off-pin: rc %d %s" % (act, vh.returncode, vh.stderr[-200:]))
        nogit = os.path.join(t, "nogitwork", "gb-" + pins["GB_SHA"]); os.makedirs(nogit)
        vn = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "gb", os.path.dirname(nogit), os.path.join(t, "vhn")],
                            env={"PATH": os.environ.get("PATH", "")}, capture_output=True, text=True, timeout=60)
        ok("run gb: a suite dir that is not a git checkout is a STOP") if vn.returncode == 3 and "is not a git checkout" in vn.stderr else bad("run gb no-git: rc %d %s" % (vn.returncode, vn.stderr[-200:]))
        vg = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "install", "gb", os.path.join(t, "vg")],
                            env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        vg_out = vg.stdout + vg.stderr
        ok("vps-run install gb: clean, esbuild rebuild, NODE_OPTIONS") if vg.returncode == 0 and "clean:packages" in vg_out and "clean:package-types" in vg_out and "npm rebuild esbuild" in vg_out and "max-old-space-size=6144" in vg_out else bad("vps-run install gb dry: %s" % vg_out[-400:])
        ok("vps-run install gb: CI=true (Gutenberg sequential tsc)") if "CI=true" in vg_out else bad("vps-run install gb: no CI=true in dry output")
        # PF_SPECS: a subset run passes its file filters to the test phase only, and says it is a subset. Run under
        # /bin/bash too: macOS bash 3.2 with set -u fails on an empty "${a[@]}".
        rgb = os.path.join(t, "rgb"); os.makedirs(rgb, exist_ok=True); open(os.path.join(rgb, "env"), "w").close()
        for sh in ("/bin/bash", "bash"):
            if sh.startswith("/") and not os.path.exists(sh):
                continue
            base_env = {"PATH": os.environ.get("PATH", ""), "DRY": "1"}
            v0 = subprocess.run([sh, os.path.join(HERE, "vps-run.sh"), "run", "gb", os.path.join(t, "w"), rgb], env=base_env, capture_output=True, text=True)
            v1 = subprocess.run([sh, os.path.join(HERE, "vps-run.sh"), "run", "gb", os.path.join(t, "w"), rgb], env=dict(base_env, PF_SPECS="specs/editor/blocks/navigation specs/x.spec.js"), capture_output=True, text=True)
            line0 = [l for l in v0.stdout.splitlines() if "playwright test" in l]
            line1 = [l for l in v1.stdout.splitlines() if "playwright test" in l]
            ok("vps-run PF_SPECS (%s): no filter runs the whole suite" % sh) if v0.returncode == 0 and line0 and line0[0].rstrip().endswith("--config=pf-conformance.config.mjs)") and "SUBSET" not in v0.stdout else bad("PF_SPECS none %s: rc %d %s %s" % (sh, v0.returncode, line0, v0.stderr[-200:]))
            ok("vps-run PF_SPECS (%s): the filters reach the test phase and the run says SUBSET" % sh) if v1.returncode == 0 and line1 and line1[0].rstrip().endswith("specs/editor/blocks/navigation specs/x.spec.js)") and "SUBSET run" in v1.stdout else bad("PF_SPECS %s: rc %d %s %s" % (sh, v1.returncode, line1, v1.stderr[-200:]))
        # PF_BROWSER=browser-run: workers 4 by default there, PF_WORKERS sets it, a bad value stops; locally always 1.
        for env_set, want in (({}, 1), ({"PF_WORKERS": "6"}, 1), ({"PF_BROWSER": "browser-run"}, 1), ({"PF_BROWSER": "browser-run", "PF_WORKERS": "2"}, 2)):
            old_env = {k: os.environ.get(k) for k in ("PF_BROWSER", "PF_WORKERS")}
            for k in old_env: os.environ.pop(k, None)
            os.environ.update(env_set)
            try:
                got = runner.pf_workers()
            finally:
                for k, v in old_env.items():
                    os.environ.pop(k, None)
                    if v is not None: os.environ[k] = v
            ok("pf_workers %s: %d" % (env_set, want)) if got == want else bad("pf_workers %s: got %d, want %d" % (env_set, got, want))
        os.environ["PF_BROWSER"] = "browser-run"; os.environ["PF_WORKERS"] = "0"
        try:
            runner.pf_workers(); bad("PF_WORKERS 0 was accepted")
        except runner.Stop:
            ok("PF_WORKERS 0 stops")
        finally:
            os.environ.pop("PF_BROWSER", None); os.environ.pop("PF_WORKERS", None)
        # vps-run: PF_BROWSER=browser-run without the account and token file is a STOP (exit 3), before Playwright.
        vbr = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "gb", os.path.join(t, "w"), rgb],
                             env={"PATH": os.environ.get("PATH", ""), "DRY": "1", "PF_BROWSER": "browser-run"}, capture_output=True, text=True)
        ok("vps-run PF_BROWSER=browser-run without account/token: STOP exit 3") if vbr.returncode == 3 and "needs PF_BROWSER_RUN_ACCOUNT" in vbr.stderr else bad("browser-run stop: rc %d %s" % (vbr.returncode, vbr.stderr[-200:]))
        tokf = os.path.join(t, "tok"); open(tokf, "w").write("x\n")
        vbr = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "gb", os.path.join(t, "w"), rgb],
                             env={"PATH": os.environ.get("PATH", ""), "DRY": "1", "PF_BROWSER": "browser-run", "PF_BROWSER_RUN_ACCOUNT": "0" * 32, "PF_BROWSER_RUN_TOKEN_FILE": tokf}, capture_output=True, text=True)
        ok("vps-run PF_BROWSER=browser-run with account/token: says BROWSER RUN, workers 1") if vbr.returncode == 0 and "BROWSER RUN" in vbr.stdout and "workers 1" in vbr.stdout else bad("browser-run go: rc %d %s" % (vbr.returncode, (vbr.stdout + vbr.stderr)[-300:]))
        # pw / redact_auth (sb1120 cf759hl): Playwright's call log printed "Authorization: Basic <app password>". The real
        # functions from vps-run.sh mask every form, keep other lines, and keep the command's own exit status.
        vtxt = open(os.path.join(HERE, "vps-run.sh")).read()
        funcs = "\n".join(l for l in vtxt.splitlines() if l.startswith("redact_auth() ") or l.startswith("pw() "))
        fake = ("printf '%s\\n' '  - Authorization: Basic YWRtaW46c0I2NDRIajJp' 'authorization=basic QUJD' "
                "'\"Authorization\": \"Bearer abc.def-ghi\"' 'user-agent: Mozilla/5.0' 'Basic idea, no header'; exit 7")
        pr = subprocess.run(["bash", "-c", "set -euo pipefail\n" + funcs + "\npw bash -c \"$0\" || echo rc=$?", fake], capture_output=True, text=True)
        out = pr.stdout
        ok("pw masks every Authorization value") if "YWRtaW46c0I2NDRIajJp" not in out and "QUJD" not in out and "abc.def-ghi" not in out and out.count("<redacted>") == 3 else bad("redact: %r" % out)
        ok("pw keeps other lines, and a bare 'Basic' word") if "user-agent: Mozilla/5.0" in out and "Basic idea, no header" in out else bad("redact kept: %r" % out)
        ok("pw returns the command's exit status (7)") if "rc=7" in out else bad("pw rc: %r %r" % (out, pr.stderr[-200:]))
        ok("every Playwright command in vps-run.sh runs through pw") if vtxt.count(" pw npx playwright test") == 2 and vtxt.count(" pw pnpm exec playwright test") == 2 and " npx playwright test --config" not in vtxt.replace(" pw npx playwright test", "") else bad("an unwrapped playwright command")
        vps_txt = open(os.path.join(HERE, "vps-run.sh")).read()
        ok("vps-run.sh gb: three build attempts on failure") if "for gb_try in 1 2 3" in vps_txt and "gb build failed after 3 attempts" in vps_txt else bad("vps-run.sh gb retry count")
        ok("vps-run.sh gb: clears node_modules/.cache before attempt 3") if "node_modules/.cache" in vps_txt and '[ "$gb_try" = 2 ]' in vps_txt else bad("vps-run.sh gb cache clear")
        ok("vps-run.sh gb: captures build log tail on failure") if "gb_run_build" in vps_txt and "tail -n 30" in vps_txt else bad("vps-run.sh gb log tail")
        # Gutenberg media specs copy ./assets/<name> from the process directory (#980).
        # Upstream cwd is test/e2e. The repository root has no such file.
        gb_sha = next(l.split("=", 1)[1].strip() for l in open(os.path.join(HERE, "pins.env")) if l.startswith("GB_SHA="))
        wp_sha = next(l.split("=", 1)[1].strip() for l in open(os.path.join(HERE, "pins.env")) if l.startswith("WP_DEVELOP_SHA="))
        gb_root = os.path.join(t, "w", "gb-" + gb_sha)
        gb_e2e = os.path.join(gb_root, "test", "e2e")
        asset_name = "10x10_e2e_test_image_z9T8jK.png"
        os.makedirs(os.path.join(gb_e2e, "assets"))
        open(os.path.join(gb_e2e, "assets", asset_name), "wb").write(b"png")
        root_asset = os.path.join(gb_root, "assets", asset_name)
        e2e_asset = os.path.join(gb_e2e, "assets", asset_name)
        ok("gb ./assets image is absent at the repository root") if not os.path.isfile(root_asset) else bad("asset is at the repository root")
        ok("gb ./assets image is present in test/e2e") if os.path.isfile(e2e_asset) else bad("asset missing from test/e2e")
        if node:
            js = "const fs=require(\"fs\"); const os=require(\"os\"); const path=require(\"path\"); const dst=path.join(os.tmpdir(),\"pf-gb-asset-copy\"); try { fs.copyFileSync(\"./assets/\"+process.argv[1], dst); fs.unlinkSync(dst); } catch (e) { if (e.code===\"ENOENT\") process.exit(2); throw e; }"
            root_cp = subprocess.run([node, "-e", js, asset_name], cwd=gb_root, capture_output=True, text=True)
            ok("copyFile ./assets from the repository root is ENOENT") if root_cp.returncode == 2 else bad("root copyFile rc %s %s" % (root_cp.returncode, (root_cp.stderr or "")[-160:]))
            e2e_cp = subprocess.run([node, "-e", js, asset_name], cwd=gb_e2e, capture_output=True, text=True)
            ok("copyFile ./assets from test/e2e succeeds") if e2e_cp.returncode == 0 else bad("e2e copyFile rc %s %s" % (e2e_cp.returncode, (e2e_cp.stderr or e2e_cp.stdout or "")[-160:]))
        else:
            bad("no node to prove the asset copy (could not measure)")
        want_cd = "(cd %s && pw npx playwright test --config=pf-conformance.config.mjs)" % gb_e2e
        for act, rd in (("run", "rg"), ("baseline", "bg")):
            vr = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), act, "gb", os.path.join(t, "w"), os.path.join(t, rd)],
                                env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
            gb_lines = [l for l in vr.stdout.splitlines() if "playwright test" in l]
            ok("vps-run %s gb: Playwright cwd is test/e2e" % act) if vr.returncode == 0 and any(want_cd in l for l in gb_lines) else bad("gb %s playwright cwd: %s" % (act, gb_lines))
        wp_root = os.path.join(t, "w", "wp-" + wp_sha)
        want_wp = "(cd %s && pw npx playwright test --config=tests/e2e/pf-conformance.config.mjs)" % wp_root
        vr = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "run", "wp", os.path.join(t, "w"), os.path.join(t, "rw")],
                            env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        wp_lines = [l for l in vr.stdout.splitlines() if "playwright test" in l]
        ok("vps-run run wp: Playwright cwd stays the repository root") if vr.returncode == 0 and any(want_wp in l for l in wp_lines) else bad("wp playwright cwd: %s" % wp_lines)


        # summarize and compare.
        def report(statuses):
            return {"suites": [{"title": "a.spec.ts", "file": "a.spec.ts", "specs": [
                {"title": name, "file": "a.spec.ts", "tests": [{"projectName": "chromium", "status": st}]} for name, st in statuses]}]}
        base = report([("t1", "expected"), ("t2", "unexpected"), ("t3", "expected"), ("t4", "unexpected")])
        ours = report([("t1", "expected"), ("t2", "unexpected"), ("t3", "unexpected"), ("t4", "expected"), ("t5", "expected")])
        for n, r in (("base", base), ("ours", ours)):
            json.dump(r, open(os.path.join(t, n + ".report.json"), "w"))
            rc, o, e = run(["summarize", "--report", os.path.join(t, n + ".report.json"), "--out", os.path.join(t, n + ".json")], {})
            if rc != 0:
                bad("summarize %s: rc %d %s" % (n, rc, e))
        rows = runner.compare_rows(json.load(open(os.path.join(t, "base.json"))), json.load(open(os.path.join(t, "ours.json"))))
        got = {r["title"]: r["verdict"] for r in rows}
        want = {"t1": "pass", "t2": "upstream", "t3": "OURS", "t4": "ours-passes", "t5": "check"}
        ok("compare verdicts: %s" % got) if got == want else bad("compare verdicts %r, want %r" % (got, want))
        rc, o, e = run(["compare", "--baseline", os.path.join(t, "base.json"), "--ours", os.path.join(t, "ours.json")], {})
        ok("compare exits 1 when a failure is OURS") if rc == 1 and "OURS" in o else bad("compare rc %d" % rc)
        rc, o, e = run(["compare", "--baseline", os.path.join(t, "base.json"), "--ours", os.path.join(t, "base.json")], {})
        ok("compare exits 0 when nothing is ours") if rc == 0 else bad("compare rc %d on identical runs" % rc)
    finally:
        shutil.rmtree(t, ignore_errors=True)
    pins_agree()
    print()
    if FAILS:
        print("FAIL runner_test: %d" % len(FAILS))
        return 1
    print("PASS runner_test")
    return 0


if __name__ == "__main__":
    sys.exit(main())
