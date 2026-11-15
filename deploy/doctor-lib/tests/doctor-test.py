#!/usr/bin/env python3
"""Test of deploy/doctor (#652) against a FAKE telemetry API. No account, no network.

The fake is a small query engine over an in-memory list of log rows. It answers only the calls it
knows: the telemetry query (views calculations and invocations; filters eq, exists, includes) and a
script-settings GET. Any other call, view, operation or key is recorded as UNEXPECTED and fails the
case. Run: python3 -I deploy/doctor-lib/tests/doctor-test.py   (python3 3.9, macOS /bin/bash 3.2)
"""
import http.server
import json
import os
import re
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
DOCTOR = os.path.join(HERE, "..", "..", "doctor")
NOW = 1763200000000  # fixed clock: 2025-11-15 09:46:40 UTC
TOKEN = "fake-" + "x" * 20  # a stand-in, never a real credential
ACCT = "acct0"
SECRET_QS = "orderkey=" + "qsmark" * 3  # a stand-in query string
CLIENT_IP = "203.0.113.97"
SQL = "SELECT user_pass FROM wp_users WHERE ID = 1"
RUNTIME_LINE = "Durable Object's isolate exceeded its memory limit and was reset."
RUNTIME_LINES = 41  # a count that must never be printed

S = {"rows": [], "settings": {}, "unexpected": [], "auth": set(), "fail_query": False, "calls": 0}


def get_key(e, key):
    if key.startswith("$metadata."):
        return (e.get("$metadata") or {}).get(key[10:])
    if key.startswith("$workers."):
        return (e.get("$workers") or {}).get(key[9:])
    if key.startswith("$"):
        raise KeyError(key)
    src = e.get("source")
    return src.get(key) if isinstance(src, dict) else None


def match(e, f):
    op, key, val = f.get("operation"), f.get("key"), f.get("value")
    if f.get("kind") == "group":
        raise KeyError("group")
    v = get_key(e, key)
    if op == "eq":
        return v == val
    if op == "exists":
        return v is not None
    if op == "includes":
        return isinstance(v, str) and val in v
    raise KeyError("operation " + str(op))


def query(body):
    view = body.get("view")
    tf = body.get("timeframe") or {}
    p = body.get("parameters") or {}
    if p.get("datasets") != ["cloudflare-workers"]:
        raise KeyError("datasets")
    rows = [e for e in S["rows"] if tf.get("from", 0) <= e["timestamp"] <= tf.get("to", 0)]
    rows = [e for e in rows if all(match(e, f) for f in p.get("filters") or [])]
    if view == "calculations":
        calcs = p.get("calculations")
        if calcs != [{"operator": "count"}]:
            raise KeyError("calculation")
        gb = p.get("groupBys") or []
        if len(gb) > 1:
            raise KeyError("groupBys")
        if not gb:
            return {"calculations": [{"aggregates": [{"value": len(rows)}] if rows else []}]}
        by = {}
        for e in rows:
            k = get_key(e, gb[0]["value"])
            if k is None:
                continue
            by[k] = by.get(k, 0) + 1
        return {"calculations": [{"aggregates": [{"groupKey": k, "value": n} for k, n in by.items()]}]}
    if view == "invocations":
        lim = body.get("limit") or 50
        groups = {}
        for e in sorted(rows, key=lambda e: -e["timestamp"]):
            rid = e["$metadata"].get("requestId")
            if rid not in groups and len(groups) >= lim:
                continue
            groups.setdefault(rid, []).append(e)
        return {"invocations": groups}
    raise KeyError("view " + str(view))


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b)

    def _unexpected(self, why):
        S["unexpected"].append("%s %s: %s" % (self.command, self.path, why))
        self._send(599, {"success": False})

    def do_GET(self):
        S["auth"].add(self.headers.get("Authorization"))
        pre = "/accounts/%s" % ACCT
        if not self.path.startswith(pre) or not self.path.endswith("/settings"):
            return self._unexpected("not a settings path")
        p = self.path[len(pre):]
        if p not in S["settings"]:
            return self._unexpected("settings of an unknown script")
        obs = S["settings"][p]
        if obs == "fail":
            return self._send(403, {"success": False})
        self._send(200, {"success": True, "result": {"observability": obs}})

    def do_POST(self):
        S["auth"].add(self.headers.get("Authorization"))
        S["calls"] += 1
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n).decode())
        if self.path != "/accounts/%s/workers/observability/telemetry/query" % ACCT:
            return self._unexpected("not the query path")
        if S["fail_query"]:
            return self._send(500, {"success": False})
        try:
            res = query(body)
        except KeyError as e:
            return self._unexpected(str(e))
        self._send(200, {"success": True, "result": res})

    def do_PATCH(self):
        self._unexpected("doctor must never write")

    do_PUT = do_PATCH
    do_DELETE = do_PATCH


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d/accounts/%s" % (srv.server_address[1], ACCT)

