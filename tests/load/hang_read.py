#!/usr/bin/env python3
"""#605: where the time of a slow admin request went, from the client, the dispatcher and the site.

  python3 -I tests/load/hang_read.py RUN.jsonl --site DIR --disp DIR [--json]

RUN is a tests/load/reuse_run.py file. --site and --disp are the lead's wexport.py directories (lines.jsonl and
invocations.jsonl) for the site's user Worker site-<name> and its dispatcher wp-<name> (#786 gives the dispatcher
Workers Logs). The dispatcher must run with DISPATCH_PERF_LOG=on (deploy/wfp, a throwaway): it then logs
{m: disp-req, at: start|end|threw, id: <x-perf-id>, path, ms, status}, and those lines join it to the request
exactly (query strings are redacted in Workers Logs, so no id in the URL can). The spec and the read table this
prints, pinned before the data: #605 (the comment that names this tool).

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
A join that could not be made says so. The dispatcher's only fallback, when it logged no disp-req line for the
request (DISPATCH_PERF_LOG off), is reuse_score's path and start within 5 s, marked "by time".

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
    """The dispatcher's view of one request: (start ms, its invocation or None, its end line or None, the join).
    By the request's own disp-req lines (x-perf-id, exact), else by path and time (marked "by time")."""
    pid = r.get("perfId")
    mine = [l for l in D["lines"] if l.get("m") == "disp-req" and pid and l.get("id") == pid]
    if mine:
        start = [l for l in mine if l.get("at") == "start"]
        end = [l for l in mine if l.get("at") in ("end", "threw")]
        t0 = min(l.get("t", 0) for l in (start or mine))
        rid = (start or mine)[0].get("rid")
        inv = (D["inv_by_rid"].get(rid) or [None])[0]
        return t0, inv, (end[0] if end else None), "disp-req"
    d = dispatcher_row(D, r)
    return ((d.get("t"), d, None, "by time") if d else (None, None, None, None))


def read(r, site, disp):
    client_ms = (r.get("s") or 0) * 1000.0
    send_ms = ((r.get("t") or 0) - (r.get("s") or 0)) * 1000.0
    st = server_timing(r.get("server-timing"))
    row = {"perfId": r.get("perfId"), "kind": r.get("kind"), "method": r.get("method"), "path": (r.get("path") or "").split("?")[0],
           "status": r.get("status"), "clientS": r.get("s"), "deadline": r.get("x-object-deadline"), "writeLoss": r.get("x-write-loss")}
    seg = dict.fromkeys(SEGMENTS)
    t_disp = None
    if disp is None:
        row["disp"] = "could not measure"
    else:
        t_disp, inv, end, dj = disp_for(disp, r)
        if dj is None:
            row["disp"] = "none"
        else:
            row["disp"] = {"join": dj, "outcome": inv.get("outcome") if inv else None, "status": (end or {}).get("status", inv.get("status") if inv else None),
                           "wallMs": inv.get("wallMs") if inv else None, "ms": (end or {}).get("ms"), "end": (end or {}).get("at")}
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
    if t_disp is not None:
        seg["edge"] = t_disp - send_ms
        if t_site is not None:
            seg["dispatch"] = t_site - t_disp
    seg["to-object"] = st.get("inbox") if "inbox" in st else (t_obj - t_site if (t_obj is not None and t_site is not None) else None)
    seg["queue"], seg["boot"], seg["php"] = st.get("queue"), st.get("boot"), st.get("php")
    known = [v for k, v in seg.items() if k != "rest" and v is not None]
    if st and r.get("status") != "EXC":
        seg["rest"] = client_ms - sum(known)
        big = max(((k, v) for k, v in seg.items() if v is not None), key=lambda kv: kv[1])
        row["where"] = "%s (%.0f%%)" % (big[0], 100.0 * big[1] / client_ms if client_ms else 0)
    elif disp is None or site is None:
        row["where"] = "could not measure (an export is missing)"
    elif t_disp is None:
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
