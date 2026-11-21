#!/bin/bash
# #705 review, finding 3: a refused boot on an OPERATOR route (/_peak) answers the known 503, and the next request
# does not await the same rejected boot again.
#   tests/boot-gate-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
# dosql-local, PHP_RECYCLE off, PHP_MEMORY_REUSE off, BOOT_GATE on: /_install boots; a forced recycle of a page
# leaves its memory retired and alive (no reuse), so the next boot must be refused. /_peak is that next boot.
# #705 second review, finding 1: the refusals never last: with BOOT_GATE_MAX_REFUSE_S=3, a boot after the bound goes
# (the platform's memory reset frees what GC does not), so /_peak answers 200 once the streak is older than 3 s.
# #1094: V8 may collect that memory before /_peak, and decide() then allows the boot. bootGate already logs the
# inputs it passed to decide() ({ m: boot-gate or boot-refused, retiredMiB, expectMiB, budgetMiB, expired, spareMiB }).
# DEV_LOG_LEVEL=log keeps the line (run.sh). Each /_peak is one request, so the line it adds is that request's
# decision. The status has to be the one those inputs require, not the boot flag in the line. A run must see the
# known 503 twice, each a new decision serial, then the bound arm. If a reading fits because the memory is already
# gone, the test queues the next /_peak behind a fresh recycle so the gate runs in the same turn the runtime is
# released. If that still does not refuse, the test fails: could not measure: no refusal observed.
# It never passes without a refusal. BOOT_TEST_DELAY_MS waits before the gate and gives GC a turn, so it stays off.
set -u
cd "$(dirname "$0")/.." || exit 1
export DEV_ENV=${DEV_ENV:-dosql-local}
# shellcheck source=port.sh
. ./port.sh
ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/boot-gate-e2e.XXXXXX"); export PERSIST_TO=$STATE
H=$(mktemp "${TMPDIR:-/tmp}/boot-gate-e2e-h.XXXXXX")
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE" "$H"' EXIT
# CRON_INTERVAL_MS is an hour so an alarm boot does not write a second gate line during a /_peak.
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="PHP_RECYCLE:off PHP_MEMORY_REUSE:off BOOT_GATE:on BOOT_GATE_MAX_REFUSE_S:3 CRON_INTERVAL_MS:3600000" ./run.sh _ping > /dev/null || { echo "boot-gate-e2e: wrangler dev did not start"; tail -20 dev.log; exit 1; }
server_port || exit 1
B=http://localhost:$PORT
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "boot-gate-e2e: /_install failed"; exit 1; }
B=$B SPIKE_TOKEN=${SPIKE_TOKEN:-local-spike-token} ADMIN_PASSWORD=$PW python3 -I - <<'PY'
import json, os, subprocess, time
B = os.environ["B"]
TOK = os.environ["SPIKE_TOKEN"]
PW = os.environ["ADMIN_PASSWORD"]
ST = ["-H", "x-spike-token: " + TOK]

def fail(msg):
    sys_exit("boot-gate-e2e: FAIL: " + msg)

def sys_exit(msg):
    print(msg)
    raise SystemExit(1)

def required(o):
    # The same rule as decide(), from the inputs on the line, not from o["boot"].
    r = float(o["retiredMiB"])
    spare = float(o["spareMiB"])
    expect = float(o["expectMiB"])
    budget = float(o["budgetMiB"])
    expired = bool(o.get("expired"))
    fits = r == 0 or r + max(expect, spare) <= budget
    return (200 if (fits or expired) else 503), fits, expired

def self_check():
    base = {"spareMiB": 0, "expectMiB": 112, "budgetMiB": 120}
    assert required(dict(base, retiredMiB=111.4))[0] == 503
    assert required(dict(base, retiredMiB=0))[0] == 200
    assert required(dict(base, retiredMiB=8))[0] == 200
    assert required(dict(base, retiredMiB=8.1))[0] == 503
    assert required(dict(base, retiredMiB=80, expired=True))[0] == 200
self_check()

def gate_objs(text):
    out = []
    for line in text.splitlines():
        if '"m":"boot-gate"' not in line and '"m":"boot-refused"' not in line:
            continue
        i = line.find("{")
        if i < 0:
            continue
        try:
            o, _ = json.JSONDecoder().raw_decode(line[i:])
        except Exception:
            continue
        if isinstance(o, dict) and o.get("m") in ("boot-gate", "boot-refused"):
            out.append(o)
    return out

def log_text():
    try:
        return open("dev.log", errors="replace").read()
    except Exception:
        return ""

def headers_of(path):
    d = {}
    try:
        raw = open(path, errors="replace").read()
    except Exception:
        return d
    for line in raw.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        d[k.strip().lower()] = v.strip()
    return d

def curl(args, header, timeout=180):
    cmd = ["curl", "-s", "-D", header, "-o", "/dev/null", "-w", "%{http_code}", "-m", str(timeout)] + ST + args
    p = subprocess.run(cmd, capture_output=True, text=True)
    code = (p.stdout or "").strip() or "000"
    return code