# --- row builders --------------------------------------------------------------------------------
_id = [0]


def console(service, src, t=None, msg=None):
    _id[0] += 1
    m = {"id": "c%d" % _id[0], "type": "cf-worker", "service": service, "requestId": "r%d" % _id[0]}
    m["message"] = msg if msg is not None else (json.dumps(src) if isinstance(src, dict) else src)
    return {"timestamp": t or NOW - 60000 - _id[0], "$metadata": m, "source": src}


def event(service, outcome, cpu, wall, path, t=None, entry=None, status=200, rid=None):
    _id[0] += 1
    w = {"outcome": outcome, "cpuTimeMs": cpu, "wallTimeMs": wall, "eventType": "fetch",
         "event": {"request": {"url": "https://shop.example" + path + "?" + SECRET_QS,
                               "headers": {"cf-connecting-ip": CLIENT_IP}},
                   "response": {"status": status}}}
    if entry:
        w["entrypoint"] = entry
        w["durableObjectId"] = "do1"
    return {"timestamp": t or NOW - 120000 - _id[0],
            "$metadata": {"id": "e%d" % _id[0], "type": "cf-worker-event", "service": service, "requestId": rid or ("q%d" % _id[0])},
            "$workers": w, "source": {}}


ON = {"enabled": True, "redact_query_string": True, "logs": {"enabled": True, "invocation_logs": False}}
ON_FULL = {"enabled": True, "redact_query_string": True, "logs": {"enabled": True, "invocation_logs": True}}


def wfp(svc):
    return "/workers/dispatch/namespaces/wp-wfp/scripts/%s/settings" % svc


def plain(svc):
    return "/workers/scripts/%s/settings" % svc


