#!/usr/bin/env python3
"""reuse_score.py bars 1 and 6, fixed before E1's data (#1022 issuecomment-7069498841, the lead's go). No site.
Bar 1: under PHP_MEMORY_REUSE the end-of-request ledger is read AFTER dropRuntime on a recycling request, so the one
memory left, the reuse spare, reads retiredMem 1 with memLive 1. Stacking is two memories (memLive >= 2), or a retired
memory on a request that did NOT itself recycle. Bar 6: the median boot wait over BOOT rows only; the old median ran
over every admin row (most 0); under 5 boot rows on an arm it is could not measure. Exit 0 when all pass."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCORE = os.path.join(HERE, "reuse_score.py")
fails = 0
def ok(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  [" + detail + "]"))
    if not cond: fails += 1
tmp = tempfile.mkdtemp(prefix="reuse-score-bars-")
def arm(name, rows):
    p = os.path.join(tmp, name + ".jsonl")
    with open(p, "w") as f:
        for r in rows: f.write(json.dumps(r) + "\n")
    return p
def logs(name):
    d = os.path.join(tmp, name); os.makedirs(d)
    with open(os.path.join(d, "lines.jsonl"), "w") as f: f.write(json.dumps({"t": 1, "rid": "r1", "m": "req"}) + "\n")
    open(os.path.join(d, "invocations.jsonl"), "w").close()
    return d
def bars(off, on, with_logs=False):
    extra = ["--logs-off", logs(os.path.basename(off) + "-L"), "--logs-on", logs(os.path.basename(on) + "-L")] if with_logs else []
    r = subprocess.run([sys.executable, "-I", SCORE, off, on] + extra, capture_output=True, text=True)
    return {int(l.split("|")[1]): l for l in r.stdout.splitlines() if l.startswith("| ") and l.split("|")[1].strip().isdigit()}, r
def admin(i, **k):
    d = {"t": 100.0 + i, "s": 0.4, "kind": "dashboard", "status": 200, "perfId": "p%d" % i, "bootWaitMs": 0}
    d.update(k); return d
guests = [{"t": 500.0 + i, "s": 0.2, "kind": "guest", "status": 200, "perfId": "g%d" % i} for i in range(3)]

print("bar 1: the reuse spare on a recycling request is NOT stacking")
on1 = [admin(i, memLive=1, retiredMem=0) for i in range(5)] + [admin(9, memLive=1, retiredMem=1, retiredMemMiB=101.4, **{"x-runtime-recycled": "memory"})] + guests
off1 = [admin(i) for i in range(5)] + guests
b, r = bars(arm("off1", off1), arm("on1", on1))
ok("a recycling request with memLive 1, retiredMem 1 passes bar 1 (the OLD predicate failed it)", "| pass |" in b.get(1, ""), b.get(1, r.stdout[-300:]))
print("bar 1: real stacking still fails")
on2 = [admin(i, memLive=1, retiredMem=0) for i in range(5)] + [admin(9, memLive=2, retiredMem=1, **{"x-runtime-recycled": "memory"})] + guests
b, r = bars(arm("off2", off1), arm("on2", on2), with_logs=True)  # logs with no named refused offer to excuse it
ok("two memories at once (memLive 2) fails bar 1, recycling or not", "| FAIL |" in b.get(1, ""), b.get(1, ""))
on3 = [admin(i, memLive=1, retiredMem=0) for i in range(5)] + [admin(9, memLive=1, retiredMem=1)] + guests
b, r = bars(arm("off3", off1), arm("on3", on3), with_logs=True)
ok("a retired memory on a request that did NOT recycle fails bar 1", "| FAIL |" in b.get(1, ""), b.get(1, ""))

print("bar 6: the median over BOOT rows")
offb = [admin(i) for i in range(20)] + [admin(30 + i, boot=1, bootWaitMs=168) for i in range(6)] + guests
onb = [admin(i) for i in range(20)] + [admin(30 + i, boot=1, bootWaitMs=1276) for i in range(6)] + guests
b, r = bars(arm("offb", offb), arm("onb", onb))
ok("boot rows 1,276 against 168 FAIL bar 6 (the OLD median over every row read 0 against 0, a pass)", "| FAIL |" in b.get(6, "") and "1276" in b.get(6, "") and "168" in b.get(6, ""), b.get(6, ""))
offq = [admin(i) for i in range(20)] + [admin(30 + i, boot=1, bootWaitMs=200) for i in range(6)] + guests
onq = [admin(i) for i in range(20)] + [admin(30 + i, boot=1, bootWaitMs=230) for i in range(6)] + guests
b, r = bars(arm("offq", offq), arm("onq", onq))
ok("boot rows within 50 ms pass bar 6", "| pass |" in b.get(6, ""), b.get(6, ""))
onf = [admin(i) for i in range(20)] + [admin(30 + i, boot=1, bootWaitMs=1276) for i in range(4)] + guests
b, r = bars(arm("offf", offb), arm("onf", onf))
ok("under 5 boot rows on an arm: could not measure", "| could not measure |" in b.get(6, ""), b.get(6, ""))

print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
