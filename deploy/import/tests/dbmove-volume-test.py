#!/usr/bin/env python3
"""Offline checks of the volume-robustness fixes in spikes/b2-wordpress/dbmove.py
(issue: import at volume). No network.

  python3 deploy/import/tests/dbmove-volume-test.py

Checks:
  1. last_nonempty_line streams the last non-empty line (so load() does not read
     a multi-10MB dump into memory), and returns None for an empty file.
  2. the completeness check reads that last line as the end line.
  3. parts() splits a dump into parts no larger than PART_BYTES.
  4. an oversized single row aborts with a message that NAMES the row's table,
     not only the byte count (describe_oversized).
Exit 0 only when all pass.
"""
import importlib.util, json, os, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DBMOVE = os.path.join(ROOT, "spikes", "b2-wordpress", "dbmove.py")
spec = importlib.util.spec_from_file_location("dbmove", DBMOVE)
dbmove = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dbmove)

fails = 0
def ok(label, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + label)
    if not cond: fails += 1

W = tempfile.mkdtemp()

# 1. last_nonempty_line
p = os.path.join(W, "trail.jsonl")
open(p, "wb").write(b'{"sql":"CREATE"}\n{"end":true,"rows":3}\n\n\n')
ok("last_nonempty_line skips trailing blanks", dbmove.last_nonempty_line(p) == b'{"end":true,"rows":3}\n')
empty = os.path.join(W, "empty.jsonl"); open(empty, "wb").write(b"")
ok("last_nonempty_line returns None for an empty file", dbmove.last_nonempty_line(empty) is None)

# 2. completeness check (the logic load() uses)
last = dbmove.last_nonempty_line(p)
ok("completeness: the end line is detected", bool(last) and json.loads(last).get("end") is True)
noend = os.path.join(W, "noend.jsonl"); open(noend, "wb").write(b'{"sql":"INSERT"}\n')
lastn = dbmove.last_nonempty_line(noend)
ok("completeness: no end line is detected as incomplete", not (lastn and json.loads(lastn).get("end")))

# 3 and 4. parts() with a small PART_BYTES so we need no huge files.
dbmove.PART_BYTES = 100
good = os.path.join(W, "good.jsonl")
rows = [b'{"sql":"INSERT INTO \\"wp_posts\\" (a) VALUES (?)","params":[%d]}\n' % i for i in range(20)]
open(good, "wb").write(b"".join(rows))
got = list(dbmove.parts(good))
ok("parts: every part is within PART_BYTES", all(len(x) <= dbmove.PART_BYTES for x in got))
ok("parts: every byte is carried (reassembly matches)", b"".join(got) == b"".join(rows))
ok("parts: more than one part for 20 small rows at 100 bytes", len(got) > 1)

big = os.path.join(W, "big.jsonl")
line = b'{"sql":"INSERT INTO \\"wp_bigtable\\" (blob) VALUES (?)","params":["%s"]}\n' % (b"x" * 300)
open(big, "wb").write(line)
try:
    list(dbmove.parts(big))
    ok("parts: an oversized row aborts", False)
except SystemExit as e:
    msg = str(e)
    ok("parts: an oversized row aborts with the byte count", "bytes" in msg and "part limit" in msg)
    ok("parts: the abort names the row's table (wp_bigtable)", "wp_bigtable" in msg)

print("%d failing check(s)" % fails)
sys.exit(fails)
