#!/usr/bin/env python3
"""Client of /_sqlimport (variant a; spikes/b2-wordpress/sql-import.js), issue #31.

  sqlimport.py info   <base-url>                 server version, flavour, max_allowed_packet
  sqlimport.py counts <base-url>                 rows and lowest auto_increment id per wp_ table
  sqlimport.py load   <base-url> <file.jsonl> [--replace]

SPIKE_TOKEN in the environment is sent as x-spike-token, with User-Agent
wp-on-cf-import/1 (the edge refuses urllib's default, #72). load sends the
file in parts of at most PART_BYTES; --replace goes with part 0 only, and the
endpoint then drops every wp_ table first. Before that, every CREATE TABLE of
the file goes to preflight=1 (each runs under a scratch name in the endpoint's
DDL mode, then is dropped): a CREATE the server refuses stops the load while
the site is still whole. A part that fails stops the load:
the script prints the part, the line and the error, and the parts before it
stay in the database.
"""
import json
import os
import sys
import urllib.error
import urllib.request

PART_BYTES = 1_500_000
USER_AGENT = "wp-on-cf-import/1"


def call(method, url, body=None):
    h = {"User-Agent": USER_AGENT, "x-spike-token": os.environ.get("SPIKE_TOKEN", "")}
    if body is not None:
        h["content-type"] = "application/x-ndjson"
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"ok": False, "error": raw[:300].decode(errors="replace")}


def parts(path):
    with open(path, "rb") as f:
        yield from parts_of(f)


def parts_of(lines):
    part, size = [], 0
    for line in lines:
        if len(line) > PART_BYTES:
            sys.exit(f"a statement is {len(line)} bytes, more than a part ({PART_BYTES})")
        if part and size + len(line) > PART_BYTES:
            yield b"".join(part)
            part, size = [], 0
        part.append(line)
        size += len(line)
    if part:
        yield b"".join(part)


def main(a):
    if len(a) >= 3 and a[1] in ("info", "counts"):
        code, o = call("GET", a[2].rstrip("/") + "/_sqlimport?" + a[1] + "=1")
        print(json.dumps(o, indent=1, sort_keys=True))
        sys.exit(0 if code == 200 else 1)
    if len(a) >= 4 and a[1] == "load":
        url = a[2].rstrip("/") + "/_sqlimport"
        replace = "--replace" in a[4:]
        creates = [l for l in open(a[3], "rb") if json.loads(l).get("sql", "").startswith("CREATE TABLE ")]
        checked = 0
        for i, body in enumerate(parts_of(creates)):
            code, o = call("POST", url + "?preflight=1", body)
            if code != 200 or not o.get("ok"):
                n = checked + (o.get("line") or 0)
                print(f"PREFLIGHT REFUSED CREATE TABLE {n} of {len(creates)}: {o.get('error')}. Nothing was dropped or imported.", file=sys.stderr)
                sys.exit(1)
            checked += o["preflight"]
        print(f"preflight: {checked} CREATE TABLE statements run under scratch names and dropped")
        total = 0
        for i, body in enumerate(parts(a[3])):
            code, o = call("POST", url + ("?replace=1" if replace and i == 0 else ""), body)
            if code != 200 or not o.get("ok"):
                print(f"STOPPED at part {i}, line {o.get('line')}: {o.get('error')} (statements that ran in this part: {o.get('ran')}, tables dropped first: {o.get('dropped')})", file=sys.stderr)
                if replace:
                    print("The site's wp_ tables were dropped before part 0, so the database is now EMPTY or PARTIAL. Fix the cause and import again (with --replace).", file=sys.stderr)
                sys.exit(1)
            total += o["statements"]
            print(f"part {i}: {o['statements']} statements" + (f", {o['dropped']} tables dropped first" if o.get("dropped") else ""))
        print(f"imported {total} statements")
        return
    sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
