#!/usr/bin/env python3
"""Make the statements that /_sqlimport runs, from a mysqldump (issue #31).

  mysql-prepare.py <dump.sql> <out.jsonl> --prefix P --to-prefix T --flavour mysql|mariadb
      --max-statement BYTES [--old ORIGIN --new ORIGIN]

Variant a (MySQL or MariaDB through Hyperdrive) only. For each statement of
the dump:

- DROP TABLE IF EXISTS, CREATE TABLE, INSERT INTO: kept. The dump's table
  prefix P becomes the TARGET site's prefix T in the TABLE NAME only (#487: T is
  the site's own WP_TABLE_PREFIX, from /_sqlimport?info=1; a fixed wp_ would
  reach another store's tables on a shared database). Tables without the
  prefix P are skipped and listed: /_sqlimport takes only the site's tables.
- Comments, mysqldump's conditional comments ("/*!...", its session settings),
  LOCK and UNLOCK TABLES: skipped. Hyperdrive does not keep session settings
  between statements, so each INSERT carries its own sql_mode:
  SET_VAR(sql_mode='NO_AUTO_VALUE_ON_ZERO') for MySQL 8 and PlanetScale,
  SET STATEMENT sql_mode='NO_AUTO_VALUE_ON_ZERO' FOR for MariaDB. A row with
  id 0 then keeps id 0. NO_HINT=1 in the environment leaves it out: only for
  the test that shows the renumbering without it.
- Conditional comments with TRIGGER, VIEW, PROCEDURE, FUNCTION or EVENT are
  listed as not imported.
- Anything else: an error.

In INSERT values (decoded from mysqldump's escapes, then encoded again):
- with --old and --new, the site address changes (deploy/import/search-replace.py:
  safe for PHP serialized data), except in a guid column, as there;
- in <T>options, option_name <P>user_roles becomes <T>user_roles; in
  <T>usermeta, a meta_key that starts with P starts with T. The columns are
  found by name in the dump's CREATE TABLE. Nothing else changes.

An INSERT longer than --max-statement is split between rows; one row longer
than that is an error. The output is JSON lines {"sql": "..."}; a report (JSON)
goes to stdout: rows per table, statements, skipped tables, changed values.
"""
import argparse
import importlib.util
import json
import os
import re
import sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sr", os.path.join(here, "search-replace.py"))
sr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sr)

PREFIX_RE = re.compile(r"^[A-Za-z0-9_]{1,40}$")
MODE = "sql_mode='NO_AUTO_VALUE_ON_ZERO'"
HEAD_RE = re.compile(rb"^(DROP TABLE IF EXISTS|CREATE TABLE|INSERT INTO) `([^`]+)`")
DECODE = {b"0": b"\0", b"'": b"'", b'"': b'"', b"b": b"\b", b"n": b"\n", b"r": b"\r", b"t": b"\t", b"Z": b"\x1a", b"\\": b"\\", b"%": b"\\%", b"_": b"\\_"}


def fail(msg):
    sys.exit("mysql-prepare: " + msg)


def complete(buf):
    """True when buf ends with ";" outside a string (mysqldump escapes)."""
    q = None
    i = 0
    n = len(buf)
    last = None
    while i < n:
        c = buf[i:i + 1]
        if q:
            if c == b"\\":
                i += 2
                continue
            if c == q:
                if buf[i + 1:i + 2] == q:
                    i += 2
                    continue
                q = None
        elif c in (b"'", b'"', b"`"):
            q = c
        elif not c.isspace():
            last = c
        i += 1
    return q is None and last == b";"


def statements(path):
    buf = b""
    with open(path, "rb") as f:
        for line in f:
            if not buf:
                t = line.lstrip()
                if not t.strip() or t.startswith(b"-- ") or t.rstrip() == b"--" or t.startswith(b"#") or re.match(rb"(?i)(UN)?LOCK\s+TABLES\b", t):
                    continue
                if t.startswith(b"/*!") or t.startswith(b"/*M!"):
                    yield ("conditional", t)
                    continue
            buf += line
            if line.rstrip().endswith(b";") and complete(buf):
                yield ("statement", buf.strip()[:-1].rstrip())
                buf = b""
    if buf.strip():
        fail("the dump ends inside a statement: " + buf[:200].decode(errors="replace"))


