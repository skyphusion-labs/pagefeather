#!/usr/bin/env python3
"""Job files and result tables for tests/bench-runner/run.sh.

  job.py target <name> <url>        stdin: `terraform output -json` of the site
                                    (deploy/terraform). Prints one target as JSON.
  job.py job <id> <branch> <n> <targets.jsonl>
                                    Prints the job JSON.
  job.py latency <id> <branch> <n> <direct-url> <dispatched-url>
                                    Prints a latency job (tests/wfp/latency.py on the runner).
  job.py redact <job.json>          Prints the job with passwords and tokens hidden.
  job.py table <result.json>        Prints a table of a runner result.
"""
import json, os, re, statistics, sys

VARIANTS = ("b-do", "b-dosql", "a", "c1")


def die(msg):
    sys.stderr.write("job.py: %s\n" % msg)
    sys.exit(1)


def target(name, url):
    o = {k: v.get("value") for k, v in json.load(sys.stdin).items()}
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name):
        die("bad site name: %r" % name)
    if not re.fullmatch(r"https://[a-z0-9.-]+(:[0-9]{1,5})?", url):
        die("bad url for %s (https://host only): %r" % (name, url))
    variant = o.get("variant")
    if variant not in VARIANTS:
        die("%s: variant %r is not one of %s" % (name, variant, ", ".join(VARIANTS)))
    for k in ("admin_password", "spike_token"):
        if not o.get(k):
            die("%s: no %s in the Terraform outputs" % (name, k))
    print(json.dumps({"name": name, "url": url, "variant": variant, "location": o.get("location") or "",
                      "admin_password": o["admin_password"], "spike_token": o["spike_token"]}))


def job(jid, branch, n, path):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", jid):
        die("bad job id")
    targets = [json.loads(l) for l in open(path) if l.strip()]
    if not targets:
        die("no targets")
    j = {"id": jid, "n": int(n), "targets": targets}
    load = os.environ.get("LOAD", "")
    if load:
        m = re.fullmatch(r"([0-9]{1,3}(?:,[0-9]{1,3}){0,9}):([0-9]{1,3}):(0(?:\.[0-9]+)?|1)(?::(nocache|cached|cached-sbjs))?", load)
        if not m or max(int(x) for x in m.group(1).split(",")) > 100 or not 10 <= int(m.group(2)) <= 300:
            die("LOAD is levels:seconds:buyers[:mode], e.g. 1,5,10,25,50:60:0.2 or 1,5,10:60:0.2:cached (users 1 to 100, seconds 10 to 300; mode nocache, cached or cached-sbjs, see tests/load/load.py)")
        j["load"] = {"levels": m.group(1), "seconds": int(m.group(2)), "buyers": float(m.group(3)), "mode": m.group(4) or "nocache"}
    if branch:
        j["branch"] = branch
    print(json.dumps(j, indent=1))


def latency(jid, branch, n, direct, dispatched):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", jid):
        die("bad job id")
    for u in (direct, dispatched):
        if not re.fullmatch(r"https://[a-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)?", u):
            die("bad url (https only, plain path): %r" % u)
    j = {"id": jid, "kind": "latency", "n": int(n), "pairs": [{"direct": direct, "dispatched": dispatched}]}
    if branch:
        j["branch"] = branch
    print(json.dumps(j, indent=1))


def redact(path):
    j = json.load(open(path))
    for t in j.get("targets", []):
        for k in ("admin_password", "spike_token"):
            if t.get(k):
                t[k] = "<hidden, %d characters>" % len(t[k])
    print(json.dumps(j, indent=1))


