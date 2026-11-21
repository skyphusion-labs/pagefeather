#!/usr/bin/env python3
"""#759: seed.py refuses a site that is not a throwaway, BEFORE any write. No site: a stub on 127.0.0.1.
  1. no marker (pf-conformance/v1/throwaway answers 404): exit 2, named, and no request but GETs;
  2. a marker that names another host: exit 2, the same;
  3. a marker with throwaway false: exit 2;
  4. localhost without SEED_ALLOW_LOCAL=1: refused like any unmarked site (1 covers it on 127.0.0.1);
  5. the right marker but a login that fails: exit 2 "cannot log in", and the only POST is the login form.
  6. --theme: activation_nonce finds the link's nonce in each escaping (&, &amp;, \\u0026), and none for a theme
     that is not on the page or a slug that only shares a prefix.
The full seed (every item set and checked, and a reseed) is verified against a real local site; see the PR.
  7. the block email editor option starts at yes. The seed writes no. The read-back is no (#916).
     A wc-admin 403 on that option still passes when wc/v3 is no.
     The same 403 still fails when wc/v3 stays yes.
  8. a gutenberg-test-plugins plugin left active (a spec that stopped mid-run) is deactivated and read back; a
     deactivation that does not stick fails the seed.
  9. #924: every failed rest-nonce after a form login (admin retries and the customer) is recorded in seed.json
     with the status and the engine headers, and its body is scrubbed.
  10. SEED_NO_WOO=1 on a WordPress-only site: no WooCommerce request, no customer, the items named as skipped; the
       same statement on a site that has wc/v3 fails.
  11. #1151: after a wp run, revoke-all has killed Basic. The form login still works. The creds password
      on wc-cleanup/v1/reset is 401. The seed mints a new application password first, then resets with
      that password, still before any content step. As soon as the reset answers, the seed revokes that
      password (DELETE of its uuid). Nothing named conformance-reset-* remains. A failed revoke stops the seed.
Run: python3 -I tests/conformance/seed-test.py
"""
import hashlib, json, os, re, subprocess, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
SEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed.py")
FAKE_IMAGE = b"\x89PNG\r\n\x1a\n stub image for seed-test"
fails = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:300]))
    if not ok:
        fails.append(name)
class H(BaseHTTPRequestHandler):
    marker = None; seen = None
    def log_message(self, *a): pass
    def reply(self, code, body=b"", ctype="text/html"):
        self.send_response(code); self.send_header("content-type", ctype); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self.seen.append(("GET", self.path))
        if "pf-conformance/v1/throwaway" in self.path and self.marker is not None:
            return self.reply(200, json.dumps(self.marker).encode(), "application/json")
        self.reply(404 if "rest_route" in self.path else 200, b"<html>login</html>")
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0); self.rfile.read(n)
        self.seen.append(("POST", self.path))
        self.reply(200, b"<html>login error</html>")  # a failed login answers 200 with the form
    do_PUT = do_DELETE = do_POST
