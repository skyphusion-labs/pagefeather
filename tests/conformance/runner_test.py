#!/usr/bin/env python3
"""Test runner.py against a stub WordPress (local http, no network, no real site).

    python3 -I tests/conformance/runner_test.py

The stub can play: no marker, a marker for another host, Basic always 401 (#761), Basic that
ignores the password, the page cache on or off. Every STOP must name its reason, and no
password may reach stdout or stderr.
"""
import base64, http.server, io, json, os, re, shutil, subprocess, sys, tempfile, threading, contextlib, stat

HERE = os.path.dirname(os.path.abspath(__file__))
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
        self.images = ["image-01", "image-02", "image-03"]
        self.customer_role = "customer"
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
                return re.search(r"wordpress_logged_in_x=(admin|customer)", self.headers.get("Cookie") or "") is not None

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
                            return self.send(200, {"id": 1})
                        return self.send(401, {"code": "incorrect_password"})
                    return self.send(401, {"code": "rest_not_logged_in"})
                if self.path == "/wp-admin/":
                    c = self.headers.get("Cookie") or ""
                    if stub.admin_form:
                        return self.send(200, '<form name="loginform" id="loginform">', ctype="text/html")
                    if "wordpress_logged_in_x=admin" in c:
                        return self.send(200, "<html>Dashboard</html>", ctype="text/html")
                    if "wordpress_logged_in_x=customer" in c:
                        return self.send(302, "", [("Location", "/my-account/")])
                    return self.send(302, "", [("Location", "/wp-login.php?redirect_to=%2Fwp-admin%2F&reauth=1")])
                if self.path == "/wp-json/":
                    return self.send(200, {"namespaces": ["wp/v2", "wc/v3"]})
                if self.path.startswith("/wp-json/wp/v2/users?search=customer"):
                    if not self.rest_ok():
                        return self.send(401, {})
                    return self.send(200, [{"id": 7, "username": "customer", "roles": [stub.customer_role]}] if stub.customer_role else [])
                if self.path == "/wp-json/wp/v2/settings":
                    return self.send(200, {"title": stub.blogname}) if self.rest_ok() else self.send(401, {})
                if self.path.startswith("/wp-json/wp/v2/media?search="):
                    q = self.path.split("search=")[1].split("&")[0]
                    return self.send(200, [{"source_url": "https://x/wp-content/uploads/%s.png" % q}] if q in stub.images else [])
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
                    if (log, pwd) in (("admin", stub.password), ("customer", stub.customer_pw)):
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
        case("a wrong CUSTOMER_PASSWORD", r"customer cannot log in", env_extra={"CUSTOMER_PASSWORD": "nope"})
        case("the wrong blogname", r"blogname is 'My Site'", setup=lambda s: setattr(s, "blogname", "My Site"))
        case("plain permalinks (#760)", r"pretty permalinks are not active", setup=lambda s: setattr(s, "plain", True))
        case("a missing test image", r"no media image-02.png", setup=lambda s: setattr(s, "images", ["image-01", "image-03"]))
        # The happy paths.
        s, rd = case("wc happy path (a seeded site)", None, expect_rc=0)
        envf = os.path.join(rd, "env")
        mode = stat.S_IMODE(os.stat(envf).st_mode) if os.path.exists(envf) else None
        ok("env is mode 600") if mode == 0o600 else bad("env mode is %r" % (oct(mode) if mode else None))
        env_text = open(envf).read() if mode else ""
        for want in ("export ADMIN_PASSWORD=%s" % s.password, "export WP_PASSWORD=%s" % s.password, "export ADMIN_USER=admin",
                     "export BASE_URL=%s" % s.url, "export CUSTOMER_USER=customer", "export CUSTOMER_PASSWORD=%s" % s.customer_pw,
                     "export PF_CONFORMANCE_CACHE=on"):
            ok("env has %s" % want.split("=")[0]) if want in env_text else bad("env lacks %s" % want.split("=")[0])
        ok("no application password was created") if s.app is None else bad("the runner created an application password")
        rc, o, e = run(["prepare", "--suite", "wc", "--base-url", Stub().url, "--cache", "on", "--run-dir", os.path.join(t, "x")],
                       {"WP_PASSWORD": "SeedAppPass24CharsAbCdEf", "CUSTOMER_PASSWORD": "Cust-Pass-9"})
        ok("tracking is reported NOT VERIFIED, never as checked") if "woocommerce_allow_tracking: NOT VERIFIED" in o else bad("tracking line missing")
        s, rd = case("wp happy path (cache off, plain permalinks, no WooCommerce checks)", None, suite_name="wp", cache="off",
                     setup=lambda s: (setattr(s, "cache", "DYNAMIC"), setattr(s, "plain", True), setattr(s, "customer_role", None)), expect_rc=0)
        env_text = open(os.path.join(rd, "env")).read()
        ok("wp: WP_PASSWORD is the operator's own") if "export WP_PASSWORD=SeedAppPass24CharsAbCdEf" in env_text else bad("wp: WP_PASSWORD wrong")
        ok("wp: no customer or Basic checks") if not any(c[1].startswith("/wp-json/wp/v2/users") for c in s.calls) else bad("wp: it ran WooCommerce checks")

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

        # rest_path, directly.
        for got, want in ((runner.rest_path("/wp-json/wp/v2/users/me?context=edit"), "/?rest_route=/wp/v2/users/me&context=edit"),
                          (runner.rest_path("/wp-json/pf-conformance/v1/throwaway"), "/?rest_route=/pf-conformance/v1/throwaway"),
                          (runner.rest_path("/wp-login.php"), "/wp-login.php")):
            ok("rest_path %s" % want) if got == want else bad("rest_path gave %s, want %s" % (got, want))

        # config: one file per suite, it parses, and it carries the exclusions.
        node = shutil.which("node")
        for sn, up in runner.UPSTREAM_CONFIG.items():
            d = os.path.join(t, "cfg-" + sn)
            os.makedirs(d)
            open(os.path.join(d, up), "w").write("export default {};\n")
            rc, o, e = run(["config", "--suite", sn, "--suite-dir", d, "--run-dir", os.path.join(t, "r")], {"PATH": os.environ.get("PATH", "")})
            p = os.path.join(d, "pf-conformance.config.mjs")
            txt = open(p).read() if os.path.exists(p) else ""
            excl = [x for x, _ in runner.read_excludes(sn)]
            if rc == 0 and all(json.dumps(x) in txt for x in excl) and "webServer: undefined" in txt and "workers: 1" in txt:
                ok("config %s: %d exclusions, webServer off, one worker" % (sn, len(excl)))
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
        for sn in ("wp", "gb"):
            txt = open(os.path.join(t, "cfg-" + sn, "pf-conformance.config.mjs")).read()
            want = "config.globalSetup = [ base.globalSetup, %s ]" % json.dumps(os.path.join(HERE, "assert-login.mjs"))
            ok("config %s: the login assert runs after the upstream globalSetup" % sn) if want in txt else bad("config %s: no login assert" % sn)
        if node:
            r = subprocess.run([node, "--check", os.path.join(HERE, "assert-login.mjs")], capture_output=True, text=True)
            ok("assert-login.mjs: node --check") if r.returncode == 0 else bad("assert-login.mjs: %s" % r.stderr.strip()[:120])

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
