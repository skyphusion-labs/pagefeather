#!/usr/bin/env python3
"""A stand-in for R2's S3 API, path style /<bucket>/<key>, for the rollback artifact tests (#466).

  fake-s3.py <port-file>

PUT stores the body, GET returns it or 404, DELETE removes it (204), and
GET /<bucket>?list-type=2&prefix=<p> lists the keys under <p> (ListObjectsV2, with Size).
GET /_keys lists every stored path, one per line (for the tests to read).
"""
import http.server, sys, urllib.parse
from xml.sax.saxutils import escape

store = {}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="application/octet-stream"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        n = int(self.headers.get("content-length") or 0)
        store[urllib.parse.unquote(self.path)] = self.rfile.read(n)
        self.send(200)

    def do_DELETE(self):
        store.pop(urllib.parse.unquote(self.path), None)
        self.send(204)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/_keys":
            return self.send(200, "".join(k + "\n" for k in sorted(store)).encode(), "text/plain")
        q = urllib.parse.parse_qs(u.query)
        if q.get("list-type") == ["2"]:
            b = u.path.strip("/")
            pre = "/%s/%s" % (b, q.get("prefix", [""])[0])
            items = "".join("<Contents><Key>%s</Key><Size>%d</Size></Contents>" % (escape(k[len(b) + 2:]), len(v))
                            for k, v in sorted(store.items()) if k.startswith(pre))
            x = '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">%s<IsTruncated>false</IsTruncated></ListBucketResult>' % items
            return self.send(200, x.encode(), "application/xml")
        p = urllib.parse.unquote(u.path)
        if p not in store:
            return self.send(404, b"<Error><Code>NoSuchKey</Code></Error>", "application/xml")
        self.send(200, store[p])


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
