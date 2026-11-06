#!/usr/bin/env python3
"""Test of split() in tests/load/warm_start.py (issue #92). No site.

  python3 tests/load/warm_start_test.py [path/to/warm_start.py]

A synthetic boot log and request log, as the container writes them
(container/bootlog.sh, c1-serve.sh, c1-prepend.php). The checks: each start
step is in seconds after the view; the first two add to cart requests of THIS
product after the cart was sent are cart1 and cart2; an add to cart of another
product (12 against 123), and one from before the cart (an earlier trial in
the same container), do not count; a missing step is left out, not zero;
the warm-up line (issue #92) gives warm_done_s and the warm-up record.
Exit 0 when all pass.
"""
import importlib.util, os, sys

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "warm_start.py")
os.environ.setdefault("B", "http://127.0.0.1:9")
os.environ.setdefault("SPIKE_TOKEN", "test")
spec = importlib.util.spec_from_file_location("warm_start", path)
ws = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ws)

V, C = 1000.0, 1012.0  # the view and the cart, epoch seconds
boot = "\n".join([
    "1001.500 c1: entrypoint start, uid 0, kernel 6.1",
    "1001.600 c1: status Uid: 0",
    "1003.250 c1: restore done (database file: yes)",
    "1003.300 c1: seed: start",
    "1003.900 c1: starting litestream replicate with c1-serve.sh",
    "1004.100000 out c1-serve: starting php-fpm, fd2 pipe:[1]",
    "1004.400000 out c1-serve: php-fpm 41, nginx 42",
    "1004.900000 out c1-serve: warm: start",
    '1009.100000 out c1-serve: warm: done {"boot_s":3.9,"total_s":4.2,"compiled":310,"stop":"done","before":{"scripts":2,"free_mib":127.9},"after":{"scripts":1702,"free_mib":63.1}}',
])
req = "\n".join([
    "990.000 0.900 0.800 40 302 GET /?add-to-cart=12",     # an earlier trial: before the cart
    "1012.200 2.000 1.000 50 302 GET /?add-to-cart=123",  # another product
    "1012.300 4.100 2.500 60 302 GET /?add-to-cart=12",   # cart1
    "1016.500 0.300 0.200 60 302 GET /?add-to-cart=12",   # cart2
    "1017.000 0.010 0.010 2 200 GET /_stats.php?what=info",
    "not a line",
])
s = ws.split(V, C, boot, req, 12)
want = {"start_s": 1.5, "restore_done_s": 3.25, "litestream_s": 3.9, "servers_s": 4.4,
        "cart1_php_wall_s": 4.1, "cart1_php_cpu_s": 2.5, "cart2_php_wall_s": 0.3, "cart2_php_cpu_s": 0.2,
        "cart1_php_start_after_send_s": 0.3, "warm_done_s": 9.1,
        "warm": {"boot_s": 3.9, "total_s": 4.2, "compiled": 310, "stop": "done", "before": {"scripts": 2, "free_mib": 127.9}, "after": {"scripts": 1702, "free_mib": 63.1}}}
fails = 0
for k, v in want.items():
    if s.get(k) != v:
        print("FAIL %s: %r (want %r)" % (k, s.get(k), v)); fails += 1
    else:
        print("PASS %s = %r" % (k, v))
# A boot log with no restore line (a stuck start): the step is absent, not 0.
s2 = ws.split(V, C, "1001.500 c1: entrypoint start, uid 0", "", 12)
s3 = ws.split(V, C, "1004.9 out c1-serve: warm: done no answer", "", 12)
s4 = ws.split(V, C, "1004.9 err c1-serve: warm: failed (HTTP 502) <html> <head><title>502", "", 12)
for k, ok in (("warm absent when its answer is not JSON", "warm" not in s3 and "warm_done_s" not in s3),
              ("warm: failed is reported", s4.get("warm_failed", "").startswith("(HTTP 502)") and "warm" not in s4),
              ("restore_done_s absent", "restore_done_s" not in s2), ("no cart lines: no cart keys", not any(x.startswith("cart") for x in s2))):
    print(("PASS " if ok else "FAIL ") + k); fails += 0 if ok else 1
extra = set(s) - set(want)
if extra:
    print("FAIL unexpected keys: %s" % sorted(extra)); fails += 1
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
