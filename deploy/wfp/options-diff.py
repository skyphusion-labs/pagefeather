#!/usr/bin/env python3
"""The #794 repair instrument: what changed in wp_options between two #533 database snapshots.

READ-ONLY and OFFLINE. It reads two local snapshot files and writes only to stdout: no network, no credentials, no
site. A snapshot is the site's own scheduled dump (#533, db-snapshot.mjs): a gzipped NDJSON file in the site's MEDIA
bucket under _snapshots/auto/<UTC yyyymmddThhmmssZ>.ndjson.gz. Fetching them is the operator's step (below).

Why: #794 is a value derived from a failed read and written over a real one (if get_option() is false, add_option() a
default). Workers Logs were off on ggc, so the logs cannot say which options it hit. The snapshots can: the OLDEST
kept snapshot against the NEWEST shows every option whose value changed in between. Most changes are ordinary edits;
the reader looks for a real setting replaced by a default. #797 stops it from happening; this finds what already did.

What it compares (the lead's spec): NON-AUTOLOADED options by default (autoload not in yes, on, auto, auto-on: those
are read one by one, the path #794 hits); --all adds the autoloaded ones. Transients (_transient_*, _site_transient_*)
are counted, not listed: they churn by design.

SECRETS: an option whose NAME or VALUE looks secret-like (must_withhold) (keys, tokens, passwords, salts, nonces, payment settings,
private keys...) is listed by NAME ONLY: its value is never printed, not even its length. Every other value is
printed truncated (--width, default 100) with control characters escaped.

Usage:
    python3 -I deploy/wfp/options-diff.py OLDER.ndjson.gz NEWER.ndjson.gz [--all] [--width N] [--json] [--table T]
    python3 -I deploy/wfp/options-diff.py SNAPSHOT_DIR [--all] ...     # the oldest and newest *.ndjson.gz by name

The operator's fetch (read-only; the lead's Cloudflare token; names only, never the token value):
    list:  GET /accounts/<account>/r2/buckets/<site media bucket>/objects?prefix=_snapshots/auto/
    get:   deploy/wr r2 object get <site media bucket>/_snapshots/auto/<key> --remote --file <dir>/<key>
The site's media bucket is its MEDIA binding (deploy/wfp: wp-wfp-<site>-media); confirm it from the site's bindings.

Exit status: 0 the diff was made (changes or not); 2 a usage or input error (a file that is not a snapshot, a dump
that ended in an error, a truncated dump, one with no options rows, or more than one options table without --table). It never exits 0 on a dump it could not fully read.
Test: deploy/wfp/tests/options-diff-test.py.
"""
import gzip
import json
import os
import re
import sys

AUTOLOADED = {"yes", "on", "auto", "auto-on"}
TRANSIENT = re.compile(r"^_(site_)?transient_")
WITHHOLD_BY_NAME = re.compile(
    r"(key|token|secret|passw|pwd|auth|salt|nonce|private|credential|licen[cs]e|session|cookie|hash|signature|"
    r"webhook|stripe|paypal|ppcp|square|braintree|smtp|mailgun|sendgrid|oauth|bearer|jwt|cert|api)", re.I)
WITHHOLD_BY_VALUE = re.compile(
    r"(sk_live_|sk_test_|rk_live_|pk_live_|whsec_|-----BEGIN|password|passwd|secret|api[_-]?key|access[_-]?token|"
    r"client[_-]?secret|private[_-]?key|bearer\s)", re.I)
# The options table, whatever its prefix: an INSERT into a table named <prefix>options. A dump with more than one
# (multisite: wp_options and wp_2_options) needs --table.
INSERT_ANY = re.compile(r'^INSERT INTO ["`]?([A-Za-z0-9_]+)["`]? \(([^)]*)\) VALUES', re.I)


class SnapshotError(Exception):
    pass