def run(marker, extra_env=None):
    seen = []
    H.marker, H.seen = marker, seen
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    out = os.path.join(os.environ.get("TMPDIR", "/tmp"), "seed-test-%d" % os.getpid())
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": "http://127.0.0.1:%d" % srv.server_address[1], "ADMIN_PASSWORD": "x"}
    env.update(extra_env or {})
    p = subprocess.run([sys.executable, "-I", SEED, out], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
    srv.shutdown()
    for f in ("creds.env", "seed.json"):
        try: os.remove(os.path.join(out, f))
        except OSError: pass
    try: os.rmdir(out)
    except OSError: pass
    return p, seen
writes = lambda seen: [x for x in seen if x[0] != "GET"]
p, seen = run(None)
check("no marker: exit 2, named", p.returncode == 2 and "has no throwaway marker" in p.stderr, (p.returncode, p.stderr[-200:]))
check("  and nothing but GETs (no write)", not writes(seen), writes(seen))
p, seen = run({"throwaway": True, "host": "ggc.sh"})
check("a marker naming another host: exit 2", p.returncode == 2 and "has no throwaway marker" in p.stderr and not writes(seen), (p.returncode, writes(seen)))
p, seen = run({"throwaway": False, "host": "127.0.0.1"})
check("a marker with throwaway false: exit 2", p.returncode == 2 and not writes(seen), (p.returncode, writes(seen)))
p, seen = run({"throwaway": True, "host": "127.0.0.1"})
w = writes(seen)
check("the right marker, a failed login: exit 2, cannot log in", p.returncode == 2 and "cannot log in" in p.stderr, (p.returncode, p.stderr[-200:]))
check("  and the only write was the login form", w == [("POST", "/wp-login.php")], w)
p, seen = run(None, {"SEED_ALLOW_LOCAL": "1"})
check("127.0.0.1 with SEED_ALLOW_LOCAL=1 passes the gate (then stops at the login)", p.returncode == 2 and "cannot log in" in p.stderr, (p.returncode, p.stderr[-200:]))
# 6. --theme: the activation link, in every escaping themes.php can carry it (joan's review of #819)
import importlib.util
_spec = importlib.util.spec_from_file_location("seed_under_test", SEED); _seed = importlib.util.module_from_spec(_spec)
_argv = sys.argv; sys.argv = ["seed.py"]; _spec.loader.exec_module(_seed); sys.argv = _argv
q = "themes.php?action=activate{a}stylesheet={s}{a}_wpnonce=0a1b2c3d4e"
for label, a in (("plain &", "&"), ("&amp;", "&amp;"), ("JSON \\u0026", "\\u0026")):
    page = ('<a href="' + q.format(a=a, s="twentytwentythree") + '">Activate</a>').encode()
    check("activation_nonce: " + label, _seed.activation_nonce(page, "twentytwentythree") == "0a1b2c3d4e", _seed.activation_nonce(page, "twentytwentythree"))
page = ('"actions":{"activate":"' + q.format(a="\\u0026", s="twentytwentyone") + '"}').encode()
check("activation_nonce: a theme not on the page gives None", _seed.activation_nonce(page, "twentytwentythree") is None)
check("activation_nonce: a prefix slug does not match", _seed.activation_nonce(page, "twentytwenty") is None)
check("activation_nonce: an empty page gives None", _seed.activation_nonce(b"", "twentytwentythree") is None)
check("first_published_link: empty list", _seed.first_published_link([]) == "")
check("first_published_link: missing link", _seed.first_published_link([{}]) == "")
check("first_published_link: first link", _seed.first_published_link([{"link": "https://ex/a"}]) == "https://ex/a")
check("first_published_link: not a list", _seed.first_published_link(None) == "")
check("settings_timezone: timezone key", _seed.settings_timezone({"timezone": "America/Detroit"}) == "America/Detroit")
check("settings_timezone: timezone_string fallback", _seed.settings_timezone({"timezone_string": "America/Detroit"}) == "America/Detroit")
check("settings_timezone: prefer timezone", _seed.settings_timezone({"timezone": "America/Detroit", "timezone_string": "UTC"}) == "America/Detroit")
check("settings_timezone: empty", _seed.settings_timezone({}) == "")
check("settings_timezone: not a dict", _seed.settings_timezone(None) == "")


for label, prefs, want in (
    ("dismissed dict", {"core/edit-post": {"welcomeGuide": False}}, True),
    ("still shown", {"core/edit-post": {"welcomeGuide": True}}, False),
    ("JSON string", '{"core/edit-post":{"welcomeGuide":false}}', True),
    ("bad JSON", "not-json", False),
):
    check("welcome_guide_dismissed: " + label, _seed.welcome_guide_dismissed(prefs) is want, prefs)

# 7. #916: a stored yes must not survive the seed. Woo's default is no.
import base64, urllib.parse
EMAIL_OPT = "woocommerce_feature_block_email_editor_enabled"
check("email option name matches the seed", EMAIL_OPT == _seed.EMAIL_EDITOR_OPT)

hidden = {"code": "woocommerce_rest_cannot_view", "data": {"status": 403}}
check("email_editor_option_ok: wc/v3 no and wc-admin no", _seed.email_editor_option_ok({"value": "no"}, 200, {EMAIL_OPT: "no"}) is True)
check("email_editor_option_ok: wc/v3 no and wc-admin 403", _seed.email_editor_option_ok({"value": "no"}, 403, hidden) is True)
check("email_editor_option_ok: wc/v3 yes and wc-admin 403", _seed.email_editor_option_ok({"value": "yes"}, 403, hidden) is False)
check("email_editor_option_ok: wc/v3 no and wc-admin yes", _seed.email_editor_option_ok({"value": "no"}, 200, {EMAIL_OPT: "yes"}) is False)
check("email_editor_option_ok: other 403 is not a skip", _seed.email_editor_option_ok({"value": "no"}, 403, {"code": "rest_forbidden"}) is False)

STORE_PAGE_IDS = (
    ("woocommerce_shop_page_id", 11, "shop"),
    ("woocommerce_cart_page_id", 12, "cart"),
    ("woocommerce_checkout_page_id", 13, "checkout"),
    ("woocommerce_myaccount_page_id", 14, "my-account"),
)
PLUGINS = (
    "woocommerce-e2e-test-helper/woocommerce-e2e-test-helper",
    "woocommerce-cleanup/woocommerce-cleanup",
    "wp-mail-logging/wp-mail-logging",
    "wc-email-template-sync-test-helper/wc-email-template-sync-test-helper",
)

class Site(BaseHTTPRequestHandler):
    state = None
    def log_message(self, *a):
        pass
    def reply(self, code, body=b"", ctype="application/json"):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        if code in (302, 303):
            self.send_header("location", "/wp-admin/")
        self.end_headers()
        self.wfile.write(body)
    def _json(self, code, obj):
        self.reply(code, json.dumps(obj).encode())
    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw.decode() or "null")
        except ValueError:
            return None
    def _route(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query, keep_blank_values=True)
        return (q.get("rest_route") or [""])[0], q
    def _basic(self):
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Basic "):
            return None
        try:
            raw = base64.b64decode(auth.split(" ", 1)[1]).decode()
            user, pw = raw.split(":", 1)
        except Exception:
            return False
        return pw == self.state["app_pw"] and user == "admin"
    def do_GET(self):
        self._dispatch("GET", None)
    def do_POST(self):
        self._dispatch("POST", self._body())
    def do_PUT(self):
        self._dispatch("PUT", self._body())
    def do_DELETE(self):
        self._dispatch("DELETE", None)
    def _opt_name(self, route):
        prefix = "/wc/v3/settings/advanced/"
        if route.startswith(prefix):
            return route[len(prefix):]
        return ""
    def _dispatch(self, method, body):
        st = self.state
        path = urllib.parse.urlparse(self.path).path
        if "pf-conformance/v1/throwaway" in self.path and method == "GET":
            if st.get("no_marker"):
                return self._json(404, {"code": "rest_no_route"})
            return self._json(200, {"throwaway": True, "host": "127.0.0.1"})
        if path == "/wp-login.php" and method == "GET":
            return self.reply(200, b"<html>login</html>", "text/html")
        if path == "/wp-login.php" and method == "POST":
            return self.reply(302, b"", "text/html")
        if path.startswith("/wp-admin/admin-ajax.php") and "rest-nonce" in self.path:
            st["nonce_calls"] = st.get("nonce_calls", 0) + 1
            if st["nonce_calls"] in st.get("nonce_fail_on", ()):
                # #924: a 500 whose body echoes a secret and a nonce, with the engine headers
                body = ("internal error pw=%s nonce=abcdef0123 tok=QUJDREVGR0hJSktMTU5PUFFSU1RVVg== end" % st["app_pw"]).encode()
                self.send_response(500); self.send_header("content-type", "text/plain")
                for k, v in (("x-pf-call", "11111111-2222-3333-4444-555555555555"), ("x-isolate-reset", "memory"), ("x-write-loss", "1"), ("x-wasm-mib", "121")):
                    self.send_header(k, v)
                self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
                return
            return self.reply(200, b"0123456789", "text/plain")
        # The pinned upstream test images (SEED_GH_API and SEED_GH_RAW point here): the contents API answers the git
        # blob sha, raw answers the bytes. No network.
        if path.startswith("/gh-api/repos/woocommerce/woocommerce/contents/") and method == "GET":
            st.setdefault("gh", []).append("api")
            return self._json(200, {"sha": hashlib.sha1(b"blob %d\0" % len(FAKE_IMAGE) + FAKE_IMAGE).hexdigest()})
        if path.startswith("/gh-raw/woocommerce/woocommerce/") and method == "GET":
            st.setdefault("gh", []).append("raw")
            return self.reply(200, FAKE_IMAGE, "image/png")
        if path.startswith("/wp-content/uploads/") and method == "GET":
            name = path.rsplit("/", 1)[-1]
            return self.reply(404 if name in st.get("missing_files", ()) else 200, b"x", "image/png")
        if path in st.get("drop_paths", ()) and not st.setdefault("dropped", []):
            # a request that gets no HTTP answer at all (the status-0 case): close the socket without a reply
            st["dropped"].append(path)
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass
            return
        if path in ("/wp-json", "/wp-json/"):
            return self._json(200, {"routes": {"/": {}}, "namespaces": list(st.get("namespaces", ["wp/v2", "wc/v3"]))})
        if path == "/wp-admin/options-permalink.php" and method == "GET":
            return self.reply(200, b'<input name="_wpnonce" value="0123456789">', "text/html")
        if path == "/wp-admin/options-permalink.php" and method == "POST":
            return self.reply(200, b"ok", "text/html")
        route, q = self._route()
        if route == "/wc-cleanup/v1/reset":
            # as the real route: it reads the Basic header itself; a cookie session is refused
            st.setdefault("routes", []).append((method, route))
            auth = self.headers.get("Authorization") or ""
            st["reset_auth"] = auth.split(" ", 1)[0] if auth else None
            pw = None
            if auth.startswith("Basic "):
                try:
                    raw = base64.b64decode(auth.split(" ", 1)[1]).decode()
                    _user, pw = raw.split(":", 1)
                except Exception:
                    pw = None
            st.setdefault("reset_basic_pws", []).append(pw)
            # #1151: revoke-all left no application password. Basic with the creds password is 401.
            # Basic with a password this stub just minted is 200. A cookie session stays 403.
            if st.get("revoked_basic"):
                ok = pw is not None and pw in st.get("live_app_pws", ())
                return self._json(200 if ok else 401, {"ok": ok})
            return self._json(200 if auth.startswith("Basic ") else 403, {"ok": True})
        if route:
            st.setdefault("routes", []).append((method, route))
        if st.get("store_pages") and method == "GET" and path in ("/shop/", "/cart/", "/checkout/", "/my-account/"):
            return self.reply(200, b"page", "text/html")
        if not route:
            st["odd"].append((method, self.path))
            return self.reply(404, b"odd")
        opt = self._opt_name(route)
        if not opt and st.get("store_pages") and route.startswith("/wc/v3/settings/products/"):
            opt = route.rsplit("/", 1)[-1]
        if opt:
            if method == "PUT" and isinstance(body, dict) and "value" in body:
                if not (opt == EMAIL_OPT and st.get("freeze_email")):
                    st["options"][opt] = body["value"]
                st["puts"].append((opt, body["value"]))
            val = st["options"].get(opt, "")
            st["reads"].append((opt, val))
            return self._json(200, {"id": opt, "value": val})
        if route == "/wc-admin/options":
            name = (q.get("options") or [""])[0]
            if name == EMAIL_OPT and st.get("wcadmin_forbid"):
                st["reads"].append((name, 403))
                return self._json(403, {
                    "code": "woocommerce_rest_cannot_view",
                    "message": "Sorry, you cannot view this resource.",
                    "data": {"status": 403},
                })
            val = st["options"].get(name, "")
            st["reads"].append((name, val))
            return self._json(200, {name: val})
        if route == "/wp/v2/settings":
            if method == "POST" and isinstance(body, dict):
                for k in ("title", "timezone", "timezone_string"):
                    if k in body:
                        st["settings"][k] = body[k]
            return self._json(200, dict(st["settings"]))
        if route == "/wp/v2/posts":
            return self._json(200, [{"id": 1, "link": "http://127.0.0.1/permalink-probe"}])
        if st.get("store_pages") and route.startswith("/wp/v2/pages/"):
            try:
                pid = int(route.rsplit("/", 1)[-1])
            except ValueError:
                pid = 0
            slug = next((s for _opt, i, s in STORE_PAGE_IDS if i == pid), "")
            if not slug:
                return self._json(404, {"code": "rest_post_invalid_id"})
            return self._json(200, {"id": pid, "status": "publish", "slug": slug, "link": "http://127.0.0.1/%s/" % slug})
        if route.startswith("/wc/v3/customers"):
            if method == "GET":
                return self._json(200, [{"id": 5, "email": "customer@woocommercecoree2etestsuite.com"}])
            return self._json(200, {"id": 5})
        if route == "/wp/v2/users/5":
            if method in ("POST", "PUT") and isinstance(body, dict) and body.get("name"):
                st["customer_name"] = body["name"]
            return self._json(200, {
                "id": 5, "username": "customer", "roles": ["customer"],
                "email": "customer@woocommercecoree2etestsuite.com",
                "first_name": "Jane", "last_name": "Smith",
                "name": st.get("customer_name") or "customer",
            })
        if route in ("/wp/v2/users/me", "/wp/v2/users/1"):
            basic = self._basic()
            if basic is False:
                return self.reply(401, b"")
            if basic is True:
                return self._json(200, {"id": 1, "username": "admin"})
            if method == "POST" and isinstance(body, dict):
                meta = (body.get("meta") or {}).get("persisted_preferences")
                if isinstance(meta, dict):
                    st["prefs"] = meta
                if "password" in body:
                    st["password_set"] = True
            prefs = st["prefs"] or {"core/edit-post": {"welcomeGuide": False}}
            return self._json(200, {"id": 1, "meta": {"persisted_preferences": prefs}})
        if route == "/wp/v2/users/1/application-passwords" and method == "POST":
            # The password WordPress returns. Spaces are not part of the Basic value.
            # The uuid is the one the seed must revoke after the store reset (#1151).
            minted = st["app_pw"].replace(" ", "")
            st.setdefault("live_app_pws", []).append(minted)
            name = body.get("name") if isinstance(body, dict) else ""
            st.setdefault("app_passwords", []).append({"name": name or "", "uuid": st["app_uuid"]})
            return self._json(200, {"password": st["app_pw"], "uuid": st["app_uuid"]})
        if route == "/wp/v2/users/1/application-passwords" and method == "GET":
            return self._json(200, [
                {"name": "conformance-old", "uuid": "old-uuid"},
                {"name": "conformance-new", "uuid": st["app_uuid"]},
            ])
        if route.startswith("/wp/v2/users/1/application-passwords/") and method == "DELETE":
            uuid = route.rsplit("/", 1)[-1]
            if st.get("fail_app_delete"):
                return self._json(500, {"code": "rest_cannot_delete"})
            st["app_passwords"] = [p for p in st.get("app_passwords") or [] if p.get("uuid") != uuid]
            return self._json(200, {"deleted": True})
        if route == "/wp/v2/media" and method == "GET":
            stem = (q.get("search") or ["image"])[0]
            base = "http://127.0.0.1:%d/wp-content/uploads/" % self.server.server_address[1]
            return self._json(200, [{"id": 40 + len(stem), "source_url": base + "%s.png" % stem,
                                     "media_details": {"sizes": {"thumbnail": {"file": "%s-150x150.png" % stem}}}}])
        if route.startswith("/wp/v2/media/") and method == "DELETE":
            st.setdefault("media_deleted", []).append(route)
            return self._json(200, {"deleted": True})
        if route == "/wp/v2/media" and method == "POST":
            st.setdefault("media_posted", []).append(self.headers.get("Content-Disposition") or "")
            return self._json(201, {"id": 99, "source_url": "http://127.0.0.1/wp-content/uploads/x.png"})
        if route == "/wp/v2/plugins":
            gb = st.get("gb", {})
            return self._json(200, [{"plugin": pid, "status": "active"} for pid in PLUGINS] + [{"plugin": k, "status": v} for k, v in gb.items()])
        if route.startswith("/wp/v2/plugins/"):
            pid = route[len("/wp/v2/plugins/"):]
            gb = st.get("gb", {})
            if pid in gb:
                if method == "POST" and isinstance(body, dict) and "status" in body:
                    st.setdefault("gb_posts", []).append((pid, body["status"]))
                    if not st.get("freeze_gb"):
                        gb[pid] = body["status"]
                return self._json(200, {"plugin": pid, "status": gb[pid]})
            return self._json(200, {"plugin": pid, "status": "active"})
        st["odd"].append((method, route))
        return self._json(200, {})

