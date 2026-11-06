#!/usr/bin/env python3
"""Evidence for the Workers for Platforms spike (issue #35).

Usage: check.py <dispatcher-url> [container]
Calls the dispatcher (tests/wfp/dispatcher) and prints one JSON object: for
each check, the path, the HTTP status, the answer and the time. A check that
is expected to fail (a limit) has a control that is expected to pass, so a
failure is shown to come from the limit, not from the test.
"""
import json, os, sys, time, urllib.error, urllib.request

D = sys.argv[1].rstrip("/")
with_container = len(sys.argv) > 2 and sys.argv[2] == "container"


def get(path):
    t = time.time()
    req = urllib.request.Request(D + path, headers={"User-Agent": "wp-on-cf-wfp-spike"})
    try:
        r = urllib.request.urlopen(req, timeout=120)
        code, body, h = r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        code, body, h = e.code, e.read(), e.headers
    except Exception as e:
        return {"path": path, "status": "EXC", "error": repr(e)[:200], "s": round(time.time() - t, 3)}
    try:
        b = json.loads(body)
    except ValueError:
        b = body.decode(errors="replace")[:300]
    return {"path": path, "status": code, "s": round(time.time() - t, 3), "answer": b,
            "x-dispatch-limits": h.get("x-dispatch-limits")}


checks = {
    # 1. SQLite-backed Durable Object in a user Worker; two tenants, separate data.
    "do_tenant_a_1": "/tenant-a/do",
    "do_tenant_a_2": "/tenant-a/do",
    "do_tenant_b_1": "/tenant-b/do",
    # 3. Bindings on a user Worker.
    "d1": "/tenant-a/d1",
    "r2": "/tenant-a/r2",
    "images": "/tenant-a/images",
    # 4. Custom limits: control, then over the limit.
    "cpu_control": "/tenant-a/burn?ms=5",
    "cpu_no_limit_500": "/tenant-a/burn?ms=500",
    "cpu_limit_10ms_500": "/tenant-a/burn?ms=500&cpuMs=10",
    "sub_control_3": "/tenant-a/sub?n=3",
    "sub_limit_2_of_6": "/tenant-a/sub?n=6&subRequests=2",
    # 4. Outbound Worker: from the user Worker, and from its Durable Object.
    "outbound_off": "/tenant-a/sub?n=1",
    "outbound_on": "/tenant-a/sub?n=1&outbound=1",
    "outbound_on_from_do": "/tenant-a/do-sub?outbound=1",
    # Dispatch of a script that does not exist.
    "missing_script": "/no-such-tenant/ping",
}
out = {"dispatcher": D, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": {}}
for k, p in checks.items():
    out["checks"][k] = get(p)
    print("%-22s %s %s" % (k, out["checks"][k]["status"], json.dumps(out["checks"][k].get("answer"))[:150]), file=sys.stderr)
# A new container application needs time before an instance exists: the
# first calls answer 503 "There is no Container instance available at this
# time" (about 1.5 to 2 minutes after the application was made, 2026-11-06,
# #43). After the other checks, container_1 repeats the call every
# CONTAINER_EVERY seconds (default 20), up to CONTAINER_WAIT seconds (default
# 240), until the container answers, and records the tries and the wait.
# container_2 is one more call, with the container warm.
if with_container:
    wait = float(os.environ.get("CONTAINER_WAIT", "240"))
    every = float(os.environ.get("CONTAINER_EVERY", "20"))
    t0, tries, r = time.time(), 0, None
    while True:
        tries += 1
        r = get("/tenant-c/container")
        a = r.get("answer")
        if isinstance(a, dict) and a.get("ok") is True:
            break
        if time.time() - t0 + every > wait:
            break
        time.sleep(every)
    r["tries"] = tries
    r["waited_s"] = round(time.time() - t0, 1)
    out["checks"]["container_1"] = r
    print("%-22s %s tries %d, waited %.0f s %s" % ("container_1", r["status"], tries, r["waited_s"], json.dumps(r.get("answer"))[:120]), file=sys.stderr)
    out["checks"]["container_2"] = get("/tenant-c/container")
    print("%-22s %s %s" % ("container_2", out["checks"]["container_2"]["status"], json.dumps(out["checks"]["container_2"].get("answer"))[:120]), file=sys.stderr)
print(json.dumps(out, indent=1))
