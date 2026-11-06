#!/usr/bin/env python3
"""Test of tests/load/c1_arm.py (#99) on a synthetic job with known answers.
Run: python3 tests/load/c1_arm_test.py   (exit 0 when every check passes)

The job: 400 s from 10:00:00 UTC.
- A cron run of 15 s from +100 s ends at +115 s. A checkout starts in PHP 0.3 s
  later: HELD. A second checkout waits 10 s for a busy CPU: not held.
- 2 orders. The cgroup CPU is 40.0 s over the window. PHP CPU: shoppers 0.9 s
  (2 checkouts and 1 page), cron 3.0 s (2 runs).
- 6 actions done, 3 left above the seed's 13.
So: corrected CPU per order (40.0 + 3 x 3.0/6) / 2 = 20.75 s; outside PHP
40.0 / 3.9 = 10.256.
"""
import importlib.util, io, json, os, sys, tempfile, contextlib
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("c1_arm", os.path.join(HERE, "c1_arm.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

T0 = 1793959200.0  # 2026-11-06T10:00:00Z
d = tempfile.mkdtemp()
json.dump({"job": "test", "runner": {"started_utc": "2026-11-06T10:00:00Z", "finished_utc": "2026-11-06T10:06:40Z"},
           "targets": [{"load": {"steps": [{"users": 5, "seconds": 400.0, "requests": 4, "rps": 0.01,
               "kinds": {"checkout": {"n": 2, "ok": 2, "p50": 10.8, "p99": 13.0, "max": 13.1}, "browse": {"n": 1, "ok": 1, "max": 0.1}},
               "slow": [{"t0": T0 + 105, "k": "checkout", "c": 200, "s": 10.8, "ttfb": 10.7, "ray": "a"},
                        {"t0": T0 + 190, "k": "checkout", "c": 200, "s": 13.1, "ttfb": 13.0, "ray": "b"}]}]}}]},
          open(os.path.join(d, "result.json"), "w"))
req = [(T0 + 50, 0.1, 0.1, "GET", "/"), (T0 + 100, 15.0, 2.0, "GET", "/wp-cron.php"),
       (T0 + 115.3, 0.4, 0.3, "POST", "/?rest_route=/wc/store/v1/checkout"),
       (T0 + 200, 3.0, 0.5, "POST", "/?rest_route=/wc/store/v1/checkout"),
       (T0 + 250, 0.01, 0.0, "GET", "/ping"), (T0 + 260, 0.2, 0.2, "GET", "/_stats.php?what=info"),
       (T0 + 300, 2.0, 1.0, "GET", "/wp-cron.php")]
with open(os.path.join(d, "req.log"), "w") as f:
    for t, wall, cpu, meth, p in req:
        f.write("%.3f %.3f %.3f 12 200 %s %s\n" % (t, wall, cpu, meth, p))
with open(os.path.join(d, "samples.log"), "w") as f:
    f.write("%.3f cpu 1 0 1 9 0 0 0 0 0 0 | cg usage_usec=1000000 | load 0 | backlog 0 | php S4 \n" % (T0 + 1))
    f.write("%.3f cpu 2 0 2 9 0 0 0 0 0 0 | cg usage_usec=41000000 | load 0 | backlog 0 | php S4 \n" % (T0 + 399))
json.dump({"rows": {"wp_wc_orders": 129}, "actions": {"complete": 160, "pending": 16}}, open(os.path.join(d, "db.json"), "w"))

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.main([d])
out = json.loads(buf.getvalue())
fails = 0
def check(name, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("PASS " if ok else "FAIL ") + "%s: %r%s" % (name, got, "" if ok else " (want %r)" % (want,)))
h, c, s = out["hol"], out["cpu"], out["split"]
check("long cron runs", h["long_cron_runs"], 1)
check("slow requests matched", (h["slow"], h["matched"]), (2, 2))
check("held", h["held"], 1)
check("the held one waited for the cron end", [r["held"] for r in h["requests"]], [True, False])
check("cgroup CPU s", c["cpu_s"], 40.0)
check("orders", c["orders"], 2)
check("CPU per order", c["cpu_s_per_order"], 20.0)
check("shopper PHP CPU s", (s["shop_php_cpu_s"], s["shop_reqs"]), (0.9, 3))
check("cron PHP CPU s", (s["cron_php_cpu_s"], s["cron_reqs"]), (3.0, 2))
check("actions done and left", (s["actions_done"], s["actions_left"]), (6, 3))
check("corrected CPU per order", s["corrected_cpu_per_order"], 20.75)
check("outside PHP", s["outside_php"], 10.256)
check("steps", [(x["users"], x["checkout_ok"]) for x in out["steps"]], [(5, 2)])
# The held count depends on the window: with no window, nothing is held.
m.HOLD_S = -1
check("no window, none held", m.hol(json.load(open(os.path.join(d, "result.json"))), m.read_req(os.path.join(d, "req.log")))["held"], 0)
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
