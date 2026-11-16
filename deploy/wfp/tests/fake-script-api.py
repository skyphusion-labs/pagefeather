#!/usr/bin/env python3
"""A stand-in for GET /workers/scripts/<name>, for the #783 dispatcher check.

  fake-script-api.py <port-file> <mode>

  present   every GET is HTTP 200
  absent    every GET is HTTP 404

The mode comes from argv. Response headers are constants. The request path,
query and headers are never copied into a response header.
"""
import http.server
import sys

port_file, mode = sys.argv[1], sys.argv[2]


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def finish_const(self, code):
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self):
        if mode == "present":
            return self.finish_const(200)
        return self.finish_const(404)


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
