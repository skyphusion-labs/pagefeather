#!/usr/bin/env python3
# Purge burst: many admin saves in a few seconds must still reach visitors
# (issue #58). c1 coalesces page cache purges to one per PURGE_INTERVAL_MS.
# Usage: B=https://<site> ADMIN_PASSWORD=... SPIKE_TOKEN=... python3 tests/purge_burst.py
# It changes the site tagline N times (default 20), then sets it back.
import json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import opener, req, login, rest

N = int(os.environ.get("N", "20"))
LIMIT = float(os.environ.get("LIMIT", "40"))  # seconds for the last value to show
results = []


def check(name, ok, extra=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))


def info():
    r = urllib.request.urlopen(urllib.request.Request(os.environ["B"].rstrip("/") + "/_store-info", headers={"x-spike-token": os.environ["SPIKE_TOKEN"], "User-Agent": "wp-on-cf-purgeburst"}), timeout=60)
    return json.loads(r.read()).get("purge", {})


o = login()
old = json.loads(rest(o, "/wp/v2/settings", method="GET")["body"]).get("description", "")
for _ in range(2):
    req(opener(), "/?feed=rss2")
before = info()
T = int(time.time())
t0 = time.time()
for i in range(N):
    rest(o, "/wp/v2/settings", {"description": f"Burst {T} {i}"}, method="POST")
burst_s = time.time() - t0
last = f"Burst {T} {N - 1}".encode()
seen = None
while time.time() - t0 < LIMIT + burst_s:
    r = req(opener(), "/?feed=rss2")
    if last in r["body"]:
        seen = time.time() - t0
        break
    time.sleep(1)
after = info()
d = {k: after.get(k, 0) - before.get(k, 0) for k in ("sent", "deferred", "failed", "retried")}
check(f"{N} saves in {burst_s:.1f} s: the last one is visible", seen is not None, f"after {seen:.1f} s from the first save" if seen else f"not after {LIMIT + burst_s:.0f} s")
check("purges coalesced (sent at most 1 + burst/15 s + 1)", d["sent"] <= 2 + int(burst_s // 15) + 1, json.dumps(d))
check("no purge refused", d["failed"] == 0, "last_error " + str(after.get("last_error")))
rest(o, "/wp/v2/settings", {"description": old}, method="POST")
print(f"{sum(results)} of {len(results)} passed")
sys.exit(0 if all(results) else 1)
