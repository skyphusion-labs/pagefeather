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
                    return self.send(200, {"title": stub.blogname, "timezone": stub.timezone}) if self.rest_ok() else self.send(401, {})
                if self.path.startswith("/wp-json/wp/v2/media?search="):
                    q = self.path.split("search=")[1].split("&")[0]
                    ext = "jpg" if q == "image-01" else "png"
                    return self.send(200, [{"source_url": "https://x/wp-content/uploads/%s.%s" % (q, ext)}] if q in stub.images else [])
                if self.path == "/":
                    n = sum(1 for c in stub.calls if c == ("GET", "/"))
                    return self.send(200, "<html>", [("cf-cache-status", "MISS" if n == 1 else stub.cache)], "text/html")
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

        def case(label, why, suite_name="wc", cache="on", setup=None, env_extra=None, expect_rc=3):
            s = Stub()
            if setup:
                setup(s)
            env = {"WP_USERNAME": "admin", "WP_PASSWORD": s.password, "CUSTOMER_PASSWORD": s.customer_pw, "PATH": os.environ.get("PATH", "")}
            env.update(env_extra or {})
            rd = os.path.join(t, "run-" + re.sub(r"\W+", "-", label))
            rc, o, e = run(["prepare", "--suite", suite_name, "--base-url", s.url, "--cache", cache, "--run-dir", rd], env)
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
        case("cache on, but nothing cached", r"--cache on, but no cached answer", setup=lambda s: setattr(s, "cache", "DYNAMIC"))
        case("cache off, but HIT", r"--cache off, but the page cache answered", cache="off")
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
                         ("PF_CONFORMANCE_CACHE", "on")):
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
            ok("send email preview is the only title exclude") if len(title_rows) == 1 and title_rows[0].path == "email/settings-email.spec.ts" and title_rows[0].title == want_title else bad("title rows: %s" % (title_rows,))
            try:
                ign = json.loads(wct.split("const ignore = ", 1)[1].split(";", 1)[0])
            except (ValueError, IndexError) as e:
                ign = None
                bad("wc ignore list did not parse: %s" % e)
            if ign is not None:
                ok("wc testIgnore lists paypal/paypal.spec.ts") if "paypal/paypal.spec.ts" in ign else bad("paypal missing from testIgnore: %s" % ign)
                ok("wc testIgnore does not drop the email settings file") if not any("settings-email" in x for x in ign) else bad("email file was file-ignored: %s" % ign)
            full = runner.grep_invert_source([("email/settings-email.spec.ts", want_title)])
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
            ok("config %s has no title grepInvert" % sn) if "grepInvert" not in txt else bad("config %s gained a title grepInvert" % sn)
        conn = [r for r in runner.read_excludes("gb") if r.path == "specs/admin/connectors.spec.js"]
        want_why = "code lock denies install_plugins, so connector install stays off"
        ok("gb excludes connectors.spec.js for the code lock") if len(conn) == 1 and conn[0].kind == "file" and conn[0].reason == want_why else bad("connectors row: %s" % (conn,))
        gbt = open(os.path.join(t, "cfg-gb", "pf-conformance.config.mjs")).read()
        ok("gb testIgnore lists connectors.spec.js") if json.dumps("specs/admin/connectors.spec.js") in gbt else bad("gb config lacks connectors.spec.js")
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
        vg = subprocess.run(["bash", os.path.join(HERE, "vps-run.sh"), "install", "gb", os.path.join(t, "vg")],
                            env={"PATH": os.environ.get("PATH", ""), "DRY": "1"}, capture_output=True, text=True)
        vg_out = vg.stdout + vg.stderr
        ok("vps-run install gb: clean, esbuild rebuild, NODE_OPTIONS") if vg.returncode == 0 and "clean:packages" in vg_out and "clean:package-types" in vg_out and "npm rebuild esbuild" in vg_out and "max-old-space-size=6144" in vg_out else bad("vps-run install gb dry: %s" % vg_out[-400:])
        ok("vps-run install gb: CI=true (Gutenberg sequential tsc)") if "CI=true" in vg_out else bad("vps-run install gb: no CI=true in dry output")
        vps_txt = open(os.path.join(HERE, "vps-run.sh")).read()
        ok("vps-run.sh gb: three build attempts on failure") if "for gb_try in 1 2 3" in vps_txt and "gb build failed after 3 attempts" in vps_txt else bad("vps-run.sh gb retry count")
        ok("vps-run.sh gb: clears node_modules/.cache before attempt 3") if "node_modules/.cache" in vps_txt and '[ "$gb_try" = 2 ]' in vps_txt else bad("vps-run.sh gb cache clear")
        ok("vps-run.sh gb: captures build log tail on failure") if "gb_run_build" in vps_txt and "tail -n 30" in vps_txt else bad("vps-run.sh gb log tail")


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
    print()
    if FAILS:
        print("FAIL runner_test: %d" % len(FAILS))
        return 1
    print("PASS runner_test")
    return 0


if __name__ == "__main__":
    sys.exit(main())
