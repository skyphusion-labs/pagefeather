#!/usr/bin/env python3
"""reuse_score.py's request id (#1022 issuecomment-7078186214, the lead's ruling). platform_deaths gives a death line the
isolate of an engine line of the SAME request (rid) before it falls back to the isolate that was live. A Workers Logs
export can carry the request id only under $metadata.requestId (cf759a's wc windows: 20,179 of 20,179 rows, none under
$workers). A conversion that left rid empty silently skipped the same-request step and counted 105 where the scorer
means 110. Now: rid is the line's own rid, else $workers.requestId, else $metadata.requestId; and when EVERY line of an
arm has an empty request id, bar 2's deaths are could not measure, never a count from the live fallback alone.
No site. Exit 0 when all pass."""
import importlib.util, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCORE = os.path.join(HERE, "reuse_score.py")
spec = importlib.util.spec_from_file_location("reuse_score", SCORE)
rs = importlib.util.module_from_spec(spec); spec.loader.exec_module(rs)
DEATH = "Durable Object's isolate exceeded its memory limit and was reset."
fails = 0
def ok(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  [" + str(detail) + "]"))
    if not cond: fails += 1

# Two requests (X, Y) die on two isolates (A, C), while isolate B's perf line is the live one. The same-request step
# gives A and C (2 isolates); the live fallback alone gives B for both (1). The fixture discriminates.
def lines(rid_of):
    return [
        {"t": 1, "m": "perf", "iso": "B", **rid_of("pB")},
        {"t": 2, "m": "txn", "iso": "A", **rid_of("X")},
        {"t": 3, "m": "txn", "iso": "C", **rid_of("Y")},
        {"t": 4, "m": "perf", "iso": "B", **rid_of("pB2")},
        {"t": 5, "message": DEATH, "level": "error", **rid_of("X")},
        {"t": 6, "message": DEATH, "level": "error", **rid_of("Y")},
    ]
meta = lambda r: {"$metadata": {"requestId": r}}
work = lambda r: {"$workers": {"requestId": r}}
top = lambda r: {"rid": r}
none = lambda r: {}

print("1. platform_deaths: the request id read from each place a line can carry it")
ok("top-level rid: 2 isolates (the control: the same-request step runs)", rs.platform_deaths(lines(top))[2] == 2, rs.platform_deaths(lines(top)))
ok("ids only under $metadata.requestId: 2 isolates, not 1 from the live fallback", rs.platform_deaths(lines(meta))[2] == 2, rs.platform_deaths(lines(meta)))
ok("ids only under $workers.requestId: 2 isolates", rs.platform_deaths(lines(work))[2] == 2, rs.platform_deaths(lines(work)))
ok("no request id anywhere: the live fallback alone gives 1 (the reading the CLI must refuse)", rs.platform_deaths(lines(none))[2] == 1, rs.platform_deaths(lines(none)))

tmp = tempfile.mkdtemp(prefix="reuse-score-rid-")
def arm_file(name):
    p = os.path.join(tmp, name + ".jsonl")
    rows = [{"t": 100.0 + i, "s": 0.4, "kind": "dashboard", "status": 200, "perfId": "%s-%d" % (name, i), "bootWaitMs": 200} for i in range(3)]
    rows += [{"t": 200.0 + i, "s": 0.2, "kind": "guest", "status": 200, "perfId": "%s-g%d" % (name, i)} for i in range(3)]
    with open(p, "w") as f:
        for r in rows: f.write(json.dumps(r) + "\n")
    return p
def logs(name, L):
    d = os.path.join(tmp, name); os.makedirs(d)
    with open(os.path.join(d, "lines.jsonl"), "w") as f:
        for o in L: f.write(json.dumps(o) + "\n")
    open(os.path.join(d, "invocations.jsonl"), "w").close()
    return d
def bar2(off_logs, on_logs):
    r = subprocess.run([sys.executable, "-I", SCORE, OFF, ON, "--logs-off", off_logs, "--logs-on", on_logs], capture_output=True, text=True)
    return next((l for l in r.stdout.splitlines() if l.startswith("| 2 |")), r.stdout[-300:] + r.stderr[-300:])
OFF, ON = arm_file("off"), arm_file("on")

print("2. the CLI on a WfP-shaped export (no invocation rows), ids only under $metadata")
b = bar2(logs("M-off", lines(meta)), logs("M-on", lines(meta)))
ok("both arms count 2 death isolates through $metadata.requestId", "platform memory-death isolates on 2, off 2" in b, b)

print("3. the CLI refuses an arm whose every line has an empty request id")
b = bar2(logs("N-off", lines(meta)), logs("N-on", lines(none)))
ok("bar 2 is could not measure, not a pass on the live fallback's 1", "| could not measure |" in b, b)
ok("the detail names the empty request id", "request id" in b and "empty" in b, b)
b = bar2(logs("N2-off", lines(none)), logs("N2-on", lines(meta)))
ok("the same when the OFF arm is the one with no request id", "| could not measure |" in b, b)

print("4. one line with a request id is enough: the refusal is for an arm where the step can never run")
part = lines(none); part[1] = {**part[1], "rid": "X"}; part[4] = {**part[4], "rid": "X"}
b = bar2(logs("P-off", lines(meta)), logs("P-on", part))
ok("no refusal; X attributes to A, Y falls back to B: 2 isolates on", "platform memory-death isolates on 2, off 2" in b, b)

print("reuse-score-rid: %d failed" % fails)
sys.exit(1 if fails else 0)
