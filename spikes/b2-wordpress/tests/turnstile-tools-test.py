#!/usr/bin/env python3
"""#718: break_lib.login and woo.py's Store API checkout send TURNSTILE_TEST_TOKEN
when it is set, and leave the request alone when it is not.

A local stub (stdlib HTTPServer) answers POST /wp-login.php with 302 only when
the body carries cf-turnstile-response equal to that token, and POST
/?rest_route=/wc/store/v1/checkout with 200 only when the JSON carries
extensions["skyphusion-turnstile"].token. That is the field
skyphusion_turnstile_block_token() reads in php/turnstile-forms.php. Any other
login answer is 200 (the login page again). Any other checkout answer is 400
skyphusion_turnstile_failed.

The login probe calls break_lib.login(). The checkout probe runs woo.py with
login() replaced, so a login failure cannot hide the checkout line. Unset is
the other half: the stub then accepts login and checkout only when those
fields are absent, and woo.py runs with its real login().

  python3 -I spikes/b2-wordpress/tests/turnstile-tools-test.py
"""
import contextlib, http.server, importlib, io, json, os, runpy, sys, threading, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WOO = os.path.join(HERE, "woo.py")
TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
NONCE = b"abcdef0123"

fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (("  " + detail) if detail and not ok else ""))
    if not ok:
        fails += 1
    return ok


