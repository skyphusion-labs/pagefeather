#!/usr/bin/env python3
"""A stand-in for R2's S3 API, path style /<bucket>/<key>, for the rollback artifact tests (#466).

  fake-s3.py <port-file>

PUT stores the body, GET returns it or 404, DELETE removes it (204), and
GET /<bucket>?list-type=2&prefix=<p> lists the keys under <p> (ListObjectsV2, with ETag and Size).
It pages as S3 and R2 do (#525): at most max-keys keys (default and cap 1000) a page, in key order,
with IsTruncated and, when true, NextContinuationToken; continuation-token resumes after it.
GET /_keys lists every stored path, one per line (for the tests to read).
POST /_fail_page/<n>: the n-th list request from now answers 500 (once).
POST /_truncate_no_token: the next list page that is truncated gives no NextContinuationToken.
"""
import base64, hashlib, http.server, sys, urllib.parse
from xml.sax.saxutils import escape

store = {}
ctl = {"fail_in": 0, "no_token": False}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="application/octet-stream"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        p = urllib.parse.urlsplit(self.path).path
        if p.startswith("/_fail_page/"):
            ctl["fail_in"] = int(p.rsplit("/", 1)[1]); return self.send(200)
        if p == "/_truncate_no_token":
            ctl["no_token"] = True; return self.send(200)
        self.send(404)

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
            if ctl["fail_in"] > 0:
                ctl["fail_in"] -= 1
                if ctl["fail_in"] == 0:
                    return self.send(500, b"<Error><Code>InternalError</Code></Error>", "application/xml")
            b = u.path.strip("/")
            pre = "/%s/%s" % (b, q.get("prefix", [""])[0])
            keys = sorted(k for k in store if k.startswith(pre))
            after = q.get("continuation-token", [""])[0]
            if after:
                after = base64.urlsafe_b64decode(after.encode()).decode()
                keys = [k for k in keys if k > after]
            n = min(1000, int(q.get("max-keys", ["1000"])[0]))
            page, more = keys[:n], len(keys) > n
            items = "".join("<Contents><Key>%s</Key><ETag>&quot;%s&quot;</ETag><Size>%d</Size></Contents>" % (
                escape(k[len(b) + 2:]), hashlib.md5(store[k]).hexdigest(), len(store[k])) for k in page)
            tail = "<IsTruncated>%s</IsTruncated>" % ("true" if more else "false")
            if more and not ctl["no_token"]:
                tail += "<NextContinuationToken>%s</NextContinuationToken>" % base64.urlsafe_b64encode(page[-1].encode()).decode()
            elif more:
                ctl["no_token"] = False
            x = '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">%s%s</ListBucketResult>' % (items, tail)
            return self.send(200, x.encode(), "application/xml")
        p = urllib.parse.unquote(u.path)
        if p not in store:
            return self.send(404, b"<Error><Code>NoSuchKey</Code></Error>", "application/xml")
        self.send(200, store[p])


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
