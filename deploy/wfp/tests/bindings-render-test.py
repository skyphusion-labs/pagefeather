#!/usr/bin/env python3
"""The REAL rendered configs through the binding audit (#533: after #539's live red on pf533).

  python3 -I deploy/wfp/tests/bindings-render-test.py [another bindings.py]

bindings-test.py feeds bindings.py hand-written binding lists, so a binding that lib.sh renders
and the audit does not know was invisible to CI: #539 added SNAPSHOT_TOKEN, SNAPSHOT_SCRIPT and
SNAPSHOT_TIMEOUT_MS, and the first live site add (pf533, 2026-11-14) failed the audit. This test
renders the site's user Worker config (render_user) and its dispatcher copy (render_site_dispatcher)
with lib.sh, takes the secret NAMES the deploy uploads (site_secrets_json, dispatcher_secrets_json),
turns them into the shape the API reads back (the bindings list), serves them from a stand-in API,
and runs bindings.py on them. Variants: the default render, OPCACHE_SPLIT=1, WP_VECTORIZE_SEARCH=1,
and Turnstile; and the phase B cron-only dispatcher copy. A TOML key it does not know is a FAIL, so the next new binding is caught here too.
Controls: a foreign binding planted in the same render must still fail the audit.
Exit 0 only when every case gives what it must.
"""
import http.server, json, os, shutil, subprocess, sys, tempfile, threading
try:
    import tomllib
except ModuleNotFoundError:  # as render-test.sh: a python3 with tomllib (3.11 or later); fail, never skip
    for _p in (os.environ.get("PY_TOML"), "python3.14", "python3.13", "python3.12", "python3.11"):
        if _p and shutil.which(_p) and subprocess.run([_p, "-c", "import tomllib"], capture_output=True).returncode == 0:
            os.execvp(_p, [_p, "-I"] + sys.argv)
    sys.exit("FAIL no python3 with tomllib (3.11 or later) on PATH")

HERE = os.path.dirname(os.path.abspath(__file__))
WFP = os.path.dirname(HERE)
PROG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WFP, "bindings.py")
SITE, KV, NS = "one", "kv123", "wp-wfp"
T = tempfile.mkdtemp()
fails = 0


def check(name, ok, got=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else " (%s)" % (got,)))
    fails += 0 if ok else 1


def lib(cmd, env=None):
    """Run cmd in bash with lib.sh sourced; stdout. Raises on a non-zero exit."""
    e = dict(os.environ, **(env or {}))
    for k in ("MAIL_FROM", "MAIL_FROM_NAME", "HTTP_ALLOW_HOSTS", "SNAPSHOT_CRON", "SNAPSHOT_TIMEOUT_MS"):
        e.pop(k, None)
    r = subprocess.run(["bash", "-c", '. "%s/lib.sh"; %s' % (WFP, cmd)], capture_output=True, text=True, env=e)
    if r.returncode:
        raise RuntimeError("%s: exit %s: %s" % (cmd, r.returncode, r.stderr[-300:]))
    return r.stdout


# The TOML keys that are NOT bindings. Anything else must be converted below, or it is a FAIL.
NOT_BINDINGS = {"name", "main", "compatibility_date", "compatibility_flags", "rules", "cache", "exports",
                "migrations", "observability", "workers_dev", "preview_urls", "triggers"}


def to_api(conf, secrets):
    """The bindings the API reads back for this config and these secret names, as bindings.py sees them."""
    out, unknown = [], []
    for k, v in conf.items():
        if k in NOT_BINDINGS:
            continue
        if k == "vars":
            out += [{"type": "plain_text", "name": n, "text": str(t)} for n, t in v.items()]
        elif k == "r2_buckets":
            out += [{"type": "r2_bucket", "name": b["binding"], "bucket_name": b["bucket_name"]} for b in v]
        elif k == "durable_objects":
            out += [{"type": "durable_object_namespace", "name": b["name"], "class_name": b["class_name"]} for b in v["bindings"]]
        elif k == "images":
            out.append({"type": "images", "name": v["binding"]})
        elif k == "assets":
            if "binding" in v:
                out.append({"type": "assets", "name": v["binding"]})
        elif k == "send_email":
            out += [{"type": "send_email", "name": b["name"]} for b in v]
        elif k == "kv_namespaces":
            out += [{"type": "kv_namespace", "name": b["binding"], "namespace_id": b["id"]} for b in v]
        elif k == "dispatch_namespaces":
            for b in v:
                x = {"type": "dispatch_namespace", "name": b["binding"], "namespace": b["namespace"]}
                if "outbound" in b:
                    x["outbound"] = {"worker": {"service": b["outbound"]["service"]}, "params": [{"name": p} for p in b["outbound"].get("parameters", [])]}
                out.append(x)
        elif k == "ai":
            out.append({"type": "ai", "name": v["binding"]})
        elif k == "vectorize":
            out += [{"type": "vectorize", "name": b["binding"], "index_name": b["index_name"]} for b in v]
        else:
            unknown.append(k)
    out += [{"type": "secret_text", "name": n} for n in secrets]
    return out, unknown


def secret_names(fn, extra_env=None):
    tf = json.dumps({"wp_salt": {"value": "s"}, "spike_token": {"value": "t"}, "snapshot_token": {"value": "k"}, "hostname": {"value": "h"}})
    f = os.path.join(T, "sec-%s.json" % fn)
    e = dict(os.environ, **(extra_env or {}))
    subprocess.run(["bash", "-c", '. "%s/lib.sh"; %s "%s"' % (WFP, fn, f)], input=tf, text=True, env=e, check=True, capture_output=True)
    return sorted(json.load(open(f)))


