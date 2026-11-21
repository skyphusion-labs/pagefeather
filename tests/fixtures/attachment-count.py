#!/usr/bin/env python3
"""attachment-count.py <dump.sql>: print wp_posts rows whose post_type is attachment.

The sample-store pin is a mysqldump. post_content can contain the word attachment
and commas, so this walks the INSERT tuples instead of searching for the word.
Prints unknown when wp_posts is not readable. Exits 0 either way.
"""
import re
import sys


def columns(text):
    match = re.search(r"CREATE TABLE `wp_posts` \((.*?)\) ENGINE=", text, re.S)
    if not match:
        return None
    cols = []
    for line in match.group(1).splitlines():
        line = line.strip().rstrip(",")
        if line.startswith(("PRIMARY", "UNIQUE", "KEY", "CONSTRAINT", "FULLTEXT")):
            continue
        col = re.match(r"`([^`]+)`\s+", line)
        if col:
            cols.append(col.group(1))
    return cols


def statement_end(text, start):
    i, n = start, len(text)
    in_str, esc = False, False
    while i < n:
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == "'":
                if i + 1 < n and text[i + 1] == "'":
                    i += 1
                else:
                    in_str = False
        else:
            if c == "'":
                in_str = True
            elif c == ";":
                return i
        i += 1
    return n


def tuples(blob):
    i, n = 0, len(blob)
    while i < n:
        while i < n and blob[i] in " \t\r\n,":
            i += 1
        if i >= n or blob[i] != "(":
            break
        i += 1
        fields, buf = [], []
        in_str, esc = False, False
        while i < n:
            c = blob[i]
            if in_str:
                buf.append(c)
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == "'":
                    if i + 1 < n and blob[i + 1] == "'":
                        buf.append(blob[i + 1])
                        i += 1
                    else:
                        in_str = False
            else:
                if c == "'":
                    in_str = True
                    buf.append(c)
                elif c == ",":
                    fields.append("".join(buf).strip())
                    buf = []
                elif c == ")":
                    fields.append("".join(buf).strip())
                    yield fields
                    i += 1
                    break
                else:
                    buf.append(c)
            i += 1
        else:
            break


def unquote(field):
    if len(field) >= 2 and field[0] == "'" and field[-1] == "'":
        body = field[1:-1]
        return body.replace("\\'", "'").replace("\\\\", "\\").replace("''", "'")
    return field


def count(text):
    cols = columns(text)
    if not cols or "post_type" not in cols:
        return None
    idx = cols.index("post_type")
    needle = "INSERT INTO `wp_posts`"
    total, i = 0, 0
    while True:
        j = text.find(needle, i)
        if j < 0:
            break
        k = text.find("VALUES", j)
        if k < 0 or k > j + 400:
            i = j + len(needle)
            continue
        end = statement_end(text, k)
        for fields in tuples(text[k + len("VALUES"):end]):
            if idx < len(fields) and unquote(fields[idx]) == "attachment":
                total += 1
        i = end + 1
    return total


def main(argv):
    if len(argv) != 2:
        sys.stdout.write("unknown\n")
        return 0
    try:
        with open(argv[1], encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        sys.stdout.write("unknown\n")
        return 0
    n = count(text)
    sys.stdout.write("unknown\n" if n is None else "%d\n" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
