#!/usr/bin/env python3
"""Test of deploy/wfp/bindings.py (issue #35, slice 4) against a stand-in API.

  python3 deploy/wfp/tests/bindings-test.py [another bindings.py]

A correct site passes. Each single misbinding fails and is named: another
site's bucket, another script's object class, a FOREIGN KV namespace or queue
on a site, an extra secret, the dispatcher's KV namespace, its outbound target,
an R2 binding on a dispatcher. The opinionated defaults a site MAY bind (its own
OC_KV, its own wp-wfp-<s>-email queue, the Browser Rendering binding, the
Workers AI binding, its own wp-wfp-<s>-analytics dataset, its own Vectorize
search index) pass.
Bindings that cannot be read fail. No binding value appears in the output.
Exit 0 when every case gives what it must.
"""
import copy, http.server, json, os, subprocess, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
PROG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "bindings.py")
GOOD_USER = [
    {"type": "r2_bucket", "name": "MEDIA", "bucket_name": "wp-wfp-one-media"},
    {"type": "durable_object_namespace", "name": "PHP_RUNTIME", "class_name": "PhpRuntime"},
    {"type": "images", "name": "IMAGES"},
    {"type": "assets", "name": "ASSETS"},
    {"type": "plain_text", "name": "SITE_ORIGIN", "text": "https://wp-one.sub.workers.dev"},
    {"type": "plain_text", "name": "PLANTED", "text": "plain-value-not-to-print"},
    {"type": "secret_text", "name": "WP_SALT"},
    {"type": "secret_text", "name": "SPIKE_TOKEN"},
]
GOOD_DISP = [
    {"type": "kv_namespace", "name": "SITES", "namespace_id": "kv1"},
    {"type": "dispatch_namespace", "name": "DISPATCHER", "namespace": "wp-wfp"},
    {"type": "dispatch_namespace", "name": "DISPATCHER_OUT", "namespace": "wp-wfp", "outbound": {"worker": {"service": "wp-wfp-outbound"}, "params": [{"name": "SITE"}]}},
]
state = {}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        p = self.path
        code, body = 404, {"success": False}
        if p == "/workers/dispatch/namespaces/wp-wfp/scripts/site-one/bindings" and state.get("user") is not None:
            code, body = 200, {"success": True, "result": state["user"]}
        elif p == "/workers/scripts/wp-one/settings" and state.get("disp") is not None:
            code, body = 200, {"success": True, "result": {"bindings": state["disp"]}}
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = dict(os.environ, WFP_API="http://127.0.0.1:%d" % srv.server_port, CLOUDFLARE_API_TOKEN="t", CLOUDFLARE_ACCOUNT_ID="acc", NAMESPACE="wp-wfp", KV_ID="kv1")


def run(user, disp):
    state["user"], state["disp"] = user, disp
    r = subprocess.run([sys.executable, "-I", PROG, "one"], capture_output=True, text=True, env=env)
    return r.returncode, r.stdout


def mod(lst, i, **kw):
    x = copy.deepcopy(lst)
    if i is None:
        x.append(kw)
    else:
        x[i].update(kw)
    return x


