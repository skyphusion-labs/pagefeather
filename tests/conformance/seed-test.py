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
Run: python3 -I tests/conformance/seed-test.py
"""
import json, os, subprocess, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
SEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed.py")
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
            return self._json(200, {"throwaway": True, "host": "127.0.0.1"})
        if path == "/wp-login.php" and method == "GET":
            return self.reply(200, b"<html>login</html>", "text/html")
        if path == "/wp-login.php" and method == "POST":
            return self.reply(302, b"", "text/html")
        if path.startswith("/wp-admin/admin-ajax.php") and "rest-nonce" in self.path:
            return self.reply(200, b"0123456789", "text/plain")
        if path in ("/wp-json", "/wp-json/"):
            return self._json(200, {"routes": {"/": {}}})
        if path == "/wp-admin/options-permalink.php" and method == "GET":
            return self.reply(200, b'<input name="_wpnonce" value="0123456789">', "text/html")
        if path == "/wp-admin/options-permalink.php" and method == "POST":
            return self.reply(200, b"ok", "text/html")
        route, q = self._route()
        if not route:
            st["odd"].append((method, self.path))
            return self.reply(404, b"odd")
        opt = self._opt_name(route)
        if opt:
            if method == "PUT" and isinstance(body, dict) and "value" in body:
                st["options"][opt] = body["value"]
                st["puts"].append((opt, body["value"]))
            val = st["options"].get(opt, "")
            st["reads"].append((opt, val))
            return self._json(200, {"id": opt, "value": val})
        if route == "/wc-admin/options":
            name = (q.get("options") or [""])[0]
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
        if route.startswith("/wc/v3/customers"):
            if method == "GET":
                return self._json(200, [{"id": 5, "email": "customer@woocommercecoree2etestsuite.com"}])
            return self._json(200, {"id": 5})
        if route == "/wp/v2/users/5":
            return self._json(200, {
                "id": 5, "username": "customer", "roles": ["customer"],
                "email": "customer@woocommercecoree2etestsuite.com",
                "first_name": "Jane", "last_name": "Smith",
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
            return self._json(200, {"password": st["app_pw"], "uuid": st["app_uuid"]})
        if route == "/wp/v2/users/1/application-passwords" and method == "GET":
            return self._json(200, [
                {"name": "conformance-old", "uuid": "old-uuid"},
                {"name": "conformance-new", "uuid": st["app_uuid"]},
            ])
        if route.startswith("/wp/v2/users/1/application-passwords/") and method == "DELETE":
            return self._json(200, {"deleted": True})
        if route == "/wp/v2/media":
            stem = (q.get("search") or ["image"])[0]
            return self._json(200, [{"source_url": "http://127.0.0.1/wp-content/uploads/%s.png" % stem}])
        if route == "/wp/v2/plugins":
            return self._json(200, [{"plugin": pid, "status": "active"} for pid in PLUGINS])
        if route.startswith("/wp/v2/plugins/"):
            pid = route[len("/wp/v2/plugins/"):]
            return self._json(200, {"plugin": pid, "status": "active"})
        st["odd"].append((method, route))
        return self._json(200, {})

def run_email_editor_seed():
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
        "password_set": False,
    }
    Site.state = state
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    out = os.path.join(os.environ.get("TMPDIR", "/tmp"), "seed-email-%d" % os.getpid())
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": "http://127.0.0.1:%d" % srv.server_address[1], "ADMIN_PASSWORD": "x"}
    p = subprocess.run([sys.executable, "-I", SEED, out], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
    srv.shutdown()
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

p, state, report = run_email_editor_seed()
chk_name = EMAIL_OPT + " = no (wc/v3 settings and wc-admin/options)"
chk = (report or {}).get("checks", {}).get(chk_name)
check(
    "email editor option: seed writes no and the read-back is no",
    isinstance(chk, dict) and chk.get("ok") is True and state["options"].get(EMAIL_OPT) == "no" and (EMAIL_OPT, "no") in state["puts"] and (EMAIL_OPT, "no") in state["reads"] and state["started"][EMAIL_OPT] == "yes",
    (p.returncode, state["options"].get(EMAIL_OPT), state["puts"], state["reads"], chk, state["odd"][:8], (p.stdout or "")[-400:], (p.stderr or "")[-200:]),
)

print("%d failing" % len(fails))
sys.exit(1 if fails else 0)
