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

for label, prefs, want in (
    ("dismissed dict", {"core/edit-post": {"welcomeGuide": False}}, True),
    ("still shown", {"core/edit-post": {"welcomeGuide": True}}, False),
    ("JSON string", '{"core/edit-post":{"welcomeGuide":false}}', True),
    ("bad JSON", "not-json", False),
):
    check("welcome_guide_dismissed: " + label, _seed.welcome_guide_dismissed(prefs) is want, prefs)
print("%d failing" % len(fails))
sys.exit(1 if fails else 0)
