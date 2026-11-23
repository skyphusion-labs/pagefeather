#!/usr/bin/env python3
"""Tests of deploy/box (#1327): the throwaway Vultr box for heavy jobs, its one-shot creds handoff and its teardown.
No Vultr, no Cloudflare: a fake S3 (deploy/wfp/tests/fake-s3.py) and a fake Vultr API in this file.
  python3 -I deploy/box/tests/box-test.py
Cases:
  presign: SigV4 query presigning reproduces botocore's signatures (virtual-host and path style, fixed key and time);
  userdata: a creds value, or its base64, in the user-data is REFUSED; the creds reach the box only by the presigned GET;
  handoff: release puts the creds, waits for the box's read marker, deletes them, and reads back 404. A HEAD that still
           finds the object (the delete was lost) FAILS the release (the guard can fail);
  destroy: deletes the instance, then the firewall, and reads both back gone; a firewall still listed FAILS;
  create: asks for no IPv6 address and reads back v6_main_ip; a box that has one FAILS and is destroyed.
"""
import base64, http.server, json, os, subprocess, sys, tempfile, threading, time, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
fails = 0
def check(name, got, want):
    global fails
    if got == want: print("PASS " + name)
    else: print("FAIL %s: got [%s], want [%s]" % (name, got, want)); fails += 1

import presign, box  # noqa: E402
TEMPS = []  # every temp dir this test makes; none may outlive it (a creds fixture was left in TMPDIR, 2026-11-23)

# 1. presign: the expected signatures come from botocore 1.44.9, a separate SigV4 implementation, not from this code:
# generate_presigned_url("get_object", ...) with the same key id, secret and the signing time pinned to 2013-05-24T00:00:00Z.
# (AWS's own published example uses an AKIA-shaped key id, which this repo's CI secret scan rightly refuses in the tree.)
KID, SEC, NOW = "EXAMPLEKEYID0000", "example-secret-for-box-test", 1369353600
u = presign.presign("GET", "https://examplebucket.s3.amazonaws.com", None, "test.txt", KID, SEC, 86400, region="us-east-1", now=NOW)
q = urllib.parse.parse_qs(urllib.parse.urlsplit(u).query)
check("presign: virtual-host GET matches botocore", q.get("X-Amz-Signature", [""])[0], "ad1103de9f1f66f2e654bf39cf8beae0ab57814052f247e2cccc5ad15ae8c4c3")
check("presign: the credential scope", q.get("X-Amz-Credential", [""])[0], KID + "/20130524/us-east-1/s3/aws4_request")
check("presign: the secret key is never in the url", SEC in u, False)
u2 = presign.presign("GET", "https://acct.r2.cloudflarestorage.com", "bkt", "run/a b.txt", KID, SEC, 600, now=NOW)
check("presign: path style (R2), the key quoted", urllib.parse.urlsplit(u2).path, "/bkt/run/a%20b.txt")
check("presign: path-style GET with a space in the key matches botocore", urllib.parse.parse_qs(urllib.parse.urlsplit(u2).query).get("X-Amz-Signature", [""])[0],
      "77df09a1e6be24169aac5a95e53c8f6c71e647b177fc81f41158a744cd9e959e")

# 2. userdata: the creds never ride in the user-data.
creds = {"FIXTURE_A": "fixture-alpha-zq7", "FIXTURE_B": "fixture-bravo-zq7"}  # stand-in values: what matters is that they reach no user-data
ok_ud = box.build_userdata("echo hello\n", puts={"done": "https://r2/put?sig"}, get="https://r2/get?sig", secrets=creds.values())
check("userdata: a clean user-data builds", "creds.env" in ok_ud and "fixture-alpha" not in ok_ud, True)
for label, script in (("the plain value", "echo fixture-alpha-zq7\n"),
                      ("the base64 of a value", "echo %s\n" % base64.b64encode(b"fixture-bravo-zq7").decode())):
    try:
        box.build_userdata(script, puts={}, get="https://r2/get?sig", secrets=creds.values()); got = "built"
    except box.SecretInUserData as e:
        got = "refused" if "fixture-" not in str(e) else "refused-but-leaked-in-message"
    check("userdata: %s in the job script is refused (and the message does not echo it)" % label, got, "refused")

