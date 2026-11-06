#!/usr/bin/env python3
"""A stand-in for KV value writes, for kv-ready-test.sh (issue #35).

  fake-kv-api.py <port-file> <log-file> <mode>

PUT and DELETE /storage/kv/namespaces/<id>/values/<key>. Each request is one
line in <log-file> ("PUT <key> <code>"). Modes:
  ready         200 from the first write
  new-2s        404 code 10013 "namespace not found" for 2 s, then 200 (the
                live reading of 2026-11-06, right after the namespace was made)
  never         404 10013 for ever
  forbidden     403 (a token without KV write): not retried
  flaky-500     500 once, then 200
  delete-fails  the write is 200, the DELETE of the test key 500
"""
import http.server, json, sys, time

port_file, log_file, mode = sys.argv[1:4]
t0 = time.time()
n = {"put": 0}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
        with open(log_file, "a") as f:
            f.write("%s %s %d\n" % (self.command, self.path.rsplit("/", 1)[-1], code))

    def do_PUT(self):
        self.rfile.read(int(self.headers.get("content-length", "0")))
        n["put"] += 1
        nf = {"success": False, "errors": [{"code": 10013, "message": "get namespace: 'namespace not found'"}]}
        if mode == "never" or (mode == "new-2s" and time.time() - t0 < 2):
            return self.send(404, nf)
        if mode == "forbidden":
            return self.send(403, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]})
        if mode == "flaky-500" and n["put"] == 1:
            return self.send(500, {"success": False})
        return self.send(200, {"success": True})

    def do_DELETE(self):
        if mode == "delete-fails":
            return self.send(500, {"success": False})
        return self.send(200, {"success": True})


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
