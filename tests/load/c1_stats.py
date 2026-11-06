#!/usr/bin/env python3
"""Where a c1 container saturates: read its own measurements after a load run.

Usage: B=<site url> SPIKE_TOKEN=... python3 tests/load/c1_stats.py [since] [until]
       python3 tests/load/c1_stats.py --files <req.log> <samples.log> [since] [until]

since and until are Unix times (default: everything). The container writes the
logs (spikes/c1-woo-container/container/c1-prepend.php and entrypoint.sh) and
/_stats.php returns them. Read them after the run: during a run the stats
request waits behind the load in the same PHP workers. The container loses the
logs when it stops (IDLE_SECONDS after the last request).

Prints one JSON object:
  info         /_stats.php?what=info (journal mode, OPcache, nproc, cgroup cpu.max)
  requests     count, status, wall and CPU seconds (p50, p95, p99, mean) per kind
  in_flight    requests the PHP workers held: time-weighted mean, max
  cpu          from /proc/stat every 2 s: busy share of all CPUs, steal share,
               and from the cgroup (if present): vCPU used, throttled share
  backlog      connections no PHP worker took yet (port 80 accept queue)
  php_states   PHP processes by state, mean per sample
"""
import json, os, sys, urllib.request


def fetch(what, since):
    r = urllib.request.Request(os.environ["B"].rstrip("/") + "/_stats.php?what=%s&since=%s" % (what, since),
                               headers={"x-spike-token": os.environ["SPIKE_TOKEN"], "User-Agent": "wp-on-cf-c1-stats"})
    return urllib.request.urlopen(r, timeout=120).read().decode()


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, max(0, int(-(-q * len(xs) // 1)) - 1))], 3)


def summary(xs):
    return {"p50": pct(xs, .5), "p95": pct(xs, .95), "p99": pct(xs, .99), "mean": round(sum(xs) / len(xs), 3) if xs else None}


def kind(path):
    if "wc/store/v1/checkout" in path:
        return "checkout"
    if "wc/store/v1/cart/add-item" in path:
        return "add"
    if "wc/store/v1/cart" in path:
        return "cart"
    if "rest_route=" in path or path.startswith("/wp-json"):
        return "rest"
    return "browse"


def parse_req(text, since, until):
    rows = []
    for line in text.splitlines():
        p = line.split(" ", 6)
        if len(p) < 7:
            continue
        t0 = float(p[0])
        if since <= t0 <= until:
            rows.append({"t0": t0, "wall": float(p[1]), "cpu": float(p[2]), "mib": float(p[3]), "status": p[4], "method": p[5], "path": p[6]})
    return rows


def parse_samples(text, since, until):
    out = []
    for line in text.splitlines():
        parts = [x.strip() for x in line.split("|")]
        head = parts[0].split()
        if len(head) < 3 or head[1] != "cpu":
            continue
        t = float(head[0])
        if not (since <= t <= until):
            continue
        s = {"t": t, "cpu": [int(x) for x in head[2:]], "cg": {}, "backlog": None, "php": {}, "pss": {}}
        for part in parts[1:]:
            w = part.split()
            if not w:
                continue
            if w[0] == "cg":
                s["cg"] = {k: int(v) for k, v in (x.split("=", 1) for x in w[1:] if "=" in x)}
            elif w[0] == "load":
                s["load1"] = float(w[1])
            elif w[0] == "backlog" and len(w) > 1:
                s["backlog"] = int(w[1])
            elif w[0] == "php":
                s["php"] = {x[0]: int(x[1:]) for x in w[1:]}
            elif w[0] == "pss":
                # PHP-FPM and nginx memory, kB (issue #99; absent before it).
                s["pss"] = {k: int(v) for k, v in (x.split("=", 1) for x in w[1:] if "=" in x)}
        out.append(s)
    return out


def main():
    args = sys.argv[1:]
    if args[:1] == ["--files"]:
        req_text, smp_text, info = open(args[1]).read(), open(args[2]).read(), None
        args = args[3:]
    else:
        since0 = args[0] if args else "0"
        info = json.loads(fetch("info", 0))
        req_text, smp_text = fetch("req", since0), fetch("samples", since0)
    since = float(args[0]) if len(args) > 0 else 0.0
    until = float(args[1]) if len(args) > 1 else 1e12
    rows = parse_req(req_text, since, until)
    smp = parse_samples(smp_text, since, until)
    res = {"info": info, "window": [since, until]}

    kinds = {}
    for r in rows:
        kinds.setdefault(kind(r["path"]), []).append(r)
    res["requests"] = {"n": len(rows), "status": {}, "kinds": {}}
    for r in rows:
        res["requests"]["status"][r["status"]] = res["requests"]["status"].get(r["status"], 0) + 1
    for k, rs in sorted(kinds.items()):
        res["requests"]["kinds"][k] = {"n": len(rs), "wall": summary([r["wall"] for r in rs]), "cpu": summary([r["cpu"] for r in rs]),
                                       "peak_mib_max": max(r["mib"] for r in rs)}

    # In flight: sweep the start and end of every request.
    if rows:
        ev = sorted([(r["t0"], 1) for r in rows] + [(r["t0"] + r["wall"], -1) for r in rows])
        t_first, t_last = ev[0][0], ev[-1][0]
        cur = area = mx = 0
        prev = t_first
        for t, d in ev:
            area += cur * (t - prev)
            prev = t
            cur += d
            mx = max(mx, cur)
        span = t_last - t_first
        res["in_flight"] = {"mean": round(area / span, 2) if span else None, "max": mx, "span_s": round(span, 1),
                            "rps": round(len(rows) / span, 2) if span else None,
                            "cpu_s_per_request": round(sum(r["cpu"] for r in rows) / len(rows), 3)}

    # CPU from consecutive samples.
    busy, steal, vcpu, thr = [], [], [], []
    for a, b in zip(smp, smp[1:]):
        d = [y - x for x, y in zip(a["cpu"], b["cpu"])]
        tot = sum(d[:8])
        if tot > 0:
            idle = d[3] + (d[4] if len(d) > 4 else 0)
            busy.append((tot - idle) / tot)
            steal.append((d[7] if len(d) > 7 else 0) / tot)
        dt = b["t"] - a["t"]
        if dt > 0 and "usage_usec" in a["cg"] and "usage_usec" in b["cg"]:
            vcpu.append((b["cg"]["usage_usec"] - a["cg"]["usage_usec"]) / 1e6 / dt)
            if "nr_periods" in a["cg"] and b["cg"].get("nr_periods", 0) > a["cg"]["nr_periods"]:
                thr.append((b["cg"]["nr_throttled"] - a["cg"]["nr_throttled"]) / (b["cg"]["nr_periods"] - a["cg"]["nr_periods"]))
    res["cpu"] = {"samples": len(smp), "busy_share": summary(busy), "steal_share": summary(steal),
                  "cgroup_vcpu_used": summary(vcpu) if vcpu else "no cgroup cpu.stat",
                  "cgroup_throttled_share": summary(thr) if thr else "no throttling data"}
    bl = [s["backlog"] for s in smp if s["backlog"] is not None]
    res["backlog"] = {"max": max(bl) if bl else None, "mean": round(sum(bl) / len(bl), 2) if bl else None}
    states = {}
    for s in smp:
        for k, v in s["php"].items():
            states[k] = states.get(k, 0) + v
    res["php_states"] = {k: round(v / len(smp), 2) for k, v in sorted(states.items())} if smp else {}
    pss = [s["pss"] for s in smp if s["pss"]]
    if pss:
        res["pss_mib"] = {k: {"max": round(max(x.get(k, 0) for x in pss) / 1024, 1),
                              "mean": round(sum(x.get(k, 0) for x in pss) / len(pss) / 1024, 1)} for k in ("fpm", "nginx")}
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