fails = 0
cases = [
    ("a correct site and dispatcher", GOOD_USER, GOOD_DISP, 0, None),
    ("the site binds another site's bucket", mod(GOOD_USER, 0, bucket_name="wp-wfp-two-media"), GOOD_DISP, 1, "not its own"),
    ("the site binds another script's object class", mod(GOOD_USER, 1, script_name="site-two"), GOOD_DISP, 1, "not its own"),
    ("the site binds a FOREIGN KV namespace (SITES, not its own OC_KV)", mod(GOOD_USER, None, type="kv_namespace", name="SITES", namespace_id="kv1"), GOOD_DISP, 1, "not its own OC_KV L2"),
    ("the site binds its OWN object-cache L2 (kv_namespace OC_KV) is allowed", mod(GOOD_USER, None, type="kv_namespace", name="OC_KV", namespace_id="ockv1"), GOOD_DISP, 0, None),
    ("the site binds its OWN durable-email queue (wp-wfp-one-email) is allowed", mod(GOOD_USER, None, type="queue", name="EMAIL_QUEUE", queue_name="wp-wfp-one-email"), GOOD_DISP, 0, None),
    ("the site binds a FOREIGN queue (wp-wfp-two-email)", mod(GOOD_USER, None, type="queue", name="EMAIL_QUEUE", queue_name="wp-wfp-two-email"), GOOD_DISP, 1, "not its own"),
    ("the site binds the Browser Rendering binding (browser) is allowed", mod(GOOD_USER, None, type="browser", name="BROWSER"), GOOD_DISP, 0, None),
    ("the site binds the Workers AI binding (ai) is allowed", mod(GOOD_USER, None, type="ai", name="AI"), GOOD_DISP, 0, None),
    ("the site binds its OWN analytics dataset (wp-wfp-one-analytics) is allowed", mod(GOOD_USER, None, type="analytics_engine", name="ANALYTICS", dataset="wp-wfp-one-analytics"), GOOD_DISP, 0, None),
    ("the site binds a FOREIGN analytics dataset (wp-wfp-two-analytics)", mod(GOOD_USER, None, type="analytics_engine", name="ANALYTICS", dataset="wp-wfp-two-analytics"), GOOD_DISP, 1, "not its own"),
    ("the site binds its OWN Vectorize search index (wp-wfp-one-search) is allowed", mod(GOOD_USER, None, type="vectorize", name="SEARCH_INDEX", index_name="wp-wfp-one-search"), GOOD_DISP, 0, None),
    ("the site binds a FOREIGN Vectorize index (wp-wfp-two-search)", mod(GOOD_USER, None, type="vectorize", name="SEARCH_INDEX", index_name="wp-wfp-two-search"), GOOD_DISP, 1, "not its own"),
    ("the site has an extra secret", mod(GOOD_USER, None, type="secret_text", name="CLOUDFLARE_API_TOKEN"), GOOD_DISP, 1, "unexpected secret"),
    ("the site's own Turnstile secret (TURNSTILE_SECRET, #340) is allowed", mod(GOOD_USER, None, type="secret_text", name="TURNSTILE_SECRET"), GOOD_DISP, 0, None),
    ("the site binds the dispatch namespace", mod(GOOD_USER, None, type="dispatch_namespace", name="NS", namespace="wp-wfp"), GOOD_DISP, 1, "not allowed for a site"),
    ("the dispatcher binds another KV namespace", GOOD_USER, mod(GOOD_DISP, 0, namespace_id="kv9"), 1, "not the site map"),
    ("the dispatcher's outbound goes elsewhere", GOOD_USER, mod(GOOD_DISP, 2, outbound={"worker": {"service": "other"}}), 1, "outbound to other"),
    ("the dispatcher binds another namespace", GOOD_USER, mod(GOOD_DISP, 1, namespace="vhc-x"), 1, "dispatch namespace vhc-x"),
    ("the dispatcher binds a bucket", GOOD_USER, mod(GOOD_DISP, None, type="r2_bucket", name="MEDIA", bucket_name="wp-wfp-one-media"), 1, "not allowed for a dispatcher"),
    ("the site's bindings cannot be read", None, GOOD_DISP, 1, "cannot be read"),
    ("the dispatcher's bindings cannot be read", GOOD_USER, None, 1, "cannot be read"),
]
for name, u, d, want_rc, want_text in cases:
    rc, out = run(u, d)
    ok = rc == want_rc and (want_text is None or want_text in out) and "plain-value-not-to-print" not in out
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else " (exit %s; output %s)" % (rc, out[-300:].replace("\n", " "))))
    fails += 0 if ok else 1
print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
