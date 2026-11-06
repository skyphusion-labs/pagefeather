#!/usr/bin/env python3
"""A stand-in for the Cloudflare zones and Email Sending API, for
c1-mail-config-test.sh only (issue #104).

  fake-cf-email.py <port-file> <mode>

GET /zones?name=<n> answers the zone skyphusion.org (id z1) for that name and
an empty list for any other. GET /zones/z1/email/sending/subdomains answers
by mode:
  enabled        wpmail-test.skyphusion.org, enabled
  disabled       wpmail-test.skyphusion.org, not enabled
  other          only notify.skyphusion.org, enabled
  zones-403      /zones answers 403
It needs a Bearer token, as the API does.
"""
import http.server, json, sys, urllib.parse
port_file, mode = sys.argv[1:3]


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

    def do_GET(self):
        if not self.headers.get("authorization", "").startswith("Bearer "):
            return self.send(401, {"success": False})
        u = urllib.parse.urlparse(self.path)
        if u.path == "/zones":
            if mode == "zones-403":
                return self.send(403, {"success": False})
            name = urllib.parse.parse_qs(u.query).get("name", [""])[0]
            res = [{"id": "z1", "name": "skyphusion.org"}] if name == "skyphusion.org" else []
            return self.send(200, {"success": True, "result": res})
        if u.path == "/zones/z1/email/sending/subdomains":
            subs = {"enabled": [{"name": "wpmail-test.skyphusion.org", "enabled": True, "tag": "t1"}],
                    "disabled": [{"name": "wpmail-test.skyphusion.org", "enabled": False, "tag": "t1"}],
                    "other": [{"name": "notify.skyphusion.org", "enabled": True, "tag": "t2"}]}.get(mode, [])
            return self.send(200, {"success": True, "result": subs})
        return self.send(404, {"success": False})


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