state = {}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        code, body = 404, {"success": False}
        if self.path == "/workers/dispatch/namespaces/%s/scripts/site-%s/bindings" % (NS, SITE):
            code, body = 200, {"success": True, "result": state["user"]}
        elif self.path == "/workers/scripts/wp-%s/settings" % SITE:
            code, body = 200, {"success": True, "result": {"bindings": state["disp"]}}
        b = json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = dict(os.environ, WFP_API="http://127.0.0.1:%d" % srv.server_port, CLOUDFLARE_API_TOKEN="t", CLOUDFLARE_ACCOUNT_ID="acc", NAMESPACE=NS, KV_ID=KV)


def audit(user, disp):
    state["user"], state["disp"] = user, disp
    r = subprocess.run([sys.executable, "-I", PROG, SITE], capture_output=True, text=True, env=env)
    return r.returncode, r.stdout


variants = [
    ("the default render", {}),
    ("OPCACHE_SPLIT=1 (the ASSETS binding, #412)", {"OPCACHE_SPLIT": "1"}),
    ("WP_VECTORIZE_SEARCH=1 (AI and the search index, #330)", {"WP_VECTORIZE_SEARCH": "1"}),
    ("Turnstile on (#340)", {"TURNSTILE_SITEKEY": "0x4AAAAAAAtestkey", "TURNSTILE_SECRET": "x"}),
]
disp_conf = tomllib.loads(lib('render_site_dispatcher %s %s' % (SITE, KV)))
disp, unk_d = to_api(disp_conf, secret_names("dispatcher_secrets_json"))
check("the dispatcher render has no binding key this test does not know (%s)" % unk_d, not unk_d, unk_d)
check("the dispatcher render carries the #533 snapshot bindings (the case #539 broke)",
      {"SNAPSHOT_SCRIPT", "SNAPSHOT_TIMEOUT_MS", "SNAPSHOT_TOKEN"} <= {b["name"] for b in disp}, sorted(b["name"] for b in disp))
for vname, venv in variants:
    try:
        uconf = tomllib.loads(lib('render_user %s https://wp-%s.sub.workers.dev' % (SITE, SITE), venv))
        usec = secret_names("site_secrets_json", venv)
    except RuntimeError as e:
        check("%s: renders" % vname, False, e); continue
    user, unk_u = to_api(uconf, usec)
    check("%s: no binding key this test does not know" % vname, not unk_u, unk_u)
    rc, out = audit(user, disp)
    check("%s: the rendered site and dispatcher pass the audit" % vname, rc == 0, " ".join(json.loads(out).get("failed", []))[:400] if out.strip().startswith("{") else out[-300:])
    check("%s: the audit prints no binding value (the SITE_ORIGIN text is not in its output)" % vname, "https://wp-%s.sub.workers.dev" % SITE not in out, "a value is in the output")
# Phase B (#533, option A): the cron-only copy binds exactly what the phase A copy binds, and passes.
cron_conf = tomllib.loads(lib('render_site_dispatcher %s %s cron-only' % (SITE, KV)))
cron, unk_c = to_api(cron_conf, secret_names("dispatcher_secrets_json"))
check("the cron-only copy (phase B) has no binding key this test does not know", not unk_c, unk_c)
check("the cron-only copy binds the same as the phase A copy", sorted(json.dumps(x, sort_keys=True) for x in cron) == sorted(json.dumps(x, sort_keys=True) for x in disp), "they differ")
rc, out = audit(to_api(tomllib.loads(lib('render_user %s https://%s.wfp-test.skyphusion.org' % (SITE, SITE))), secret_names("site_secrets_json"))[0], cron)
check("a phase B site (Custom Domain origin) with its cron-only copy passes the audit", rc == 0, out[-300:])
check("the cron-only copy renders workers_dev = false", cron_conf.get("workers_dev") is False and cron_conf.get("preview_urls") is False, cron_conf.get("workers_dev"))
# Controls: the same real render with ONE foreign binding planted still fails.
uconf = tomllib.loads(lib('render_user %s https://wp-%s.sub.workers.dev' % (SITE, SITE)))
user, _ = to_api(uconf, secret_names("site_secrets_json"))
for name, u, d, want in [
    ("control: an extra secret on the site", user + [{"type": "secret_text", "name": "CLOUDFLARE_API_TOKEN"}], disp, "unexpected secret"),
    ("control: SNAPSHOT_SCRIPT naming ANOTHER site on the dispatcher", user, [dict(b, text="site-two") if b.get("name") == "SNAPSHOT_SCRIPT" else b for b in disp], "not its own"),
    ("control: a non-numeric SNAPSHOT_TIMEOUT_MS on the dispatcher", user, [dict(b, text="60s") if b.get("name") == "SNAPSHOT_TIMEOUT_MS" else b for b in disp], "SNAPSHOT_TIMEOUT_MS"),
    ("control: another plain_text var on the dispatcher", user, disp + [{"type": "plain_text", "name": "OTHER", "text": "x"}], "not allowed for a dispatcher"),
    ("control: another secret on the dispatcher", user, disp + [{"type": "secret_text", "name": "SPIKE_TOKEN"}], "not allowed for a dispatcher"),
    ("control: SNAPSHOT_TOKEN as plain_text on the dispatcher (a key must be a secret)", user, [dict(b, type="plain_text", text="v") if b.get("name") == "SNAPSHOT_TOKEN" else b for b in disp], "not allowed for a dispatcher"),
]:
    rc, out = audit(u, d)
    check(name + ": fails the audit, named", rc == 1 and want in out, (rc, out[-200:]))
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
