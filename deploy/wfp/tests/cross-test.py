#!/usr/bin/env python3
"""Test of deploy/wfp/cross.py verdict() (issue #35, slice 4): the isolation
decision from the attacker's probe responses.

  python3 deploy/wfp/tests/cross-test.py

For each test, an ISOLATED response is "pass"; a BREACH response with no
B-binding is "platform"; the same breach WITH a B-binding is "our-defect"; an
unreadable response is "inconclusive". A mutant of verdict() that calls a
breach "pass" must be caught (summarize's worst result is not pass).
"""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cross", sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "cross.py"))
cross = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cross)

B = {"site": "two", "bucket_key": "wfp-isolation/B.txt", "do_marker": "obj-bbbb", "wp_salt_hash": "bbbbbb"}
ISOLATED = {
    "r2": {"keys": ["wfp-isolation/A.txt"]},
    "r2_fetch": {"status": 403, "bytes": 0},
    "do": {"marker": "obj-aaaa"},
    "secret": {"env_names": ["SITE_ORIGIN", "SPIKE_TOKEN", "WP_SALT"], "wp_salt_hash": "aaaaaa"},
    "sub": {"requested": 6, "ok": 2, "error": "Too many subrequests"}, "sub_limit": 2,
    "cpu": {"ms": 900, "error": "Worker exceeded CPU time limit"}, "cpu_limit_ms": 1000,
}
NO_BINDING = []
fails = 0


def check(name, want, probe, b=B, binds=NO_BINDING):
    global fails
    res = {r["test"]: r["result"] for r in cross.verdict(probe, b, binds)}
    if res.get(want[0]) == want[1]:
        print("PASS %s: %s is %s" % (name, want[0], want[1]))
    else:
        print("FAIL %s: %s is %s (want %s)" % (name, want[0], res.get(want[0]), want[1]))
        fails += 1


check("all isolated -> r2 pass", ("r2", "pass"), ISOLATED)
worst, _ = cross.summarize(cross.verdict(ISOLATED, B, NO_BINDING))
print(("PASS" if worst == "pass" else "FAIL") + " all isolated -> worst is pass (got %s)" % worst); fails += 0 if worst == "pass" else 1

# R2 breach: A lists B's key.
br = dict(ISOLATED, r2={"keys": ["wfp-isolation/A.txt", "wfp-isolation/B.txt"]})
check("A lists B's object, no B-binding -> platform", ("r2", "platform"), br)
check("A lists B's object, WITH a B-binding -> our-defect", ("r2", "our-defect"), br, binds=["r2_bucket MEDIA wp-wfp-two-media"])
check("a fetch to B's bucket returns bytes -> platform", ("r2_fetch", "platform"), dict(ISOLATED, r2_fetch={"status": 200, "bytes": 42}))
# DO breach: same marker.
check("A's object marker equals B's -> platform", ("do", "platform"), dict(ISOLATED, do={"marker": "obj-bbbb"}))
check("same marker WITH a B DO-binding -> our-defect", ("do", "our-defect"), dict(ISOLATED, do={"marker": "obj-bbbb"}), binds=["durable_object_namespace PHP script_name=site-two"])
# Secret breach: same salt hash.
check("A's salt equals B's -> platform", ("secret", "platform"), dict(ISOLATED, secret={"env_names": ["WP_SALT"], "wp_salt_hash": "bbbbbb"}))
# Limits.
check("A made all subrequests past the limit -> platform", ("sub", "platform"), dict(ISOLATED, sub={"requested": 6, "ok": 6, "error": None}))
check("A cut at the subrequest limit -> pass", ("sub", "pass"), ISOLATED)
check("A ran far past a >=2s cpu limit -> platform", ("cpu", "platform"), dict(ISOLATED, cpu={"ms": 9000}, cpu_limit_ms=2000))
check("A cut by cpuMs -> pass (inexactness noted)", ("cpu", "pass"), ISOLATED)
# Unreadable.
check("an unreadable r2 probe -> inconclusive", ("r2", "inconclusive"), dict(ISOLATED, r2={"error": "boom"}))
check("an unreadable secret probe -> inconclusive", ("secret", "inconclusive"), dict(ISOLATED, secret={"status": 500}))

# The worst-result summary catches any breach.
for nm, probe in [("r2 breach", br), ("do breach", dict(ISOLATED, do={"marker": "obj-bbbb"})), ("sub breach", dict(ISOLATED, sub={"requested": 6, "ok": 6}))]:
    worst, _ = cross.summarize(cross.verdict(probe, B, NO_BINDING))
    print(("PASS" if worst != "pass" else "FAIL") + " %s -> worst is not pass (got %s)" % (nm, worst)); fails += 0 if worst != "pass" else 1
print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
