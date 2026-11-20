"""deploy/live-sites/check_live.py (fleet-chezmoi#2620): a code redeploy of a live site refuses unless the
live Worker matches its site file. SETTINGS replaces the API read; no network."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "deploy" / "live-sites" / "check_live.py"
fails = 0


def settings(bucket="zarapo-media", origin="https://zarapo.skyphusion.workers.dev", do=True):
    b = [{"name": "MEDIA", "type": "r2_bucket", "bucket_name": bucket},
         {"name": "SITE_ORIGIN", "type": "plain_text", "text": origin},
         {"name": "SPIKE_TOKEN", "type": "secret_text"}]
    if do:
        b.append({"name": "PHP_RUNTIME", "type": "durable_object_namespace", "class_name": "PhpRuntime"})
    return {"result": {"bindings": b}}


def run(site_text, data):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "site.env"
        f.write_text(site_text)
        env = {"PATH": os.environ["PATH"], "F": str(f), "WORKER": "zarapo"}
        s = Path(d) / "settings.json"
        if data is not None:
            s.write_text(data if isinstance(data, str) else json.dumps(data))
        env["SETTINGS"] = str(s)  # with data None the file is absent, so the read fails
        r = subprocess.run([sys.executable, "-I", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout + r.stderr


def check(name, got, want):
    global fails
    if got == want:
        print("  ok   " + name)
    else:
        print("  FAIL %s: got %r, want %r" % (name, got, want))
        fails += 1


SITE = (ROOT / "deploy" / "live-sites" / "zarapo.env").read_text()
rc, out = run(SITE, settings())
check("a matching live Worker passes", rc, 0)
rc, out = run(SITE, settings(bucket="other-media"))
check("a different MEDIA bucket refuses", (rc, "MEDIA bucket" in out), (1, True))
rc, out = run(SITE, settings(origin="https://wp.posterntesting.com"))
check("a different SITE_ORIGIN refuses", (rc, "SITE_ORIGIN" in out), (1, True))
rc, out = run(SITE, settings(do=False))
check("no PHP_RUNTIME Durable Object refuses", (rc, "PHP_RUNTIME" in out), (1, True))
rc, out = run(SITE, None)
check("an unreadable live Worker refuses, never passes", (rc, "refusing" in out), (1, True))
rc, out = run(SITE, "not json")
check("a garbled read refuses", rc, 1)
def domains(data):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "domains.json"
        if data is not None:
            p.write_text(json.dumps(data))
        env = {"PATH": os.environ["PATH"], "WORKER": "zarapo", "MODE": "domains", "DOMAINS": str(p)}
        r = subprocess.run([sys.executable, "-I", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout.strip()


check("domains: lists the Worker's own, sorted",
      domains({"success": True, "result": [{"hostname": "b.example", "service": "zarapo"},
                                           {"hostname": "a.example", "service": "zarapo"},
                                           {"hostname": "x.example", "service": "other"}]}),
      (0, "a.example,b.example"))
check("domains: none prints -", domains({"success": True, "result": []}), (0, "-"))
check("domains: an unread list refuses, never reads as none", domains(None)[0], 1)
check("domains: a failed read refuses", domains({"success": False, "result": []})[0], 1)
for site in ("zarapo", "woocap"):
    text = (ROOT / "deploy" / "live-sites" / ("%s.env" % site)).read_text()
    kv = dict(l.split("=", 1) for l in text.splitlines() if l and not l.startswith("#"))
    check("%s.env names its own bucket" % site, kv.get("MEDIA_BUCKET"), "%s-media" % site)
    check("%s.env is b-dosql" % site, kv.get("VARIANT"), "b-dosql")
# #1063: live_bindings reads the ACTIVE version: the deployment with the greatest created_on (the API's order is not
# trusted), then its version at 100%. In process, with the API read replaced; this fixture lists the OLDEST first.
import importlib.util
spec = importlib.util.spec_from_file_location("check_live_mod", str(SCRIPT)); cl = importlib.util.module_from_spec(spec); spec.loader.exec_module(cl)
answers = {
    "/deployments": {"result": {"deployments": [
        {"created_on": "2026-11-20T19:44:07.92125Z", "versions": [{"version_id": "VID-OLD", "percentage": 100}]},
        {"created_on": "2026-11-20T19:56:59.786013Z", "versions": [{"version_id": "VID-NEW", "percentage": 100}]},
        {"created_on": "2026-11-20T19:56:54.683323Z", "versions": [{"version_id": "VID-MID", "percentage": 100}]}]}},
    "/versions/VID-NEW": {"result": {"resources": {"bindings": [{"name": "SITE_ORIGIN", "type": "plain_text", "text": "new"}]}}},
    "/versions/VID-OLD": {"result": {"resources": {"bindings": [{"name": "SITE_ORIGIN", "type": "plain_text", "text": "old"}]}}},
}
asked = []
cl._get = lambda path: (asked.append(path), answers[path])[1]
os.environ.pop("SETTINGS", None); os.environ.setdefault("WORKER", "w")
check("#1063 live_bindings reads the NEWEST deployment by created_on, not the first listed", (cl.live_bindings().get("SITE_ORIGIN") or {}).get("text"), "new")
check("#1063 and it asks deployments, then that version, never /settings", asked, ["/deployments", "/versions/VID-NEW"])
answers["/deployments"] = {"result": {"deployments": [{"created_on": "2026-11-20T19:56:59Z", "versions": [{"version_id": "A", "percentage": 60}, {"version_id": "B", "percentage": 40}]}]}}
try:
    cl.live_bindings(); got = "passed"
except SystemExit:
    got = "refused"
check("#1063 a split rollout (no version at 100%) is refused", got, "refused")
print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
