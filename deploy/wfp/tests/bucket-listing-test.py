#!/usr/bin/env python3
"""Test of snapshot.py bucket_listing (#525) against fake-s3.py, which pages as R2 does (1000 keys
a page, IsTruncated, NextContinuationToken). The listing is what isolation.sh compares before and
after a site add or remove, through snapshot.py take and diff. No account.
Run: python3 -I deploy/wfp/tests/bucket-listing-test.py"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
T = tempfile.mkdtemp()
fails = 0


def check(name, ok, got=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (" (%s)" % got if got != "" else ""))
    fails += 0 if ok else 1


pf = os.path.join(T, "port")
srv = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "fake-s3.py"), pf])
try:
    for _ in range(50):
        if os.path.exists(pf) and open(pf).read():
            break
        time.sleep(0.1)
    EP = "http://127.0.0.1:" + open(pf).read()
    os.environ.update(WFP_S3_ENDPOINT=EP, WFP_S3_KEY_ID="test-key", WFP_S3_SECRET="test-secret", CLOUDFLARE_ACCOUNT_ID="test")
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.join(HERE, ".."))
    import snapshot

    def put(path, body):
        urllib.request.urlopen(urllib.request.Request(EP + path, data=body, method="PUT"))

    def post(path):
        urllib.request.urlopen(urllib.request.Request(EP + path, data=b"", method="POST"))

    B = "wp-wfp-big-media"
    for i in range(2500):
        put("/%s/uploads/2026/%05d.jpg" % (B, i), b"img %d" % i)
    put("/wp-wfp-small-media/uploads/a.jpg", b"a")

    one = snapshot.bucket_listing(B)
    check("a bucket of 2500 keys lists all 2500 (three pages of at most 1000)", len(one.get("objects", [])) == 2500, len(one.get("objects", [])))
    check("  every key once, in order", [o[0] for o in one["objects"]] == ["uploads/2026/%05d.jpg" % i for i in range(2500)])
    check("  with an ETag and a size", all(o[1] and o[2] for o in one["objects"]))
    small = snapshot.bucket_listing("wp-wfp-small-media").get("objects", [])
    check("a small bucket lists its one key, with its size", len(small) == 1 and small[0][0] == "uploads/a.jpg" and small[0][2] == "1", small)

    # THE #525 CASE: a change at key 1500 (past the first page) must show in isolation.sh's diff.
    rec = lambda listing: {"sites": {"big": {"dispatcher": "d", "user_script": "u", "entry": "e", "bucket": listing, "title": "t"}}}
    a = os.path.join(T, "a.json"); b = os.path.join(T, "b.json")
    json.dump(rec(snapshot.bucket_listing(B)), open(a, "w"))
    put("/%s/uploads/2026/01500.jpg" % B, b"CHANGED by another site's command")
    json.dump(rec(snapshot.bucket_listing(B)), open(b, "w"))
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "..", "snapshot.py"), "diff", a, b], capture_output=True, text=True, env=os.environ)
    check("#525: a change at key 1500 makes the diff fail (exit 1)", r.returncode == 1, r.returncode)
    check("  it names the bucket as CHANGED", "big bucket CHANGED" in r.stdout)
    json.dump(rec(snapshot.bucket_listing(B)), open(a, "w"))
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "..", "snapshot.py"), "diff", a, b], capture_output=True, text=True, env=os.environ)
    check("control: no change, the diff passes (exit 0)", r.returncode == 0, r.returncode)

    # A page that fails, or a truncated page with no token, is an ERROR, never a short listing.
    post("/_fail_page/2")
    e = snapshot.bucket_listing(B)
    check("a failed second page is an error, not 1000 keys", "error" in e and "objects" not in e, e.get("error"))
    post("/_truncate_no_token")
    e = snapshot.bucket_listing(B)
    check("a truncated page with no continuation token is an error", "error" in e and "no continuation token" in e["error"], e.get("error"))
    json.dump(rec({"error": "list HTTP 500 on page 2"}), open(b, "w"))
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "..", "snapshot.py"), "diff", a, b], capture_output=True, text=True, env=os.environ)
    check("  and diff refuses it (exit 1, cannot compare)", r.returncode == 1 and "cannot compare" in r.stdout, r.returncode)
finally:
    srv.kill(); srv.wait()
    shutil.rmtree(T, ignore_errors=True)
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
