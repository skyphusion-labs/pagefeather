#!/usr/bin/env python3
"""Compare per-table row counts for the import self-verify at volume (issue #165):
what the import SENT (the jsonl, dbmove-file.py counts) against the object's own
per-table COUNT(*) (dbmove.py counts -> /_dbcounts). No full-DB export, which
does not complete for a large object.

  count-check.py <sent-counts.json> <do-counts.json>

Each file is {"rows": {table: n}, ...}. Every table the import sent must exist
on the object with an equal count. Tables only on the object (the runtime's
undo log, made on a later page view) are ignored: the verify runs before any
page view, so there should be none, and an extra object-only table is not a
lost row. Exit 0 on a full match, 1 on any mismatch (naming the tables).
"""
import json
import sys

if len(sys.argv) != 3:
    sys.exit(__doc__)
sent = json.load(open(sys.argv[1])).get("rows", {})
do = json.load(open(sys.argv[2])).get("rows", {})
bad = []
for table in sorted(sent):
    got = do.get(table)
    if got != sent[table]:
        bad.append((table, sent[table], got))
if bad:
    sys.stderr.write("ROW COUNTS DIFFER (table: sent -> object):\n")
    for table, n, got in bad:
        sys.stderr.write("  %s: %s -> %s\n" % (table, n, "MISSING" if got is None else got))
    sys.exit(1)
print("rows: every table matches (%d rows across %d tables)" % (sum(sent.values()), len(sent)))