def read_options(path, table=None):
    """{option_name: (option_id, value, autoload)} from one snapshot. Raises SnapshotError on anything incomplete."""
    opener = gzip.open if path.endswith(".gz") else open
    rows, ended, tables = {}, False, set()
    try:
        with opener(path, "rt", encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    raise SnapshotError("%s: line %d is not JSON: not a snapshot" % (path, n))
                if "error" in o:
                    raise SnapshotError("%s: the dump ended in an error (%s): it is incomplete" % (path, str(o["error"])[:120]))
                if o.get("end"):
                    ended = True
                    continue
                sql = o.get("sql") or ""
                m = INSERT_ANY.match(sql)
                if not m:
                    continue
                t = m.group(1)
                if not (t == table if table else t.endswith("options")):
                    continue
                cols = [c.strip().strip('"`') for c in m.group(2).split(",")]
                if "option_name" not in cols:
                    continue
                tables.add(t)
                p = o.get("params") or []
                r = dict(zip(cols, p))
                name = r.get("option_name")
                if name is None:
                    continue
                v = r.get("option_value")
                if isinstance(v, dict) and "$b" in v:
                    v = "(blob, base64 %d chars)" % len(v["$b"])
                rows[str(name)] = (r.get("option_id"), "" if v is None else str(v), str(r.get("autoload") or ""))
    except OSError as e:
        raise SnapshotError("%s: %s" % (path, e))
    if not ended:
        raise SnapshotError("%s: no end line: the dump is truncated" % path)
    if len(tables) > 1:
        raise SnapshotError("%s: more than one options table (%s): name one with --table" % (path, ", ".join(sorted(tables))))
    if not tables:
        raise SnapshotError("%s: no options rows in this dump%s" % (path, " for table " + table if table else ""))
    return rows


def must_withhold(name, *values):
    """True when the option's NAME or any of its VALUES looks secret-like: then only its name is ever reported."""
    return bool(WITHHOLD_BY_NAME.search(name)) or any(WITHHOLD_BY_VALUE.search(v or "") for v in values)


def withheld_row(name, id_changed, autoload):
    """A row for an option whose value is withheld: built from its name and metadata ONLY (no value is passed in)."""
    return {"name": name, "withheld": True, "idChanged": id_changed, "autoload": autoload}


def shown_row(name, id_changed, autoload, old_value, new_value, width):
    """A row for an option judged NOT secret-like (must_withhold false): its values, truncated and escaped."""
    return {"name": name, "withheld": False, "idChanged": id_changed, "autoload": autoload,
            "old": None if old_value is None else show(old_value, width),
            "new": None if new_value is None else show(new_value, width)}


def show(v, width):
    s = json.dumps(v, ensure_ascii=True)[1:-1]  # escapes control characters and quotes
    return s if len(s) <= width else s[:width] + "...(%d chars)" % len(v)


def diff(old, new, include_autoloaded=False):
    def wanted(name, rec):
        return include_autoloaded or rec[2].lower() not in AUTOLOADED
    out = {"changed": [], "added": [], "removed": [], "transients": 0, "autoloadChanged": []}
    for name in sorted(set(old) | set(new)):
        a, b = old.get(name), new.get(name)
        if TRANSIENT.match(name):
            if a != b:
                out["transients"] += 1
            continue
        if a and b:
            if not (wanted(name, a) or wanted(name, b)):
                continue
            if a[1] != b[1] or a[0] != b[0]:
                out["changed"].append((name, a, b))
            elif a[2] != b[2]:
                out["autoloadChanged"].append((name, a[2], b[2]))
        elif b and wanted(name, b):
            out["added"].append((name, None, b))
        elif a and wanted(name, a):
            out["removed"].append((name, a, None))
    return out


def snapshot_pair(args):
    if len(args) == 1 and os.path.isdir(args[0]):
        files = sorted(f for f in os.listdir(args[0]) if f.endswith(".ndjson.gz"))
        if len(files) < 2:
            raise SnapshotError("%s: fewer than two *.ndjson.gz snapshots" % args[0])
        return os.path.join(args[0], files[0]), os.path.join(args[0], files[-1])
    if len(args) == 2:
        return args[0], args[1]
    raise SnapshotError("usage: options-diff.py OLDER NEWER | SNAPSHOT_DIR [--all] [--width N] [--json]")


def main(argv):
    include_all = "--all" in argv
    as_json = "--json" in argv
    width = 100
    table = None
    rest = []
    it = iter(argv)
    for a in it:
        if a == "--width":
            width = int(next(it, "100"))
        elif a == "--table":
            table = next(it, None)
        elif a not in ("--all", "--json"):
            rest.append(a)
    try:
        older, newer = snapshot_pair(rest)
        old, new = read_options(older, table), read_options(newer, table)
    except SnapshotError as e:
        print("options-diff: %s" % e, file=sys.stderr)
        return 2
    d = diff(old, new, include_all)

    def rec(name, a, b):
        # Decide FIRST whether the value is withheld; a withheld row is then built from the name and metadata alone,
        # so no value of it reaches any printed structure (the CodeQL data flow, alert 36, and the reader's).
        id_changed = bool(a and b and a[0] != b[0])
        autoload = [a[2] if a else None, b[2] if b else None]
        if must_withhold(name, a[1] if a else "", b[1] if b else ""):
            return withheld_row(name, id_changed, autoload)
        return shown_row(name, id_changed, autoload, a[1] if a else None, b[1] if b else None, width)

    report = {
        "older": os.path.basename(older), "newer": os.path.basename(newer),
        "scope": "all options" if include_all else "non-autoloaded options",
        "options": [len(old), len(new)],
        "changed": [rec(*x) for x in d["changed"]],
        "added": [rec(*x) for x in d["added"]],
        "removed": [rec(*x) for x in d["removed"]],
        "autoloadOnlyChanged": [{"name": n, "autoload": [x, y]} for n, x, y in d["autoloadChanged"]],
        "transientsChanged": d["transients"],
    }
    if as_json:
        print(json.dumps(report, indent=1))
        return 0
    print("options-diff: %s -> %s (%s; %d and %d options in all)" % (report["older"], report["newer"], report["scope"], len(old), len(new)))
    print("  changed %d, added %d, removed %d, autoload only %d; transients changed %d (not listed)" % (
        len(report["changed"]), len(report["added"]), len(report["removed"]), len(report["autoloadOnlyChanged"]), report["transientsChanged"]))
    for title, key in (("CHANGED", "changed"), ("ADDED", "added"), ("REMOVED", "removed")):
        if not report[key]:
            continue
        print("\n%s" % title)
        for r in report[key]:
            tag = (" [id changed: the row was replaced]" if r["idChanged"] else "") + (" [autoload %s -> %s]" % tuple(r["autoload"]) if key == "changed" and r["autoload"][0] != r["autoload"][1] else "")
            if r["withheld"]:
                print("  %s  (secret-like: value withheld)%s" % (r["name"], tag))
            else:
                print("  %s%s" % (r["name"], tag))
                if r["old"] is not None:
                    print("      was: %s" % r["old"])
                if r["new"] is not None:
                    print("      now: %s" % r["new"])
    if report["autoloadOnlyChanged"]:
        print("\nAUTOLOAD ONLY")
        for r in report["autoloadOnlyChanged"]:
            print("  %s  %s -> %s" % (r["name"], r["autoload"][0], r["autoload"][1]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
