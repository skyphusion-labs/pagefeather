#!/usr/bin/env python3
"""A stand-in for R2's S3 API, for tests/run.sh only: one bucket in memory.

  fake-s3.py <port-file> <log-file>

Answers GET /<bucket>?list-type=2 (200), GET and HEAD /<bucket>/<key> (404,
or 200 with the bytes and Content-Length), and PUT /<bucket>/<key> (stores
the bytes and the content type). It needs an Authorization header that starts with
"AWS4-HMAC-SHA256" (what curl --aws-sigv4 sends); it does not check the
signature. It writes the port it listens on to <port-file>, and one JSON line
per PUT to <log-file>. It tests the loop in media.sh, not R2.
"""
import http.server
import json
import sys
import urllib.parse

store = {}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def auth(self):
        if not self.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256"):
            self.send_response(403)
            self.end_headers()
            return False
        return True

    def key(self):
        return urllib.parse.unquote(urllib.parse.urlsplit(self.path).path.split("/", 2)[2])

    def do_GET(self):
        if not self.auth():
            return
        parts = urllib.parse.urlsplit(self.path).path.split("/", 2)
        if len(parts) < 3 or not parts[2]:
            self.send_response(200)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        o = store.get(self.key())
        if o is None:
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("content-length", str(o["size"]))
        self.end_headers()
        self.wfile.write(o["body"])

    def do_HEAD(self):
        if not self.auth():
            return
        k = self.key()
        if k in store:
            self.send_response(200)
            self.send_header("content-length", str(store[k]["size"]))
        else:
            self.send_response(404)
            self.send_header("content-length", "0")
        self.end_headers()

    def do_PUT(self):
        if not self.auth():
            return
        n = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(n)
        k = self.key()
        store[k] = {"size": n, "type": self.headers.get("content-type"), "body": body}
        with open(sys.argv[2], "a") as f:
            f.write(json.dumps({"key": k, "size": n, "type": store[k]["type"]}) + "\n")
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[1], "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
