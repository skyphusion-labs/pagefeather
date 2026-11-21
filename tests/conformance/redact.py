#!/usr/bin/env python3
"""#1291: redact credentials from collected conformance files, in place, before they leave the box.

A failing request's dump (Axios in the WooCommerce suite, Playwright's error context) can print the site's Basic
credentials in two shapes:
  - URL userinfo:  https://admin:<password>@host/...   becomes   https://admin:***@host/...
  - an Authorization header, in any quoting:  Authorization: Basic <token>  /  'authorization': 'Basic <token>'  /
    "authorization":"Bearer <token>"   becomes   ... Basic ***  (or Bearer ***)
Usage: redact.py <file or directory>...  Directories are walked. A binary file (a NUL in its first 8 KiB, or a
zip/png/webm/jpeg/gz) is left untouched: a trace.zip cannot be redacted without rewriting it, so traces stay on the
laptop (docs/conformance.md). Prints one summary line. Exit 0, or 2 when a path is missing (a collect step must STOP).
"""
import os
import re
import sys

URL = re.compile(r"(\b[A-Za-z][A-Za-z0-9+.-]*://)([^/\s:@\"'<>]+):([^@\s\"'<>/]+)@")
AUTH = re.compile(r"(?i)(authorization[\"']?\s*[:=]\s*[\"']?\s*(?:basic|bearer)\s+)([A-Za-z0-9+/=._~-]{4,})")
BINARY_EXT = (".zip", ".png", ".webm", ".jpg", ".jpeg", ".gz", ".tgz")


def redact_text(s):
    """Returns (text, count). Only the secret part changes; a clean text comes back identical."""
    s, a = URL.subn(lambda m: m.group(1) + m.group(2) + ":***@", s)
    s, b = AUTH.subn(lambda m: m.group(1) + "***", s)
    return s, a + b


def is_binary(path):
    if path.lower().endswith(BINARY_EXT):
        return True
    with open(path, "rb") as f:
        return b"\0" in f.read(8192)


def redact_file(path):
    if is_binary(path):
        return 0
    raw = open(path, "rb").read()
    text = raw.decode("utf-8", "surrogateescape")
    out, n = redact_text(text)
    if n:
        tmp = path + ".redact-tmp"
        with open(tmp, "wb") as f:
            f.write(out.encode("utf-8", "surrogateescape"))
        os.chmod(tmp, os.stat(path).st_mode & 0o777)
        os.replace(tmp, path)
    return n


def main(argv):
    if not argv:
        print("usage: redact.py <file or directory>...", file=sys.stderr)
        return 2
    files, total, changed = 0, 0, 0
    for p in argv:
        if not os.path.exists(p):
            print("redact: STOP: no such path %s" % p, file=sys.stderr)
            return 2
        paths = [p] if os.path.isfile(p) else [os.path.join(d, n) for d, _ds, ns in os.walk(p) for n in ns]
        for f in paths:
            if os.path.islink(f) or not os.path.isfile(f):
                continue
            files += 1
            n = redact_file(f)
            total += n
            changed += 1 if n else 0
    print("redact: %d credential matches redacted in %d of %d files" % (total, changed, files))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
