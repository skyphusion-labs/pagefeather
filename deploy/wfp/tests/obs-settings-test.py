#!/usr/bin/env python3
"""Test of deploy/wfp/obs_settings.py against a stand-in API: the dispatch path and the ordinary
Worker path ("-", #394), the redact PATCH, the read-back, and the refusal when it does not read back.
No account. Run: python3 -I deploy/wfp/tests/obs-settings-test.py"""
import http.server, json, os, subprocess, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
OBS = os.path.join(HERE, "..", "obs_settings.py")
state = {"paths": [], "settings": {}, "broken": False}

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        state["paths"].append(("GET", self.path))
        self._send(200, {"success": True, "result": {"observability": state["settings"].get(self.path)}})
    def do_PATCH(self):
        n = int(self.headers.get("content-length", 0)); body = self.rfile.read(n).decode()
        state["paths"].append(("PATCH", self.path))
        obs = json.loads(body[body.index("{"):body.rindex("}") + 1])["observability"]
        if state["broken"]: obs = dict(obs, redact_query_string=False)
        state["settings"][self.path] = obs
        self._send(200, {"success": True, "result": {}})

srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = dict(os.environ, WFP_API="http://127.0.0.1:%d" % srv.server_port, CLOUDFLARE_API_TOKEN="test")
fails = 0
def check(name, ok):
    global fails
    print(("PASS " if ok else "FAIL ") + name); fails += 0 if ok else 1
def run(*args):
    return subprocess.run([sys.executable, "-I", OBS, *args], env=env, capture_output=True, text=True)

on = {"enabled": True, "head_sampling_rate": 1}
state["settings"]["/workers/scripts/wp-a-lean/settings"] = dict(on)
r = run("redact", "-", "wp-a-lean")
check('"-" redacts an ordinary Worker: exit 0', r.returncode == 0)
check('  it used /workers/scripts/<name>/settings', ("PATCH", "/workers/scripts/wp-a-lean/settings") in state["paths"])
check('  and it reads back redact_query_string true', state["settings"]["/workers/scripts/wp-a-lean/settings"].get("redact_query_string") is True)
state["settings"]["/workers/dispatch/namespaces/wp-wfp/scripts/site-x/settings"] = dict(on)
r = run("redact", "wp-wfp", "site-x")
check("a namespace keeps the dispatch path", r.returncode == 0 and ("PATCH", "/workers/dispatch/namespaces/wp-wfp/scripts/site-x/settings") in state["paths"])
state["broken"] = True; state["settings"]["/workers/scripts/wp-b/settings"] = dict(on)
r = run("redact", "-", "wp-b")
check("a redaction that does not read back fails (exit 1)", r.returncode == 1)
state["broken"] = False
r = run("redact", "-", "wp-off")
check("observability off: nothing to redact, exit 0, no PATCH", r.returncode == 0 and ("PATCH", "/workers/scripts/wp-off/settings") not in state["paths"])
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
