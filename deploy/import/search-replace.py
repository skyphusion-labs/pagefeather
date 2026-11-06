#!/usr/bin/env python3
"""Change the site address in a WordPress SQLite file, safe for serialized data.

  search-replace.py <file.sqlite> <old-origin> <new-origin> [--dry-run]

An origin is scheme://host[:port], with no path. The script replaces the old
host with both schemes (http:// and https://) by the new origin, and also the
JSON form with "\\/" (block attributes and page builders keep URLs so). A host
that goes on (old.example.com.other.net) or has another port is not changed.

PHP serialized values are changed in place: the length of each changed string
is written again, as WP Migrate and "wp search-replace" do. A string in a
serialized value can hold a serialized value; that one is changed the same way.
A "C:" value (custom serialization) is not changed and is counted as skipped.
A value that is not serialized gets a plain replace.

Not changed: the guid column (WordPress uses it as an identifier), the
_wp_sqlite_* tables of the driver, and BLOB values. The script prints JSON:
changed rows per table and column, and the skipped values.
"""
import json
import re
import sqlite3
import sys

ORIGIN_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$")


class NotSerialized(Exception):
    pass


class Replacer:
    def __init__(self, old_origin, new_origin):
        host = old_origin.split("://", 1)[1]
        new = new_origin.encode()
        self.pairs = []
        for scheme in ("https", "http"):
            old = f"{scheme}://{host}".encode()
            for o, n in ((old, new), (old.replace(b"/", b"\\/"), new.replace(b"/", b"\\/"))):
                # Not when the host goes on (old.example.com.other.net).
                self.pairs.append((re.compile(re.escape(o) + rb"(?![A-Za-z0-9.:-])"), n))
        self.needle = host.encode()
        self.skipped = 0

    def plain(self, b):
        for old, new in self.pairs:
            b = old.sub(lambda m: new, b)
        return b

    def value(self, b):
        """The changed bytes of one value, serialized or not."""
        if self.needle not in b:
            return b
        try:
            out, end = self.walk(b, 0)
            if end == len(b):
                return out
        except (NotSerialized, IndexError, ValueError):
            pass
        return self.plain(b)

    def walk(self, b, i):
        """Parse one serialized item at i. Returns (new bytes, end index)."""
        t = b[i:i + 2]
        if t == b"N;":
            return b"N;", i + 2
        if t in (b"b:", b"i:", b"d:", b"r:", b"R:"):
            end = b.index(b";", i) + 1
            body = b[i + 2:end - 1]
            if t == b"b:" and body not in (b"0", b"1"):
                raise NotSerialized
            if t in (b"i:", b"r:", b"R:") and not re.fullmatch(rb"-?[0-9]+", body):
                raise NotSerialized
            if t == b"d:" and not re.fullmatch(rb"-?([0-9.]+(E[+-]?[0-9]+)?|INF|NAN)", body):
                raise NotSerialized
            return b[i:end], end
        if t in (b"s:", b"E:"):
            colon = b.index(b":", i + 2)
            n = int(b[i + 2:colon])
            start = colon + 2
            if b[colon + 1:start] != b'"' or b[start + n:start + n + 2] != b'";':
                raise NotSerialized
            payload = b[start:start + n]
            if t == b"s:":
                payload = self.value(payload)
            return t + str(len(payload)).encode() + b':"' + payload + b'";', start + n + 2
        if t == b"a:":
            colon = b.index(b":", i + 2)
            count = int(b[i + 2:colon])
            if b[colon + 1:colon + 2] != b"{":
                raise NotSerialized
            return self.items(b, i, colon + 2, count * 2)
        if t == b"O:":
            colon = b.index(b":", i + 2)
            n = int(b[i + 2:colon])
            j = colon + 2 + n  # after the class name
            if b[j:j + 2] != b'":':
                raise NotSerialized
            colon2 = b.index(b":", j + 2)
            count = int(b[j + 2:colon2])
            if b[colon2 + 1:colon2 + 2] != b"{":
                raise NotSerialized
            return self.items(b, i, colon2 + 2, count * 2)
        if t == b"C:":
            colon = b.index(b":", i + 2)
            n = int(b[i + 2:colon])
            j = colon + 2 + n
            colon2 = b.index(b":", j + 2)
            m = int(b[j + 2:colon2])
            end = colon2 + 2 + m + 1
            if b[end - 1:end] != b"}":
                raise NotSerialized
            if self.needle in b[i:end]:
                self.skipped += 1
            return b[i:end], end
        raise NotSerialized

    def items(self, b, i, body, n):
        """n items from body, then "}". The head b[i:body] is kept."""
        parts = [b[i:body]]
        j = body
        for _ in range(n):
            out, j = self.walk(b, j)
            parts.append(out)
        if b[j:j + 1] != b"}":
            raise NotSerialized
        parts.append(b"}")
        return b"".join(parts), j + 1


def qid(name):
    return '"' + name.replace('"', '""') + '"'


def run(path, old_origin, new_origin, dry_run):
    for o in (old_origin, new_origin):
        if not ORIGIN_RE.match(o):
            sys.exit(f"not an origin (scheme://host[:port], no path): {o!r}")
    r = Replacer(old_origin, new_origin)
    con = sqlite3.connect(path)
    con.text_factory = bytes
    tables = [bytes(n).decode() for (n,) in con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
        "AND name NOT LIKE '\\_wp\\_sqlite\\_%' ESCAPE '\\' ORDER BY name")]
    changed = {}
    for t in tables:
        cols = [bytes(c[1]).decode() for c in con.execute(f"PRAGMA table_info({qid(t)})")]
        for c in cols:
            if c.lower() == "guid":
                continue
            rows = con.execute(
                f"SELECT rowid, {qid(c)} FROM {qid(t)} WHERE typeof({qid(c)}) = 'text' AND instr({qid(c)}, ?) > 0",
                (r.needle.decode(),)).fetchall()
            n = 0
            for rowid, v in rows:
                new = r.value(bytes(v))
                if new != v:
                    n += 1
                    if not dry_run:
                        con.execute(f"UPDATE {qid(t)} SET {qid(c)} = ? WHERE rowid = ?", (new.decode("utf-8"), rowid))
            if n:
                changed[f"{t}.{c}"] = n
    if not dry_run:
        con.commit()
    con.close()
    print(json.dumps({"dry_run": dry_run, "changed": changed, "skipped_custom_serialized": r.skipped}, indent=1))


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if x != "--dry-run"]
    if len(a) != 3:
        sys.exit(__doc__)
    run(a[0], a[1], a[2], "--dry-run" in sys.argv)
