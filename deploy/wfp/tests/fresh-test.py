#!/usr/bin/env python3
"""Test of snapshot.py fresh (#533), the freshness check of the scheduled snapshots, against
fake-s3.py (it lists with LastModified and pages as R2 does). The check must go red on every miss
it exists for, and must NOT go red on a site's first snapshot (nothing to compare its size to).
No account. Run: python3 -I deploy/wfp/tests/fresh-test.py"""
import os, shutil, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "..", "snapshot.py")
# #567: this directory used to be left behind on every run. mkdtemp plus rmtree in a
# finally removes it on the way out, including a failing run. ignore_errors so a cleanup
# error is not the test result. Python 3.9 has no TemporaryDirectory(ignore_cleanup_errors).
# WFP_TEMP_CLEAN_FAIL=1 exits 1 from inside it (tempdir-clean-test.py).
T = tempfile.mkdtemp()
try:
    if os.environ.get("WFP_TEMP_CLEAN_FAIL") == "1":
        sys.exit(1)
    fails = 0
    NOW = 1794640000  # a fixed "now" (FRESH_NOW), so ages are exact


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
        empty = os.path.join(T, "sites-empty")
        open(empty, "w").write("# none yet\n\n")

        def put(path, body, age_h, alarm=None):
            h = {} if alarm is None else {"x-amz-meta-alarmstate": alarm[0], "x-amz-meta-alarmat": alarm[1]}
            urllib.request.urlopen(urllib.request.Request(EP + path, data=body, method="PUT", headers=h))
            urllib.request.urlopen(urllib.request.Request(EP + "/_mtime" + path + "?t=%d" % (NOW - age_h * 3600), data=b"", method="POST"))

        def post(path):
            urllib.request.urlopen(urllib.request.Request(EP + path, data=b"", method="POST"))

        def fresh(*sites, **env):
            e = dict(os.environ, WFP_S3_ENDPOINT=EP, WFP_S3_KEY_ID="k", WFP_S3_SECRET="s", CLOUDFLARE_ACCOUNT_ID="test", FRESH_NOW=str(NOW), FRESH_SITES_FILE=empty)
            e.update(env)
            r = subprocess.run([sys.executable, "-I", SNAP, "fresh", *sites], env=e, capture_output=True, text=True)
            return r.returncode, r.stdout + r.stderr

        A = "/wp-wfp-%s-media/_snapshots/auto/%s.ndjson.gz"
        # first: ONE tiny snapshot, 2 h old. ok: two, the newest 2 h old and the same size.
        put(A % ("first", "20261114T071700Z"), b"x" * 10, 2)
        put(A % ("ok", "20261113T071700Z"), b"x" * 1000, 26)
        put(A % ("ok", "20261114T071700Z"), b"x" * 990, 2)
        # stale: the newest is 27 h old. shrank: 400 after 1000. edge: exactly half is not red.
        put(A % ("stale", "20261113T041700Z"), b"x" * 1000, 27)
        put(A % ("shrank", "20261113T071700Z"), b"x" * 1000, 26)
        put(A % ("shrank", "20261114T071700Z"), b"x" * 400, 2)
        put(A % ("half", "20261113T071700Z"), b"x" * 1000, 26)
        put(A % ("half", "20261114T071700Z"), b"x" * 500, 2)
        # handonly: only a hand-taken snapshot (outside auto/) and a stray non-.gz key under auto/.
        put("/wp-wfp-handonly-media/_snapshots/handonly/b1-20261114T000000Z.ndjson", b"x" * 1000, 1)
        put("/wp-wfp-handonly-media/_snapshots/auto/tmp-part", b"x" * 1000, 1)
        # paged: 1001 old snapshots, the newest (on page 2) fresh: it is found, not the 1000th.
        for i in range(1000):
            put(A % ("paged", "2026010%dT%06dZ" % (1 + i // 500, i)), b"x" * 1000, 500)
        put(A % ("paged", "20261114T071700Z"), b"x" * 1000, 1)
        # #841: the newest snapshot's alarm record (the state BEFORE the snapshot re-armed the cron alarm).
        put(A % ("alarmok", "20261114T071700Z"), b"x" * 1000, 2, ("ok", "1794640060000"))
        put(A % ("alarmnone", "20261114T071700Z"), b"x" * 1000, 2, ("none", "1794640060000"))
        put(A % ("alarmstale", "20261114T071700Z"), b"x" * 1000, 2, ("stale", "1794640060000"))
        put(A % ("alarmgone", "20261114T071700Z"), b"x" * 1000, 2, ("ok", "none"))
        put(A % ("alarmold", "20261113T071700Z"), b"x" * 1000, 26, ("none", "1794540060000"))
        put(A % ("alarmold", "20261114T071700Z"), b"x" * 1000, 2, ("ok", "1794640060000"))

        rc, out = fresh(); check("no site listed: exit 0, and it SAYS nothing was checked", rc == 0 and "NO SITES LISTED" in out, out.strip())
        rc, out = fresh("first"); check("the FIRST snapshot (tiny, nothing to compare): not red", rc == 0 and "OK first" in out and "first snapshot" in out, out.strip())
        rc, out = fresh("ok"); check("a fresh snapshot of the same size: exit 0", rc == 0 and "OK ok" in out, out.strip())
        rc, out = fresh("missing"); check("no snapshot at all: RED, exit 1", rc == 1 and "RED missing: no snapshot" in out, out.strip())
        rc, out = fresh("stale"); check("27 h old: RED stale", rc == 1 and "RED stale" in out and "27.0 h old" in out, out.strip())
        rc, out = fresh("stale", FRESH_MAX_AGE_H="30"); check("CONTROL: the same bucket with a 30 h limit is not red (the age rule is what fired)", rc == 0, out.strip())
        rc, out = fresh("shrank"); check("400 bytes after 1000: RED, under half", rc == 1 and "RED shrank" in out and "under 0.5" in out, out.strip())
        rc, out = fresh("half"); check("exactly half: not red", rc == 0, out.strip())
        rc, out = fresh("handonly"); check("only a hand-taken snapshot and a stray key: RED, no scheduled snapshot", rc == 1 and "RED handonly: no snapshot" in out, out.strip())
        rc, out = fresh("paged"); check("1001 snapshots: the newest on page 2 is found, fresh", rc == 0 and "OK paged: _snapshots/auto/20261114T071700Z" in out, out.strip())
        rc, out = fresh("ok"); check("#841: a snapshot with no alarm record (a build from before #841) is not red, and says so", rc == 0 and "no alarm record" in out, out.strip())
        rc, out = fresh("alarmok"); check("#841: alarm ok before the snapshot: OK, and says so", rc == 0 and "OK alarmok" in out and "alarm ok" in out, out.strip())
        rc, out = fresh("alarmnone"); check("#841 THE CASE: the cron alarm was MISSING until the snapshot re-armed it: RED", rc == 1 and "RED alarmnone" in out and "alarm was none" in out, out.strip())
        rc, out = fresh("alarmstale"); check("#841: the cron alarm was long past (stale): RED", rc == 1 and "RED alarmstale" in out and "alarm was stale" in out, out.strip())
        rc, out = fresh("alarmgone"); check("#841: no cron alarm even after the re-arm: RED", rc == 1 and "RED alarmgone" in out and "no cron alarm after" in out, out.strip())
        rc, out = fresh("alarmold"); check("#841: only the NEWEST snapshot's record counts (an older none, a newer ok: OK)", rc == 0 and "OK alarmold" in out, out.strip())
        rc, out = fresh("ok", "stale", "first"); check("three sites, one red: exit 1, the count", rc == 1 and "1 of 3 site(s) red" in out, out.strip())
        rc, out = fresh(FRESH_SITES="ok, first"); check("FRESH_SITES (commas and spaces) names the sites", rc == 0 and "0 of 2" in out, out.strip())
        lst = os.path.join(T, "sites")
        open(lst, "w").write("# the inventory\nok   # live\n\nstale\n")
        rc, out = fresh(FRESH_SITES_FILE=lst); check("the inventory file: comments and blank lines skipped", rc == 1 and "1 of 2" in out and "RED stale" in out, out.strip())
        rc, out = fresh("Bad_Name"); check("a bad site name: exit 2, nothing read", rc == 2, out.strip())
        post("/_fail_page/1")
        rc, out = fresh("ok"); check("an unreadable listing: RED, never fresh", rc == 1 and "cannot read" in out, out.strip())
        post("/_truncate_no_token")
        rc, out = fresh("paged"); check("a truncated page with no token: RED", rc == 1 and "cannot read" in out, out.strip())
    finally:
        srv.kill()
        srv.wait()
    print("%d failing check(s)" % fails)
    sys.exit(1 if fails else 0)
finally:
    shutil.rmtree(T, ignore_errors=True)
