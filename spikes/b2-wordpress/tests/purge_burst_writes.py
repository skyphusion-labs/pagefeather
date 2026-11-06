#!/usr/bin/env python3
"""Bursts of parallel content writes for the purge coalescing gate (issue #78).
Usage: B=<site> ADMIN_PASSWORD=... purge_burst_writes.py [n1 n2 gap_s]
Creates n1 posts in parallel, waits gap_s, creates n2 more, then deletes them.
Prints one JSON line: {"created": n, "first_t": ms, "last_t": ms, "codes": {...}}."""
import json, os, sys, time, collections
sys.path.insert(0, os.path.dirname(__file__))
import break_lib as L

n1, n2, gap = (int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) > 3 else (20, 10, 5.0)
o = L.login()
codes = collections.Counter()
ids = []
t0 = time.time()
def make(i):
    r = L.rest(o, "/wp/v2/posts", {"title": "purge burst %d" % i, "status": "publish", "content": "x"})
    codes[r["code"]] += 1
    try:
        ids.append(json.loads(r["body"])["id"])
    except Exception:
        pass
L.par(make, range(n1), n1)
time.sleep(gap)
L.par(make, range(n1, n1 + n2), n2)
t1 = time.time()
for i in ids:
    L.rest(o, "/wp/v2/posts/%d?force=true" % i, method="DELETE")
print(json.dumps({"created": len(ids), "first_t": int(t0 * 1000), "last_t": int(t1 * 1000), "codes": dict(codes)}))