# 3. handoff against the fake S3.
T = tempfile.mkdtemp(); TEMPS.append(T); pf = os.path.join(T, "port")
fs = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "..", "..", "wfp", "tests", "fake-s3.py"), pf])
try:
    for _ in range(50):
        if os.path.exists(pf) and open(pf).read().strip(): break
        time.sleep(0.1)
    ep = "http://127.0.0.1:%s" % open(pf).read().strip()
    st = box.S3(ep, "bkt", "kid", "sec")
    def box_reads(run_id, delay=0.3):  # the box: GET the creds by the presigned url, then PUT its read marker
        def run():
            time.sleep(delay)
            import urllib.request
            urllib.request.urlopen(st.presign("GET", run_id + "/creds.env", 60)).read()
            urllib.request.urlopen(urllib.request.Request(st.presign("PUT", run_id + "/creds-read", 60), data=b"t", method="PUT"))
        threading.Thread(target=run, daemon=True).start()
    box_reads("r1")
    r = box.release(st, "r1", b"FIXTURE_A=fixture-alpha-zq7\n", wait_s=10, poll_s=0.1)
    check("handoff: release saw the read marker", r["read"], True)
    check("handoff: the creds object is gone (HEAD 404)", r["head_after"], 404)
    check("handoff: release reports ok", r["ok"], True)
    # The guard can fail: a delete that does not take (the object stays) must fail the release.
    box_reads("r1b")
    r2 = box.release(st, "r1b", b"FIXTURE_A=x\n", wait_s=10, poll_s=0.1, _skip_delete_for_test=True)
    check("handoff: the creds object LEFT IN PLACE fails the release", (r2["ok"], r2["head_after"]), (False, 200))
    time.sleep(0.6); st.delete("r1b/creds.env")  # after the box thread has read
    # No read marker in time: the creds are still deleted (never left waiting), and the release reports not read.
    r3 = box.release(st, "r2", b"FIXTURE_A=y\n", wait_s=0.5, poll_s=0.1)
    check("handoff: no read marker: deleted anyway, reported unread", (r3["read"], r3["head_after"], r3["ok"]), (False, 404, False))
finally:
    fs.terminate(); fs.wait()

