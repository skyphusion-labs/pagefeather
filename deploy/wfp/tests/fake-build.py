#!/usr/bin/env python3
"""A stand-in for /_build and /_evict, for wait-build-test.sh (issue #35 slice 5).
  fake-build.py <port-file> <mode>
GET /_build -> {"build": "<old|new>"} by mode; GET /_evict -> flips to new (if
the mode lets it). Modes (OLD until, then NEW):
  flip-2       /_build is NEW from the 2nd poll (a normal re-upload)
  evict-only   /_build stays OLD until /_evict is called, then NEW
  never        /_build stays OLD; /_evict does not change it (abort unavailable)
It needs the x-spike-token header "t".
"""
import http.server, sys, urllib.parse

mode = sys.argv[2]
n = {"build": 0, "evicted": False}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, obj):
        import json
        b = json.dumps(obj).encode()
        self.send_response(200 if self.headers.get("x-spike-token") == "t" else 403)
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = urllib.parse.urlsplit(self.path).path
        if p == "/_evict":
            n["evicted"] = True
            return self.send({"evicting": True})
        if p == "/_build":
            n["build"] += 1
            new = (mode == "flip-2" and n["build"] >= 2) or (mode == "evict-only" and n["evicted"])
            return self.send({"build": "new" if new else "old"})
        self.send({})


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
