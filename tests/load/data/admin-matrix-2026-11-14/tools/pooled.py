import csv, sys, math, collections
def pct(v, q):
    v = sorted(v); return v[max(0, math.ceil(q * len(v)) - 1)] if v else None
for path in sys.argv[1:]:
    rows = list(csv.DictReader(open(path)))
    print("==", path.split("/")[-1], len(rows), "rows")
    for sc in ["dashboard", "post-new-post", "post-new-page", "edit-post", "edit-page", "profile-get", "profile-save"]:
        g = [r for r in rows if r["screen"] == sc]
        ms = [int(r["ms"]) for r in g if r["ms"] and r["status"].isdigit() and int(r["status"]) < 500]
        print("  %-14s n %d p50 %s p95 %s" % (sc, len(g), pct(ms, .5), pct(ms, .95)))
