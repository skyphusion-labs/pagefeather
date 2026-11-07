#!/usr/bin/env python3
"""Concurrent load across SEVERAL WfP sites AT ONCE (issue #152).

Drives all the sites in SITES at the same time, so they contend on the one
dispatch namespace, and reports per-site latency, throughput and status mix at
each concurrency step. Pure standard library: it runs on a fresh Ubuntu VPS
with nothing to install but python3. It parallels the single-site harness
tests/load/load.py (same req/pct model, the same client-load guard).

Usage:
  SITES="shop:woo:https://a.workers.dev store:woo:https://b.workers.dev \
         blog:reg:https://c.workers.dev news:reg:https://d.workers.dev" \
    python3 tests/load/multi.py

A site is "name:type:url"; type is woo or reg. url may contain colons (the
split keeps the scheme).

Environment:
  LEVELS      TOTAL concurrent workers per step, split evenly across the sites.
              Default "10,50,100,250". With PER_SITE=1 each level is per site.
  SECONDS     seconds per step (default 30).
  CACHE       miss (default): every request carries a unique ?nocache= so it
              misses the Workers Cache and reaches the Durable Object.
              hit: no nocache, so the edge cache can answer. Run both for the
              cache-hit vs cache-miss comparison (two invocations).
  WOO_PATHS   comma paths for woo sites (default "/,/shop/,/?post_type=product").
  REG_PATHS   comma paths for reg sites (default "/,/?p=1").
  CHECKOUT_PROBE=1  one GET /checkout/ per woo site before the ramp, recorded on
              its own (NOT sustained): confirms the isolate memory limit (error
              1102) without stressing it. Not loaded in the ramp.
  MODE        ramp (default) or isolation.
  ISO_HEAVY / ISO_LIGHT   isolation worker counts (default 200 / 10).
  HEAVY_SITE  which site is heavy in isolation (default: the first site).
  PLAN=1      print the plan as JSON and exit; no network. For the offline test.
  SLOW_S      requests slower than this (s) are listed per step (default 10).

Output: per site, per step, p50/p95/p99 (ms), rps, status classes
(2xx/3xx/4xx/5xx/exc), error-1102 count and cf-cache-status mix; plus the
client's 1-minute load and cpu count (so a saturated generator is visible, not
mistaken for the sites). One JSON object on the last line; a short human table
to stderr. Exit 0: a failed request is a result.
"""
import concurrent.futures as cf, http.cookiejar, json, os, random, sys, threading, time, urllib.error, urllib.request

UA = {"User-Agent": "wp-on-cf-load-multi"}
CACHE = os.environ.get("CACHE", "miss")
if CACHE not in ("miss", "hit"):
    sys.exit("CACHE must be miss or hit")
SECONDS = float(os.environ.get("SECONDS", "30"))
LEVELS = [int(x) for x in os.environ.get("LEVELS", "10,50,100,250").split(",") if x.strip()]
PER_SITE = os.environ.get("PER_SITE", "0") == "1"
WOO_PATHS = [p for p in os.environ.get("WOO_PATHS", "/,/shop/,/?post_type=product").split(",") if p]
REG_PATHS = [p for p in os.environ.get("REG_PATHS", "/,/?p=1").split(",") if p]
MODE = os.environ.get("MODE", "ramp")
ISO_HEAVY = int(os.environ.get("ISO_HEAVY", "200"))
ISO_LIGHT = int(os.environ.get("ISO_LIGHT", "10"))
SLOW_S = float(os.environ.get("SLOW_S", "10"))


def parse_sites(spec):
    sites = []
    for tok in spec.split():
        parts = tok.split(":", 2)
        if len(parts) != 3 or parts[1] not in ("woo", "reg") or not parts[2].startswith("http"):
            sys.exit("bad site '%s': want name:woo|reg:http(s)://host" % tok)
        sites.append({"name": parts[0], "type": parts[1], "url": parts[2].rstrip("/")})
    names = [s["name"] for s in sites]
    if len(set(names)) != len(names):
        sys.exit("site names must be unique: %s" % names)
    if not sites:
        sys.exit("set SITES (name:type:url, space separated)")
    return sites


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect)


def nc(path):
    if CACHE == "hit":
        return path
    return path + ("&" if "?" in path else "?") + "nocache=%08x" % random.getrandbits(32)


def req(o, url, timeout=60):
    h = dict(UA)
    t = time.time()
    try:
        r = o.open(urllib.request.Request(url, headers=h), timeout=timeout)
        code, body, hd = r.status, r.read(2048), r.headers
    except urllib.error.HTTPError as e:
        code, body, hd = e.code, (e.read(2048) if hasattr(e, "read") else b""), e.headers
    except Exception as e:
        return {"code": "EXC", "s": time.time() - t, "cf": None, "e1102": False, "exc": repr(e)}
    return {"code": code, "s": time.time() - t, "cf": (hd.get("cf-cache-status") if hd else None),
            "e1102": (code != 200 and b"1102" in (body or b""))}


