#!/usr/bin/env python3
"""The deploy/wfp/bindings.py decision on one recorded upload (#328 PR 0).

  bindings-decision.py <site> <capture.json>

Reads the namespace script upload in a capture (capture.mjs), serves its bindings and a correct
dispatcher from a stand-in API, runs the real bindings.py against it, and prints its exit code
and its output as JSON. No binding value is printed (bindings.py prints names and types only).
"""
import http.server, json, os, re, subprocess, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
PROG = os.path.join(HERE, "..", "..", "wfp", "bindings.py")
site, capture = sys.argv[1], sys.argv[2]
with open(capture) as f:
    calls = json.load(f)
up = [c for c in calls if c["method"] == "PUT" and re.search(r"/workers/dispatch/namespaces/[^/]+/scripts/[^/]+$", c["path"])]
if len(up) != 1:
    sys.exit("expected one namespace script upload in %s, found %d" % (capture, len(up)))
USER = up[0]["body"]["metadata"]["bindings"]
DISP = [
    {"type": "kv_namespace", "name": "SITES", "namespace_id": "kv-sites-test-id"},
    {"type": "dispatch_namespace", "name": "DISPATCHER", "namespace": "wp-wfp"},
]


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        code, body = 404, {"success": False}
        if self.path == "/workers/dispatch/namespaces/wp-wfp/scripts/site-%s/bindings" % site:
            code, body = 200, {"success": True, "result": USER}
        elif self.path == "/workers/scripts/wp-%s/settings" % site:
            code, body = 200, {"success": True, "result": {"bindings": DISP}}
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = {"PATH": os.environ.get("PATH", ""), "WFP_API": "http://127.0.0.1:%d" % srv.server_port,
       "CLOUDFLARE_API_TOKEN": "token-test-not-real", "CLOUDFLARE_ACCOUNT_ID": "account-test",
       "NAMESPACE": "wp-wfp", "KV_ID": "kv-sites-test-id"}
r = subprocess.run([sys.executable, "-I", PROG, site], capture_output=True, text=True, env=env)
try:
    out = json.loads(r.stdout)
except ValueError:
    out = r.stdout
print(json.dumps({"exit": r.returncode, "output": out}, indent=2, sort_keys=True))
