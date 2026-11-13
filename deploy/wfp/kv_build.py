#!/usr/bin/env python3
"""Read a site map entry from stdin and print one string field (issue #35
slice 5, #421). The field defaults to "build". Pass "config_hash" to read the
hash recorded next to the build id.

The input is what lib.sh api prints: the JSON value, then a trailing line with
the HTTP code. Prints "" when there is no entry, the field is missing or not a
string, or the input is not JSON. Never raises, so entry_build is safe under
set -u.
"""
import json
import sys

field = sys.argv[1] if len(sys.argv) > 1 else "build"
raw = sys.stdin.read()
for cand in (raw.rsplit("\n", 1)[0], raw.strip(), raw):
    cand = cand.strip()
    if not cand:
        continue
    try:
        v = json.loads(cand)
    except ValueError:
        continue
    val = v.get(field, "") if isinstance(v, dict) else ""
    print(val if isinstance(val, str) else "")
    break
else:
    print("")
