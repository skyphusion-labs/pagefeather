#!/usr/bin/env python3
"""The dispatch hop's added latency (issue #35, item 5).

Usage: latency.py <direct-url> <dispatched-url> [N]
The same trivial Worker (tests/wfp/echo) is called direct on workers.dev and
through the dispatcher, N times each (default 100), in turns (direct, then
dispatched), so a change of network or load hits both alike. Each URL has its
own kept-alive HTTPS connection, so TLS setup is not in the times after the
warm-up. Prints one JSON object with p50, p95, p99, mean and the difference.
"""
import http.client, json, math, os, platform, statistics, sys, time, urllib.parse, uuid

direct, dispatched = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 100


class Target:
    def __init__(self, url):
        self.u = urllib.parse.urlsplit(url)
        self.c = None

    def get(self):
        if self.c is None:
            self.c = http.client.HTTPSConnection(self.u.hostname, timeout=60)
        path = (self.u.path or "/") + "?r=" + uuid.uuid4().hex[:10]
        t = time.perf_counter()
        try:
            self.c.request("GET", path, headers={"User-Agent": "wp-on-cf-wfp-latency", "Cache-Control": "no-cache"})
            r = self.c.getresponse()
            r.read()
            ms = (time.perf_counter() - t) * 1000
            return ms if r.status == 200 else None
        except (http.client.HTTPException, OSError):
            self.c = None
            return None


def pct(v, p):
    v = sorted(v)
    return round(v[max(0, min(len(v) - 1, math.ceil(p / 100 * len(v)) - 1))], 2)  # nearest rank


a, b = Target(direct), Target(dispatched)
for _ in range(5):  # warm-up: connections, isolates
    a.get(); b.get()
ta, tb = [], []
for _ in range(N):
    x = a.get(); ta.append(x)
    y = b.get(); tb.append(y)


def stats(v):
    ok = [x for x in v if x is not None]
    if not ok:
        return {"ok": 0}
    return {"ok": len(ok), "p50": pct(ok, 50), "p95": pct(ok, 95), "p99": pct(ok, 99), "mean": round(statistics.mean(ok), 2),
            "min": round(min(ok), 2), "max": round(max(ok), 2)}


sa, sb = stats(ta), stats(tb)
out = {"utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "n": N, "client": {"label": os.environ.get("RUNNER_REGION") and "runner " + os.environ["RUNNER_REGION"] or os.environ.get("CLIENT", "laptop"),
       "python": platform.python_version()}, "direct": {"url": direct, **sa}, "dispatched": {"url": dispatched, **sb}}
if sa.get("ok") and sb.get("ok"):
    out["added_ms"] = {k: round(sb[k] - sa[k], 2) for k in ("p50", "p95", "mean")}
print(json.dumps(out))