def run(site, *args):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "CLOUDFLARE_API_TOKEN": TOKEN, "ACCOUNT_ID": ACCT,
           "DOCTOR_API_BASE": BASE, "DOCTOR_NOW_MS": str(NOW)}
    argv = ["/bin/bash", DOCTOR, site] + list(args)
    assert TOKEN not in " ".join(argv)
    p = subprocess.run(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
    return p.returncode, p.stdout, p.stderr


def reset(rows, settings):
    S["rows"] = rows
    S["settings"] = settings
    S["unexpected"] = []
    S["auth"] = set()
    S["fail_query"] = False


FAILS = []


def check(name, cond, detail=""):
    if not cond:
        FAILS.append("%s: %s" % (name, detail))
        print("FAIL", name, detail)


def never_leaks(name, text):
    for bad, what in ((SECRET_QS, "query string"), ("qsmark", "query string"), (CLIENT_IP, "client IP"), (TOKEN, "token"),
                      ("SELECT", "SQL"), ("wp_users", "SQL"), ("?", "a query mark")):
        check(name + " never prints the " + what, bad not in text, "found in the output")


def common(name, code_out_err, want_code):
    code, out, err = code_out_err
    check(name + " exit", code == want_code, "exit %r, stderr %r" % (code, err[-300:]))
    check(name + " no unexpected calls", not S["unexpected"], S["unexpected"])
    # The detail names the count only: a failure must not print the header (it holds the token).
    check(name + " sends the token in a header", S["auth"] == {"Bearer " + TOKEN}, "%d distinct Authorization values" % len(S["auth"]))
    never_leaks(name, out + err)
    return out


def ints(o):
    if isinstance(o, bool):
        return []
    if isinstance(o, int):
        return [o]
    if isinstance(o, dict):
        return [x for v in o.values() for x in ints(v)] + [x for k in o.keys() for x in ints(k)]
    if isinstance(o, list):
        return [x for v in o for x in ints(v)]
    return []


# 1. no rows: cannot see, never healthy, names every name tried.
reset([], {wfp("site-shop"): ON, plain("shop"): ON, plain("wp-shop"): ON})
out = common("no rows", run("shop"), 3)
check("no rows says it cannot see", "CANNOT SEE" in out, out)
check("no rows is not healthy", "no failures" not in out and "healthy" not in out.replace("not a healthy", ""), out)
for n in ("shop", "site-shop", "wp-shop"):
    check("no rows names " + n, ("- %s: 0 rows" % n) in out, out)
j = json.loads(run("shop", "--json")[1])
check("no rows json verdict", j["verdict"] == "cannot_see" and j["service"] is None, j.get("verdict"))

# 2. logging off: cannot see, and says logging is off.
reset([], {wfp("site-shop"): {"enabled": False}, plain("shop"): ON, plain("wp-shop"): ON})
out = common("logging off", run("shop"), 3)
check("logging off says so", "Logging is OFF for site-shop" in out, out)

# 3. a wrong service name: the site's rows are under another name; doctor never reads them as this site.
reset([console("site-other", {"m": "req", "path": "/"}) for _ in range(5)], {wfp("site-shop"): ON, wfp("site-other"): ON})
out = common("wrong name", run("shop"), 3)
check("wrong name cannot see", "CANNOT SEE" in out and "site-other" not in out, out)
#    the right name with --service reads it
out = common("forced name", run("shop", "--service", "site-other"), 3)
check("forced name sees the rows", "under the name site-other" in out, out)

# 4. console only (OBSERVABILITY=1): failures cannot be counted; our signals and the reset yes/no.
rows = [console("site-shop", {"m": "req", "path": "/", "boot": False, "d1": 3}) for _ in range(30)]
rows += [console("site-shop", {"m": "boot", "origin": "fetch"}) for _ in range(2)]
rows += [console("site-shop", {"m": "isolate-reset", "kind": "memory", "path": "/wp-admin/", "retried": True, "error": RUNTIME_LINE}) for _ in range(2)]
rows += [console("site-shop", {"m": "php-lock", "event": "queued", "depth": 2}) for _ in range(3)]
rows += [console("site-shop", {"m": "php-lock", "event": "shed", "waitMs": 9000})]
rows += [console("site-shop", {"@event": "write-loss", "m": "write-loss", "method": "POST", "path": "/wp-login.php", "failed": 2, "firstSql": SQL})]
rows += [console("site-shop", RUNTIME_LINE) for _ in range(RUNTIME_LINES)]
reset(rows, {wfp("site-shop"): ON})
out = common("console only", run("shop"), 1)
check("console only says failures cannot be counted", "FAILURES CANNOT BE COUNTED" in out, out)
check("console only never says no failures", "Summary: no failures found" not in out, out)
check("console only resolves site-shop", "under the name site-shop" in out, out)
check("console only counts isolate-reset", re.search(r"isolate-reset\s+2 \(memory 2\)", out) is not None, out)
check("console only splits php-lock", "queued 3" in out and "shed 1" in out, out)
check("console only write-loss", re.search(r"write-loss\s+1\.", out) is not None, out)
check("console only reports resets as yes", "Memory resets happened" in out, out)
check("console only never prints the runtime line count", not re.search(r"\b%d\b" % RUNTIME_LINES, out), out)
check("console only names x-d1-failures as header-only", "x-d1-failures" in out and "not in the logs" in out, out)
code, jout, _ = run("shop", "--json")
j = json.loads(jout)
never_leaks("console only json", jout)
check("console only json visibility", j["visibility"] == "console_only" and j["outcomes"] is None, j["visibility"])
check("console only json never holds the runtime line count", RUNTIME_LINES not in ints(j), sorted(set(ints(j))))
check("console only json memory resets is a yes", j["memory_resets_seen"] is True)

# 5. structured lines unreadable (no "m" field): every signal is could-not-measure, never 0.
reset([console("site-shop", "plain text line") for _ in range(4)], {wfp("site-shop"): ON})
out = common("no structured", run("shop"), 3)
check("no structured says could not measure", "could not measure: I found no Pagefeather structured lines" in out, out)
check("no structured never 0", not re.search(r"isolate-reset\s+0", out), out)

# 6. outcome rows (deploy.sh name wp-shop, request logs on): counts, timing, slow paths, path only.
rows = [event("wp-shop", "ok", 2.0 + i % 5, 40 + i, "/") for i in range(20)]
rows += [event("wp-shop", "ok", 30, 900 + i, "/wp-admin/edit.php", entry="PhpRuntime") for i in range(6)]
rows += [event("wp-shop", "exceededMemory", 120, 5000, "/wp-admin/post.php", entry="PhpRuntime") for _ in range(3)]
rows += [console("wp-shop", {"m": "req", "path": "/"})]
reset(rows, {plain("wp-shop"): ON_FULL})
out = common("outcomes", run("shop"), 1)
check("outcomes resolves wp-shop", "under the name wp-shop" in out, out)
check("outcomes counts ok", re.search(r"ok\s+26", out) is not None, out)
check("outcomes counts out of memory", re.search(r"out of memory\s+3", out) is not None, out)
check("outcomes zero for exceptions", re.search(r"crashed \(exception\)\s+0", out) is not None, out)
check("outcomes timing worker", "Worker: 20 records" in out and "Durable Object: 9 records" in out, out)
check("outcomes slowest path first", out.find("/wp-admin/post.php") < out.find("/wp-admin/edit.php") and "/wp-admin/post.php" in out, out)
check("outcomes memory resets yes", "Memory resets happened" in out, out)
code, jout, _ = run("shop", "--json")
never_leaks("outcomes json", jout)
j = json.loads(jout)
check("outcomes json counts", j["outcomes"]["exceededMemory"] == 3 and j["outcomes"]["ok"] == 26, j["outcomes"])
check("outcomes json complete", j["sample"]["complete"] is True and j["sample"]["rows"] == 29, j["sample"]["rows"])

# 7. a healthy site with request logs: exit 0, says no failures.
reset([event("wp-shop", "ok", 2, 40, "/") for _ in range(10)] + [console("wp-shop", {"m": "req", "path": "/"})], {plain("wp-shop"): ON_FULL})
out = common("healthy", run("wp-shop"), 0)
check("healthy says no failures", "Summary: no failures found." in out, out)

# 8. redaction off: a privacy warning.
reset([console("site-shop", {"m": "req", "path": "/"})], {wfp("site-shop"): dict(ON, redact_query_string=False)})
out = common("redaction off", run("shop"), 3)
check("redaction off warns", "PRIVACY WARNING" in out, out)
reset([console("site-shop", {"m": "req", "path": "/"})], {wfp("site-shop"): "fail"})
out = common("settings unreadable", run("shop"), 3)
check("settings unreadable says it cannot say", "could not read the log settings" in out and "PRIVACY WARNING" not in out, out)

# 9. a failed read is never zero rows.
reset([], {wfp("site-shop"): ON, plain("shop"): ON, plain("wp-shop"): ON})
S["fail_query"] = True
out = common("read failed", run("shop"), 3)
check("read failed is not 0 rows", "0 rows" not in out and "the read failed" in out, out)

# 10. paging: 250 requests read whole; 150 in one millisecond end (the old exporter could loop).
reset([event("wp-shop", "ok", 1, 10, "/p%d" % (i % 7)) for i in range(250)], {plain("wp-shop"): ON_FULL})
j = json.loads(run("shop", "--json")[1])
check("paging reads every row", j["sample"]["rows"] == 250 and j["sample"]["complete"], (j["sample"]["rows"], j["sample"]["complete"]))
check("paging no unexpected calls", not S["unexpected"], S["unexpected"])
reset([event("wp-shop", "ok", 1, 10, "/", t=NOW - 5000) for _ in range(150)], {plain("wp-shop"): ON_FULL})
j = json.loads(run("shop", "--json")[1])
# 12 calls outside paging (3 names, outcomes, the signal control and 6 signals, the reset check)
# plus 2 pages: the second page adds no row, so the read stops there, not at the 20-page cap.
check("same millisecond ends after 2 pages", j["api_calls"] <= 14, j["api_calls"])
check("same millisecond is not complete", j["sample"]["complete"] is False and j["complete"] is False, j["sample"])
out = run("shop")[1]
check("same millisecond says the read stopped", "NOT the whole window" in out and "lower bound" in out, out)

# 10b. the facts layer itself keeps no query string or IP: checked with the print guard out of the way.
sys.path.insert(0, os.path.join(HERE, ".."))
import facts  # noqa: E402
reset([event("wp-shop", "ok", 1, 10, "/a") for _ in range(5)] + [console("wp-shop", {"m": "write-loss", "firstSql": SQL})], {plain("wp-shop"): ON_FULL})
raw = json.dumps(facts.gather(facts.Api(BASE, TOKEN), "shop", facts.window_ms(24, NOW)))
for bad in (SECRET_QS, CLIENT_IP, TOKEN, "SELECT", "?"):
    check("facts layer never keeps " + ("the token" if bad == TOKEN else bad), bad not in raw, "found in the facts")

# 11. the leak guard can fire: a path that carries an IP and SQL is hidden by the last guard.
import doctor  # noqa: E402
t = doctor.scrub("GET /x?" + SECRET_QS + " from " + CLIENT_IP + " ran " + SQL + " Bearer " + TOKEN, [TOKEN])
never_leaks("scrub", t)

# 12. usage: no token, or a bad window, is exit 2 with no API call.
reset([], {})
c0 = S["calls"]
env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "ACCOUNT_ID": ACCT, "DOCTOR_API_BASE": BASE}
p = subprocess.run(["/bin/bash", DOCTOR, "shop"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
check("no token is exit 2", p.returncode == 2 and "CLOUDFLARE_API_TOKEN" in p.stderr, "exit %r" % p.returncode)
code, out, err = run("shop", "--hours", "0")
check("bad window is exit 2", code == 2, (code, err))
check("usage makes no API call", S["calls"] == c0 and not S["unexpected"], S["calls"] - c0)

srv.shutdown()
if FAILS:
    print("%d FAILED" % len(FAILS))
    sys.exit(1)
print("doctor-test: all cases pass")
