#!/usr/bin/env python3
"""Write deploy.sh's measurements to one JSON file and print a summary.

Usage: summarize.py <result.json> <name> <url> <location> <e2e-exit> <work-dir>
The work dir holds: ping (one /_d1ping JSON per line), e2e (e2e.sh output),
bench (tests/a/bench.py output; the last line is its JSON), and optional
extra (one JSON object, merged into the result: variant c1 writes the instance
type and the start times). VARIANT in the environment names the variant.
"""
import json, os, re, sys

res, name, url, loc, e2e_exit, w = sys.argv[1:7]


def lines(f):
    p = os.path.join(w, f)
    return open(p).read().splitlines() if os.path.exists(p) else []


ping = [json.loads(l) for l in lines("ping") if l.strip().startswith("{")]
rows = [l for l in lines("e2e") if l[:4] in ("GET ", "POST")]
bench = [l for l in lines("bench") if l.startswith("{")]
out = {
    "name": name, "url": url, "variant": os.environ.get("VARIANT", "b-do"), "location": loc,
    "d1_ping": ping,
    "e2e": {"exit": int(e2e_exit), "rows": len(rows),
            "ok": sum(1 for l in rows if (lambda c: c and c[0][:1] in "23")([t for t in l.split()[1:] if re.fullmatch(r"\d{3}", t)]))},
    "bench": json.loads(bench[-1]) if bench else None,
}
extra = [l for l in lines("extra") if l.startswith("{")]
if extra:
    out.update(json.loads(extra[-1]))
json.dump(out, open(res, "w"), indent=1)
if ping:
    print("Database per statement, median ms:", [p.get("median") for p in ping])
if "cold_start_s" in out:
    sec = lambda v: "not measured" if v is None else "%s s" % v
    print("container: %s, %s PHP workers; first start %s, cold start %s" % (
        out.get("instance_type"), out.get("php_workers"), sec(out.get("first_start_s")), sec(out.get("cold_start_s"))))
print("e2e.sh: exit %d, %d of %d requests 2xx or 3xx" % (out["e2e"]["exit"], out["e2e"]["ok"], out["e2e"]["rows"]))
for k, v in ((out["bench"] or {}).get("pages") or {}).items():
    print("%-10s median %ss, %s queries, %s of %s answered" % (k, v["median_s"], v["queries"], v["ok"], out["bench"]["n"]))
print("results:", res)
