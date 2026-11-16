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
        self.password = "Operator-Pass-1!"
        self.marker = "self"     # self | none | other
        self.basic = "ok"        # ok | always401 | ignores
        self.cache = "HIT"       # what cf-cache-status says on the 2nd and 3rd guest GET
        self.app = None
        self.calls = []
        self.options = {}
        self.media = 0
        self.users = {}
        self.nonce = "0a1b2c3d4e"
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
                return "wordpress_logged_in_x=admin" in (self.headers.get("Cookie") or "")

            def rest_ok(self):
                return self.logged_in() and self.headers.get("X-WP-Nonce") == stub.nonce

            def body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(n)

            def do_GET(self):
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
                        if stub.basic == "ignores" or (u == "admin" and p == stub.app):
                            return self.send(200, {"id": 1})
                        return self.send(401, {"code": "incorrect_password"})
                    return self.send(401, {"code": "rest_not_logged_in"})
                if self.path.startswith("/wp-json/wp/v2/users?search=customer"):
                    return self.send(200, [{"id": 7, "username": "customer"}] if "customer" in stub.users else [])
                if self.path == "/":
                    n = sum(1 for c in stub.calls if c == ("GET", "/"))
                    return self.send(200, "<html>", [("cf-cache-status", "MISS" if n == 1 else stub.cache)], "text/html")
                self.send(404, {})

            def do_POST(self):
                b = self.body()
                stub.calls.append(("POST", self.path))
                if self.path == "/wp-login.php":
                    f = dict(x.split("=", 1) for x in b.decode().split("&"))
                    from urllib.parse import unquote_plus
                    if unquote_plus(f.get("log", "")) == "admin" and unquote_plus(f.get("pwd", "")) == stub.password:
                        return self.send(302, "", [("Set-Cookie", "wordpress_logged_in_x=admin; Path=/"), ("Location", "/wp-admin/")])
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
        suite = os.path.join(t, "wc-e2e")
        os.makedirs(os.path.join(suite, "test-data", "images"))
        for i in (1, 2, 3):
            with open(os.path.join(suite, "test-data", "images", "image-0%d.png" % i), "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n" + bytes([i]))

        def case(label, why, suite_name="wc", cache="on", setup=None, env_extra=None, expect_rc=3):
            s = Stub()
            if setup:
                setup(s)
            env = {"WP_USERNAME": "admin", "WP_PASSWORD": "Operator-Pass-1!", "PATH": os.environ.get("PATH", "")}
            env.update(env_extra or {})
            rd = os.path.join(t, "run-" + re.sub(r"\W+", "-", label))
            rc, o, e = run(["prepare", "--suite", suite_name, "--base-url", s.url, "--cache", cache, "--run-dir", rd,
                            "--suite-dir", suite], env)
            s.close()
            secrets = [x for x in ("Operator-Pass-1!", s.app) if x]
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
        case("a wrong admin password", r"form did not log the admin in.*Turnstile", env_extra={"WP_PASSWORD": "wrong"})
        case("no WP_PASSWORD", r"WP_PASSWORD is not set", env_extra={"WP_PASSWORD": ""})
        case("cache on, but nothing cached", r"--cache on, but no cached answer", setup=lambda s: setattr(s, "cache", "DYNAMIC"))
        case("cache off, but HIT", r"--cache off, but the page cache answered", cache="off")
        # Basic auth (#761).
        s, _ = case("Basic always 401 (#761)", r"returned 401, not 200.*#761", setup=lambda s: setattr(s, "basic", "always401"))
        if s.password == "Operator-Pass-1!":
            ok("#761 stop: the operator's account password is unchanged")
        else:
            bad("#761 stop: the account password was changed before the stop")
        case("Basic ignores the password", r"WRONG password returned 200, not 401", setup=lambda s: setattr(s, "basic", "ignores"))
        # The happy paths.
        s, rd = case("wc happy path", None, expect_rc=0)
        envf = os.path.join(rd, "env")
        mode = stat.S_IMODE(os.stat(envf).st_mode) if os.path.exists(envf) else None
        ok("env is mode 600") if mode == 0o600 else bad("env mode is %r" % (oct(mode) if mode else None))
        env_text = open(envf).read() if mode else ""
        for want in ("export ADMIN_PASSWORD=%s" % s.app, "export WP_PASSWORD=%s" % s.app, "export ADMIN_USER=admin",
                     "export BASE_URL=%s" % s.url, "export CUSTOMER_USER=customer", "export PF_CONFORMANCE_CACHE=on"):
            ok("env has %s" % want.split("=")[0]) if want in env_text else bad("env lacks %s" % want.split("=")[0])
        ok("the account password became the app password") if s.password == s.app else bad("account password not changed")
        cp = re.search(r"export CUSTOMER_PASSWORD=(\S+)", env_text)
        ok("the customer password in env is the one the site got") if cp and s.users.get("customer", {}).get("password") == cp.group(1) else bad("customer password mismatch")
        want_opts = {"blogname": "WooCommerce Core E2E Test Suite", "woocommerce_allow_tracking": "yes",
                     "permalink_structure": "/%postname%/", "rewrite_rules": None}
        ok("options set, rewrite_rules emptied") if s.options == want_opts else bad("options are %r" % s.options)
        ok("3 images uploaded") if s.media == 3 else bad("%d images uploaded" % s.media)
        s, rd = case("wp happy path (cache off, no Basic, no WooCommerce setup)", None, suite_name="wp", cache="off",
                     setup=lambda s: setattr(s, "cache", "DYNAMIC"), expect_rc=0)
        env_text = open(os.path.join(rd, "env")).read()
        ok("wp: WP_PASSWORD is the operator's own") if "export WP_PASSWORD='Operator-Pass-1!'" in env_text else bad("wp: WP_PASSWORD wrong")
        ok("wp: no application password, no setup calls") if s.app is None and not s.options and not s.media else bad("wp: it ran WooCommerce setup")
        # An existing customer is updated, not a failure.
        def pre(s):
            s.users["customer"] = {"username": "customer", "password": "old"}
        s, rd = case("wc with an existing customer", None, setup=pre, expect_rc=0)
        ok("existing customer: password updated") if s.users["customer"]["password"] != "old" else bad("existing customer not updated")

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
        ok("wc config drops blocks/**") if '"blocks/**"' in open(os.path.join(t, "cfg-wc", "pf-conformance.config.mjs")).read() else bad("wc config lacks blocks/**")

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
