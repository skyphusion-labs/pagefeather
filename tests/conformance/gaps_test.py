#!/usr/bin/env python3
"""gaps.py (#759): our replacement for the excluded wordpress-develop fatal-error-handler spec, against a local
stand-in site. Run: python3 -I tests/conformance/gaps_test.py"""
import http.server, json, os, sys, tempfile, threading, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import runner, gaps, matrix
runner.REQUIRE_HTTPS = False  # the stand-in is plain http on localhost

fails = 0
def ok(label, cond, detail=""):
    global fails
    print(("PASS " if cond else "FAIL ") + label + (("  (" + str(detail)[:200] + ")") if (detail and not cond) else ""))
    fails += 0 if cond else 1

HANDLER = "<p>There has been a critical error on this website.</p>"
class Stand(http.server.BaseHTTPRequestHandler):
    mode = "handler"; marker = True; seen = []; served = 0
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        Stand.seen.append(self.path)
        if "/pf-conformance/v1/throwaway" in self.path:
            if not Stand.marker: return self.send(404, "{}", "application/json")
            return self.send(200, json.dumps({"throwaway": True, "host": "127.0.0.1"}), "application/json")
        if q.get("pf_conformance") == ["fatal"]:
            if Stand.mode in ("handler", "dies"): return self.send(500, "<b>Fatal error</b>: Uncaught Error " + HANDLER)
            if Stand.mode == "quiet": return self.send(500, HANDLER)
            if Stand.mode == "bare": return self.send(500, "error code: 1101")
            if Stand.mode == "ok200": return self.send(200, HANDLER)
            return self.send(200, "<html>home</html>")
        Stand.served += 1
        if Stand.mode == "dies" and Stand.served > 1: return self.send(500, "error code: 1101")
        return self.send(200, "<html>home</html>")
    def send(self, code, body, ctype="text/html"):
        b = body.encode(); self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stand)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % srv.server_address[1]

def run(mode, marker=True):
    Stand.mode, Stand.marker, Stand.seen, Stand.served = mode, marker, [], 0
    return {r["title"]: r for r in gaps.check(BASE)}

r = run("handler")
ok("handler page: the fatal row is expected", r[gaps.T_FATAL]["status"] == "expected", r)
ok("handler page: the site serves normally without the trigger", r[gaps.T_CONTROL]["status"] == "expected")
ok("handler page: the site serves the next request", r[gaps.T_AFTER]["status"] == "expected")
ok("handler page: the PHP error text is reported, never a failure on its own", r[gaps.T_FATAL].get("fatal_text") is True)
fat = [p for p in Stand.seen if "pf_conformance=fatal" in p]
ok("the trigger is sent once, with a cache-busting value", len(fat) == 1 and "pf_n=" in fat[0], Stand.seen)
r = run("quiet")
ok("display_errors off: the handler text alone is still expected", r[gaps.T_FATAL]["status"] == "expected" and r[gaps.T_FATAL].get("fatal_text") is False)
r = run("bare")
ok("a bare 500 with no handler text (the runtime died) is unexpected", r[gaps.T_FATAL]["status"] == "unexpected")
r = run("ok200")
ok("the handler text with HTTP 200 (not the handler's own 500) is unexpected", r[gaps.T_FATAL]["status"] == "unexpected")
r = run("absent")
ok("a 200 (the gap plugin did not fire) is unexpected", r[gaps.T_FATAL]["status"] == "unexpected")
r = run("dies")
ok("a site that fails the next request is unexpected there", r[gaps.T_AFTER]["status"] == "unexpected" and r[gaps.T_FATAL]["status"] == "expected", r)
Stand.mode, Stand.marker, Stand.seen = "handler", False, []
try:
    gaps.check(BASE); ok("no throwaway marker: refused", False)
except runner.Stop:
    ok("no throwaway marker: refused", True)
ok("no throwaway marker: the trigger is never sent", not any("pf_conformance" in p for p in Stand.seen), Stand.seen)

# The baseline: the outcome the upstream spec asserts, the same rows, all expected.
b = gaps.baseline_rows()
ok("baseline: the same titles, all expected", sorted(x["title"] for x in b) == sorted([gaps.T_CONTROL, gaps.T_FATAL, gaps.T_AFTER]) and all(x["status"] == "expected" for x in b))
# The rows feed matrix.py: a failure only here is OURS on the fatal-error row.
Stand.mode, Stand.marker = "bare", True
ours = gaps.check(BASE)
areas = matrix.parse_areas("gaps pf/*  WordPress | Fatal error handling")
feats, un = matrix.feature_rows([("gaps", ours, b)], areas)
v = {x["title"]: x["verdict"] for x in feats[("WordPress", "Fatal error handling")]}
ok("matrix: the bare 500 is OURS on Fatal error handling", v[gaps.T_FATAL] == "OURS" and not un, v)
# The CLI writes the results file and exits 0 (a failing check is a RESULT, not a stop).
with tempfile.TemporaryDirectory() as d:
    out = os.path.join(d, "results-gaps-on.json")
    rc = gaps.main(["run", "--base-url", BASE, "--out", out])
    ok("cli run: writes the results, exit 0 on a failing check", rc == 0 and len(json.load(open(out))) == 3)
    bo = os.path.join(d, "baseline-gaps.json")
    ok("cli baseline: writes the baseline", gaps.main(["baseline", "--out", bo]) == 0 and json.load(open(bo)) == b)
srv.shutdown()
print("%d failing" % fails)
sys.exit(1 if fails else 0)
