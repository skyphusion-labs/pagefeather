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
import json, re, statistics, sys

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
