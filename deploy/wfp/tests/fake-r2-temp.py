#!/usr/bin/env python3
"""A stand-in for the Cloudflare API's R2 temporary credentials and for R2's S3 API (#273).

  fake-r2-temp.py <port-file>

API (under /api, as WFP_API):
  GET  /api/tokens/verify                     the deploy token's id, "tok-parent"
  POST /api/r2/temp-access-credentials        mint: records the body; a credential for that one bucket
S3 (path style /<bucket>/<key>), as R2 answers a temporary credential:
  the access key id is read from the AWS4 Authorization header; the request must carry
  x-amz-security-token equal to that credential's session token and name its bucket, else 403.
  An expired credential answers 403. PUT, GET, HEAD, DELETE, GET ?list-type=2.
Control:
  POST /_refuse_mint                          the next mint answers 403
  POST /_expire_after?n=<n>                   every live credential expires after n more S3 requests
  POST /_drop_puts?n=<n>                      the next n PUTs get no answer (the connection closes: curl 000)
  POST /_put_503?n=<n>                        the next n PUTs answer 503 SlowDown
  PUT  /_seed/<bucket>/<key>                  store an object with no auth
  GET  /_state                                {"mints": [...bodies], "mint_log": [[time, bucket]...], "objects": [...paths], "denied": n}
"""
import http.server, json, sys, threading, time, urllib.parse

lock = threading.Lock()
objects, creds, mints, mint_log = {}, {}, [], []
state = {"refuse_mint": False, "expire_after": None, "denied": 0, "drop_puts": 0, "put_503": 0}


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="application/octet-stream", head=False):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def api(self, method):
        u = urllib.parse.urlsplit(self.path)
        if method == "GET" and u.path == "/api/tokens/verify":
            return self.send(200, json.dumps({"success": True, "result": {"id": "tok-parent", "status": "active"}}).encode(), "application/json")
        if method == "POST" and u.path == "/api/r2/temp-access-credentials":
            b = json.loads(self.body() or b"{}")
            with lock:
                if state["refuse_mint"]:
                    state["refuse_mint"] = False
                    return self.send(403, json.dumps({"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]}).encode(), "application/json")
                mints.append(b)
                mint_log.append([round(time.time(), 3), b.get("bucket")])
                n = len(mints)
                kid, sec, tok = "tmpkey%d" % n, "tmpsecret%d" % n, "sessiontoken%d" % n
                creds[kid] = {"bucket": b.get("bucket"), "token": tok, "left": None}
            return self.send(200, json.dumps({"success": True, "result": {"accessKeyId": kid, "secretAccessKey": sec, "sessionToken": tok}}).encode(), "application/json")
        return self.send(404, b"{}", "application/json")

    def control(self, method):
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/_refuse_mint":
            state["refuse_mint"] = True; self.body(); return self.send(200)
        if u.path == "/_drop_puts":
            state["drop_puts"] = int(q["n"][0]); self.body(); return self.send(200)
        if u.path == "/_put_503":
            state["put_503"] = int(q["n"][0]); self.body(); return self.send(200)
        if u.path == "/_expire_after":
            with lock:
                for c in creds.values():
                    c["left"] = int(q["n"][0])
            self.body(); return self.send(200)
        if u.path.startswith("/_seed/"):
            objects[urllib.parse.unquote(u.path[len("/_seed"):])] = self.body(); return self.send(200)
        if u.path == "/_state":
            return self.send(200, json.dumps({"mints": mints, "mint_log": mint_log, "objects": sorted(objects), "denied": state["denied"]}).encode(), "application/json")
        return self.send(404)

    def allowed(self, bucket):
        # The access key id: the text after "Credential=" up to the first "/" (no regex: CodeQL).
        auth = self.headers.get("authorization", "")
        i = auth.find("Credential=")
        kid = auth[i + len("Credential="):].split("/", 1)[0] if i >= 0 else None
        with lock:
            c = creds.get(kid)
            ok = bool(c) and c["bucket"] == bucket and self.headers.get("x-amz-security-token") == c["token"]
            if ok and c["left"] is not None:
                if c["left"] <= 0:
                    ok = False
                else:
                    c["left"] -= 1
            if not ok:
                state["denied"] += 1
        return ok

    def s3(self, method):
        u = urllib.parse.urlsplit(self.path)
        parts = u.path.lstrip("/").split("/", 1)
        bucket, key = parts[0], (parts[1] if len(parts) > 1 else "")
        data = self.body() if method == "PUT" else b""
        if not self.allowed(bucket):
            return self.send(403, b"<Error><Code>AccessDenied</Code></Error>", "application/xml", head=method == "HEAD")
        path = "/%s/%s" % (bucket, urllib.parse.unquote(key))
        if method == "GET" and not key and "list-type=2" in u.query:
            items = "".join("<Contents><Key>%s</Key><Size>%d</Size></Contents>" % (k[len(bucket) + 2:], len(v)) for k, v in sorted(objects.items()) if k.startswith("/%s/" % bucket))
            return self.send(200, ('<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">%s<IsTruncated>false</IsTruncated></ListBucketResult>' % items).encode(), "application/xml")
        if method == "PUT":
            with lock:
                drop = state["drop_puts"] > 0
                if drop:
                    state["drop_puts"] -= 1
                busy = not drop and state["put_503"] > 0
                if busy:
                    state["put_503"] -= 1
            if drop:  # no answer at all: curl reports 000 (#545)
                self.close_connection = True
                return
            if busy:
                return self.send(503, b"<Error><Code>SlowDown</Code></Error>", "application/xml")
            objects[path] = data; return self.send(200)
        if method == "DELETE":
            objects.pop(path, None); return self.send(204)
        if path not in objects:
            return self.send(404, b"", head=method == "HEAD")
        return self.send(200, objects[path], head=method == "HEAD")

    def route(self, method):
        if self.path.startswith("/api/"):
            return self.api(method)
        if self.path.startswith("/_"):
            return self.control(method)
        return self.s3(method)

    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def do_PUT(self): self.route("PUT")
    def do_DELETE(self): self.route("DELETE")
    def do_HEAD(self): self.route("HEAD")


s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