def run_email_editor_seed(extra_env=None, **flags):
    state = {
        "options": {
            "woocommerce_allow_tracking": "no",
            EMAIL_OPT: "yes",
        },
        "started": {EMAIL_OPT: "yes"},
        "settings": {"title": "", "timezone": "", "timezone_string": ""},
        "prefs": None,
        "puts": [],
        "reads": [],
        "odd": [],
        "app_pw": "abcdefghij123456",
        "app_uuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "app_passwords": [],
        "password_set": False,
    }
    state.update(flags)
    if state.get("store_pages"):
        for opt, pid, _slug in STORE_PAGE_IDS:
            state["options"][opt] = str(pid)
    Site.state = state
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    out = os.path.join(os.environ.get("TMPDIR", "/tmp"), "seed-email-%d" % os.getpid())
    stub = "http://127.0.0.1:%d" % srv.server_address[1]
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": stub, "ADMIN_PASSWORD": "x",
           "SEED_GH_API": stub + "/gh-api", "SEED_GH_RAW": stub + "/gh-raw"}
    env.update(extra_env or {})
    p = subprocess.run([sys.executable, "-I", SEED, out], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
    srv.shutdown()
    try:
        state["creds_keys"] = sorted(re.findall(r"^export ([A-Z_]+)=", open(os.path.join(out, "creds.env")).read(), re.M))
    except OSError:
        state["creds_keys"] = None
    report = None
    try:
        report = json.load(open(os.path.join(out, "seed.json")))
    except OSError:
        report = None
    for f in ("creds.env", "seed.json"):
        try:
            os.remove(os.path.join(out, f))
        except OSError:
            pass
    try:
        os.rmdir(out)
    except OSError:
        pass
    return p, state, report

def email_chk(report):
    checks = (report or {}).get("checks", {})
    for name, chk in checks.items():
        if name.startswith(EMAIL_OPT + " = no"):
            return chk
    return None

p, state, report = run_email_editor_seed()
chk = email_chk(report)
check(
    "email editor option: seed writes no and the read-back is no",
    isinstance(chk, dict) and chk.get("ok") is True and state["options"].get(EMAIL_OPT) == "no" and (EMAIL_OPT, "no") in state["puts"] and (EMAIL_OPT, "no") in state["reads"] and state["started"][EMAIL_OPT] == "yes",
    (p.returncode, state["options"].get(EMAIL_OPT), state["puts"], state["reads"], chk, state["odd"][:8], (p.stdout or "")[-400:], (p.stderr or "")[-200:]),
)

def customer_chk(report):
    checks = (report or {}).get("checks", {})
    for name, chk in checks.items():
        if name.startswith("customer:"):
            return chk
    return None

chk_c = customer_chk(report)
check(
    "customer display name is Jane Smith",
    isinstance(chk_c, dict) and chk_c.get("ok") is True and state.get("customer_name") == "Jane Smith" and chk_c.get("display") == "Jane Smith",
    (chk_c, state.get("customer_name")),
)

p, state, report = run_email_editor_seed(wcadmin_forbid=True)
chk = email_chk(report)
check(
    "email editor option: wc-admin 403 passes when wc/v3 is no",
    isinstance(chk, dict) and chk.get("ok") is True and chk.get("wcv3") == "no" and chk.get("wcadmin_status") == 403 and chk.get("wcadmin") == "woocommerce_rest_cannot_view" and state["options"].get(EMAIL_OPT) == "no" and (EMAIL_OPT, "no") in state["puts"] and (EMAIL_OPT, 403) in state["reads"],
    (p.returncode, state["options"].get(EMAIL_OPT), state["puts"], state["reads"], chk),
)

p, state, report = run_email_editor_seed(wcadmin_forbid=True, freeze_email=True)
chk = email_chk(report)
check(
    "email editor option: wc-admin 403 fails when wc/v3 is yes",
    isinstance(chk, dict) and chk.get("ok") is False and chk.get("wcv3") == "yes" and chk.get("wcadmin_status") == 403 and state["options"].get(EMAIL_OPT) == "yes" and (EMAIL_OPT, 403) in state["reads"] and p.returncode == 1,
    (p.returncode, state["options"].get(EMAIL_OPT), state["puts"], state["reads"], chk),
)

GB_LEFT = "gutenberg-test-plugins/default-post-content"
def gb_chk(report):
    return ((report or {}).get("checks", {})).get("gutenberg-test-plugins stay inactive (the specs toggle them)")

p, state, report = run_email_editor_seed(gb={GB_LEFT: "active", "gutenberg-test-plugins/other": "inactive"})
chk = gb_chk(report)
check(
    "gutenberg-test-plugins: a leftover active one is deactivated and read back inactive",
    isinstance(chk, dict) and chk.get("ok") is True and state["gb"][GB_LEFT] == "inactive" and state.get("gb_posts") == [(GB_LEFT, "inactive")] and chk.get("deactivated") == [GB_LEFT],
    (p.returncode, state.get("gb"), state.get("gb_posts"), chk),
)

p, state, report = run_email_editor_seed(gb={GB_LEFT: "active"}, freeze_gb=True)
chk = gb_chk(report)
check(
    "gutenberg-test-plugins: a deactivation that does not stick fails the seed",
    isinstance(chk, dict) and chk.get("ok") is False and chk.get("still_active") == [GB_LEFT] and p.returncode == 1,
    (p.returncode, state.get("gb"), chk),
)

p, state, report = run_email_editor_seed(gb={"gutenberg-test-plugins/other": "inactive"})
check(
    "gutenberg-test-plugins: none active means no write and no check row",
    gb_chk(report) is None and not state.get("gb_posts"),
    (state.get("gb_posts"), gb_chk(report)),
)

files = {"https://ex/u/image-01.jpg": 200, "https://ex/u/image-01-150x150.jpg": 404, "https://ex/u/image-01-300x300.jpg": 200}
item = {"source_url": "https://ex/u/image-01.jpg", "media_details": {"sizes": {"thumbnail": {"file": "image-01-150x150.jpg"}, "woocommerce_thumbnail": {"file": "image-01-300x300.jpg"}, "full": {"file": "image-01.jpg"}}}}
check("image_files_missing: names the sub-size that answers 404", _seed.image_files_missing(item, get=lambda u: files.get(u, 0)) == ["image-01-150x150.jpg"])
check("image_files_missing: none when every file answers 200", _seed.image_files_missing(item, get=lambda u: 200) == [])

p, state, report = run_email_editor_seed()
check("images whose files load: no delete, no upload", not state.get("media_deleted") and not state.get("media_posted"),
      (state.get("media_deleted"), state.get("media_posted")))
p, state, report = run_email_editor_seed(missing_files=["image-02-150x150.png"])
check("an image whose thumbnail answers 404 is deleted (force) and uploaded again, from the stub (no network)",
      any(r.startswith("/wp/v2/media/") for r in state.get("media_deleted", [])) and any("image-02.png" in d for d in state.get("media_posted", []))
      and state.get("gh") == ["api", "raw"],
      (state.get("media_deleted"), state.get("media_posted"), state.get("gh")))

def woo_routes(state):
    return [r for _m, r in state.get("routes", []) if r.startswith("/wc/") or r.startswith("/wc-admin/")]

p, state, report = run_email_editor_seed({"SEED_NO_WOO": "1"}, namespaces=["wp/v2"])
checks = (report or {}).get("checks", {})
skipped = sorted(k for k, v in checks.items() if isinstance(v, dict) and v.get("ok") is None and "SEED_NO_WOO" in str(v.get("skipped")))
check(
    "SEED_NO_WOO=1 on a site with no wc/v3: exit 0, no WooCommerce request, no customer in creds.env, the items named as skipped",
    p.returncode == 0 and woo_routes(state) == [] and state["creds_keys"] == ["WP_PASSWORD", "WP_USERNAME"] and len(skipped) >= 3
    and (checks.get("SEED_NO_WOO=1: the site has no WooCommerce (no wc/v3 namespace)") or {}).get("ok") is True,
    (p.returncode, woo_routes(state)[:6], state["creds_keys"], skipped, (report or {}).get("failed")),
)

p, state, report = run_email_editor_seed({"SEED_NO_WOO": "1"})
check(
    "SEED_NO_WOO=1 on a site that HAS wc/v3: the seed fails",
    p.returncode == 1 and "SEED_NO_WOO=1: the site has no WooCommerce (no wc/v3 namespace)" in ((report or {}).get("failed") or []),
    (p.returncode, (report or {}).get("failed")),
)

p, state, report = run_email_editor_seed(namespaces=["wp/v2"])
check(
    "no SEED_NO_WOO: the WooCommerce items run as before (wc/v3 is asked, the customer is in creds.env)",
    any(r.startswith("/wc/v3/") for r in woo_routes(state)) and state["creds_keys"] == ["CUSTOMER_PASSWORD", "CUSTOMER_USERNAME", "WP_PASSWORD", "WP_USERNAME"],
    (woo_routes(state)[:4], state["creds_keys"]),
)

# #924: login order in a full seed: the first admin login (1), the customer (2), the admin after its password write (3).
p, state, report = run_email_editor_seed(nonce_fail_on={3})
rows = (report or {}).get("rest_nonce_failures") or []
admin_chk = ((report or {}).get("checks") or {}).get("admin: the account password IS the application password (form login)") or {}
blob = json.dumps(rows)
check("#924: a hidden admin retry 500 is recorded, with the engine headers",
      len(rows) == 1 and rows[0].get("who") == "admin" and rows[0].get("status") == 500 and rows[0].get("x-pf-call") == "11111111-2222-3333-4444-555555555555"
      and rows[0].get("x-isolate-reset") == "memory" and rows[0].get("x-write-loss") == "1" and rows[0].get("x-wasm-mib") == "121"
      and admin_chk.get("login_attempts") == 2 and admin_chk.get("ok") is True, (rows, admin_chk))
check("#924: the recorded body has no password, nonce or token", state["app_pw"] not in blob and "abcdef0123" not in blob and "QUJDREVG" not in blob and "internal error" in blob, blob)
p, state, report = run_email_editor_seed(nonce_fail_on={2})
rows = (report or {}).get("rest_nonce_failures") or []
check("#924: a customer login 500 is recorded too", len(rows) == 1 and rows[0].get("who") == "customer" and rows[0].get("status") == 500, rows)
p, state, report = run_email_editor_seed()
check("#924: no failure, no rows", not (report or {}).get("rest_nonce_failures"), (report or {}).get("rest_nonce_failures"))

p, state, report = run_email_editor_seed(drop_paths=["/wp-json/"])
ne = (report or {}).get("network_errors") or []
idx_chk = ((report or {}).get("checks") or {}).get("permalinks: a raw GET /wp-json/ is the REST index") or {}
check("a status-0 request keeps its exception text in seed.json network_errors",
      state.get("dropped") == ["/wp-json/"] and idx_chk.get("status") == 0 and len(ne) == 1 and ne[0].get("path") == "/wp-json/"
      and ne[0].get("method") == "GET" and "RemoteDisconnected" in (ne[0].get("error") or ""), (ne, idx_chk))
p, state, report = run_email_editor_seed()
check("no network failure, no network_errors", not (report or {}).get("network_errors"), (report or {}).get("network_errors"))

def auth_restore_route(route):
    """User and application-password routes. They restore Basic. They are not content."""
    if route in ("/wp/v2/users/me", "/wp/v2/users/1"):
        return True
    return route.startswith("/wp/v2/users/1/application-passwords")

def content_before_reset(pairs):
    """REST routes before the store reset that are not the Basic restore."""
    routes = [r for _m, r in pairs]
    if "/wc-cleanup/v1/reset" not in routes:
        return routes
    before = pairs[:routes.index("/wc-cleanup/v1/reset")]
    return [r for _m, r in before if not auth_restore_route(r)]

def conformance_reset_left(state):
    """Names of conformance-reset-* application passwords the stub still holds."""
    return [p.get("name") for p in state.get("app_passwords") or [] if (p.get("name") or "").startswith("conformance-reset-")]

# SEED_RESET_STORE=1: restore Basic, then reset the store, still before any content step.
# Without the variable there is no reset at all.
p, state, report = run_email_editor_seed({"SEED_RESET_STORE": "1"})
pairs = state.get("routes") or []
rts = [r for _m, r in pairs]
chk = ((report or {}).get("checks") or {}).get("store reset first (SEED_RESET_STORE, wc-cleanup/v1/reset)") or {}
reset_at = rts.index("/wc-cleanup/v1/reset") if "/wc-cleanup/v1/reset" in rts else -1
before = pairs[:reset_at] if reset_at >= 0 else pairs
check("SEED_RESET_STORE: Basic is restored, then the reset, before any content step, and it is recorded",
      reset_at >= 0 and content_before_reset(pairs) == []
      and ("POST", "/wp/v2/users/1/application-passwords") in before
      and chk.get("ok") is True and state.get("reset_auth") == "Basic"
      and (report or {}).get("store_reset", {}).get("status") == 200
      and state.get("reset_basic_pws") == [state["app_pw"]],
      (rts[:4], state.get("reset_basic_pws"), chk, state.get("reset_auth")))
reset_uuid = state.get("app_uuid") or ""
delete_route = "/wp/v2/users/1/application-passwords/" + reset_uuid
after = pairs[reset_at + 1:] if reset_at >= 0 else []
check("#1151: after the reset, the stub saw DELETE for that uuid, and no conformance-reset-* password remains",
      reset_at >= 0 and after[:1] == [("DELETE", delete_route)] and conformance_reset_left(state) == [],
      (after[:4], conformance_reset_left(state)))

# #1151: the creds password is not an application password anymore. Form login still works.
# store_pages lets the rest of the seed finish, so a reset 401 is the failure that stops it.
p, state, report = run_email_editor_seed({"SEED_RESET_STORE": "1"}, revoked_basic=True, store_pages=True)
pairs = state.get("routes") or []
rts = [r for _m, r in pairs]
chk = ((report or {}).get("checks") or {}).get("store reset first (SEED_RESET_STORE, wc-cleanup/v1/reset)") or {}
reset_at = rts.index("/wc-cleanup/v1/reset") if "/wc-cleanup/v1/reset" in rts else -1
before = pairs[:reset_at] if reset_at >= 0 else pairs
check("#1151: a revoked Basic auth is restored, then the store resets, before any content step",
      p.returncode == 0 and chk.get("ok") is True and state.get("reset_auth") == "Basic"
      and (report or {}).get("store_reset", {}).get("status") == 200
      and state.get("reset_basic_pws") == [state["app_pw"]]
      and ("POST", "/wp/v2/users/1/application-passwords") in before
      and content_before_reset(pairs) == []
      and reset_at >= 0 and "/wp/v2/settings" in rts[reset_at + 1:],
      (p.returncode, rts[:6], state.get("reset_basic_pws"), content_before_reset(pairs), chk, (report or {}).get("failed")))
p, state, report = run_email_editor_seed({"SEED_RESET_STORE": "1"}, fail_app_delete=True)
left = conformance_reset_left(state)
err = p.stderr or ""
check("#1151: a failed revoke stops the seed and says the application password is still on the site",
      p.returncode == 1 and left != [] and "still on the site" in err and "The seed is stopping." in err
      and state["app_pw"] not in err,
      (p.returncode, left, err[-240:]))
p, state, report = run_email_editor_seed({"SEED_RESET_STORE": "1", "SEED_ALLOW_LOCAL": "1"}, no_marker=True)
check("SEED_RESET_STORE on a local site without the marker: refused (2), no reset",
      p.returncode == 2 and "/wc-cleanup/v1/reset" not in [r for _m, r in state.get("routes", [])] and "needs the throwaway marker" in (p.stdout + p.stderr), (p.returncode, (p.stdout + p.stderr)[-200:]))
p, state, report = run_email_editor_seed()
check("no SEED_RESET_STORE: the store is never reset", "/wc-cleanup/v1/reset" not in [r for _m, r in state.get("routes", [])], [r for _m, r in state.get("routes", [])][:3])

page = {"id": 7, "status": "publish", "slug": "cart", "link": "https://ex/cart/"}
check("wc_store_page_ok: published cart", _seed.wc_store_page_ok(7, page, "cart") is True)
check("wc_store_page_ok: string id", _seed.wc_store_page_ok("7", page, "cart") is True)
check("wc_store_page_ok: no trailing slash", _seed.wc_store_page_ok(7, dict(page, link="https://ex/cart"), "cart") is True)
check("wc_store_page_ok: home link is not the cart", _seed.wc_store_page_ok(7, dict(page, link="https://ex/?page_id=7"), "cart") is False)
check("wc_store_page_ok: missing page", _seed.wc_store_page_ok(7, None, "cart") is False)
check("wc_store_page_ok: other id", _seed.wc_store_page_ok(7, dict(page, id=8), "cart") is False)
check("wc_store_page_ok: draft", _seed.wc_store_page_ok(7, dict(page, status="draft"), "cart") is False)
check("wc_store_page_ok: zero option", _seed.wc_store_page_ok(0, page, "cart") is False)
rows = [(7, page, "cart"), (None, None, "checkout")]
check("wc_store_pages_missing: names the dead slug", _seed.wc_store_pages_missing(rows) == ["checkout"])

def fake_rest(route):
    if route.endswith("woocommerce_cart_page_id"):
        return 200, {"value": 7}
    if route.endswith("/pages/7"):
        return 200, page
    return 404, {"code": "rest_post_invalid_id"}

got = _seed.fetch_wc_store_pages(fake_rest)
check("fetch_wc_store_pages: four rows", len(got) == 4 and got[1][2] == "cart" and got[1][1]["id"] == 7, got)
check("fetch_wc_store_pages: a dead id is missing", _seed.wc_store_pages_missing(got) == ["shop", "checkout", "my-account"])

check("wc_public_page_ok: cart 200", _seed.wc_public_page_ok("cart", 200, "") is True)
check("wc_public_page_ok: cart 404", _seed.wc_public_page_ok("cart", 404, "") is False)
check("wc_public_page_ok: empty checkout redirects to cart", _seed.wc_public_page_ok("checkout", 302, "https://ex/cart/") is True)
check("wc_public_page_ok: checkout redirect home is not the store", _seed.wc_public_page_ok("checkout", 302, "https://ex/") is False)
check("wc_public_page_ok: checkout 200", _seed.wc_public_page_ok("checkout", 200, "") is True)
print("%d failing" % len(fails))
sys.exit(1 if fails else 0)
