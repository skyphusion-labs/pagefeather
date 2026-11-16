#!/usr/bin/env python3
"""alarm-record.py's pure parts, offline (#291): UTC formatting, the alarm-only minutes, and the cpuMs verdict."""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("alarm_record", os.path.join(HERE, "..", "alarm-record.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fails = []
def ok(name, cond, got=None):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  got %r" % (got,)))
    cond or fails.append(name)

ok("utc: epoch ms to an ISO UTC string", m.utc(1794866747261) == "2026-11-16T22:05:47.261Z", m.utc(1794866747261))
ok("utc: None stays None", m.utc(None) is None)
inv = [
    {"dimensions": {"datetimeMinute": "2026-11-16T10:00:00Z", "type": "alarm", "status": "success", "objectId": "o1"}, "sum": {"requests": 1}},
    {"dimensions": {"datetimeMinute": "2026-11-16T10:01:00Z", "type": "alarm", "status": "success", "objectId": "o1"}, "sum": {"requests": 1}},
    {"dimensions": {"datetimeMinute": "2026-11-16T10:01:00Z", "type": "fetch", "status": "success", "objectId": "o1"}, "sum": {"requests": 3}},
    {"dimensions": {"datetimeMinute": "2026-11-16T10:02:00Z", "type": "alarm", "status": "success", "objectId": "o1"}, "sum": {"requests": 2}},
]
cpu = [
    {"dimensions": {"datetimeMinute": "2026-11-16T10:00:00Z", "objectId": "o1"}, "sum": {"cpuTime": 850000}},
    {"dimensions": {"datetimeMinute": "2026-11-16T10:01:00Z", "objectId": "o1"}, "sum": {"cpuTime": 4000000}},
    {"dimensions": {"datetimeMinute": "2026-11-16T10:02:00Z", "objectId": "o1"}, "sum": {"cpuTime": 1200000}},
    {"dimensions": {"datetimeMinute": "2026-11-16T10:03:00Z", "objectId": "o1"}, "sum": {"cpuTime": 9000}},
]
t = m.alarm_only_minutes(inv, cpu)
ok("alarm-only minutes: a minute with a fetch beside the alarm is left out", [x["minute"] for x in t] == ["2026-11-16T10:00:00Z", "2026-11-16T10:02:00Z"], t)
ok("  cpuTime microseconds become milliseconds", t[0]["cpu_ms"] == 850.0 and t[1]["cpu_ms"] == 1200.0, t)
ok("  a minute with no invocation row is left out (no alarm to blame)", all(x["minute"] != "2026-11-16T10:03:00Z" for x in t))
v = m.verdict(500, t)
ok("verdict: a cpuMs below the worst tick (per alarm: 1200/2 = 600 ms) is a #291 cause", v["verdict"].startswith("BELOW") and v["worst_tick_cpu_ms"] == 850.0, v)
v = m.verdict(30000, t)
ok("verdict: 30000 is above every tick, with the headroom", v["verdict"] == "above every measured tick" and v["headroom_ms"] == 29150.0, v)
ok("verdict: no cpuMs in the map", m.verdict(None, t)["verdict"] == "no cpuMs in the map entry")
ok("verdict: no alarm-only minute is could-not-measure, never a pass", m.verdict(30000, [])["verdict"].startswith("could not measure"))
ok("summarize: per type and status, requests and errors", m.summarize(inv + [{"dimensions": {"datetimeMinute": "x", "type": "fetch", "status": "clientDisconnected", "objectId": "o1"}, "sum": {"requests": 2, "errors": 2}}]) ==
   {"alarm/success": {"requests": 4, "errors": 0}, "fetch/success": {"requests": 3, "errors": 0}, "fetch/clientDisconnected": {"requests": 2, "errors": 2}},
   m.summarize(inv))
ok("classify_403: the site's own refusal names the token", "refused the token" in m.classify_403(b"forbidden"))
ok("classify_403: error code 1010 is the edge, before the token", "edge" in m.classify_403(b"error code: 1010\n") and "not checked" in m.classify_403(b"error code: 1010\n"))
ok("classify_403: anything else is unknown, with the body", m.classify_403(b"nope").startswith("an unknown 403: nope"))
ok("every request carries a User-Agent (the 1010 block)", m.UA.get("User-Agent") == "pagefeather-alarm-record" and "{**UA," in open(os.path.join(HERE, "..", "alarm-record.py")).read())
ok("the CPU query filters by objectId_in, never scriptName (unknown there, live)", "objectId_in: $o" in m.GQL_CPU and "scriptName" not in m.GQL_CPU)
src = open(os.path.join(HERE, "..", "alarm-record.py")).read()
ok("read-only: no POST other than GraphQL, no PUT or DELETE", "method=" not in src and "PUT" not in src and "DELETE" not in src)
print("%d failing" % len(fails))
sys.exit(1 if fails else 0)
