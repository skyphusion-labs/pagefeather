#!/usr/bin/env python3
"""A stand-in for R2's S3 API, for r2-empty-test.sh only (issue #115).

  fake-r2.py <port-file> <objects> <deny-list-s> <deny-delete-s> [delete-500]

One bucket, "b", with <objects> objects. For the first <deny-list-s> seconds
after it starts, a list answers 403; for the first <deny-delete-s> seconds, a
DELETE answers 403: a key whose new policy has not reached R2 yet (seen on
2026-11-06: the list passed, the delete got 403). With "delete-500", a DELETE
answers 500 (an error that must not be retried). It needs an AWS4 signature
header, as R2 does; it does not check it.
"""
import http.server, sys, time, urllib.parse
port_file, n, deny_list, deny_delete = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
fail500 = len(sys.argv) > 5 and sys.argv[5] == "delete-500"
t0 = time.time()
objects = {"uploads/img-%d.webp" % i for i in range(n)}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="application/xml"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        if not self.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256"):
            self.send(403)
            return False
        return True

    def do_GET(self):
        if not self.authed():
            return
        u = urllib.parse.urlsplit(self.path)
        if u.path != "/b":
            return self.send(404)
        if time.time() - t0 < deny_list:
            return self.send(403, b"<Error><Code>AccessDenied</Code></Error>")
        keys = "".join("<Contents><Key>%s</Key></Contents>" % k for k in sorted(objects)[:1000])
        return self.send(200, ('<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">%s</ListBucketResult>' % keys).encode())

    def do_DELETE(self):
        if not self.authed():
            return
        if fail500:
            return self.send(500, b"<Error><Code>InternalError</Code></Error>")
        if time.time() - t0 < deny_delete:
            return self.send(403, b"<Error><Code>AccessDenied</Code></Error>")
        k = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path.split("/", 2)[2])
        objects.discard(k)
        return self.send(204)


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
