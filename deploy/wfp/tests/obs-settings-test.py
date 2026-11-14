#!/usr/bin/env python3
"""Test of deploy/wfp/obs_settings.py against a stand-in API: the dispatch path and the ordinary
Worker path ("-", #394), the redact PATCH, the read-back, and the refusal when it does not read back.
No account. Run: python3 -I deploy/wfp/tests/obs-settings-test.py"""
import http.server, json, os, subprocess, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
OBS = os.path.join(HERE, "..", "obs_settings.py")
state = {"paths": [], "settings": {}, "broken": False, "stale": 0, "old": {}}

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        state["paths"].append(("GET", self.path))
        if state["stale"] > 0 and self.path in state["old"]:
            # #481: a good PATCH that still reads back the old value for a while.
            state["stale"] -= 1
            return self._send(200, {"success": True, "result": {"observability": state["old"][self.path]}})
        self._send(200, {"success": True, "result": {"observability": state["settings"].get(self.path)}})
    def do_PATCH(self):
        n = int(self.headers.get("content-length", 0)); body = self.rfile.read(n).decode()
        state["paths"].append(("PATCH", self.path))
        obs = json.loads(body[body.index("{"):body.rindex("}") + 1])["observability"]
        if state["broken"]: obs = dict(obs, redact_query_string=False)
        state["old"][self.path] = state["settings"].get(self.path)
        state["settings"][self.path] = obs
        self._send(200, {"success": True, "result": {}})

srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = dict(os.environ, WFP_API="http://127.0.0.1:%d" % srv.server_port, CLOUDFLARE_API_TOKEN="test", OBS_READBACK_DELAYS="0,0.01,0.01,0.01")
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
check("  it read back 4 times before it failed", r.stderr.count("read-back ") == 4 and "after 4 read-backs" in r.stderr)
state["broken"] = False
# #481: the read-back reads false once, then true: the retry passes it, and it logs each attempt.
state["settings"]["/workers/scripts/wp-e/settings"] = dict(on); state["stale"] = 1
r = run("redact", "-", "wp-e")
check("a read-back false once, then true: exit 0", r.returncode == 0)
check("  it logged read-back 1/4 false and 2/4 true", "read-back 1/4: redact_query_string=None" in r.stderr and "read-back 2/4: redact_query_string=True" in r.stderr)
state["settings"]["/workers/scripts/wp-f/settings"] = dict(on); state["stale"] = 1
r = run("redact-or-off", "-", "wp-f")
check("redact-or-off: false once, then true: exit 0 and the logs stay on", r.returncode == 0 and state["settings"]["/workers/scripts/wp-f/settings"].get("enabled") is True)
state["settings"]["/workers/scripts/wp-g/settings"] = dict(on); state["stale"] = 99
r = run("redact-or-off", "-", "wp-g")
check("redact-or-off: false on every read-back still fails closed (exit 1)", r.returncode == 1 and "after 4 read-backs" in r.stderr)
state["stale"] = 0
state["broken"] = False
r = run("redact", "-", "wp-off")
check("observability off: nothing to redact, exit 0, no PATCH", r.returncode == 0 and ("PATCH", "/workers/scripts/wp-off/settings") not in state["paths"])
# redact-or-off (#394): a redaction that does not read back turns observability OFF.
state["broken"] = True; state["settings"]["/workers/scripts/wp-c/settings"] = dict(on)
r = run("redact-or-off", "-", "wp-c")
check("redact-or-off: a failed redaction exits 1", r.returncode == 1)
check("  and the script's observability reads back OFF", state["settings"]["/workers/scripts/wp-c/settings"].get("enabled") is False)
state["broken"] = False; state["settings"]["/workers/scripts/wp-d/settings"] = dict(on)
r = run("redact-or-off", "-", "wp-d")
check("redact-or-off: a good redaction exits 0 and leaves the logs on", r.returncode == 0 and state["settings"]["/workers/scripts/wp-d/settings"].get("enabled") is True)
# The deploy wrapper (#394): the upload, then redact-or-off, in one script under set -e.
w = open(os.path.join(HERE, "..", "..", "..", "spikes", "b2-wordpress", "deploy-a-lean.sh")).read()
check("deploy-a-lean.sh runs under set -euo pipefail", "set -euo pipefail" in w)
i_dep = w.find('../../deploy/wr deploy --env a-paid-lean "$@"'); i_red = w.find("obs_settings.py redact-or-off - wp-a-lean")
check("  it deploys, then redact-or-off (in that order)", 0 <= i_dep < i_red)
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
