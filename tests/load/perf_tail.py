#!/usr/bin/env python3
"""Join tests/load/perf.py samples with `wrangler tail --format json` events.

Usage: python3 tests/load/perf_tail.py <perf.jsonl> <tail.jsonl>

The PHP object logs {"m":"perf","id":...} for each request; perf.py sends the
same id as x-perf-id. Each tail event of the object carries that log line, and
Cloudflare's own cpuTime and wallTime for the invocation. Those are the real
times: inside the object, Date.now() does not move during synchronous PHP.
Prints one JSON line per joined sample, then a summary per page: CPU and wall
at p50 and p95, and how many samples had no tail event (tail can drop events).
"""
import json, sys


def pct(v, p):
    v = sorted(x for x in v if x is not None)
    return v[max(0, -(-p * len(v) // 100) - 1)] if v else None


def events(path):
    # wrangler tail --format json prints each event as indented JSON over many lines.
    text = open(path).read()
    dec = json.JSONDecoder()
    i = 0
    while True:
        j = text.find("{", i)
        if j < 0:
            return
        try:
            ev, i = dec.raw_decode(text, j)
        except ValueError:
            i = j + 1
            continue
        yield ev


def perf_id(ev):
    for log in ev.get("logs") or []:
        for m in log.get("message") or []:
            if isinstance(m, str) and m.startswith('{"m":"perf"'):
                try:
                    return json.loads(m).get("id")
                except ValueError:
                    pass
    return None


def main(perf_path, tail_path):
    tail = {}
    seen = 0
    for ev in events(tail_path):
        seen += 1
        i = perf_id(ev)
        if i:
            tail[i] = {"cpuMs": ev.get("cpuTime"), "wallMs": ev.get("wallTime"), "outcome": ev.get("outcome")}
    rows = [json.loads(l) for l in open(perf_path)]
    pages = {}
    for r in rows:
        t = tail.get(r["id"], {})
        r["tail"] = t
        print(json.dumps({"page": r["page"], "i": r["i"], "code": r["code"], "s": r["s"], "objectMs": r["objectMs"], "boot": r["perf"].get("boot"), **t}))
        pages.setdefault(r["page"], []).append(r)
    summary = {"tail_events": seen, "joined": sum(1 for r in rows if r["tail"]), "samples": len(rows), "pages": {}}
    for name, rs in pages.items():
        ok = [r for r in rs if r["tail"]]
        cpu = [r["tail"].get("cpuMs") for r in ok]
        wall = [r["tail"].get("wallMs") for r in ok]
        warm = [r["tail"].get("cpuMs") for r in ok if not r["perf"].get("boot")]
        summary["pages"][name] = {"joined": len(ok), "of": len(rs), "cpu_p50_ms": pct(cpu, 50), "cpu_p95_ms": pct(cpu, 95),
                                  "wall_p50_ms": pct(wall, 50), "wall_p95_ms": pct(wall, 95), "warm_cpu_p50_ms": pct(warm, 50),
                                  "warm_cpu_p95_ms": pct(warm, 95), "outcomes": sorted({str(r["tail"].get("outcome")) for r in ok})}
    print(json.dumps(summary))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