def describe(label, code, h, o):
    if not o:
        print("boot-gate-e2e: /_peak %s: %s %s decision %s (no gate line)" % (
            label, code, h.get("x-runtime-wait") or "no x-runtime-wait", h.get("x-runtime-wait-decision") or "none"))
        return
    print("boot-gate-e2e: /_peak %s: %s %s m %s decision %s retired %s spare %s expect %s budget %s expired %s boot %s" % (
        label, code, h.get("x-runtime-wait") or "no x-runtime-wait", o.get("m"), o.get("decision"),
        o.get("retiredMiB"), o.get("spareMiB"), o.get("expectMiB"), o.get("budgetMiB"),
        1 if o.get("expired") else 0, o.get("boot")))

def objs_after(mark):
    return gate_objs(log_text()[mark:])

def pick_line(mark, h, seen, timeout_s):
    # A 503 names its decision serial. That line is this request's, even if another
    # gate line landed in the same window. A 200 has no serial: the one new line is it.
    want = h.get("x-runtime-wait-decision")
    deadline = time.time() + timeout_s
    seen_at = None
    while True:
        objs = objs_after(mark)
        if want:
            hit = [o for o in objs if str(o.get("decision")) == want]
            if hit:
                return hit[-1]
        else:
            fresh = [o for o in objs if str(o.get("decision")) not in seen]
            if len(fresh) == 1:
                if seen_at is None:
                    seen_at = time.time()
                elif time.time() - seen_at >= 0.15:
                    return fresh[0]
            elif len(fresh) > 1:
                return fresh
        if time.time() >= deadline:
            objs = objs_after(mark)
            if want:
                hit = [o for o in objs if str(o.get("decision")) == want]
                return hit[-1] if hit else None
            fresh = [o for o in objs if str(o.get("decision")) not in seen]
            if len(fresh) == 1:
                return fresh[0]
            if len(fresh) > 1:
                return fresh
            return None
        time.sleep(0.05)

def one_peak(label, seen):
    header = os.path.join(os.environ.get("TMPDIR") or "/tmp", "boot-gate-e2e-peak-%s.txt" % str(label).replace(" ", "-"))
    mark = len(log_text())
    code = curl([B + "/_peak"], header, timeout=180)
    h = headers_of(header)
    chosen = pick_line(mark, h, seen, 5)
    if isinstance(chosen, list):
        describe(label, code, h, chosen[-1])
        fail("/_peak %s added %d gate lines and no decision header; the line is not this request's" % (label, len(chosen)))
    describe(label, code, h, chosen)
    try:
        os.remove(header)
    except Exception:
        pass
    return code, h, chosen

def check_match(label, code, o):
    if not o:
        fail("/_peak %s did not log a gate line" % label)
    for k in ("retiredMiB", "spareMiB", "expectMiB", "budgetMiB", "decision"):
        if k not in o:
            fail("/_peak %s gate line has no %s" % (label, k))
    req, fits, expired = required(o)
    if str(code) != str(req):
        fail("/_peak %s status %s but the inputs require %s (fits %s expired %s retired %s)" % (
            label, code, req, int(fits), int(expired), o.get("retiredMiB")))
    return req

def check_known(label, code, h, o, seen):
    if h.get("x-runtime-wait") != "retired-resident":
        fail("/_peak %s was not the known 503" % label)
    mib = h.get("x-runtime-wait-mib")
    try:
        same = float(mib) == float(o["retiredMiB"])
    except Exception:
        same = False
    if not same:
        fail("/_peak %s x-runtime-wait-mib %s != retired %s" % (label, mib or "none", o.get("retiredMiB")))
    dn = str(o.get("decision"))
    if h.get("x-runtime-wait-decision") != dn:
        fail("/_peak %s x-runtime-wait-decision %s != %s" % (label, h.get("x-runtime-wait-decision") or "none", dn))
    if dn in seen:
        fail("/_peak %s repeated decision %s: a rejected boot was reused" % (label, dn))
    seen.add(dn)
    return dn

def recycle(label):
    header = os.path.join(os.environ.get("TMPDIR") or "/tmp", "boot-gate-e2e-rc.txt")
    code = curl(["-H", "x-runtime-recycle: force", B + "/"], header, timeout=180)
    h = headers_of(header)
    rr = h.get("x-runtime-recycled") or "none"
    print("boot-gate-e2e: the forced recycle (%s): / %s, x-runtime-recycled %s" % (label, code, rr))
    try:
        os.remove(header)
    except Exception:
        pass
    if code != "200" or rr != "forced":
        fail("the page was not force-recycled")

def grants():
    return log_text().count('"event":"granted"')

def tmp(name):
    return os.path.join(os.environ.get("TMPDIR") or "/tmp", "boot-gate-e2e-%s.txt" % name)

def popen_curl(args, header):
    cmd = ["curl", "-s", "-D", header, "-o", "/dev/null", "-w", "%{http_code}", "-m", "180"] + ST + args
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def finish_curl(proc):
    out, _ = proc.communicate()
    return (out or "").strip() or "000"

