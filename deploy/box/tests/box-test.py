#!/usr/bin/env python3
"""Tests of deploy/box (#1327): the throwaway Vultr box for heavy jobs, its one-shot creds handoff and its teardown.
No Vultr, no Cloudflare: a fake S3 (deploy/wfp/tests/fake-s3.py) and a fake Vultr API in this file.
  python3 -I deploy/box/tests/box-test.py
Cases:
  presign: SigV4 query presigning reproduces AWS's published example (the S3 docs' GET example, fixed key and date);
  userdata: a creds value, or its base64, in the user-data is REFUSED; the creds reach the box only by the presigned GET;
  handoff: release puts the creds, waits for the box's read marker, deletes them, and reads back 404. A HEAD that still
           finds the object (the delete was lost) FAILS the release (the guard can fail);
  destroy: deletes the instance, then the firewall, and reads both back gone; a firewall still listed FAILS.
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

# 1. presign: AWS's documented example (S3 API reference, "Authenticating Requests: Using Query Parameters").
u = presign.presign("GET", "https://examplebucket.s3.amazonaws.com", None, "test.txt", "AKIAIOSFODNN7EXAMPLE",
                    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", 86400, region="us-east-1", now=1369353600)
q = urllib.parse.parse_qs(urllib.parse.urlsplit(u).query)
check("presign: AWS's example signature", q.get("X-Amz-Signature", [""])[0], "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")
check("presign: the credential scope", q.get("X-Amz-Credential", [""])[0], "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request")
check("presign: the secret key is never in the url", "wJalrXUtnFEMI" in u, False)
u2 = presign.presign("PUT", "https://acct.r2.cloudflarestorage.com", "bkt", "run/a b.txt", "kid", "sec", 600, now=1700000000)
check("presign: path style, the key quoted", urllib.parse.urlsplit(u2).path, "/bkt/run/a%20b.txt")

# 2. userdata: the creds never ride in the user-data.
creds = {"PF_TOKEN": "tok-SECRET-123456", "DB_PASSWORD": "pw-SECRET-abcdef"}  # gitleaks:allow (a fake fixture token)
ok_ud = box.build_userdata("echo hello\n", puts={"done": "https://r2/put?sig"}, get="https://r2/get?sig", secrets=creds.values())
check("userdata: a clean user-data builds", "creds.env" in ok_ud and "tok-SECRET" not in ok_ud, True)
for label, script in (("the plain value", "echo tok-SECRET-123456\n"),
                      ("the base64 of a value", "echo %s\n" % base64.b64encode(b"pw-SECRET-abcdef").decode())):
    try:
        box.build_userdata(script, puts={}, get="https://r2/get?sig", secrets=creds.values()); got = "built"
    except box.SecretInUserData as e:
        got = "refused" if "SECRET" not in str(e) else "refused-but-leaked-in-message"
    check("userdata: %s in the job script is refused (and the message does not echo it)" % label, got, "refused")

# 3. handoff against the fake S3.
T = tempfile.mkdtemp(); pf = os.path.join(T, "port")
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
    r = box.release(st, "r1", b"PF_TOKEN=tok-SECRET-123456\n", wait_s=10, poll_s=0.1)  # gitleaks:allow (a fake fixture token)
    check("handoff: release saw the read marker", r["read"], True)
    check("handoff: the creds object is gone (HEAD 404)", r["head_after"], 404)
    check("handoff: release reports ok", r["ok"], True)
    # The guard can fail: a delete that does not take (the object stays) must fail the release.
    box_reads("r1b")
    r2 = box.release(st, "r1b", b"PF_TOKEN=x\n", wait_s=10, poll_s=0.1, _skip_delete_for_test=True)
    check("handoff: the creds object LEFT IN PLACE fails the release", (r2["ok"], r2["head_after"]), (False, 200))
    time.sleep(0.6); st.delete("r1b/creds.env")  # after the box thread has read
    # No read marker in time: the creds are still deleted (never left waiting), and the release reports not read.
    r3 = box.release(st, "r2", b"PF_TOKEN=y\n", wait_s=0.5, poll_s=0.1)
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
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
