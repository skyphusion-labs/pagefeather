#!/usr/bin/env python3
"""#699 part B: binders.py says who still binds pf-purge-budget, so down.sh removes it ONLY when nothing does (the
lead's ruling: checked, never assumed). A stand-in API serves namespaces, their scripts, their bindings, and the
account's scripts with their settings. Every script that cannot be read makes the answer "unknown" (exit 2), never
"none". The token never reaches the output.
  python3 -I deploy/purge-budget/tests/binders-test.py [another binders.py]
"""
import copy, http.server, json, os, subprocess, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
PROG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "binders.py")
BUDGET = {"type": "durable_object_namespace", "name": "PURGE_BUDGET", "class_name": "PurgeBudget", "script_name": "pf-purge-budget"}
PHP = {"type": "durable_object_namespace", "name": "PHP_RUNTIME", "class_name": "PhpRuntime"}
BASE = {
    "namespaces": ["wp-wfp", "pf699-ns-b"],
    "ns_scripts": {"wp-wfp": ["site-one", "site-two"], "pf699-ns-b": ["site-three"]},
    "ns_bindings": {("wp-wfp", "site-one"): [PHP], ("wp-wfp", "site-two"): [PHP], ("pf699-ns-b", "site-three"): [PHP]},
    "acct_scripts": ["pf-purge-budget", "wp-wfp-outbound", "woocap"],
    "acct_bindings": {"pf-purge-budget": [dict(BUDGET, script_name=None, name="PURGE_BUDGET")], "wp-wfp-outbound": [], "woocap": [PHP]},
    "fail": set(),
}
state = {}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, result=None):
        body = json.dumps({"success": code == 200, "result": result}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        st = state
        if self.headers.get("Authorization") != "Bearer planted-token":
            return self.send(403)
        p = self.path.split("?")[0]
        if p in st["fail"]:
            return self.send(500)
        parts = p.strip("/").split("/")
        if p == "/workers/dispatch/namespaces":
            return self.send(200, [{"namespace_name": n} for n in st["namespaces"]])
        if p == "/workers/scripts":
            return self.send(200, [{"id": s} for s in st["acct_scripts"]])
        if len(parts) == 5 and parts[:3] == ["workers", "dispatch", "namespaces"] and parts[4] == "scripts":
            return self.send(200, [{"script": {"id": s}} for s in st["ns_scripts"].get(parts[3], [])])
        if len(parts) == 7 and parts[:3] == ["workers", "dispatch", "namespaces"] and parts[6] == "bindings":
            return self.send(200, st["ns_bindings"].get((parts[3], parts[5]), []))
        # #1063: an account script's bindings come from its ACTIVE version. Deployments are listed OLDEST first; the old
        # version binds nothing, and /settings answers stale (nothing), so only the right read finds a binder.
        if len(parts) == 4 and parts[:2] == ["workers", "scripts"] and parts[3] == "deployments":
            return self.send(200, {"deployments": st.get("deps") or [
                {"created_on": "2026-11-20T19:44:07.92125Z", "versions": [{"version_id": "OLD", "percentage": 100}]},
                {"created_on": "2026-11-20T19:56:59.786013Z", "versions": [{"version_id": "NEW", "percentage": 100}]}]})
        if len(parts) == 5 and parts[:2] == ["workers", "scripts"] and parts[3] == "versions":
            return self.send(200, {"resources": {"bindings": st["acct_bindings"].get(parts[2], []) if parts[4] == "NEW" else []}})
        if len(parts) == 4 and parts[:2] == ["workers", "scripts"] and parts[3] == "settings":
            return self.send(200, {"bindings": []})
        self.send(404)


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = dict(os.environ, WFP_API="http://127.0.0.1:%d" % srv.server_port, CLOUDFLARE_API_TOKEN="planted-token", CLOUDFLARE_ACCOUNT_ID="acc")


def run(**over):
    state.clear()
    state.update(copy.deepcopy(BASE))
    for k, v in over.items():
        state[k] = v
    r = subprocess.run([sys.executable, "-I", PROG], capture_output=True, text=True, env=env)
    return r.returncode, r.stdout + r.stderr


def nsb(extra):
    b = copy.deepcopy(BASE["ns_bindings"])
    b.update(extra)
    return b


def acb(extra):
    b = copy.deepcopy(BASE["acct_bindings"])
    b.update(extra)
    return b


fails = 0
cases = [
    ("nothing binds it: none (exit 0)", {}, 0, '"binders": []'),
    ("a WfP site in one namespace binds it: exit 1, named", {"ns_bindings": nsb({("wp-wfp", "site-two"): [PHP, BUDGET]})}, 1, "wp-wfp/site-two"),
    ("a site in ANOTHER namespace binds it: exit 1, named", {"ns_bindings": nsb({("pf699-ns-b", "site-three"): [PHP, BUDGET]})}, 1, "pf699-ns-b/site-three"),
    ("a deploy.sh site (an account script) binds it: exit 1, named", {"acct_bindings": acb({"woocap": [PHP, BUDGET]})}, 1, "woocap"),
    ("the budget's own class binding does not count", {}, 0, '"binders": []'),
    ("another class of another script does not count", {"ns_bindings": nsb({("wp-wfp", "site-one"): [PHP, dict(BUDGET, script_name="other-script")]})}, 0, '"binders": []'),
    ("the namespace list cannot be read: unknown (exit 2)", {"fail": {"/workers/dispatch/namespaces"}}, 2, "/workers/dispatch/namespaces"),
    ("one namespace's script list cannot be read: unknown", {"fail": {"/workers/dispatch/namespaces/pf699-ns-b/scripts"}}, 2, "pf699-ns-b"),
    ("one script's bindings cannot be read: unknown, even with no binder seen", {"fail": {"/workers/dispatch/namespaces/wp-wfp/scripts/site-one/bindings"}}, 2, "site-one"),
    ("an account script's active version cannot be read: unknown", {"fail": {"/workers/scripts/woocap/deployments"}}, 2, "woocap"),
    ("#1063 a split rollout of an account script is unknown, not guessed", {"deps": [{"created_on": "2026-11-20T19:56:59Z", "versions": [{"version_id": "NEW", "percentage": 60}, {"version_id": "OLD", "percentage": 40}]}]}, 2, "woocap"),
    ("a binder AND an unread script: still exit 1 (a binder is enough to keep it)", {"ns_bindings": nsb({("wp-wfp", "site-two"): [BUDGET]}), "fail": {"/workers/scripts/woocap/deployments"}}, 1, "wp-wfp/site-two"),
]
for name, over, want_rc, want_text in cases:
    rc, out = run(**over)
    good = rc == want_rc and want_text in out and "planted-token" not in out
    print(("PASS " if good else "FAIL ") + name + ("" if good else " (exit %s; %s)" % (rc, out[-300:].replace("\n", " "))))
    fails += 0 if good else 1
print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
