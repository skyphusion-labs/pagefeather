#!/usr/bin/env python3
"""A stand-in for a c1 site, for c1-check-test.sh only (issue #99).

  fake-c1-site.py <port-file> <mode>

It answers the paths that deploy/variants/c1.sh c1_check uses. The container
behind it is "old" (php -S: /_stats.php what=info says cli-server, and
/_fpm-ping is a WordPress 301) or "new" (fpm-fcgi, /_fpm-ping 200 "pong").
Modes:
  new           new from the start
  old-then-new  old until a POST /_store-stop, then new
  old-forever   old, and a stop does not change it
  php-stuck     new, but /_fpm-ping does not answer (504): no free child
/_boot.txt and / always answer 200, /_store-info always says current.
"""
import http.server, json, sys

mode = sys.argv[2]
state = {"new": mode in ("new", "php-stuck"), "stops": 0}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="text/plain", extra=None):
        self.send_response(code)
        self.send_header("content-type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/_boot.txt" or p == "/":
            return self.send(200, b"ok")
        if p == "/_store-info":
            return self.send(200, json.dumps({"current": True, "do_version": "v1", "worker_version": "v1"}).encode(), "application/json")
        if p == "/_stats.php":
            return self.send(200, json.dumps({"sapi": "fpm-fcgi" if state["new"] else "cli-server", "drop_in": True}).encode(), "application/json")
        if p == "/_fpm-ping":
            if not state["new"]:
                return self.send(301, b"", extra={"location": "/_fpm-ping/"})
            if mode == "php-stuck":
                return self.send(504, b"timeout")
            return self.send(200, b"pong")
        return self.send(404)

    def do_POST(self):
        if self.path.split("?")[0] == "/_store-stop":
            state["stops"] += 1
            if mode == "old-then-new":
                state["new"] = True
            return self.send(200, json.dumps({"ok": True, "still_running": False, "reset": True}).encode(), "application/json")
        return self.send(404)


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