def paths_for(site):
    return WOO_PATHS if site["type"] == "woo" else REG_PATHS


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return round(1000 * xs[min(len(xs) - 1, max(0, int(-(-q * len(xs) // 1)) - 1))], 1)  # ms


lock = threading.Lock()


def worker(site, stop, rows):
    o = opener()
    paths = paths_for(site)
    while time.time() < stop:
        r = req(o, site["url"] + nc(random.choice(paths)))
        with lock:
            rows.append(r)


def site_stats(site, rows, wall):
    cls = {"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "exc": 0}
    cache = {}
    times = []
    for r in rows:
        c = r["code"]
        if c == "EXC":
            cls["exc"] += 1
        else:
            cls["%dxx" % (c // 100)] = cls.get("%dxx" % (c // 100), 0) + 1
            times.append(r["s"])
        k = r["cf"] or "none"
        cache[k] = cache.get(k, 0) + 1
    return {"name": site["name"], "type": site["type"], "requests": len(rows),
            "rps": round(len(rows) / wall, 2) if wall else 0,
            "p50_ms": pct(times, .5), "p95_ms": pct(times, .95), "p99_ms": pct(times, .99),
            "status": cls, "e1102": sum(1 for r in rows if r["e1102"]), "cache": cache}


def run_phase(sites, threads_by_site, seconds):
    rows = {s["name"]: [] for s in sites}
    total = sum(threads_by_site.values())
    t0 = time.time()
    stop = t0 + seconds
    tasks = []
    for s in sites:
        for _ in range(threads_by_site[s["name"]]):
            tasks.append(s)
    with cf.ThreadPoolExecutor(max(1, total)) as ex:
        list(ex.map(lambda s: worker(s, stop, rows[s["name"]]), tasks))
    wall = time.time() - t0
    return {"seconds": round(wall, 1), "threads_total": total,
            "threads_by_site": threads_by_site,
            "client_load1": round(os.getloadavg()[0], 2), "client_cpus": os.cpu_count(),
            "sites": [site_stats(s, rows[s["name"]], wall) for s in sites]}


def split_even(sites, level):
    if PER_SITE:
        return {s["name"]: level for s in sites}
    per = max(1, level // len(sites))
    return {s["name"]: per for s in sites}


def checkout_probe(sites):
    out = []
    o = opener()
    for s in sites:
        if s["type"] != "woo":
            continue
        r = req(o, s["url"] + "/checkout/")
        out.append({"name": s["name"], "code": r["code"], "e1102": r["e1102"],
                    "note": "one-shot; checkout is NOT sustained (isolate memory limit, error 1102)"})
    return out


def human(result):
    L = ["", "== multi-site load (%s, cache=%s) ==" % (MODE, CACHE)]
    for step in result["steps"]:
        L.append("step total=%s per-site=%s  %ss  client_load1=%s/%scpu" % (
            step.get("level", step["threads_total"]), step["threads_by_site"], step["seconds"],
            step["client_load1"], step["client_cpus"]))
        for s in step["sites"]:
            st = s["status"]
            L.append("  %-8s %-3s rps=%-7s p50=%-7s p95=%-7s p99=%-7s  2xx=%d 3xx=%d 4xx=%d 5xx=%d exc=%d e1102=%d  cache=%s" % (
                s["name"], s["type"], s["rps"], s["p50_ms"], s["p95_ms"], s["p99_ms"],
                st["2xx"], st["3xx"], st["4xx"], st["5xx"], st["exc"], s["e1102"], s["cache"]))
    if result.get("checkout_probe"):
        L.append("checkout probe (one-shot, not sustained):")
        for c in result["checkout_probe"]:
            L.append("  %-8s code=%s e1102=%s" % (c["name"], c["code"], c["e1102"]))
    if result.get("isolation"):
        iso = result["isolation"]
        L.append("isolation: heavy=%s" % iso["heavy_site"])
        for name, d in iso["light_delta"].items():
            L.append("  %-8s p95 baseline=%s under-heavy=%s delta=%s ms" % (name, d["baseline_p95_ms"], d["heavy_p95_ms"], d["delta_ms"]))
    return "\n".join(L)


def main():
    sites = parse_sites(os.environ.get("SITES", ""))
    plan = {"sites": sites, "mode": MODE, "cache": CACHE, "seconds_per_step": SECONDS,
            "per_site_levels" if PER_SITE else "total_levels": LEVELS,
            "woo_paths": WOO_PATHS, "reg_paths": REG_PATHS,
            "checkout_probe": os.environ.get("CHECKOUT_PROBE", "0") == "1",
            "iso_heavy": ISO_HEAVY, "iso_light": ISO_LIGHT,
            "heavy_site": os.environ.get("HEAVY_SITE") or sites[0]["name"]}
    if os.environ.get("PLAN", "0") == "1":
        print(json.dumps({"plan": plan}))
        return
    result = {"plan": plan, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if os.environ.get("CHECKOUT_PROBE", "0") == "1":
        result["checkout_probe"] = checkout_probe(sites)
    if MODE == "isolation":
        heavy = os.environ.get("HEAVY_SITE") or sites[0]["name"]
        base = run_phase(sites, {s["name"]: ISO_LIGHT for s in sites}, SECONDS)
        hv = run_phase(sites, {s["name"]: (ISO_HEAVY if s["name"] == heavy else ISO_LIGHT) for s in sites}, SECONDS)
        base_p95 = {s["name"]: s["p95_ms"] for s in base["sites"]}
        delta = {}
        for s in hv["sites"]:
            if s["name"] == heavy:
                continue
            b, h = base_p95.get(s["name"]), s["p95_ms"]
            delta[s["name"]] = {"baseline_p95_ms": b, "heavy_p95_ms": h,
                                "delta_ms": (round(h - b, 1) if (b is not None and h is not None) else None)}
        result["steps"] = [dict(base, level="baseline-light"), dict(hv, level="one-heavy")]
        result["isolation"] = {"heavy_site": heavy, "light_delta": delta}
    else:
        result["steps"] = []
        for lvl in LEVELS:
            step = run_phase(sites, split_even(sites, lvl), SECONDS)
            step["level"] = lvl
            result["steps"].append(step)
            print(json.dumps({"step": step}), flush=True)
    sys.stderr.write(human(result) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
