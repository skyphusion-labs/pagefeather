#!/usr/bin/env python3
"""#567: fresh-test.py, bindings-render-test.py and lock-race.py must leave no temp directory.

Each made one with tempfile.mkdtemp and never removed it (one directory per run on a crew
seat; a CI runner throws its temp away). This runs each with TMPDIR set to an empty directory
and fails if any entry is left. Python's tempfile follows TMPDIR on macOS and on Linux, so the
check sees the directory here and in CI. (Shell mktemp -d with no template does not follow
TMPDIR on macOS; that limit is #513's, not this one.)

A second run of each sets WFP_TEMP_CLEAN_FAIL=1. The script exits 1 from inside the same
cleanup, and must still leave nothing. On the code this was written against, both runs left
one directory.

The only directory this test removes is the empty one it just made for that run, after it has
counted what the run left. It does not look at older temp directories.

Run: python3 -I deploy/wfp/tests/tempdir-clean-test.py
"""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
CASES = [
    ("fresh-test.py", [PY, "-I", os.path.join(HERE, "fresh-test.py")]),
    ("bindings-render-test.py", [PY, "-I", os.path.join(HERE, "bindings-render-test.py")]),
    ("lock-race.py", [PY, "-I", os.path.join(HERE, "lock-race.py"), "flock", "2", "4"]),
]
fails = 0


def check(name, ok, got=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else " (%s)" % (got,)))
    fails += 0 if ok else 1


def run_one(label, args, extra, want_rc):
    sandbox = tempfile.mkdtemp(prefix="wfp-567-")
    try:
        env = dict(os.environ)
        env["TMPDIR"] = sandbox
        env["TEMP"] = sandbox
        env["TMP"] = sandbox
        env.pop("WFP_TEMP_CLEAN_FAIL", None)
        env.update(extra)
        r = subprocess.run(args, env=env, capture_output=True, text=True)
        left = sorted(os.listdir(sandbox))
        check("%s: exit %s and no temp directory left" % (label, want_rc),
              r.returncode == want_rc and left == [],
              "exit %s, left %s" % (r.returncode, left))
        if r.returncode != want_rc:
            err = (r.stderr or "").strip().splitlines()
            if err:
                print("  stderr: " + err[-1][:300])
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


for name, args in CASES:
    run_one(name, args, {}, 0)
    run_one("%s failing run" % name, args, {"WFP_TEMP_CLEAN_FAIL": "1"}, 1)
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
