#!/usr/bin/env python3
# Slice 7 feasibility probe (#147): the minimal container. It returns a fixed
# marker on any request, on port 8080, so a response carrying the marker proves
# the container launched. No WordPress, no state.
import http.server, socketserver

MARKER = b"c1-probe-ok\n"


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(MARKER)))
        self.end_headers()
        self.wfile.write(MARKER)

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass


with socketserver.TCPServer(("0.0.0.0", 8080), H) as httpd:
    httpd.serve_forever()
