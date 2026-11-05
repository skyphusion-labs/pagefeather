#!/usr/bin/env python3
"""Uncached page times for approach A and HostlessWP, side by side.

Each page is rendered fresh: a unique ?nocache= query string (our page cache
skips it) and Cache-Control: no-cache (HostlessWP renders fresh on it, per its
README). Logged-in pages log in first. Prints median, min and max seconds over
N runs, plus queries and database ms per request where the target reports them
(our x-d1-calls / x-d1-ms; HostlessWP's x-hostlesswp JSON).
Usage: B=<url> ADMIN_PASSWORD=... N=10 python3 tests/a/bench.py
"""
import json, os, statistics, sys, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "spikes", "b2-wordpress", "tests"))
import break_lib as L

N = int(os.environ.get("N", "10"))
PAGES = [("home", "/", False), ("post", "/?p=1", False), ("search", "/?s=hello", False),
         ("dashboard", "/wp-admin/", True), ("post-new", "/wp-admin/post-new.php", True), ("edit", "/wp-admin/edit.php", True)]
anon = L.opener()
admin = L.login()
# The first published post, not ?p=1: plugin content can take the low ids.
try:
    first = json.loads(L.req(anon, "/?rest_route=/wp/v2/posts&per_page=1&orderby=id&order=asc")["body"])
    PAGES[1] = ("post", "/?p=%d" % first[0]["id"], False)
except (ValueError, IndexError, KeyError):
    pass  # lookup failed (for example a CPU limit on Workers Free): keep ?p=1
out = {"target": L.B, "n": N, "pages": {}}
for name, path, logged in PAGES:
    o = admin if logged else anon
    s, q, dbms, codes = [], [], [], []
    for _ in range(N):
        p = path + ("&" if "?" in path else "?") + "nocache=" + uuid.uuid4().hex[:8]
        r = L.req(o, p, headers={"Cache-Control": "no-cache"})
        codes.append(r["code"])
        if r["code"] != 200:
            continue
        s.append(r["s"])
        h = r["h"]
        if h.get("x-hostlesswp"):
            j = json.loads(h["x-hostlesswp"]); q.append(j.get("queries")); dbms.append(j.get("dbMs"))
        elif h.get("x-d1-calls"):
            q.append(int(h["x-d1-calls"])); dbms.append(int(h.get("x-d1-ms") or 0))
    med = lambda v: statistics.median(v) if v else None
    out["pages"][name] = {"ok": codes.count(200), "median_s": med(s), "min_s": min(s) if s else None,
                          "max_s": max(s) if s else None, "queries": med([x for x in q if x is not None]),
                          "db_ms": med([x for x in dbms if x is not None])}
    print(f"{name:10} ok {codes.count(200)}/{N}  median {out['pages'][name]['median_s']}s  min {out['pages'][name]['min_s']}  max {out['pages'][name]['max_s']}  queries {out['pages'][name]['queries']}  db_ms {out['pages'][name]['db_ms']}", flush=True)
print(json.dumps(out))
