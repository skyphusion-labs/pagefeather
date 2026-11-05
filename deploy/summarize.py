#!/usr/bin/env python3
"""Write deploy.sh's measurements to one JSON file and print a summary.

Usage: summarize.py <result.json> <name> <url> <location> <e2e-exit> <work-dir>
The work dir holds: ping (one /_d1ping JSON per line), e2e (e2e.sh output),
bench (tests/a/bench.py output; the last line is its JSON).
"""
import json, os, sys

res, name, url, loc, e2e_exit, w = sys.argv[1:7]


def lines(f):
    p = os.path.join(w, f)
    return open(p).read().splitlines() if os.path.exists(p) else []


ping = [json.loads(l) for l in lines("ping") if l.strip().startswith("{")]
rows = [l for l in lines("e2e") if l[:4] in ("GET ", "POST")]
bench = [l for l in lines("bench") if l.startswith("{")]
out = {
    "name": name, "url": url, "variant": "b-do", "location": loc,
    "d1_ping": ping,
    "e2e": {"exit": int(e2e_exit), "rows": len(rows),
            "ok": sum(1 for l in rows if len(l.split()) > 2 and l.split()[2][:1] in "23")},
    "bench": json.loads(bench[-1]) if bench else None,
}
json.dump(out, open(res, "w"), indent=1)
print("D1 per statement, median ms:", [p.get("median") for p in ping])
print("e2e.sh: exit %d, %d of %d requests 2xx or 3xx" % (out["e2e"]["exit"], out["e2e"]["ok"], out["e2e"]["rows"]))
for k, v in ((out["bench"] or {}).get("pages") or {}).items():
    print("%-10s median %ss, %s queries, %s of %s answered" % (k, v["median_s"], v["queries"], v["ok"], out["bench"]["n"]))
print("results:", res)
