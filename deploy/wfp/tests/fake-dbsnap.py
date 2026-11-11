#!/usr/bin/env python3
"""A stand-in for a site's DB export/import and its R2 bucket, for
dbsnap-test.sh (issue #35 slice 5).

  fake-dbsnap.py <port-file> <mode>

GET  /_dbexport                 ndjson rows (by mode), or a non-200
POST /_dbimport?replace=1|append=1   records the part; 413 over 2 MiB (the site's MAX_BODY_BYTES)
GET  /_parts                    the parts received: [[query, lines, bytes], ...]
PUT  /<bucket>/_snapshots/<k>   stores the bytes (unless truncate: stores short)
GET  /<bucket>/_snapshots/<k>   the stored bytes (needs an AWS4 header)
Modes: ok; big (about 4 MB, a real store's size); export-empty; export-500; readback-truncate; put-500; import-error.
"""
import http.server, sys, urllib.parse

mode = sys.argv[2]
store = {}
parts = []
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
        if p == "/_dbexport":
            if mode == "export-500":
                return self.send(500, b"err")
            if mode == "export-empty":
                return self.send(200, b"\n  \n")
            if mode == "big":
                return self.send(200, BIG)
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
            return self.send(200, b'{"ok": true, "rows": 3}', "application/json")
        self.send(404, b"no")


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
