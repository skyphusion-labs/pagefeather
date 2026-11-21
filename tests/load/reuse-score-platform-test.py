#!/usr/bin/env python3
"""reuse_score.py bar 2 on Workers for Platforms (#1022 issuecomment-7067599082, the lead's ruling, set before the
lean-on data). A WfP user script exposes NO invocation rows, so invocations.jsonl is empty. Before this, the scorer read
exceededMemory as 0 on both arms and could PASS bar 2 without reading a death. Now: when either arm has no invocation
rows, BOTH arms count the platform's own memory-death line in lines.jsonl ("Durable Object's isolate exceeded its memory
limit and was reset."); with no lines either, bar 2 is could not measure, never a pass. No site. Exit 0 when all pass."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCORE = os.path.join(HERE, "reuse_score.py")
DEATH = "Durable Object's isolate exceeded its memory limit and was reset."
fails = 0
def ok(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  [" + detail + "]"))
    if not cond: fails += 1

tmp = tempfile.mkdtemp(prefix="reuse-score-platform-")
def arm_file(name):
    p = os.path.join(tmp, name + ".jsonl")
    rows = [{"t": 100.0 + i, "s": 0.4, "kind": "dashboard", "status": 200, "perfId": "%s-%d" % (name, i), "bootWaitMs": 200} for i in range(3)]
    rows += [{"t": 200.0 + i, "s": 0.2, "kind": "guest", "status": 200, "perfId": "%s-g%d" % (name, i)} for i in range(3)]
    with open(p, "w") as f:
        for r in rows: f.write(json.dumps(r) + "\n")
    return p
def logs(name, lines, inv=()):
    d = os.path.join(tmp, name); os.makedirs(d)
    with open(os.path.join(d, "lines.jsonl"), "w") as f:
        for o in lines: f.write(json.dumps(o) + "\n")
    with open(os.path.join(d, "invocations.jsonl"), "w") as f:
        for o in inv: f.write(json.dumps(o) + "\n")
    return d
def bar2(off_logs, on_logs):
    r = subprocess.run([sys.executable, "-I", SCORE, OFF, ON, "--logs-off", off_logs, "--logs-on", on_logs], capture_output=True, text=True)
    return next((l for l in r.stdout.splitlines() if l.startswith("| 2 |")), r.stdout[-300:] + r.stderr[-300:])

OFF, ON = arm_file("off"), arm_file("on")
death = lambda t: {"t": t, "rid": "p%d" % t, "message": DEATH, "level": "error"}
req = lambda t: {"t": t, "rid": "r%d" % t, "m": "req"}

print("1. empty invocations AND empty lines: never a pass")
b = bar2(logs("E-off", []), logs("E-on", []))
ok("bar 2 is could not measure", "| could not measure |" in b, b)

print("1b. empty logs: lost writes fall back to the client, never a 0 read from empty logs")
ON_WL = os.path.join(tmp, "on-wl.jsonl")
with open(ON_WL, "w") as f:
    for line in open(ON): f.write(line)
    f.write(json.dumps({"t": 150.0, "s": 0.5, "kind": "save", "status": 500, "perfId": "on-wl", "x-write-loss": "1"}) + "\n")
r = subprocess.run([sys.executable, "-I", SCORE, OFF, ON_WL, "--logs-off", logs("W-off", []), "--logs-on", logs("W-on", [])], capture_output=True, text=True)
b = next((l for l in r.stdout.splitlines() if l.startswith("| 2 |")), r.stdout[-300:])
ok("a client-seen write loss on the on arm FAILS bar 2", "| FAIL |" in b and "client x-write-loss + silent) on 1, off 0" in b, b)

print("2. the positive control: empty invocations, platform death lines present (on 3, off 1)")
b = bar2(logs("P-off", [req(1), death(2)]), logs("P-on", [req(1), death(2), death(3), death(4)]))
ok("bar 2 FAILS on the platform deaths", "| FAIL |" in b, b)
ok("the detail names the platform source and both counts (unattributed lines count by timestamp)", "platform memory-death isolates on 3, off 1" in b, b)

print("3. empty invocations, lines present, no platform deaths on the on arm (off has 2)")
b = bar2(logs("Z-off", [req(1), death(2), death(3)]), logs("Z-on", [req(1)]))
ok("bar 2 passes on a MEASURED zero", "| pass |" in b, b)
ok("the detail names the platform source", "platform memory-death isolates on 0, off 2" in b, b)

print("4. one arm with invocation rows, one without: BOTH use the platform lines (one source for both arms)")
inv = [{"t": 1, "type": "fetch", "outcome": "exceededMemory", "status": 500, "path": "/", "wallMs": 9, "rid": "i1"}]
b = bar2(logs("M-off", [req(1)], inv), logs("M-on", [req(1), death(2)]))
ok("scored from the platform lines (on 1, off 0), so a FAIL", "| FAIL |" in b and "platform memory-death isolates on 1, off 0" in b, b)

print("6. distinct ISOLATES, not lines (#1022 issuecomment-7067648245): one death logs a line per in-flight request")
# on: 3 death lines, all in isolate A (two joined by rid to a line that names the isolate, one by the live perf isolate).
# off: 2 death lines in two isolates. So on 1 isolate, off 2: a pass, and the raw lines (3 against 2) are only reported.
on_l = [{"t": 1, "rid": "q1", "m": "perf", "iso": "isoA"}, {"t": 2, "rid": "a1", "m": "php-lock", "iso": "isoA"}, {"t": 3, "rid": "a2", "m": "php-lock", "iso": "isoA"},
        {"t": 10, "rid": "a1", "message": DEATH, "level": "error"}, {"t": 10, "rid": "a2", "message": DEATH, "level": "error"}, {"t": 12, "rid": "zz", "message": DEATH, "level": "error"}]
off_l = [{"t": 1, "rid": "q1", "m": "perf", "iso": "isoB"}, {"t": 5, "rid": "b1", "message": DEATH, "level": "error"},
         {"t": 20, "rid": "q2", "m": "perf", "iso": "isoC"}, {"t": 25, "rid": "c1", "message": DEATH, "level": "error"}]
b = bar2(logs("D-off", off_l), logs("D-on", on_l))
ok("bar 2 passes on 1 isolate against 2", "| pass |" in b, b)
ok("the detail gives isolates first, then the raw lines and the distinct timestamps", "platform memory-death isolates on 1, off 2 (lines on 3, off 2; timestamps on 2, off 2)" in b, b)
b = bar2(logs("D2-off", on_l), logs("D2-on", off_l))
ok("and the reverse (on 2 isolates, off 1) FAILS", "| FAIL |" in b and "platform memory-death isolates on 2, off 1" in b, b)

print("6b. the rid join wins over the live isolate: a death of isolate A logged after isolate D's first perf line")
on_x = [{"t": 1, "rid": "q1", "m": "perf", "iso": "isoA"}, {"t": 2, "rid": "a1", "m": "php-lock", "iso": "isoA"},
        {"t": 9, "rid": "q9", "m": "perf", "iso": "isoD"}, {"t": 10, "rid": "a1", "message": DEATH, "level": "error"}, {"t": 11, "rid": "zz", "message": DEATH, "level": "error"}]
off_x = [{"t": 1, "rid": "q1", "m": "perf", "iso": "isoB"}, {"t": 5, "rid": "b1", "message": DEATH, "level": "error"}]
b = bar2(logs("X-off", off_x), logs("X-on", on_x))
ok("two isolates on the on arm (A by rid, D by the live isolate), one off: a FAIL", "| FAIL |" in b and "platform memory-death isolates on 2, off 1" in b, b)

print("5. both arms with invocation rows: the invocation outcome, as before")
inv_ok = [{"t": 1, "type": "fetch", "outcome": "ok", "status": 200, "path": "/", "wallMs": 9, "rid": "i1"}]
b = bar2(logs("I-off", [req(1)], inv_ok), logs("I-on", [req(1)], inv_ok))
ok("bar 2 passes on exceededMemory 0 and 0, from invocations", "| pass |" in b and "exceededMemory on 0, off 0" in b, b)

print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