def values(body):
    """Parse '(..),(..)' into rows: lists of ('s', bytes) | ('n', bytes)."""
    rows = []
    i = 0
    n = len(body)
    while i < n:
        while i < n and body[i:i + 1] in (b",", b" ", b"\n", b"\r", b"\t"):
            i += 1
        if i >= n:
            break
        if body[i:i + 1] != b"(":
            fail("expected ( in VALUES at byte %d: %r" % (i, body[i:i + 40]))
        i += 1
        row = []
        while True:
            while body[i:i + 1] in (b" ", b"\n"):
                i += 1
            c = body[i:i + 1]
            if c == b"'":
                i += 1
                out = bytearray()
                while True:
                    d = body[i:i + 1]
                    if d == b"":
                        fail("a string in VALUES does not end")
                    if d == b"\\":
                        e = body[i + 1:i + 2]
                        out += DECODE.get(e, e)
                        i += 2
                        continue
                    if d == b"'":
                        if body[i + 1:i + 2] == b"'":
                            out += b"'"
                            i += 2
                            continue
                        i += 1
                        break
                    out += d
                    i += 1
                row.append(("s", bytes(out)))
            else:
                m = re.match(rb"NULL|0x[0-9A-Fa-f]*|[-+]?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?", body[i:])
                if not m:
                    fail("a value that is not a literal at byte %d: %r (make the dump with --hex-blob)" % (i, body[i:i + 40]))
                row.append(("n", m.group(0)))
                i += len(m.group(0))
            while body[i:i + 1] == b" ":
                i += 1
            c = body[i:i + 1]
            if c == b",":
                i += 1
                continue
            if c == b")":
                i += 1
                break
            fail("expected , or ) in VALUES at byte %d: %r" % (i, body[i:i + 40]))
        rows.append(row)
    return rows


def encode(v):
    kind, b = v
    if kind == "n":
        return b
    b = b.replace(b"\\", b"\\\\").replace(b"'", b"\\'").replace(b"\0", b"\\0").replace(b"\n", b"\\n").replace(b"\r", b"\\r").replace(b"\x1a", b"\\Z")
    return b"'" + b + b"'"


def create_strings(st):
    """CREATE TABLE with no backslash in its strings (sql-import.js refuses one:
    with a backslash the server's sql_mode, NO_BACKSLASH_ESCAPES, decides what it
    means). A string after DEFAULT becomes a hex literal, which every mode reads
    the same (Wordfence: binary(16) DEFAULT '\\0...'). Another string with an
    escape is written again with '' for a quote; with a backslash or a control
    byte left after decoding, it is an error. Double-quoted strings: an error."""
    out = bytearray()
    i = 0
    n = len(st)
    while i < n:
        c = st[i:i + 1]
        if c == b"`":
            j = st.index(b"`", i + 1)
            out += st[i:j + 1]
            i = j + 1
            continue
        if c == b'"':
            fail("a double-quoted string in CREATE TABLE: " + st[:80].decode(errors="replace"))
        if c != b"'":
            out += c
            i += 1
            continue
        j = i + 1
        raw = bytearray()
        escaped = False
        while True:
            d = st[j:j + 1]
            if d == b"":
                fail("a string in CREATE TABLE does not end")
            if d == b"\\":
                e = st[j + 1:j + 2]
                raw += DECODE.get(e, e)
                escaped = True
                j += 2
                continue
            if d == b"'":
                if st[j + 1:j + 2] == b"'":
                    raw += b"'"
                    j += 2
                    continue
                break
            raw += d
            j += 1
        if not escaped:
            out += st[i:j + 1]
        elif re.search(rb"DEFAULT\s*$", bytes(out)):
            out += b"0x" + bytes(raw).hex().upper().encode()
        elif b"\\" in raw or re.search(rb"[\x00-\x1f]", bytes(raw)):
            fail("a string in CREATE TABLE with a backslash or a control byte: " + st[:80].decode(errors="replace"))
        else:
            out += b"'" + bytes(raw).replace(b"'", b"''") + b"'"
        i = j + 1
    return bytes(out)