class H(http.server.BaseHTTPRequestHandler):
    mode = "require"  # require: the token must match; absent: the field must be missing
    token = TOKEN
    product_name = b"Edge Mug"
    login_token = None
    login_code = None
    checkout_token = None
    checkout_code = None
    account = {}
    unknown = []

    def log_message(self, *a):
        return

    def do_GET(self):
        self.route("GET", b"")

    def do_POST(self):
        self.route("POST", self._body())

    def do_PUT(self):
        self.route("PUT", self._body())

    def _body(self):
        n = int(self.headers.get("Content-Length") or "0")
        return self.rfile.read(n) if n else b""

    def send(self, code, body, extra=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/json" if body[:1] == b"{" else "text/html")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def route(self, method, body):
        path = self.path
        if path == "/ready":
            self.send(200, b"ok")
            return
        if method == "POST" and path.startswith("/wp-login.php"):
            if "action=register" in path:
                self._form_gate(body, "wp-register")
                return
            if "action=lostpassword" in path:
                self._form_gate(body, "wp-lost")
                return
            self._login(body)
            return
        if method == "POST" and path.startswith("/my-account"):
            self._account(body)
            return
        if method == "POST" and "rest_route=/wc/store/v1/checkout" in path:
            self._checkout(body)
            return
        if method == "GET" and path.startswith("/wp-login.php"):
            self.send(200, b"login")
        elif method == "GET" and "action=rest-nonce" in path:
            self.send(200, NONCE)
        elif method == "PUT" and "payment_gateways" in path:
            self.send(200, b'{"enabled":true}')
        elif method == "POST" and "wc-admin/options" in path:
            self.send(200, b"{}")
        elif method == "POST" and "rest_route=/wc/v3/products" in path:
            try:
                H.product_name = json.loads(body.decode()).get("name", "Edge Mug").encode()
            except Exception:
                H.product_name = b"Edge Mug"
            self.send(201, b'{"id":7,"permalink":""}')
        elif method == "GET" and "post_type=product" in path:
            self.send(200, b"<html>" + H.product_name + b"</html>")
        elif method == "GET" and "?p=" in path:
            self.send(200, b"<html>12.50</html>")
        elif method == "GET" and "rest_route=/wc/store/v1/cart" in path:
            self.send(200, b'{"items_count":2}', {"Nonce": "stubnonce", "Cart-Token": "stubcart"})
        elif method == "POST" and "cart/add-item" in path:
            self.send(201, b'{"items_count":2,"totals":{"total_price":"2500"}}')
        elif method == "GET" and "rest_route=/wc/v3/orders/" in path:
            self.send(200, b'{"total":"25.00","status":"processing"}')
        elif method == "GET" and "rest_route=/wc/v3/products/" in path:
            self.send(200, b'{"stock_quantity":18}')
        elif method == "GET" and "page=wc-orders" in path:
            self.send(200, b"orders 42")
        else:
            H.unknown.append("%s %s" % (method, path))
            self.send(404, b"no stub")

    def _posted_login_token(self, body):
        form = urllib.parse.parse_qs(body.decode("utf-8", "replace"))
        vals = form.get("cf-turnstile-response")
        return vals[0] if vals else ""

    def _posted_checkout_token(self, body):
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            return ""
        ext = data.get("extensions") if isinstance(data, dict) else None
        box = ext.get("skyphusion-turnstile") if isinstance(ext, dict) else None
        token = box.get("token") if isinstance(box, dict) else ""
        return token if isinstance(token, str) else ""

    def _accepts(self, got):
        if H.mode == "require":
            return got == H.token and got != ""
        return got == ""

    def _form_token(self, body):
        form = urllib.parse.parse_qs(body.decode("utf-8", "replace"))
        vals = form.get("cf-turnstile-response")
        return vals[0] if vals else "", form

    def _form_gate(self, body, kind):
        got, _form = self._form_token(body)
        H.account[kind] = got
        if self._accepts(got):
            self.send(200, b"ok")
        else:
            self.send(403, b"challenge")

    def _account(self, body):
        got, form = self._form_token(body)
        if "woocommerce-login-nonce" in form:
            kind = "woo-login"
        elif "woocommerce-register-nonce" in form:
            kind = "woo-register"
        elif "woocommerce-lost-password-nonce" in form:
            kind = "woo-lost"
        else:
            kind = "woo-other"
        H.account[kind] = got
        if self._accepts(got):
            self.send(200, b"ok")
        else:
            self.send(403, b"challenge")

    def _login(self, body):
        got = self._posted_login_token(body)
        H.login_token = got
        if self._accepts(got):
            H.login_code = 302
            self.send(302, b"", {"Location": "/wp-admin/"})
        else:
            H.login_code = 200
            self.send(200, b"login")

    def _checkout(self, body):
        got = self._posted_checkout_token(body)
        H.checkout_token = got
        if self._accepts(got):
            H.checkout_code = 200
            self.send(200, b'{"order_id":42,"status":"processing"}')
        else:
            H.checkout_code = 400
            self.send(400, b'{"code":"skyphusion_turnstile_failed","message":"Please complete the challenge to place your order."}')


def reset_seen():
    H.login_token = None
    H.login_code = None
    H.checkout_token = None
    H.checkout_code = None
    H.account = {}
    H.unknown = []


ACCOUNT_POSTS = (
    "post_account_login",
    "post_account_register",
    "post_account_lost_password",
    "post_wp_register",
    "post_wp_lost_password",
)


def post_account_forms(break_lib):
    """Post the five #857 forms. Missing helpers are a failure, not a crash."""
    missing = [n for n in ACCOUNT_POSTS if not hasattr(break_lib, n)]
    if missing:
        return missing, {}
    o = break_lib.opener()
    break_lib.post_account_login(o, "ada", "secret")
    break_lib.post_account_register(o, "ada@example.com")
    break_lib.post_account_lost_password(o, "ada")
    break_lib.post_wp_register(o, "ada", "ada@example.com")
    break_lib.post_wp_lost_password(o, "ada")
    return [], dict(H.account)


def run_woo(break_lib, patch_login):
    real = break_lib.login
    if patch_login:
        def fake_login():
            o = break_lib.opener()
            o.nonce = NONCE.decode()
            return o
        break_lib.login = fake_login
    buf = io.StringIO()
    code = 1
    note = ""
    try:
        with contextlib.redirect_stdout(buf):
            runpy.run_path(WOO, run_name="woo_under_test")
        code = 0
    except SystemExit as e:
        c = e.code
        code = 0 if c in (None, 0) else (c if isinstance(c, int) else 1)
    except Exception as e:
        note = "%s: %s" % (type(e).__name__, e)
        code = 1
    finally:
        break_lib.login = real
    text = buf.getvalue()
    if note:
        text += note + "\n"
    return code, text


def show_woo(text):
    shown = 0
    for line in text.splitlines():
        if line.startswith("FAIL") or "turnstile" in line or line.startswith("AssertionError"):
            print("    " + line)
            shown += 1
            if shown >= 8:
                break
    if H.unknown:
        print("    unknown " + ", ".join(H.unknown))


def main():
    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % srv.server_port
    deadline = time.time() + 2
    while time.time() < deadline:
        try:
            urllib.request.urlopen(base + "/ready", timeout=0.2).read()
            break
        except Exception:
            time.sleep(0.02)
    else:
        raise SystemExit("stub did not start")
    os.environ["B"] = base
    os.environ["ADMIN_PASSWORD"] = "test-password"
    os.environ.pop("TURNSTILE_TEST_TOKEN", None)
    for k in ("SPIKE_TOKEN", "MEM_LEDGER_HDR", "D1_FIRST_FAILURE"):
        os.environ.pop(k, None)
    sys.path.insert(0, HERE)
    import break_lib
    break_lib = importlib.reload(break_lib)
    if break_lib.B != base:
        raise SystemExit("refusing to run: break_lib.B is %s" % break_lib.B)
    try:
        # Unset: a site with no Turnstile still gets the old requests.
        reset_seen()
        H.mode = "absent"
        os.environ.pop("TURNSTILE_TEST_TOKEN", None)
        code, text = run_woo(break_lib, patch_login=False)
        ok = code == 0 and H.login_token == "" and H.checkout_token == "" and H.login_code == 302 and H.checkout_code == 200
        check("unset: login and checkout stay unchanged (no Turnstile field)", ok,
              "exit %s login %s %r checkout %s %r" % (code, H.login_code, H.login_token, H.checkout_code, H.checkout_token))
        if not ok:
            show_woo(text)

        # Token set: login() itself.
        reset_seen()
        H.mode = "require"
        os.environ["TURNSTILE_TEST_TOKEN"] = TOKEN
        login_note = ""
        try:
            break_lib.login()
            login_ok = True
        except AssertionError as e:
            login_ok = False
            login_note = str(e)
        except Exception as e:
            login_ok = False
            login_note = "%s: %s" % (type(e).__name__, e)
        ok = login_ok and H.login_token == TOKEN and H.login_code == 302
        check("token set: login() is 302 only with cf-turnstile-response", ok,
              "code %s field %r %s" % (H.login_code, H.login_token, login_note))

        # Token set: woo.py's checkout line, login replaced so it is reached.
        reset_seen()
        H.mode = "require"
        os.environ["TURNSTILE_TEST_TOKEN"] = TOKEN
        code, text = run_woo(break_lib, patch_login=True)
        ok = code == 0 and H.checkout_token == TOKEN and H.checkout_code == 200
        check("token set: Store API checkout is 2xx only with extensions skyphusion-turnstile.token", ok,
              "exit %s code %s token %r" % (code, H.checkout_code, H.checkout_token))
        if not ok:
            show_woo(text)

        # #857: the same tools send the test token on the account forms (#718).
        reset_seen()
        H.mode = "require"
        os.environ["TURNSTILE_TEST_TOKEN"] = TOKEN
        missing, seen = post_account_forms(break_lib)
        want = {"woo-login": TOKEN, "woo-register": TOKEN, "woo-lost": TOKEN, "wp-register": TOKEN, "wp-lost": TOKEN}
        ok = not missing and seen == want
        check("token set: break_lib sends cf-turnstile-response on the account forms", ok,
              ("missing " + ", ".join(missing)) if missing else "seen %r" % (seen,))

        reset_seen()
        H.mode = "absent"
        os.environ.pop("TURNSTILE_TEST_TOKEN", None)
        missing, seen = post_account_forms(break_lib)
        want_absent = {"woo-login": "", "woo-register": "", "woo-lost": "", "wp-register": "", "wp-lost": ""}
        ok = not missing and seen == want_absent
        check("unset: break_lib account forms stay unchanged (no Turnstile field)", ok,
              ("missing " + ", ".join(missing)) if missing else "seen %r" % (seen,))

        woo_src = open(WOO).read()
        woo_posts = "ACCOUNT_FORMS" in woo_src and "post_account_login" in woo_src and "post_account_register" in woo_src and "post_account_lost_password" in woo_src
        check("woo.py posts the My Account forms when ACCOUNT_FORMS=1", woo_posts, "woo.py does not post them")
        if woo_posts:
            reset_seen()
            H.mode = "require"
            os.environ["TURNSTILE_TEST_TOKEN"] = TOKEN
            os.environ["ACCOUNT_FORMS"] = "1"
            code, text = run_woo(break_lib, patch_login=True)
            got = {k: H.account.get(k) for k in ("woo-login", "woo-register", "woo-lost")}
            ok = code == 0 and got == {"woo-login": TOKEN, "woo-register": TOKEN, "woo-lost": TOKEN}
            check("token set: woo.py My Account forms carry the test token", ok, "exit %s seen %r" % (code, got))
            if not ok:
                show_woo(text)
            os.environ.pop("ACCOUNT_FORMS", None)
    finally:
        srv.shutdown()
        srv.server_close()
    print("%d failing check(s)" % fails)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