def load_table(r):
    print("users  req    rps    errors  aborted  1102  boots  recycled        wasm MiB  browse p50/p95/p99    checkout ok/n  p50/p95/p99   client load")
    for t in r.get("targets", []):
        print("%s (%s)%s" % (t.get("name"), t.get("variant"), "  ERROR: " + t["error"] if t.get("error") else ""))
        for s in (t.get("load") or {}).get("steps", []):
            b, c = s["kinds"].get("browse") or {}, s["kinds"].get("checkout") or {}
            f = lambda k: "%s/%s/%s" % (k.get("p50"), k.get("p95"), k.get("p99")) if k else "-"
            print("%-6s %-6s %-6s %-7s %-8s %-5s %-6s %-15s %-9s %-21s %-14s %-13s %s/%s" % (
                s["users"], s["requests"], s["rps"], s["errors"], s.get("aborted", "-"), s["e1102"], s["boots"],
                ",".join("%s=%s" % kv for kv in s["recycled"].items()) or "0", s["max_wasm_mib"],
                f(b), "%s/%s" % (c.get("ok", 0), c.get("n", 0)), f(c), s.get("client_load1"), s.get("client_cpus")))
    print("Seconds. errors: any request not 2xx (a checkout must return an order). 1102: Worker exceeded resource limits.")
    print("aborted: buy loops whose cart request failed, so add item and checkout were not sent (#40). \"-\": a run before #40.")
    print("client load: the runner's 1-minute load / its CPUs. At or above 1 per CPU, the client was the limit for that step.")


def table(path):
    r = json.load(open(path))
    m = r.get("runner") or {}
    print("runner: %s %s, branch %s at %s, %s to %s, n=%s" % (m.get("region"), m.get("plan"), m.get("branch"), (m.get("git_sha") or "")[:10],
                                                           m.get("started_utc"), m.get("finished_utc"), r.get("n")))
    print("        %s" % m.get("curl"))
    if r.get("error"):
        print("JOB ERROR:", r["error"])
    if r.get("kind") == "latency":
        for p in r.get("latency") or []:
            if p.get("error"):
                print("ERROR:", p["error"])
                continue
            for k in ("direct", "dispatched"):
                v = p.get(k) or {}
                print("%-10s p50 %s ms  p95 %s ms  p99 %s ms  mean %s ms  ok %s  %s" % (k, v.get("p50"), v.get("p95"), v.get("p99"), v.get("mean"), v.get("ok"), v.get("url")))
            print("added     ", p.get("added_ms"))
        return
    if r.get("load"):
        print("load: users %s, %s s per step, buyers %s, mode %s" % (r["load"]["levels"], r["load"]["seconds"], r["load"]["buyers"], r["load"].get("mode", "nocache")))
        return load_table(r)
    pages = []
    for t in r.get("targets", []):
        for p in ((t.get("bench") or {}).get("pages") or {}):
            if p not in pages:
                pages.append(p)
    head = ["target", "variant", "db ms/q", "e2e"] + pages
    rows = []
    for t in r.get("targets", []):
        # /_d1ping answers {median, ...}; /_dbping (b-dosql) answers {perStatementMs, ...}.
        ping = [p.get("median", p.get("perStatementMs")) for p in t.get("d1_ping") or [] if isinstance(p, dict)]
        ping = [x for x in ping if isinstance(x, (int, float))]
        e2e = t.get("e2e") or {}
        cells = [t.get("name") or "?", t.get("variant") or "?",
                 ("%.3g" % statistics.median(ping)) if ping else "-",
                 ("exit %s, %s/%s" % (e2e.get("exit"), e2e.get("ok"), e2e.get("rows"))) if e2e else "-"]
        bp = (t.get("bench") or {}).get("pages") or {}
        for p in pages:
            v = bp.get(p) or {}
            cells.append("-" if v.get("median_s") is None else "%.2fs" % v["median_s"])
        if t.get("error"):
            cells[3] = "ERROR: " + t["error"]
        rows.append(cells)
    w = [max(len(str(x)) for x in col) for col in zip(head, *rows)]
    for line in [head] + rows:
        print("  ".join(str(c).ljust(w[i]) for i, c in enumerate(line)))
    print("Page columns: median seconds of fresh (uncached) renders. db ms/q: median of the three /_d1ping or /_dbping medians.")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["target"] and len(a) == 3:
        target(a[1], a[2])
    elif a[:1] == ["job"] and len(a) == 5:
        job(*a[1:])
    elif a[:1] == ["latency"] and len(a) == 6:
        latency(*a[1:])
    elif a[:1] == ["redact"] and len(a) == 2:
        redact(a[1])
    elif a[:1] == ["table"] and len(a) == 2:
        table(a[1])
    else:
        die(__doc__)
