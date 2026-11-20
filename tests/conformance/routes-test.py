#!/usr/bin/env python3
"""#759: routes.py's rules against a stub site (no WordPress). Each kind is produced once and named:
json (pass), a declared zip (pass), json_contaminated, rest_error_5xx, fatal, no_schema on OPTIONS, a route with a
path parameter (listed, not called), a core route missing from the index, and a 400 (a valid REST answer).
The conformance test plugins' namespaces (the store reset, the feature-flag reset) are never called, only listed.
Also: a clean index exits 0; a bad admin password exits 2 before any route is called.
Run: python3 -I tests/conformance/routes-test.py
"""
import base64, json, os, subprocess, sys, tempfile, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
ROUTES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "routes.py")
fails = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:300]))
    if not ok:
        fails.append(name)
GOOD = base64.b64encode(b"admin:apppw").decode()
def mk_index(bad):
    r = {"/ok": "GET", "/needsarg": "GET", "/wp/v2/thing/(?P<id>[\\d]+)": "GET"}
    if bad:
        r.update({"/zip": "GET", "/contam": "GET", "/rest500": "GET", "/fatal": "GET", "/noschema": "POST"})
    else:
        r["/zip"] = "GET"
    idx = {"namespaces": ["t"], "routes": {k: {"namespace": "t", "endpoints": [{"methods": [m]}]} for k, m in r.items()}}
    # sb1120: the test plugins' destructive GETs. routes.py must never call them.
    idx["routes"]["/wc-cleanup/v1/reset"] = {"namespace": "wc-cleanup/v1", "endpoints": [{"methods": ["GET"]}]}
    idx["routes"]["/e2e-feature-flags/reset"] = {"namespace": "e2e-feature-flags", "endpoints": [{"methods": ["GET"]}]}
    return idx
class H(BaseHTTPRequestHandler):
    index = None; calls = None
    def log_message(self, *a): pass
    def reply(self, code, body, ctype="application/json; charset=UTF-8"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def route(self):
        q = self.path.split("rest_route=", 1)
        return q[1].split("&", 1)[0].replace("%28", "(").replace("%29", ")") if len(q) > 1 else None
    def do_GET(self):
        self.calls.append(("GET", self.path))
        if self.path == "/wp-json/":
            return self.reply(200, json.dumps(self.index))
        r = self.route()
        if r == "/wp/v2/users/me":
            return self.reply(200 if self.headers.get("Authorization") == "Basic " + GOOD else 401, '{"id":1}')
        return {"/ok": lambda: self.reply(200, '[]'), "/needsarg": lambda: self.reply(400, '{"code":"rest_missing_callback_param"}'),
                "/zip": lambda: self.reply(200, b"PK\x03\x04zipdata", "application/zip"),
                "/contam": lambda: self.reply(200, '<b>Deprecated</b>: x\n{"a":1}'),
                "/rest500": lambda: self.reply(500, '{"code":"not_available","data":{"status":500}}'),
                "/fatal": lambda: self.reply(500, "<html>There has been a critical error</html>", "text/html")}.get(r, lambda: self.reply(404, '{"code":"rest_no_route"}'))()
    def do_OPTIONS(self):
        self.calls.append(("OPTIONS", self.path))
        r = self.route()
        if r == "/noschema":
            return self.reply(200, '{"x":1}')
        self.reply(200, '{"namespace":"t","endpoints":[]}')
def run(bad, pw="apppw", core_extra=False):
    calls = []
    H.index, H.calls = mk_index(bad), calls
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    d = tempfile.mkdtemp(prefix="routes-test-")
    out = os.path.join(d, "out.json")
    args = [sys.executable, "-I", ROUTES, out]
    if core_extra:
        cf = os.path.join(d, "core.js")
        core = {"routes": {"/ok": {"namespace": "t"}, "/missing": {"namespace": "t"}}}
        open(cf, "w").write("var mockedApiResponse = {};\nmockedApiResponse.Schema = " + json.dumps(core) + ";\n")
        args += ["--core", cf]
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": "http://127.0.0.1:%d" % srv.server_address[1], "WP_PASSWORD": pw}
    p = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
    srv.shutdown()
    res = json.load(open(out)) if os.path.exists(out) else None
    for f in os.listdir(d): os.remove(os.path.join(d, f))
    os.rmdir(d)
    return p, res, calls
p, res, calls = run(True, core_extra=True)
check("a bad index exits 1", p.returncode == 1, (p.returncode, p.stderr[-200:]))
kinds = {(f["route"], f["as"]): f.get("kind", f.get("status")) for f in (res or {}).get("failures", [])}
check("json_contaminated: a JSON type whose body has PHP output first", kinds.get(("/contam", "admin")) == "json_contaminated", kinds)
check("rest_error_5xx: a 5xx REST error object, with its code", kinds.get(("/rest500", "guest")) == "rest_error_5xx" and any(f.get("code") == "not_available" for f in res["failures"]), kinds)
check("fatal: a 5xx that is not a REST error", kinds.get(("/fatal", "admin")) == "fatal", kinds)
check("no_schema: OPTIONS without endpoints", kinds.get(("/noschema", "admin OPTIONS")) == "no_schema", kinds)
check("a core route missing from the index fails", (res or {}).get("missing_core") == ["/missing"], (res or {}).get("missing_core"))
check("a declared zip is a valid answer", ("/zip", "admin") not in kinds and (res or {})["routes"]["/zip"]["admin"]["kind"] == "non_json:application/zip", (res or {}).get("routes", {}).get("/zip"))
check("a 400 is a valid REST answer", ("/needsarg", "guest") not in kinds, kinds)
check("a path-parameter route is listed, never called", any(x["route"].startswith("/wp/v2/thing/") for x in (res or {}).get("param_routes", [])) and not any("thing" in c[1] for c in calls), [c for c in calls if "thing" in c[1]])
check("the test plugins' reset routes are never called (no GET, no OPTIONS), and are listed as skipped",
      not any(("/wc-cleanup/v1/reset" in c[1] or "/e2e-feature-flags/reset" in c[1]) for c in calls)
      and sorted(x["route"] for x in (res or {}).get("skipped", [])) == ["/e2e-feature-flags/reset", "/wc-cleanup/v1/reset"],
      ([c for c in calls if "reset" in c[1]], (res or {}).get("skipped")))
p, res, _ = run(False)
check("a clean index exits 0", p.returncode == 0 and res and res["failures"] == [], (p.returncode, (res or {}).get("failures")))
p, res, calls = run(False, pw="wrong")
check("a bad admin password exits 2 before any route is called", p.returncode == 2 and not any(r in c[1] for c in calls for r in ("/ok", "/zip")), (p.returncode, calls))
print("%d failing" % len(fails))
sys.exit(1 if fails else 0)