def judge(label, code, header, mark, seen):
    h = headers_of(header)
    chosen = pick_line(mark, h, seen, 5)
    if isinstance(chosen, list):
        describe(label, code, h, chosen[-1])
        fail("/_peak %s added %d gate lines and no decision header; the line is not this request's" % (label, len(chosen)))
    describe(label, code, h, chosen)
    try:
        os.remove(header)
    except Exception:
        pass
    return code, h, chosen

def classify(label, code, h, o, seen, which):
    if not o:
        if code == "200":
            return "none" if which == 1 else "one"
        fail("/_peak %s status %s and no gate line" % (which, code))
    req = check_match(label, code, o)
    if req != 503:
        return "none" if which == 1 else "one"
    check_known(label, code, h, o, seen)
    return "refused"

def queued_pair(seen):
    # Both /_peak calls wait behind the recycle. The first gate runs in the same turn the
    # runtime is released, and the second is already queued, so it does not wait on a new
    # connection. Each 503 carries x-runtime-wait-decision, and that serial selects its line.
    n0 = grants()
    hd_rc = tmp("qrc")
    rec = popen_curl(["-H", "x-runtime-recycle: force", B + "/"], hd_rc)
    t0 = time.time()
    held = False
    while time.time() - t0 < 90:
        if grants() > n0:
            held = True
            break
        if rec.poll() is not None:
            break
        time.sleep(0.05)
    if not held:
        rc = finish_curl(rec)
        rh = headers_of(hd_rc)
        print("boot-gate-e2e: the forced recycle (queue): / %s, x-runtime-recycled %s (the peaks were not queued behind it)" % (
            rc, rh.get("x-runtime-recycled") or "none"))
        try:
            os.remove(hd_rc)
        except Exception:
            pass
        if rc != "200" or rh.get("x-runtime-recycled") != "forced":
            fail("the page was not force-recycled")
        c1, h1, o1 = one_peak("1", seen)
        got = classify("1", c1, h1, o1, seen, 1)
        if got != "refused":
            return got
        c2, h2, o2 = one_peak("2", seen)
        got = classify("2", c2, h2, o2, seen, 2)
        return "pair" if got == "refused" else got
    mark = len(log_text())
    hd1, hd2 = tmp("q1"), tmp("q2")
    p1 = popen_curl([B + "/_peak"], hd1)
    p2 = popen_curl([B + "/_peak"], hd2)
    rc = finish_curl(rec)
    c1 = finish_curl(p1)
    c2 = finish_curl(p2)
    rh = headers_of(hd_rc)
    print("boot-gate-e2e: the forced recycle (queue): / %s, x-runtime-recycled %s" % (rc, rh.get("x-runtime-recycled") or "none"))
    try:
        os.remove(hd_rc)
    except Exception:
        pass
    if rc != "200" or rh.get("x-runtime-recycled") != "forced":
        fail("the page was not force-recycled")
    c1, h1, o1 = judge("1", c1, hd1, mark, seen)
    got = classify("1", c1, h1, o1, seen, 1)
    if got != "refused":
        try:
            os.remove(hd2)
        except Exception:
            pass
        return got
    c2, h2, o2 = judge("2", c2, hd2, mark, seen)
    got = classify("2", c2, h2, o2, seen, 2)
    return "pair" if got == "refused" else got

def pair(mode, seen):
    # Two refusals, or how far the retired memory stayed visible.
    if mode == "queue":
        got = queued_pair(seen)
        if got is not None:
            return got
        mode = "seq"
    recycle("page")
    c1, h1, o1 = one_peak("1", seen)
    got = classify("1", c1, h1, o1, seen, 1)
    if got != "refused":
        return got
    c2, h2, o2 = one_peak("2", seen)
    got = classify("2", c2, h2, o2, seen, 2)
    return "pair" if got == "refused" else got

seen = set()
# The install boot logged a decision. Later serials must be new; the refusal header is what proves it.
result = pair("seq", seen)
if result != "pair":
    # The sequential read fit, or the second /_peak fit. The runtime that booted is live.
    # Queue the next two /_peak calls behind a fresh recycle so the gate runs before the isolate is idle.
    result = pair("queue", seen)
if result != "pair":
    if not seen:
        sys_exit("boot-gate-e2e: could not measure: no refusal observed")
    sys_exit("boot-gate-e2e: could not measure: no second refusal observed")
time.sleep(4)
c, h, o = one_peak("after the 3 s bound", seen)
if c != "200":
    fail("still %s after the bound: the gate refuses forever (the storm)" % c)
if not o:
    fail("the bound /_peak did not log a gate line: the runtime was reused, so the bound was not decided")
req, fits, expired = required(o)
if str(c) != str(req):
    fail("the bound /_peak status %s but the inputs require %s (fits %s expired %s)" % (c, req, int(fits), int(expired)))
if h.get("x-runtime-wait"):
    fail("a boot carried x-runtime-wait")
dn = str(o.get("decision"))
if dn in seen:
    fail("the bound /_peak repeated decision %s: a rejected boot was reused" % dn)
print("boot-gate-e2e: ok: a refused operator boot is the known 503, decided again on each request, and never past the bound")
PY
