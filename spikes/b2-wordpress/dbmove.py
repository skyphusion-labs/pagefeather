#!/usr/bin/env python3
"""Move a WordPress database in or out of the PHP object (DB_IN_DO=on).

  dbmove.py export <base-url> <file> [--from-d1]   dump to a JSON lines file
  dbmove.py import <base-url> <file> [--replace]   load a dump into the object

SPIKE_TOKEN in the environment is sent as x-spike-token. The dump format is in
index.js (dumpTo). Export stops with an error if the dump has no end line.
Import sends the file in parts of at most PART_BYTES (the Worker refuses a body
over 2 MB); each part is one transaction in the object. A part that fails is
rolled back and import stops; parts before it stay.
The object must hold no tables. --replace drops every table first (in the
transaction of the first part). Any page view of an empty object creates the
SQLite driver's own tables, so a new site usually needs --replace. The second
and later parts are sent with append=1: the tables of the first part exist.
(Before 2026-11-06 they were not, and every dump of more than one part stopped
at part 1 with "tables or indexes exist".)
"""
import json
import os
import sys
import urllib.request

PART_BYTES = 1_500_000


def call(method, url, body=None):
    req = urllib.request.Request(url, data=body, method=method)
    token = os.environ.get("SPIKE_TOKEN")
    if token:
        req.add_header("x-spike-token", token)
    if body is not None:
        req.add_header("content-type", "application/x-ndjson")
    return urllib.request.urlopen(req, timeout=300)


def export(base, path, from_d1):
    url = base.rstrip("/") + "/_dbexport" + ("?from=d1" if from_d1 else "")
    last = None
    lines = 0
    with call("GET", url) as r, open(path, "wb") as f:
        for line in r:
            f.write(line)
            lines += 1
            last = line
    end = json.loads(last) if last else {}
    if not end.get("end"):
        sys.exit(f"export incomplete: last line {last[:200] if last else None!r}")
    print(f"exported {lines} lines, {end['rows']} rows, to {path}")


def parts(path):
    part = []
    size = 0
    with open(path, "rb") as f:
        for line in f:
            if len(line) > PART_BYTES:
                sys.exit(f"a line is {len(line)} bytes, more than {PART_BYTES}: import it by hand")
            if size + len(line) > PART_BYTES and part:
                yield b"".join(part)
                part, size = [], 0
            part.append(line)
            size += len(line)
    if part:
        yield b"".join(part)


def load(base, path, replace):
    with open(path, "rb") as f:
        lines = f.read().splitlines()
    if not lines or not json.loads(lines[-1]).get("end"):
        sys.exit("the dump has no end line: it is incomplete")
    url = base.rstrip("/") + "/_dbimport"
    total = 0
    for i, body in enumerate(parts(path)):
        try:
            query = ("?replace=1" if replace else "") if i == 0 else "?append=1"
            with call("POST", url + query, body) as r:
                reply = json.load(r)
        except urllib.request.HTTPError as e:
            sys.exit(f"part {i} failed: HTTP {e.code} {e.read()[:500]!r}")
        if not reply.get("ok"):
            sys.exit(f"part {i} failed: {reply}")
        total += reply["statements"]
        print(f"part {i}: {reply['statements']} statements, database {reply['databaseBytes']} bytes")
    print(f"imported {total} statements")


if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] not in ("export", "import"):
        sys.exit(__doc__)
    if sys.argv[1] == "export":
        export(sys.argv[2], sys.argv[3], "--from-d1" in sys.argv[4:])
    else:
        load(sys.argv[2], sys.argv[3], "--replace" in sys.argv[4:])
