#!/usr/bin/env python3
"""Test of deploy/doctor (#652) against a FAKE telemetry API. No account, no network.

The fake is a small query engine over an in-memory list of log rows. It models the API as measured
on 2026-11-15:
  - a FILTER or GROUP names a field of a JSON console line by its bare key ("m", "kind", "event");
    "source.<k>" as a filter key reads 0 (the field sits at source.<k> only in a RETURNED row);
  - our JSON lines have $metadata.message null, and a message filter is UNEXPECTED;
  - the calculations view computes count, median and p95 (key + keyType number) server-side in one
    call, with one group-by, orderBy and limit; "p50" and "percentile" are refused with a 400;
  - the invocations view returns at most 100 invocations a call.
Any other call, view, operation or key is recorded as UNEXPECTED and fails the case; so does a write.
Run: python3 -I deploy/doctor-lib/tests/doctor-test.py   (python3 3.9, macOS /bin/bash 3.2)
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
STAND_IN = "fake-" + "x" * 20  # a stand-in, never a real credential
ACCT = "acct0"
QS_MARK = "orderkey=" + "qsmark" * 3  # a stand-in query string
CLIENT_IP = "203.0.113.97"
SQL = "SELECT user_pass FROM wp_users WHERE ID = 1"
RUNTIME_LINE = "Durable Object's isolate exceeded its memory limit and was reset."
RUNTIME_LINES = 41  # a count that must never be printed

# fail_op: a calculations call that uses this operator answers 500 (one read fails, the rest succeed).
S = {"rows": [], "settings": {}, "unexpected": [], "auth": set(), "fail_query": False, "calls": 0, "inv_calls": 0, "fail_op": None}


class Refused(Exception):
    pass


def get_key(e, key):
    if key == "$metadata.message":
        raise KeyError("a message filter: our lines are in source, never message text")
    if key.startswith("$metadata."):
        return (e.get("$metadata") or {}).get(key[10:])
    if key.startswith("$workers."):
        v = e.get("$workers") or {}
        for part in key[9:].split("."):
            v = v.get(part) if isinstance(v, dict) else None
        return v
    if key.startswith("$"):
        raise KeyError(key)
    if key.startswith("source."):
        return None  # measured: source.<k> as a filter or group key reads nothing
    src = e.get("source")
    return src.get(key) if isinstance(src, dict) else None


def match(e, f):
    op, key, val = f.get("operation"), f.get("key"), f.get("value")
    if f.get("kind") == "group":
        raise KeyError("group")
    v = get_key(e, key)
    if op == "eq":
        return v == val
    if op == "neq":
        return v is not None and v != val
    if op == "exists":
        return v is not None
    raise KeyError("operation " + str(op))


def pct(vals, p):
    v = sorted(vals)
    if not v:
        return None
    if p == 50:
        n = len(v)
        return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0
    i = max(0, min(len(v) - 1, -(-p * len(v) // 100) - 1))
    return v[i]


def one_calc(c, rows):
    op = c.get("operator")
    if op == "count":
        if c.get("key"):
            raise KeyError("count with a key")
        return len(rows), len(rows)
    if op in ("median", "p95"):
        if c.get("keyType") != "number" or not str(c.get("key", "")).startswith("$workers."):
            raise KeyError("percentile needs a $workers number key")
        vals = [x for x in (get_key(e, c["key"]) for e in rows) if isinstance(x, (int, float))]
        return pct(vals, 50 if op == "median" else 95), len(vals)
    raise Refused(op)


def query(body):
    view = body.get("view")
    tf = body.get("timeframe") or {}
    p = body.get("parameters") or {}
    if p.get("datasets") != ["cloudflare-workers"]:
        raise KeyError("datasets")
    rows = [e for e in S["rows"] if tf.get("from", 0) <= e["timestamp"] <= tf.get("to", 0)]
    rows = [e for e in rows if all(match(e, f) for f in p.get("filters") or [])]
    if view == "calculations":
        calcs = p.get("calculations") or []
        gb = p.get("groupBys") or []
        if len(gb) > 1 or not calcs:
            raise KeyError("groupBys or calculations")
        groups = {}
        for e in rows:
            k = get_key(e, gb[0]["value"]) if gb else "_all"
            if k is not None:
                groups.setdefault(k, []).append(e)
        out = []
        for c in calcs:
            aggs = []
            for k, rs in groups.items():
                v, n = one_calc(c, rs)
                a = {"value": v, "count": n}
                if gb:
                    a["groupKey"] = k
                aggs.append(a)
            out.append({"alias": c.get("alias"), "calculation": c.get("operator"), "aggregates": aggs, "series": []})
        ob = p.get("orderBy")
        if ob:
            if not gb:
                raise KeyError("orderBy with no group")
            idx = [c.get("alias") for c in calcs].index(ob["value"])
            order = sorted(range(len(out[idx]["aggregates"])), key=lambda i: -(out[idx]["aggregates"][i]["value"] or 0))
            lim = body.get("limit") or len(order)
            for c in out:
                c["aggregates"] = [c["aggregates"][i] for i in order[:lim]]
        return {"calculations": out}
    if view == "invocations":
        S["inv_calls"] += 1
        lim = min(body.get("limit") or 50, 100)
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
        if S["fail_query"] or (S["fail_op"] and any(c.get("operator") == S["fail_op"] for c in (body.get("parameters") or {}).get("calculations") or [])):
            return self._send(500, {"success": False})
        try:
            res = query(body)
        except Refused as e:
            S["unexpected"].append("operator refused with 400: %s" % e)
            return self._send(400, {"success": False})
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


def console(service, src, t=None):
    _id[0] += 1
    m = {"id": "c%d" % _id[0], "type": "cf-worker", "service": service, "requestId": "r%d" % _id[0]}
    # measured: a JSON line has message null, its fields in source; a text line has its text as message
    m["message"] = None if isinstance(src, dict) else src
    return {"timestamp": t or NOW - 60000 - _id[0], "$metadata": m, "source": src}


def event(service, outcome, cpu, wall, path, t=None, do=False, status=200, with_path=True):
    _id[0] += 1
    w = {"outcome": outcome, "cpuTimeMs": cpu, "wallTimeMs": wall, "eventType": "fetch",
         "executionModel": "durableObject" if do else "stateless",
         "event": {"path": path if with_path else None,
                   "request": {"url": "https://shop.example" + path + "?" + QS_MARK, "headers": {"cf-connecting-ip": CLIENT_IP}},
                   "response": {"status": status}}}
    return {"timestamp": t or NOW - 120000 - _id[0],
            "$metadata": {"id": "e%d" % _id[0], "type": "cf-worker-event", "service": service, "requestId": "q%d" % _id[0]},
            "$workers": w, "source": {}}


ON = {"enabled": True, "redact_query_string": True, "logs": {"enabled": True, "invocation_logs": False}}
ON_FULL = {"enabled": True, "redact_query_string": True, "logs": {"enabled": True, "invocation_logs": True}}


def wfp(svc):
    return "/workers/dispatch/namespaces/wp-wfp/scripts/%s/settings" % svc


def plain(svc):
    return "/workers/scripts/%s/settings" % svc


def run(site, *args):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "CLOUDFLARE_API_TOKEN": STAND_IN, "ACCOUNT_ID": ACCT,
           "DOCTOR_API_BASE": BASE, "DOCTOR_NOW_MS": str(NOW)}
    argv = ["/bin/bash", DOCTOR, site] + list(args)
    assert STAND_IN not in " ".join(argv)
    p = subprocess.run(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=120)
    return p.returncode, p.stdout, p.stderr


def reset(rows, settings):
    S["rows"] = rows
    S["settings"] = settings
    S["unexpected"] = []
    S["auth"] = set()
    S["fail_query"] = False
    S["inv_calls"] = 0
    S["fail_op"] = None


FAILS = []


def check(name, cond, detail=""):
    if not cond:
        FAILS.append("%s: %s" % (name, detail))
        print("FAIL", name, detail)


def never_leaks(name, text):
    for bad, what in ((QS_MARK, "query string"), ("qsmark", "query string"), (CLIENT_IP, "client IP"), (STAND_IN, "token"),
                      ("SELECT", "SQL"), ("wp_users", "SQL"), ("?", "a query mark")):
        check(name + " never prints the " + what, bad not in text, "found in the output")


def common(name, code_out_err, want_code):
    code, out, err = code_out_err
    check(name + " exit", code == want_code, "exit %r, stderr %r" % (code, err[-300:]))
    check(name + " no unexpected calls", not S["unexpected"], S["unexpected"])
    # The detail names the count only: a failure must not print the header (it holds the token).
    check(name + " sends the token in a header", S["auth"] == {"Bearer " + STAND_IN}, "%d distinct Authorization values" % len(S["auth"]))
    never_leaks(name, out + err)
    return out


def ints(o):
    if isinstance(o, bool):
        return []
    if isinstance(o, (int, float)):
        return [o]
    if isinstance(o, dict):
        return [x for v in o.values() for x in ints(v)]
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
out = common("forced name", run("shop", "--service", "site-other"), 3)
check("forced name sees the rows", "under the name site-other" in out, out)

# 4. console only (OBSERVABILITY=1): failures cannot be counted; our signals by the bare key m.
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
check("console only reads no rows", S["inv_calls"] == 0, S["inv_calls"])
code, jout, _ = run("shop", "--json")
j = json.loads(jout)
never_leaks("console only json", jout)
check("console only json visibility", j["visibility"] == "console_only" and j["outcomes"] is None, j["visibility"])
check("console only json field key is the bare m", j["signals"]["field_key"] == "m", j["signals"]["field_key"])
check("console only json never holds the runtime line count", RUNTIME_LINES not in ints(j), sorted(set(ints(j))))
check("console only json memory resets is a yes", j["memory_resets_seen"] is True)

# 4b. page-cache purges (#628): asked, sent, and refused, from the m: purge lines (index.js schedulePurge
#     and the object's alarm). A refused purge leaves the cached pages old until the TTL.
rows = [console("site-shop", {"m": "req", "path": "/"}) for _ in range(5)]
rows += [console("site-shop", {"m": "purge", "asked": 1, "coalesced": 0, "waitMs": 0}) for _ in range(3)]
rows += [console("site-shop", {"m": "purge", "sent": 1, "ok": True, "errors": [], "where": "object"}) for _ in range(2)]
rows += [console("site-shop", {"m": "purge", "sent": 1, "ok": False, "errors": ["rate limited"], "where": "object"})]
reset(rows, {wfp("site-shop"): ON})
code, jout, _ = run("shop", "--json")
j = json.loads(jout)
p = next((i for i in j["signals"]["items"] if i["m"] == "purge"), None)
check("purge counts", p is not None and p.get("parts") == {"asked": 3, "sent": 3, "ok": 2, "refused": 1}, p)
out = common("purge", run("shop"), 3)
check("purge plain line", re.search(r"purge\s+asked 3, sent 3, refused 1\.", out) is not None, out)
check("purge error text never printed", "rate limited" not in out and "rate limited" not in jout)

# 5. structured lines unreadable (no "m" field): every signal is could-not-measure, never 0.
reset([console("site-shop", "plain text line") for _ in range(4)], {wfp("site-shop"): ON})
out = common("no structured", run("shop"), 3)
check("no structured says could not measure", "could not measure: I found no Pagefeather structured lines" in out, out)
check("no structured never 0", not re.search(r"isolate-reset\s+0", out), out)

# 6. outcome rows (deploy.sh name wp-shop, request logs on): server counts, server percentiles,
#    the Worker and Durable Object split, the slowest paths, and labelled examples, path only.
rows = [event("wp-shop", "ok", 1 + i, 10 * (i + 1), "/") for i in range(20)]  # cpu 1..20, wall 10..200
rows += [event("wp-shop", "ok", 30, 900, "/wp-admin/edit.php", do=True) for _ in range(6)]
rows += [event("wp-shop", "exceededMemory", 120, 5000, "/wp-admin/post.php", do=True) for _ in range(3)]
rows += [console("wp-shop", {"m": "req", "path": "/"})]
reset(rows, {plain("wp-shop"): ON_FULL})
out = common("outcomes", run("shop"), 1)
check("outcomes resolves wp-shop", "under the name wp-shop" in out, out)
check("outcomes counts ok", re.search(r"ok\s+26", out) is not None, out)
check("outcomes counts out of memory", re.search(r"out of memory\s+3", out) is not None, out)
check("outcomes zero for exceptions", re.search(r"crashed \(exception\)\s+0", out) is not None, out)
check("outcomes per model", "Worker: ok 20" in out and "Durable Object: ok 6, out of memory 3" in out, out)
check("outcomes server timing worker", "Worker: 20 requests. CPU p50 10 ms, p95 19 ms. Total time p50 105 ms, p95 190 ms." in out, out)
check("outcomes server timing durable object", "Durable Object: 9 requests." in out, out)
check("outcomes slowest path first", "/wp-admin/post.php" in out and out.find("/wp-admin/post.php") < out.find("/wp-admin/edit.php"), out)
check("outcomes examples are labelled", "Examples of failed requests" in out and "not a count" in out, out)
check("outcomes memory resets yes", "Memory resets happened" in out, out)
check("outcomes reads rows once, for the examples", S["inv_calls"] == 1, S["inv_calls"])
code, jout, _ = run("shop", "--json")
never_leaks("outcomes json", jout)
j = json.loads(jout)
check("outcomes json counts", j["outcomes"]["exceededMemory"] == 3 and j["outcomes"]["ok"] == 26, j["outcomes"])
check("outcomes json timing", j["timing"]["worker"]["cpu_ms"]["p50"] == 10.5 and j["timing"]["durable_object"]["requests"] == 9, j["timing"])
check("outcomes json examples", len(j["examples"]) == 3 and all(e["path"] == "/wp-admin/post.php" for e in j["examples"]), j["examples"])
check("outcomes json complete", j["complete"] is True, j["complete"])

# 7. a healthy site with request logs: exit 0, says no failures, reads no rows at all.
reset([event("wp-shop", "ok", 2, 40, "/") for _ in range(10)] + [console("wp-shop", {"m": "req", "path": "/"})], {plain("wp-shop"): ON_FULL})
out = common("healthy", run("wp-shop"), 0)
check("healthy says no failures", "Summary: no failures found." in out, out)
check("healthy reads no rows", S["inv_calls"] == 0, S["inv_calls"])

# 8. redaction off: a privacy warning. Settings unreadable: it says it cannot say.
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

# 10. a busy window (3,771 requests, the measured case): complete by construction, a few calls, and
#     no row read for statistics. Row-by-row reading of a busy hour took over 10 minutes live.
rows = [event("wp-shop", "ok" if i % 50 else "canceled", 1, 10 + i % 300, "/p%d" % (i % 7), t=NOW - 60000 - i * 20000, do=bool(i % 4 == 0)) for i in range(3771)]
reset(rows, {plain("wp-shop"): ON_FULL})
j = json.loads(run("shop", "--json")[1])
check("busy window no unexpected calls", not S["unexpected"], S["unexpected"])
check("busy window counts every request", sum(j["outcomes"].values()) == 3771, j["outcomes"])
check("busy window timing covers every request", j["timing"]["worker"]["requests"] + j["timing"]["durable_object"]["requests"] == 3771, j["timing"])
check("busy window is complete", j["complete"] is True, j["complete"])
check("busy window takes few calls", j["api_calls"] <= 25, j["api_calls"])
check("busy window reads rows only for examples", S["inv_calls"] <= 2, S["inv_calls"])

# 10b. the timing read fails while the counts read: timing is could-not-measure, and NOT complete.
reset([event("wp-shop", "ok", 2, 40, "/") for _ in range(10)], {plain("wp-shop"): ON_FULL})
S["fail_op"] = "median"
code, jout, _ = run("shop", "--json")
j = json.loads(jout)
check("timing failure is not complete", j["timing"] is None and j["complete"] is False and j["outcomes"]["ok"] == 10, (j["timing"], j["complete"]))
out = run("shop")[1]
check("timing failure says could not measure", re.search(r"Timing, computed.*\n  could not measure", out) is not None and "not complete" in out, out)
check("timing failure is never healthy", "Summary: no failures found" not in out, out)

# 10c. the timing denominator (#662): records with no time, or no execution model, drop out of the
#      grouped percentile call. Doctor prints "from N of M requests" and keeps both in the JSON.
rows = [event("wp-shop", "ok", 2, 40, "/") for _ in range(10)]
for _ in range(3):
    e = event("wp-shop", "canceled", 1, 1, "/c")
    del e["$workers"]["cpuTimeMs"], e["$workers"]["wallTimeMs"]
    rows.append(e)
for _ in range(2):
    e = event("wp-shop", "ok", 2, 40, "/m")
    del e["$workers"]["executionModel"]
    rows.append(e)
reset(rows, {plain("wp-shop"): ON_FULL})
code, jout, _ = run("shop", "--json")
j = json.loads(jout)
check("timing denominator json", j.get("timing_requests") == 10 and j.get("timing_of") == 15, (j.get("timing_requests"), j.get("timing_of")))
out = run("shop")[1]
check("timing denominator printed", "Timing, computed by Cloudflare, from 10 of 15 requests:" in out, out)
reset([event("wp-shop", "ok", 2, 40, "/") for _ in range(10)], {plain("wp-shop"): ON_FULL})
out = run("shop")[1]
check("timing denominator printed when whole", "from 10 of 10 requests:" in out, out)

# 11. the facts layer itself keeps no query string or IP: checked with the print guard out of the way.
sys.path.insert(0, os.path.join(HERE, ".."))
import facts  # noqa: E402
# with_path=False: the row has no event.path, so the path comes from the request URL (it holds the query).
reset([event("wp-shop", "canceled", 1, 10, "/a", with_path=False) for _ in range(5)] + [console("wp-shop", {"m": "write-loss", "firstSql": SQL})], {plain("wp-shop"): ON_FULL})
raw = json.dumps(facts.gather(facts.Api(BASE, STAND_IN), "shop", facts.window_ms(24, NOW)))
for bad, label in ((QS_MARK, "a query string"), (CLIENT_IP, "a client IP"), (STAND_IN, "the token"), ("SELECT", "SQL"), ("?", "a query mark")):
    check("facts layer never keeps " + label, bad not in raw, "found in the facts")

# 12. the leak guard can fire: a path that carries an IP and SQL is hidden by the last guard.
import doctor  # noqa: E402
t = doctor.scrub("GET /x?" + QS_MARK + " from " + CLIENT_IP + " ran " + SQL + " Bearer " + STAND_IN, [STAND_IN])
never_leaks("scrub", t)

# 13. usage: no token, or a bad window, is exit 2 with no API call.
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