def columns(create):
    return [m.group(1).decode() for m in re.finditer(rb"^\s+`([^`]+)` ", create, re.M)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dump")
    ap.add_argument("out")
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--to-prefix", required=True, help="the target site's WP_TABLE_PREFIX (/_sqlimport?info=1)")
    ap.add_argument("--flavour", required=True, choices=("mysql", "mariadb"))
    ap.add_argument("--max-statement", type=int, required=True)
    ap.add_argument("--old")
    ap.add_argument("--new")
    a = ap.parse_args()
    if a.max_statement < 4096:
        fail("--max-statement is too small")
    if not PREFIX_RE.match(a.to_prefix):
        fail("--to-prefix must be 1 to 40 of A-Z a-z 0-9 _")
    NEW = a.to_prefix
    old = a.prefix.encode()
    rep = sr.Replacer(a.old, a.new) if a.old and a.new else None
    if os.environ.get("NO_HINT") == "1":
        head = lambda t: b"INSERT INTO `" + t + b"` VALUES "
    elif a.flavour == "mysql":
        head = lambda t: b"INSERT /*+ SET_VAR(" + MODE.encode() + b") */ INTO `" + t + b"` VALUES "
    else:
        head = lambda t: b"SET STATEMENT " + MODE.encode() + b" FOR INSERT INTO `" + t + b"` VALUES "
    cols = {}
    rows = {}
    skipped = {}
    objects = []
    changed = {"address": 0, "user_roles": 0, "usermeta_keys": 0}
    out = []
    for kind, st in statements(a.dump):
        if kind == "conditional":
            m = re.search(rb"\b(TRIGGER|VIEW|PROCEDURE|FUNCTION|EVENT)\b", st)
            if m and m.group(1) not in (b"VIEW",) or (m and b"CREATE" in st):
                objects.append(st[:120].decode(errors="replace"))
            continue
        m = HEAD_RE.match(st)
        if not m:
            fail("a statement that is not DROP TABLE IF EXISTS, CREATE TABLE or INSERT INTO: " + st[:120].decode(errors="replace"))
        verb, table = m.group(1), m.group(2)
        if not table.startswith(old):
            skipped[table.decode()] = skipped.get(table.decode(), 0) + 1
            continue
        new_table = NEW.encode() + table[len(old):]
        rest = st[m.end():]
        if verb == b"DROP TABLE IF EXISTS":
            if rest.strip():
                fail("DROP TABLE with more than one table: " + st[:120].decode(errors="replace"))
            out.append(b"DROP TABLE IF EXISTS `" + new_table + b"`")
        elif verb == b"CREATE TABLE":
            cols[new_table.decode()] = columns(st)
            out.append(create_strings(b"CREATE TABLE `" + new_table + b"`" + rest))
        else:
            if not rest.startswith(b" VALUES "):
                fail("INSERT with a column list or no VALUES: " + st[:120].decode(errors="replace"))
            t = new_table.decode()
            names = cols.get(t)
            if names is None:
                fail(f"INSERT into {t} before its CREATE TABLE")
            key = None
            if t == NEW + "options" and "option_name" in names and old != NEW.encode():
                key = ("user_roles", names.index("option_name"))
            if t == NEW + "usermeta" and "meta_key" in names and old != NEW.encode():
                key = ("usermeta_keys", names.index("meta_key"))
            parsed = values(rest[len(b" VALUES "):])
            enc_rows = []
            for row in parsed:
                if len(row) != len(names):
                    fail(f"a row of {t} has {len(row)} values, its table {len(names)} columns")
                if rep:
                    for j, v in enumerate(row):
                        if v[0] == "s" and names[j].lower() != "guid":
                            nv = rep.value(v[1])
                            if nv != v[1]:
                                row[j] = ("s", nv)
                                changed["address"] += 1
                if key:
                    what, j = key
                    v = row[j]
                    if v[0] == "s" and ((what == "user_roles" and v[1] == old + b"user_roles") or (what == "usermeta_keys" and v[1].startswith(old))):
                        row[j] = ("s", NEW.encode() + v[1][len(old):])
                        changed[what] += 1
                enc_rows.append(b"(" + b",".join(encode(v) for v in row) + b")")
            rows[t] = rows.get(t, 0) + len(enc_rows)
            h = head(new_table)
            batch = []
            size = len(h)
            for r in enc_rows:
                if len(h) + len(r) > a.max_statement:
                    fail(f"one row of {t} is {len(r)} bytes: more than --max-statement {a.max_statement}")
                if batch and size + 1 + len(r) > a.max_statement:
                    out.append(h + b",".join(batch))
                    batch, size = [], len(h)
                batch.append(r)
                size += len(r) + 1
            if batch:
                out.append(h + b",".join(batch))
    tmp = a.out + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        for st in out:
            try:
                s = st.decode("utf-8")
            except UnicodeDecodeError:
                fail("a statement is not UTF-8: " + st[:80].decode(errors="replace"))
            f.write(json.dumps({"sql": s}, ensure_ascii=False) + "\n")
    os.replace(tmp, a.out)
    print(json.dumps({"statements": len(out), "rows": dict(sorted(rows.items())), "skipped_tables": skipped, "not_imported": objects, "changed": changed, "hint": os.environ.get("NO_HINT") != "1", "flavour": a.flavour}, indent=1))


if __name__ == "__main__":
    main()
