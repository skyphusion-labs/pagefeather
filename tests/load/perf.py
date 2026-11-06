#!/usr/bin/env python3
"""Where the time goes in the PHP object (b-dosql), per request.

Usage: B=<site url> ADMIN_PASSWORD=... SPIKE_TOKEN=... python3 tests/load/perf.py
Options (environment): N (renders per page, default 30), C (concurrent clients,
default 1: one request at a time), PAGES (comma list, default all below),
OPCACHE=1 (ask the object for OPcache hits and misses; two extra php.run per
request, so the times grow), OUT (JSON lines file, default perf-<time>.jsonl).

Each render is fresh: a unique ?nocache= and Cache-Control: no-cache. Each
request carries x-perf-id, so a line here can be joined with `wrangler tail`
(the object logs {"m":"perf","id":...}), which gives CPU time per request.

Per request it keeps the client time, the Worker's wall time for the object
(x-object-ms), and the object's x-perf and x-perf-queue (docs/perf-dosql.md).
It prints p50 and p95 per page, and for the slowest tenth of each page the
values that differ from the rest. Exit 0: a failed request is a result.
"""
import concurrent.futures as cf, json, os, statistics, sys, time, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "spikes", "b2-wordpress", "tests"))
import break_lib as L

N = int(os.environ.get("N", "30"))
C = int(os.environ.get("C", "1"))
ALL = [("home", "/", False), ("post", "/?p=1", False), ("search", "/?s=hello", False),
       ("dashboard", "/wp-admin/", True), ("post-new", "/wp-admin/post-new.php", True), ("edit", "/wp-admin/edit.php", True)]
want = os.environ.get("PAGES")
PAGES = [p for p in ALL if not want or p[0] in want.split(",")]
OUT = os.environ.get("OUT") or "perf-%s.jsonl" % time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
TOKEN = os.environ.get("SPIKE_TOKEN", "")


def pct(v, p):
    """Nearest rank: the value below which p percent of the runs fall."""
    v = sorted(x for x in v if x is not None)
    return v[max(0, -(-p * len(v) // 100) - 1)] if v else None


def one(o, name, path, i):
    rid = uuid.uuid4().hex[:12]
    p = path + ("&" if "?" in path else "?") + "nocache=" + rid
    h = {"Cache-Control": "no-cache", "x-perf-id": rid}
    if TOKEN:
        h["x-spike-token"] = TOKEN
    if os.environ.get("OPCACHE") == "1":
        h["x-perf-opcache"] = "1"
    t0 = time.time()
    r = L.req(o, p, headers=h)
    hd = r["h"]
    get = (lambda k: hd.get(k)) if hd else (lambda k: None)
    js = lambda k: json.loads(get(k)) if get(k) else {}
    return {"page": name, "i": i, "id": rid, "t": round(t0, 3), "code": r["code"], "s": round(r["s"], 4),
            "objectMs": int(get("x-object-ms")) if get("x-object-ms") else None,
            "perf": js("x-perf"), "queue": js("x-perf-queue"), "worker": js("x-perf-worker"),
            "recycled": get("x-runtime-recycled"), "timing": get("server-timing"),
            # A failed answer keeps what tells whose it is: the body start and the server headers.
            **({"err": {"body": (r["body"] or b"")[:300].decode("utf-8", "replace"), "server": get("server"), "cf-ray": get("cf-ray"), "type": get("content-type"), "cache-control": get("cache-control"), "retry-after": get("retry-after"), "exc": r.get("err")}} if r["code"] != 200 else {})}


def main():
    anon = L.opener()
    admin = L.login() if any(p[2] for p in PAGES) else None
    rows = []
    with open(OUT, "w") as f, cf.ThreadPoolExecutor(max_workers=C) as ex:
        for name, path, logged in PAGES:
            o = admin if logged else anon
            futs = [ex.submit(one, o, name, path, i) for i in range(N)]
            for fu in futs:
                row = fu.result()
                rows.append(row)
                f.write(json.dumps(row) + "\n")
    summary = {"target": L.B, "n": N, "c": C, "out": OUT, "pages": {}}
    for name, _, _ in PAGES:
        rs = [r for r in rows if r["page"] == name]
        ok = [r for r in rs if r["code"] == 200]
        s = [r["s"] for r in ok]
        cut = pct(s, 90)
        slow = [r for r in ok if cut is not None and r["s"] >= cut]
        rest = [r for r in ok if r not in slow]
        f = lambda rr, k: [r["perf"].get(k) for r in rr if r["perf"]]
        med = lambda v: statistics.median([x for x in v if x is not None]) if [x for x in v if x is not None] else None
        summary["pages"][name] = {
            "ok": len(ok), "codes": sorted({str(r["code"]) for r in rs}),
            "client_p50_s": pct(s, 50), "client_p95_s": pct(s, 95),
            "object_p50_ms": pct([r["objectMs"] for r in ok], 50), "object_p95_ms": pct([r["objectMs"] for r in ok], 95),
            "boots": sum(1 for r in ok if r["perf"].get("boot")),
            "recycled": sum(1 for r in rs if r["recycled"]),
            "isolates": len({r["perf"].get("iso") for r in ok if r["perf"]}),
            "runtimes": len({(r["perf"].get("iso"), r["perf"].get("rt")) for r in ok if r["perf"]}),
            "worker_colos": sorted({str(r["worker"].get("colo")) for r in ok}),
            "slow": [{"s": r["s"], "objectMs": r["objectMs"], "boot": r["perf"].get("boot"), "rt": r["perf"].get("rt"),
                      "rtServed": r["perf"].get("rtServed"), "inflateKiB": r["perf"].get("inflateKiB"),
                      "wasm": [r["perf"].get("wasm0MiB"), r["perf"].get("wasm1MiB")], "ahead": r["queue"].get("ahead"),
                      "inboxMs": r["queue"].get("inboxMs"), "waitMs": r["queue"].get("waitMs"), "phpMs": r["perf"].get("phpMs")} for r in sorted(slow, key=lambda r: -r["s"])],
            "rest_median": {"objectMs": med([r["objectMs"] for r in rest]), "inflateKiB": med(f(rest, "inflateKiB")),
                            "rtServed": med(f(rest, "rtServed")), "phpMs": med(f(rest, "phpMs"))},
        }
        print(json.dumps({name: summary["pages"][name]}), flush=True)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
