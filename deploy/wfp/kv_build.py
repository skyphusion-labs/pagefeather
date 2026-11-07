#!/usr/bin/env python3
"""Read a site map entry from stdin and print its "build" field (issue #35
slice 5). The input is what lib.sh api prints: the JSON value, then a trailing
line with the HTTP code. Prints "" when there is no entry, no build field, or
the input is not JSON. Never raises, so entry_build is safe under set -u.
"""
import json
import sys

raw = sys.stdin.read()
for cand in (raw.rsplit("\n", 1)[0], raw.strip(), raw):
    cand = cand.strip()
    if not cand:
        continue
    try:
        v = json.loads(cand)
    except ValueError:
        continue
    print(v.get("build", "") if isinstance(v, dict) else "")
    break
else:
    print("")
