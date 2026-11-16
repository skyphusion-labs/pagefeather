#!/usr/bin/env python3
"""#605: where the time of a slow admin request went, from the client, the dispatcher and the site.

  python3 -I tests/load/hang_read.py RUN.jsonl --site DIR --disp DIR [--json]

RUN is a tests/load/reuse_run.py file (run with PFID_IN_URL=1, so each admin request carries its x-perf-id in its
query too). --site and --disp are the lead's wexport.py directories (lines.jsonl and invocations.jsonl) for the
site's user Worker site-<name> and its dispatcher wp-<name> (#786 gives the dispatcher Workers Logs). The spec and
the read table this prints, pinned before the data: #605 (the comment that names this tool).

A request is SLOW when its client time is over SLOW_S (env, default 30) or it got no answer (EXC). For each one:
  edge      dispatcher start - client send      (the VPS clock against Cloudflare's: see the run's clock offset)
  dispatch  site Worker start - dispatcher start (the user Worker's start, through the dispatch namespace)
  to-object Server-Timing inbox, else the object's first ledger line - the site Worker's start
  queue     Server-Timing queue: the wait for the object's PHP lock
  boot      Server-Timing boot: a runtime boot on this request
  php       Server-Timing php: PHP's wall time
  rest      client time - all of the above (the way back, and anything no layer accounts for)
WHERE (the pinned rule): an answered request with Server-Timing is placed in its largest segment (named with its
share of the client time). A request with no Server-Timing is placed by the last layer that saw it start:
  never reached the dispatcher | dispatch: the site Worker never started | to-object: the object never ran it |
  inside the object (it started; no end line)
A join that could not be made says so; it is never filled from the time alone except the dispatcher's
fallback (path and start within 5 s, marked "by time") when the export carries no query.

Exit 0 when the table was printed; 2 when an export is missing (the dispatcher or site columns are "could not
measure"); 3 on a bad argument or input.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from reuse_score import load, logs, joined, dispatcher_row  # noqa: E402  (the same wexport.py reader as the #724 score)

SLOW_S = float(os.environ.get("SLOW_S", "30"))
SEGMENTS = ("edge", "dispatch", "to-object", "queue", "boot", "php", "rest")


def server_timing(v):
    """{name: ms} from a Server-Timing header value."""
    out = {}
    for part in (v or "").split(","):
        m = re.match(r"\s*([A-Za-z0-9_-]+)\s*;\s*dur=([0-9.]+)", part)
        if m:
            out[m.group(1)] = float(m.group(2))
    return out


def disp_for(D, r):
    """The dispatcher invocation of one request: by its pfid in the exported url or path, else by path and time."""
    pid = r.get("perfId")
    for i in D["inv"]:
        u = str(i.get("url") or i.get("path") or "")
        if pid and ("pfid=" + pid) in u and re.search(r"pfid=" + re.escape(pid) + r"(&|$)", u):
            return i, "pfid"
    d = dispatcher_row(D, r)
    return (d, "by time") if d else (None, None)


def read(r, site, disp):
    client_ms = (r.get("s") or 0) * 1000.0
    send_ms = ((r.get("t") or 0) - (r.get("s") or 0)) * 1000.0
    st = server_timing(r.get("server-timing"))
    row = {"perfId": r.get("perfId"), "kind": r.get("kind"), "method": r.get("method"), "path": (r.get("path") or "").split("?")[0],
           "status": r.get("status"), "clientS": r.get("s"), "deadline": r.get("x-object-deadline"), "writeLoss": r.get("x-write-loss")}
    seg = dict.fromkeys(SEGMENTS)
    d = dj = None
    if disp is not None:
        d, dj = disp_for(disp, r)
    row["disp"] = "could not measure" if disp is None else ({"join": dj, "outcome": d.get("outcome"), "status": d.get("status"), "wallMs": d.get("wallMs")} if d else "none")
    t_site = t_obj = None
    obj_end = False
    if site is not None:
        jl, ji = joined(site, r.get("perfId"))
        if ji:
            t_site = min(i.get("t", 0) for i in ji)
        led = [l.get("t") for l in jl if l.get("m") == "mem-ledger" and l.get("t") is not None]
        if led:
            t_obj = min(led)
        obj_end = any(l.get("m") in ("perf", "req") for l in jl)
        ms = {}
        for l in jl:
            ms[l.get("m")] = ms.get(l.get("m"), 0) + 1
        row["site"] = {"invocations": [(i.get("outcome"), i.get("status"), i.get("wallMs")) for i in sorted(ji, key=lambda i: i.get("t", 0))], "lines": ms}
    else:
        row["site"] = "could not measure"
    if d is not None and d.get("t") is not None:
        seg["edge"] = d["t"] - send_ms
        if t_site is not None:
            seg["dispatch"] = t_site - d["t"]
    seg["to-object"] = st.get("inbox") if "inbox" in st else (t_obj - t_site if (t_obj is not None and t_site is not None) else None)
    seg["queue"], seg["boot"], seg["php"] = st.get("queue"), st.get("boot"), st.get("php")
    known = [v for k, v in seg.items() if k != "rest" and v is not None]
    if st and r.get("status") != "EXC":
        seg["rest"] = client_ms - sum(known)
        big = max(((k, v) for k, v in seg.items() if v is not None), key=lambda kv: kv[1])
        row["where"] = "%s (%.0f%%)" % (big[0], 100.0 * big[1] / client_ms if client_ms else 0)
    elif disp is None or site is None:
        row["where"] = "could not measure (an export is missing)"
    elif d is None:
        row["where"] = "never reached the dispatcher"
    elif t_site is None:
        row["where"] = "dispatch: the site Worker never started"
    elif t_obj is None:
        row["where"] = "to-object: the object never ran it"
    elif not obj_end:
        row["where"] = "inside the object (it started; no end line)"
    else:
        row["where"] = "answered without Server-Timing (see the lines)"
    row["segmentsMs"] = {k: (None if v is None else round(v)) for k, v in seg.items()}
    return row


def main(argv):
    if not argv or argv[0].startswith("--"):
        sys.stderr.write("usage: hang_read.py RUN.jsonl --site DIR --disp DIR [--json]\n")
        return 3
    opts, i = {}, 1
    while i < len(argv):
        if argv[i] in ("--site", "--disp"):
            if i + 1 >= len(argv):
                sys.stderr.write("hang_read: %s needs a directory\n" % argv[i]); return 3
            opts[argv[i]] = argv[i + 1]; i += 2
        elif argv[i] == "--json":
            opts["--json"] = True; i += 1
        else:
            sys.stderr.write("hang_read: unknown argument %s\n" % argv[i]); return 3
    if not os.path.isfile(argv[0]):
        sys.stderr.write("hang_read: no run file %s\n" % argv[0]); return 3
    rows = [r for r in load(argv[0]) if r.get("perfId")]
    site, disp = logs(opts.get("--site")), logs(opts.get("--disp"))
    slow = [r for r in rows if r.get("status") == "EXC" or (r.get("s") or 0) > SLOW_S]
    out = [read(r, site, disp) for r in slow]
    where = {}
    for o in out:
        k = o["where"].split(" (")[0]
        where[k] = where.get(k, 0) + 1
    if opts.get("--json"):
        print(json.dumps({"admin": len(rows), "slow": len(out), "slowS": SLOW_S, "where": where, "rows": out}, indent=1))
    else:
        print("#605 read: %d admin requests, %d over %g s or with no answer" % (len(rows), len(out), SLOW_S))
        print("where: %s" % (json.dumps(where) if where else "none slow"))
        if out:
            print("\n| x-perf-id | request | status | client s | deadline | " + " | ".join(s + " ms" for s in SEGMENTS) + " | where | dispatcher | site |")
            print("|" + "---|" * (len(SEGMENTS) + 8))
            for o in out:
                sg = o["segmentsMs"]
                print("| %s | %s %s | %s | %s | %s | %s | %s | %s | %s |" % (
                    o["perfId"], o["method"], o["path"], o["status"], o["clientS"], o["deadline"] or "absent",
                    " | ".join("-" if sg[s] is None else str(sg[s]) for s in SEGMENTS), o["where"],
                    json.dumps(o["disp"]), json.dumps(o["site"])))
    return 2 if (site is None or disp is None) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
