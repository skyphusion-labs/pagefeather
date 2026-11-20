#!/usr/bin/env python3
"""#1050: OBSERVABILITY is a recorded site setting for 0 and 1, never for full.

cf759a (2026-11-20): the user Worker site-cf759a had no observability block, because OBSERVABILITY
was not recorded and the update that remounted it did not pass it. Workers Logs then held nothing
for the site, and #1042's statement-failure lines were lost.
- 1 (events only: our own structured lines and uncaught exceptions, no request metadata) and 0 are
  recorded, so an update without OBSERVABILITY keeps the site's logs as they were.
- full (invocation logs: every request's URL, client IP and user agent; a throwaway only, #639)
  stays a per-run choice and is never recorded: the next update without it falls back to the record
  (or off), the safe direction for data that carries client IPs.
Usage: python3 -I deploy/wfp/tests/obs-record-test.py [site_settings.py dir]
"""
import io, os, sys, contextlib
here = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, here)
import site_settings as ss  # noqa: E402

fails = 0


def check(name, got, want):
    global fails
    ok = got == want
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else ": got %r, want %r" % (got, want)))
    fails += not ok


def merged(record, env):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        ss.merge(record, env)
    return out.getvalue().splitlines()


check("OBSERVABILITY is a known setting", "OBSERVABILITY" in ss.SETTINGS, True)
check("1 is recorded", ss.env_json({"OBSERVABILITY": "1"})["settings"].get("OBSERVABILITY"), "1")
check("0 is recorded", ss.env_json({"OBSERVABILITY": "0"})["settings"].get("OBSERVABILITY"), "0")
check("full is NOT recorded (client IPs; per run only)", "OBSERVABILITY" in ss.env_json({"OBSERVABILITY": "full", "THROWAWAY": "1"})["settings"], False)
rec = {"v": 1, "settings": {"OBSERVABILITY": "1"}, "secrets": []}
check("THE cf759a CASE: an update without OBSERVABILITY keeps the recorded 1", "export OBSERVABILITY=1" in merged(rec, {}), True)
check("  a run that sets 0 wins over the recorded 1", any(l.startswith("export OBSERVABILITY=") for l in merged(rec, {"OBSERVABILITY": "0"})), False)
check("  DROP_SETTINGS=OBSERVABILITY drops it", "export OBSERVABILITY=''" in merged(rec, {"DROP_SETTINGS": "OBSERVABILITY"}), True)
check("a record holding full (hand-made) is not kept", "export OBSERVABILITY=full" in merged({"v": 1, "settings": {"OBSERVABILITY": "full"}, "secrets": []}, {}), False)
print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
