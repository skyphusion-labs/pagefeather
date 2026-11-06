#!/usr/bin/env python3
"""Gate for issue #78: the PHP object coalesces page cache purges for the whole site.

Usage: B=<site> ADMIN_PASSWORD=... [SPIKE_TOKEN=...] [LOCAL=1] purge_coalesce_check.py
Reads the object's /_purgestate, makes bursts of parallel writes
(purge_burst_writes.py: 20 posts, then 10 more 5 s later, then deletes),
waits two windows, and reads /_purgestate again. The new sends must be:
at least one; at least PURGE_GAP_MS (15 s) apart; no more than the windows;
the last one at or after the object's last purge request (lastAsked), with
nothing pending. On Cloudflare (LOCAL unset) every send must be ok. Locally
there is no cache API, so a send answers "no cache API" and that is accepted.
Exits 1 on any FAIL.
"""
import json, os, subprocess, sys, time, urllib.request
B = os.environ["B"].rstrip("/")
GAP = 15000
LOCAL = os.environ.get("LOCAL") == "1"


def state():
    h = {"User-Agent": "wp-on-cf-purgecheck"}
    if os.environ.get("SPIKE_TOKEN"):
        h["x-spike-token"] = os.environ["SPIKE_TOKEN"]
    with urllib.request.urlopen(urllib.request.Request(B + "/_purgestate", headers=h), timeout=60) as r:
        return json.loads(r.read())


fails = 0


def check(name, ok, got=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + json.dumps(got)[:300]), flush=True)
    fails += 0 if ok else 1


before = state()
seen = {s["t"] for s in before.get("sends", [])}
burst = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "purge_burst_writes.py"), "20", "10", "5"], capture_output=True, text=True)
print("burst:", burst.stdout.strip() or burst.stderr.strip()[-300:])
time.sleep(2 * GAP / 1000 + 10)
after = state()
new = sorted((s for s in after.get("sends", []) if s["t"] not in seen), key=lambda s: s["t"])
ts = [s["t"] for s in new]
gaps = [b - a for a, b in zip(ts, ts[1:])]
asked_from = before.get("lastAsked") or 0
span = (after.get("lastAsked") or 0) - (ts[0] if ts else 0)
print("new sends %d, gaps (ms) %s, lastAsked %s, lastSent %s, pending %s, alarm %s" % (len(new), gaps, after.get("lastAsked"), after.get("lastSent"), after.get("pending"), after.get("alarm")))
check("the writes asked for a purge", (after.get("lastAsked") or 0) > asked_from, (asked_from, after.get("lastAsked")))
check("at least one purge was sent", len(new) >= 1, len(new))
check("at most one purge per window (%d ms or more apart)" % GAP, all(g >= GAP - 250 for g in gaps), gaps)
check("no more purges than windows", len(new) <= max(span, 0) // GAP + 2, (len(new), span))
check("the last request is covered: a purge at or after it, nothing pending", bool(ts) and ts[-1] >= (after.get("lastAsked") or 0) and not after.get("pending"), (ts[-1:] , after.get("lastAsked"), after.get("pending")))
if LOCAL:
    check("locally each send reached Pages.purge (no cache API)", all(s.get("ok") or s.get("error") == "no cache API" for s in new), new)
else:
    check("every purge was accepted by Workers Cache", all(s.get("ok") for s in new), new)
print("FAILS %d" % fails)
sys.exit(1 if fails else 0)