# 4. destroy against a fake Vultr.
state = {"instances": {"i1": "pfbox-x"}, "firewalls": {"f1"}, "keep_fw": False}
class V(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_DELETE(self):
        p = self.path.split("?")[0]
        if p.startswith("/v2/instances/"): state["instances"].pop(p.rsplit("/", 1)[1], None); self.send_response(204); self.end_headers()
        elif p.startswith("/v2/firewalls/"):
            if not state["keep_fw"]: state["firewalls"].discard(p.rsplit("/", 1)[1])
            self.send_response(204); self.end_headers()
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/v2/instances": self.j(200, {"instances": [{"id": k, "label": v} for k, v in state["instances"].items()]})
        elif p == "/v2/firewalls": self.j(200, {"firewall_groups": [{"id": f} for f in state["firewalls"]]})
        else: self.j(404, {})
srv = http.server.HTTPServer(("127.0.0.1", 0), V); threading.Thread(target=srv.serve_forever, daemon=True).start()
api = box.Vultr("k", base="http://127.0.0.1:%d/v2" % srv.server_port)
d = box.destroy(api, "i1", "f1", settle_s=0)
check("destroy: instance and firewall read back gone", (d["instance_left"], d["firewall_left"], d["ok"]), (False, False, True))
state["instances"]["i2"] = "pfbox-y"; state["firewalls"].add("f2"); state["keep_fw"] = True
d2 = box.destroy(api, "i2", "f2", settle_s=0)
check("destroy: a firewall still listed FAILS", (d2["firewall_left"], d2["ok"]), (True, False))
srv.shutdown()

# 5. create: no inbound must hold on IPv6 too. It asks for no v6 address and reads back v6_main_ip; a box that has one is
# destroyed (instance and firewall) and create fails.
cs = {"v6": "", "posted": None, "instances": {}, "firewalls": set()}
class CV(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def body(self):
        n = int(self.headers.get("content-length") or 0); return json.loads(self.rfile.read(n) or b"{}")
    def do_POST(self):
        p = self.path.split("?")[0]; b = self.body()
        if p == "/v2/firewalls": cs["firewalls"].add("fw9"); self.j(201, {"firewall_group": {"id": "fw9"}})
        elif p.endswith("/rules"): self.j(201, {})
        elif p == "/v2/instances": cs["posted"] = b; cs["instances"]["i9"] = b["label"]; self.j(202, {"instance": {"id": "i9"}})
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/v2/plans": self.j(200, {"plans": [{"id": "vhf-3c-8gb", "locations": ["lax"], "hourly_cost": 0.066}]})
        elif p.endswith("/rules"): self.j(200, {"firewall_rules": [{"id": 1}]})
        elif p == "/v2/instances/i9": self.j(200, {"instance": {"id": "i9", "v6_main_ip": cs["v6"]}} if "i9" in cs["instances"] else {})
        elif p == "/v2/instances": self.j(200, {"instances": [{"id": k} for k in cs["instances"]]})
        elif p == "/v2/firewalls": self.j(200, {"firewall_groups": [{"id": f} for f in cs["firewalls"]]})
        else: self.j(404, {})
    def do_DELETE(self):
        p = self.path.split("?")[0]
        if p.startswith("/v2/instances/"): cs["instances"].pop(p.rsplit("/", 1)[1], None)
        if p.startswith("/v2/firewalls/"): cs["firewalls"].discard(p.rsplit("/", 1)[1])
        self.send_response(204); self.end_headers()
cv = http.server.HTTPServer(("127.0.0.1", 0), CV); threading.Thread(target=cv.serve_forever, daemon=True).start()
capi = box.Vultr("k", base="http://127.0.0.1:%d/v2" % cv.server_port)
r = box.create(capi, "pfbox-t", "#!/bin/bash\n", "lax", "vhf-3c-8gb", v6_wait_s=1, v6_poll_s=0)
check("create: the box is asked for no IPv6 address", cs["posted"].get("enable_ipv6"), False)
check("create: no v6_main_ip read back: the box is kept", (r["instance"], r["v6_main_ip"]), ("i9", ""))
cs.update(v6="2001:db8::1", instances={}, firewalls=set())
try:
    box.create(capi, "pfbox-t", "#!/bin/bash\n", "lax", "vhf-3c-8gb", v6_wait_s=1, v6_poll_s=0); got = "kept"
except SystemExit as e:
    got = "refused" if "IPv6" in str(e) else "refused: " + str(e)
check("create: a box with a v6_main_ip FAILS", got, "refused")
check("create: and that box and its firewall are destroyed", (sorted(cs["instances"]), sorted(cs["firewalls"])), ([], []))
cv.shutdown()
# 6. BOX_PUBLIC_KEYS (#1405): every creds value is checked unless its key is named as a public identifier. No name
# pattern decides it, so a secret under an unexpected name (DATABASE_URL with a password in it) is still checked.
_cfd = tempfile.mkdtemp(); TEMPS.append(_cfd); cf = os.path.join(_cfd, "creds.env")
open(cf, "w").write("export CLOUDFLARE_API_TOKEN=tok-zq7-fixture-alpha\nMYSQL_USER=pf1327e\nMYSQL_DATABASE='pf1327e_wp'\n"
                    "DATABASE_URL=mysql://u:pw-zq7-fixture@h/db\n")
vals, absent = box.creds_values(cf, public="MYSQL_USER MYSQL_DATABASE ACCOUNT_ID")
check("public keys: a listed key's value is exempt", ("pf1327e" in vals, "pf1327e_wp" in vals), (False, False))
check("public keys: an unlisted key is still checked, an odd name included", ("tok-zq7-fixture-alpha" in vals, "mysql://u:pw-zq7-fixture@h/db" in vals), (True, True))
check("public keys: a listed key absent from the file is reported", absent, ["ACCOUNT_ID"])
vals0, _ = box.creds_values(cf, public="")
check("public keys: unset or empty keeps every value checked", sorted(vals0), sorted(["tok-zq7-fixture-alpha", "pf1327e", "pf1327e_wp", "mysql://u:pw-zq7-fixture@h/db"]))
job_names_site = "SITE=pf1327e\necho $SITE\n"
try:
    box.build_userdata(job_names_site, puts={}, get="https://r2/get?sig", secrets=vals); got = "built"
except box.SecretInUserData:
    got = "refused"
check("public keys: a job that names the site (= MYSQL_USER) builds once MYSQL_USER is listed", got, "built")
try:
    box.build_userdata("echo " + "mysql://u:pw-zq7-fixture@h/db" + "\n", puts={}, get=None, secrets=vals); got = "built"
except box.SecretInUserData:
    got = "refused"
check("public keys: a DATABASE_URL in the job is still refused", got, "refused")

# 7. HOME (#1405): cloud-init runs user-data with no HOME; a set -u job that reads it must not stop.
ud = box.build_userdata("echo $HOME\n", puts={}, get=None, secrets=[])
lines = ud.split("\n")
hi = next((i for i, l in enumerate(lines) if l.strip() == "export HOME=/root"), None)
ji = next((i for i, l in enumerate(lines) if "base64 -d > /root/job.sh" in l), None)
check("HOME: the user-data exports HOME=/root before the job", hi is not None and ji is not None and hi < ji, True)
envrun = subprocess.run(["env", "-i", "PATH=/usr/bin:/bin", "bash", "-c", "set -u; " + lines[hi] + "; echo \"[$HOME]\""], capture_output=True, text=True)
check("HOME: under env -i and set -u, that line gives a HOME", envrun.stdout.strip(), "[/root]")
import shutil
for _d in TEMPS: shutil.rmtree(_d, ignore_errors=True)
check("cleanup: every temp dir this test made is gone", [d for d in TEMPS if os.path.exists(d)], [])
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
