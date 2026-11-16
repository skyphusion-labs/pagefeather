#!/usr/bin/env python3
"""tests/load/hang_read.py (#605) on synthetic runs and wexport.py directories: each placement rule, the joins,
and the exits. Run: python3 -I tests/load/hang-read-test.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "hang_read.py")
fails = []


def ok(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (("  (" + detail + ")") if detail and not cond else ""))
    cond or fails.append(name)


def jl(path, rows):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def wexport(d, lines, inv):
    os.makedirs(d)
    jl(os.path.join(d, "lines.jsonl"), lines)
    jl(os.path.join(d, "invocations.jsonl"), inv)


tmp = tempfile.mkdtemp(prefix="hang-read-test.")
T = 1_800_000_000.0  # client end times, s
ST = 'object;dur=40000, inbox;dur=50, queue;dur=36000;desc="ahead 3", in;dur=3900, outbox;dur=50, php;dur=3800, db;dur=900'
run = [
    # A: answered in 40 s, most of it the PHP-lock queue
    {"t": T, "s": 40.0, "kind": "post-new", "method": "GET", "path": "/wp-admin/post-new.php?pfid=r-1", "perfId": "r-1", "status": 200, "server-timing": ST},
    # B: no answer; the dispatcher never saw it
    {"t": T + 100, "s": 120.0, "kind": "save", "method": "POST", "path": "/wp-admin/profile.php?pfid=r-2", "perfId": "r-2", "status": "EXC"},
    # C: no answer; the dispatcher saw it (by pfid), the site Worker never started
    {"t": T + 300, "s": 121.0, "kind": "post-new", "method": "GET", "path": "/wp-admin/post-new.php?pfid=r-3", "perfId": "r-3", "status": "EXC"},
    # D: no answer; the site Worker started, the object never ran it
    {"t": T + 500, "s": 90.0, "kind": "edit", "method": "GET", "path": "/wp-admin/edit.php?pfid=r-4", "perfId": "r-4", "status": 503, "x-object-deadline": "no-answer"},
    # E: no answer; the object started it (a ledger line) and never ended
    {"t": T + 700, "s": 155.0, "kind": "save", "method": "POST", "path": "/wp-admin/profile.php?pfid=r-5", "perfId": "r-5", "status": "EXC"},
    # F: fast: not listed
    {"t": T + 800, "s": 0.4, "kind": "edit", "method": "GET", "path": "/wp-admin/edit.php?pfid=r-6", "perfId": "r-6", "status": 200},
    # G: a slow request whose pfid is a PREFIX of another's (r-1 against r-10): the join must not confuse them
    {"t": T + 900, "s": 31.0, "kind": "edit", "method": "GET", "path": "/wp-admin/edit.php?pfid=r-10", "perfId": "r-10", "status": "EXC"},
]
jl(os.path.join(tmp, "run.jsonl"), run)
ms = lambda s: s * 1000.0  # noqa: E731
start = lambda r: ms(r["t"] - r["s"])  # noqa: E731
A, B_, C, D, E, F, G = run
# The dispatcher with DISPATCH_PERF_LOG=on: its disp-req lines (by x-perf-id) and its invocation records (by rid).
# G's lines come FIRST: an id match that is not exact would hand them to A (r-1 is a prefix of r-10).
disp_lines = [
    {"t": start(G) + 20, "rid": "dG", "m": "disp-req", "at": "start", "id": "r-10", "path": "/wp-admin/edit.php"},
    {"t": start(A) + 30, "rid": "dA", "m": "disp-req", "at": "start", "id": "r-1", "path": "/wp-admin/post-new.php"},
    {"t": ms(A["t"]) - 10, "rid": "dA", "m": "disp-req", "at": "end", "id": "r-1", "path": "/wp-admin/post-new.php", "ms": 39960, "status": 200},
    {"t": start(C) + 40, "rid": "dC", "m": "disp-req", "at": "start", "id": "r-3", "path": "/wp-admin/post-new.php"},
    {"t": start(D) + 40, "rid": "dD", "m": "disp-req", "at": "start", "id": "r-4", "path": "/wp-admin/edit.php"},
    {"t": ms(D["t"]) - 10, "rid": "dD", "m": "disp-req", "at": "end", "id": "r-4", "path": "/wp-admin/edit.php", "ms": 89950, "status": 503},
    {"t": start(E) + 40, "rid": "dE", "m": "disp-req", "at": "start", "id": "r-5", "path": "/wp-admin/profile.php"},
]
disp_inv = [
    {"t": start(G) + 19, "type": "fetch", "outcome": "canceled", "status": None, "path": "/wp-admin/edit.php", "wallMs": 30900, "rid": "dG"},
    {"t": start(A) + 29, "type": "fetch", "outcome": "ok", "status": 200, "path": "/wp-admin/post-new.php", "wallMs": 39900, "rid": "dA"},
    {"t": start(C) + 39, "type": "fetch", "outcome": "canceled", "status": None, "path": "/wp-admin/post-new.php", "wallMs": 120900, "rid": "dC"},
    {"t": start(D) + 39, "type": "fetch", "outcome": "ok", "status": 503, "path": "/wp-admin/edit.php", "wallMs": 89900, "rid": "dD"},
    {"t": start(E) + 39, "type": "fetch", "outcome": "canceled", "status": None, "path": "/wp-admin/profile.php", "wallMs": 154900, "rid": "dE"},
]
site_lines = [
    {"t": start(A) + 120, "rid": "sA", "m": "mem-ledger", "id": "r-1", "at": "start"},
    {"t": ms(A["t"]) - 20, "rid": "sA", "m": "perf", "id": "r-1"},
    {"t": start(D) + 90100, "rid": "sD", "m": "object-deadline", "id": "r-4", "deadlineMs": 90000},
    {"t": start(E) + 300, "rid": "oE", "m": "mem-ledger", "id": "r-5", "at": "start"},
]
site_inv = [
    {"t": start(A) + 60, "type": "fetch", "outcome": "ok", "status": 200, "path": "/wp-admin/post-new.php", "wallMs": 39800, "rid": "sA"},
    {"t": start(D) + 70, "type": "fetch", "outcome": "ok", "status": 503, "path": "/wp-admin/edit.php", "wallMs": 89800, "rid": "sD"},
    {"t": start(E) + 120, "type": "fetch", "outcome": "exceededMemory", "status": 500, "path": "/wp-admin/profile.php", "wallMs": 154000, "rid": "oE"},
]
wexport(os.path.join(tmp, "site"), site_lines, site_inv)
wexport(os.path.join(tmp, "disp"), disp_lines, disp_inv)

p = subprocess.run([sys.executable, "-I", TOOL, os.path.join(tmp, "run.jsonl"), "--site", os.path.join(tmp, "site"), "--disp", os.path.join(tmp, "disp"), "--json"],
                   capture_output=True, text=True, env=dict(os.environ, SLOW_S="30"))
ok("exit 0 with both exports", p.returncode == 0, p.stderr[-300:])
r = json.loads(p.stdout) if p.returncode == 0 else {"rows": [], "slow": None}
by = {x["perfId"]: x for x in r["rows"]}
ok("6 slow of 7 (the 0.4 s request is not listed)", r["slow"] == 6 and "r-6" not in by, str(r.get("slow")))
ok("A: answered, placed in its largest segment: the PHP-lock queue (90%)", by.get("r-1", {}).get("where") == "queue (90%)", by.get("r-1", {}).get("where"))
ok("A: the segments add up from the layers (edge 30, dispatch 30, to-object 50 from inbox, php 3800)",
   by.get("r-1", {}).get("segmentsMs", {}) and [by["r-1"]["segmentsMs"][k] for k in ("edge", "dispatch", "to-object", "php")] == [30, 30, 50, 3800], str(by.get("r-1", {}).get("segmentsMs")))
ok("A: the db entry is inside php, never summed (rest = 40000 - 30 - 30 - 50 - 36000 - 3800)", by.get("r-1", {}).get("segmentsMs", {}).get("rest") == 90, str(by.get("r-1", {}).get("segmentsMs")))
ok("B: no dispatcher invocation: never reached the dispatcher", by.get("r-2", {}).get("where") == "never reached the dispatcher", by.get("r-2", {}).get("where"))
ok("C: the dispatcher joined by its disp-req line, no site invocation: dispatch", by.get("r-3", {}).get("where") == "dispatch: the site Worker never started" and by["r-3"]["disp"]["join"] == "disp-req", json.dumps(by.get("r-3")))
ok("C: no end line (the call never returned): end is None", by.get("r-3", {}).get("disp", {}).get("end") is None, json.dumps(by.get("r-3", {}).get("disp")))
ok("C: the dispatcher's own outcome and wall time are shown (from its invocation, by rid)", by.get("r-3", {}).get("disp", {}).get("outcome") == "canceled" and by["r-3"]["disp"]["wallMs"] == 120900)
ok("D: the dispatcher's end line gives its status and time", by.get("r-4", {}).get("disp", {}).get("status") == 503 and by["r-4"]["disp"]["ms"] == 89950 and by["r-4"]["disp"]["end"] == "end", json.dumps(by.get("r-4", {}).get("disp")))
ok("D: the site Worker started, no object line: to-object (the #703 deadline shown)", by.get("r-4", {}).get("where") == "to-object: the object never ran it" and by["r-4"]["deadline"] == "no-answer", json.dumps(by.get("r-4")))
ok("E: the object started it and never ended: inside the object, its exceededMemory shown",
   by.get("r-5", {}).get("where") == "inside the object (it started; no end line)" and ("exceededMemory", 500, 154000) in [tuple(x) for x in by["r-5"]["site"]["invocations"]], json.dumps(by.get("r-5")))
ok("A joins its OWN dispatcher invocation, not r-10's listed first (an exact id, not a prefix)", by.get("r-1", {}).get("disp", {}).get("wallMs") == 39900, json.dumps(by.get("r-1", {}).get("disp")))
ok("G joins its own invocation by its id", by.get("r-10", {}).get("disp", {}).get("wallMs") == 30900 and by["r-10"]["disp"]["join"] == "disp-req", json.dumps(by.get("r-10", {}).get("disp")))
ok("the verdict histogram counts each placement", r.get("where", {}).get("queue") == 1 and r["where"].get("never reached the dispatcher") == 1, json.dumps(r.get("where")))

# DISPATCH_PERF_LOG off: no disp-req lines. The only fallback joins by path and start time, and says so.
wexport(os.path.join(tmp, "disp-nolines"), [], disp_inv)
p = subprocess.run([sys.executable, "-I", TOOL, os.path.join(tmp, "run.jsonl"), "--site", os.path.join(tmp, "site"), "--disp", os.path.join(tmp, "disp-nolines"), "--json"], capture_output=True, text=True)
r2 = json.loads(p.stdout)
by2 = {x["perfId"]: x for x in r2["rows"]}
ok("no disp-req lines: the dispatcher joins by path and time, marked so", by2["r-3"]["disp"]["join"] == "by time", json.dumps(by2["r-3"]["disp"]))

p = subprocess.run([sys.executable, "-I", TOOL, os.path.join(tmp, "run.jsonl"), "--site", os.path.join(tmp, "site")], capture_output=True, text=True)
ok("no dispatcher export: exit 2, and the rows say could not measure", p.returncode == 2 and "could not measure" in p.stdout, str(p.returncode))
ok("the table prints the pinned columns", "| x-perf-id | request | status | client s | deadline | edge ms | dispatch ms | to-object ms | queue ms | boot ms | php ms | rest ms | where |" in p.stdout)
p = subprocess.run([sys.executable, "-I", TOOL, "--site", "x"], capture_output=True, text=True)
ok("a bad argument: exit 3", p.returncode == 3)
p = subprocess.run([sys.executable, "-I", TOOL, os.path.join(tmp, "run.jsonl"), "--disp", os.path.join(tmp, "nope")], capture_output=True, text=True)
ok("an export directory that is not one: exit 3", p.returncode == 3, str(p.returncode))

shutil.rmtree(tmp)
print("hang-read-test: %d failing" % len(fails))
sys.exit(1 if fails else 0)
