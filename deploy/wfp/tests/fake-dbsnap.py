#!/usr/bin/env python3
"""A stand-in for a site's DB export/import and its R2 bucket, for
dbsnap-test.sh (issue #35 slice 5).

  fake-dbsnap.py <port-file> <mode>

GET  /_dbexport                 ndjson rows (by mode), or a non-200
POST /_dbimport?replace=1|append=1   records the part; 413 over 2 MiB (the site's MAX_BODY_BYTES)
GET  /_parts                    the parts received: [[query, lines, bytes], ...]
PUT  /<bucket>/_snapshots/<k>   stores the bytes (unless truncate: stores short)
GET  /<bucket>/_snapshots/<k>   the stored bytes (needs an AWS4 header)
GET  /_dbcounts                 per-table row counts of what /_dbimport applied (as the site's)
Modes: ok; big (about 4 MB, a real store's size); export-empty; export-500; readback-truncate; put-500; import-error.
#515, on the big export, at the 7th part of a pass (index 6; the index counts applied parts, so a
retried part keeps its index): big-502once (502 once, not applied), big-502always (always 502),
big-502applied (applied, then 502 once: a resend would put its rows twice), big-502once-nocounts
(502 once, and /_dbcounts answers 404, as an older build would).
tables-502once and tables-502applied: the export is the site's shape (CREATE TABLE with quoted
names first, then the rows of "wp_a", then of "wp_b"), sized so that the FIRST rows of "wp_b" are
in part 6 (DBIMPORT_PART_BYTES=4096). As on the site, a CREATE makes an empty table that
/_dbcounts reports as 0. The pf512 live run, 2026-11-14, found that case. tables-502once-livewrite:
502 once at part 6, and a visitor's write puts one row in "wp_b" as it answers (neither count).
"""
import http.server, sys, urllib.parse

mode = sys.argv[2]
store = {}
parts = []
db = {"rows": {}, "applied": 0, "fired": False}
FAULT_PART = 6
# The site's dump shape for the tables-* modes: lines of one length, so a 4096-byte part holds
# exactly PER lines, and "wp_b" starts on the first line of part 6 (part 0 also holds the CREATEs).
import json as _json
def _row(t, i):
    return (_json.dumps({"sql": 'INSERT INTO "%s" ("v") VALUES (?)' % t, "params": ["%s-%06d" % (t, i) + "x" * 40]}) + "\n").encode()
_L = len(_row("wp_a", 0)); PER = 4096 // _L
_CREATES = b"".join((_json.dumps({"sql": 'CREATE TABLE "%s" ("v" TEXT)' % t}) + "\n").encode() for t in ("wp_a", "wp_b"))
_first = PER - (len(_CREATES) + _L - 1) // _L   # rows of wp_a that fit in part 0 beside the CREATEs
TABLES = _CREATES + b"".join(_row("wp_a", i) for i in range(_first + PER * 5)) + b"".join(_row("wp_b", i) for i in range(PER * 3))


def apply_part(body):
    import json, re
    for line in body.splitlines():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        sql = str(o.get("sql") or "")
        c = re.match(r'^CREATE TABLE\s+"?([A-Za-z0-9_]+)"?', sql)
        if c:
            db["rows"].setdefault(c.group(1), 0)   # as the site: an empty table counts 0
        m = re.match(r'^INSERT INTO\s+"?([A-Za-z0-9_]+)"?', sql)
        if m:
            db["rows"][m.group(1)] = db["rows"].get(m.group(1), 0) + 1
    db["applied"] += 1
MAX_BODY = 2 * 1024 * 1024
ROWS = b'{"t":"wp_options","r":1}\n{"t":"wp_options","r":2}\n{"t":"wp_posts","r":1}\n'
BIG = b"".join(b'{"sql":"INSERT INTO wp_postmeta VALUES (?)","params":["%s"]}\n' % (b"x" * 64 + str(i).encode()) for i in range(40000))


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="application/x-ndjson"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urllib.parse.urlsplit(self.path).path
        if p == "/_parts":
            import json
            return self.send(200, json.dumps(parts).encode(), "application/json")
        if p == "/_dbcounts":
            import json
            if mode == "big-502once-nocounts":
                return self.send(404, b"no")
            return self.send(200, json.dumps({"rows": db["rows"]}).encode(), "application/json")
        if p == "/_dbexport":
            if mode == "export-500":
                return self.send(500, b"err")
            if mode == "export-empty":
                return self.send(200, b"\n  \n")
            if mode.startswith("big"):
                return self.send(200, BIG)
            if mode.startswith("tables"):
                return self.send(200, TABLES)
            return self.send(200, ROWS)
        if "/_snapshots/" in p:
            if not self.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256"):
                return self.send(403, b"<Error/>", "application/xml")
            v = store.get(p)
            return self.send(200 if v is not None else 404, v or b"")
        return self.send(404, b"no")

    def do_PUT(self):
        p = urllib.parse.urlsplit(self.path).path
        n = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(n)
        if not self.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256"):
            return self.send(403, b"<Error/>", "application/xml")
        if mode == "put-500":
            return self.send(500, b"<Error/>", "application/xml")
        store[p] = body[:-10] if mode == "readback-truncate" else body
        self.send(200, b"")

    def do_POST(self):
        p = urllib.parse.urlsplit(self.path).path
        n = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(n)
        if p == "/_dbimport":
            if n > MAX_BODY:
                return self.send(413, b"request body too large", "text/plain")
            parts.append([urllib.parse.urlsplit(self.path).query, body.count(b"\n"), n])
            if mode == "import-error":
                return self.send(400, b'{"ok": false, "error": "bad"}', "application/json")
            if "replace=1" in urllib.parse.urlsplit(self.path).query:
                db["rows"], db["applied"] = {}, 0
            at = db["applied"] == FAULT_PART
            if at and mode == "big-502always":
                return self.send(502, b"error code: 502\n", "text/plain")
            if at and mode in ("big-502once", "big-502once-nocounts", "tables-502once", "tables-502once-livewrite") and not db["fired"]:
                db["fired"] = True
                if mode == "tables-502once-livewrite":
                    db["rows"]["wp_b"] = db["rows"].get("wp_b", 0) + 1
                return self.send(502, b"error code: 502\n", "text/plain")
            apply_part(body)
            if at and mode in ("big-502applied", "tables-502applied") and not db["fired"]:
                db["fired"] = True
                return self.send(502, b"error code: 502\n", "text/plain")
            return self.send(200, b'{"ok": true, "rows": 3}', "application/json")
        self.send(404, b"no")


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
