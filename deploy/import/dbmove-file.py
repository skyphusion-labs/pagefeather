#!/usr/bin/env python3
"""Make and read the dump files of spikes/b2-wordpress/dbmove.py.

  dbmove-file.py from-sqlite <in.sqlite> <out.jsonl>   SQLite file to a dump
  dbmove-file.py counts <dump.jsonl>                     rows of each table

The format is the format of dumpTo in spikes/b2-wordpress/index.js: one JSON
object on each line. First {"sql": "CREATE TABLE ..."} for each table, then
{"sql": "INSERT ...", "params": [...]} for each row, then the indexes,
triggers and views, then {"end": true, "rows": <total>}. A blob is
{"$b": "<base64>"}. Objects named sqlite_* and _cf_* are not in a dump.

from-sqlite stops with an error, and writes no file, when a TEXT value is not
UTF-8 or an integer is larger than 2^53 - 1 (JSON numbers in the Worker are
doubles, so such an integer would change). counts prints JSON: the rows of
each table, and the total of the end line.
"""
import base64
import json
import os
import sqlite3
import sys

MAX_SAFE = 2**53 - 1
OBJECTS = (
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
    "AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY rowid"
)


class Text(bytes):
    """A TEXT value, kept as bytes so a value that is not UTF-8 is found."""


def quote_id(name):
    return '"' + name.replace('"', '""') + '"'


def value(v, where):
    if isinstance(v, Text):
        try:
            return bytes(v).decode("utf-8")
        except UnicodeDecodeError:
            sys.exit(f"{where}: a TEXT value is not UTF-8")
    if isinstance(v, bytes):
        return {"$b": base64.b64encode(v).decode("ascii")}
    if isinstance(v, int) and abs(v) > MAX_SAFE:
        sys.exit(f"{where}: integer {v} is larger than 2^53 - 1")
    return v


def from_sqlite(src, out):
    if os.path.exists(out):
        sys.exit(f"{out} exists; remove it first")
    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    con.text_factory = Text
    objects = [tuple(bytes(x).decode() for x in o) for o in con.execute(OBJECTS)]
    tables = [o for o in objects if o[0] == "table"]
    tmp = out + ".part"
    total = 0
    with open(tmp, "w", encoding="utf-8") as f:
        def line(o):
            f.write(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n")

        for _, _, sql in tables:
            line({"sql": sql})
        for _, name, _ in tables:
            cur = con.execute(f"SELECT * FROM {quote_id(name)}")
            cols = [d[0] for d in cur.description]
            insert = f"INSERT INTO {quote_id(name)} ({', '.join(map(quote_id, cols))}) VALUES ({', '.join('?' * len(cols))})"
            for i, row in enumerate(cur):
                line({"sql": insert, "params": [value(v, f"{name} row {i + 1}") for v in row]})
                total += 1
        for _, _, sql in (o for o in objects if o[0] != "table"):
            line({"sql": sql})
        line({"end": True, "rows": total})
    os.replace(tmp, out)
    print(json.dumps({"tables": len(tables), "rows": total, "file": out}))


def counts(path):
    rows = {}
    end = None
    prefix = "INSERT INTO "
    with open(path, encoding="utf-8") as f:
        for raw in f:
            if not raw.strip():
                continue
            o = json.loads(raw)
            if o.get("error"):
                sys.exit(f"the dump has an error line: {o['error']}")
            if o.get("end"):
                end = o.get("rows")
                continue
            sql = o.get("sql", "")
            if sql.startswith(prefix):
                name = sql[len(prefix):].split(" (", 1)[0]
                if name.startswith('"') and name.endswith('"'):
                    name = name[1:-1].replace('""', '"')
                rows[name] = rows.get(name, 0) + 1
    if end is None:
        sys.exit("the dump has no end line")
    print(json.dumps({"rows": dict(sorted(rows.items())), "end": end}, indent=1))


def main(argv):
    if len(argv) == 4 and argv[1] == "from-sqlite":
        from_sqlite(argv[2], argv[3])
    elif len(argv) == 3 and argv[1] == "counts":
        counts(argv[2])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
