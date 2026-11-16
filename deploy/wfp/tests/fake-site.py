#!/usr/bin/env python3
"""A stand-in for a new site behind its dispatcher, for wait-site-test.sh (#35).

  fake-site.py <port-file> <count-file> <mode>

GET /_dbping answers, by mode, for the first EARLY requests (default 2) and then as
the site (b-dosql's own 403 "forbidden" with no spike token). By request count, not
by time (#319): the test drives a fake clock, so CPU load cannot move a case.
  platform-404   404 with no x-wfp-error (a new workers.dev name), then the site
  not-deployed   404 x-wfp-error not-deployed (the third day one, 2026-11-06), then the site
  no-site        404 x-wfp-error no-site (a site map read that lags), then the site
  cold-503       503, then the site
  site           the site from the first request (403 forbidden)
  site-200       200 from the first request
  bad-entry      500 x-wfp-error bad-entry, always
  dispatch       502 x-wfp-error dispatch, always
  cold-dispatch  502 x-wfp-error dispatch, then the site (a first cold boot, #294)
  never          404 x-wfp-error not-deployed, always
  edge-1104      403 body "error code: 1104", always (#783, a Cloudflare edge error)
  edge-1104-nl   the same, with a trailing newline
  edge-401       401 body "error code: 1104", always
  gate-401       401 body "forbidden" (the site's own gate bytes, status 401)
  edge-then-site 403 "error code: 1104" for the first EARLY requests, then the site
"""
import http.server, os, sys

port_file, count_file, mode = sys.argv[1:4]
EARLY = int(os.environ.get("EARLY", "2"))
n = {"c": 0}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, err=None):
        b = body.encode()
        self.send_response(code)
        if err:
            self.send_header("x-wfp-error", err)
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        n["c"] += 1
        open(count_file, "w").write(str(n["c"]))
        early = n["c"] <= EARLY
        if mode == "bad-entry":
            return self.send(500, "This site is not configured correctly.", "bad-entry")
        if mode == "dispatch" or (mode == "cold-dispatch" and early):
            return self.send(502, "This site did not answer.", "dispatch")
        if mode == "never" or (mode == "not-deployed" and early):
            return self.send(404, "This site is not deployed.", "not-deployed")
        if mode == "no-site" and early:
            return self.send(404, "No site at this address.", "no-site")
        if mode == "platform-404" and early:
            return self.send(404, "not found")
        if mode == "cold-503" and early:
            return self.send(503, "starting")
        if mode == "site-200":
            return self.send(200, "ok")
        # #783. Bodies and header values are constants. Nothing from the request is copied
        # into a header.
        if mode == "edge-1104" or (mode == "edge-then-site" and early):
            return self.send(403, "error code: 1104")
        if mode == "edge-1104-nl":
            return self.send(403, "error code: 1104\n")
        if mode == "edge-401":
            return self.send(401, "error code: 1104")
        if mode == "gate-401":
            return self.send(401, "forbidden")
        return self.send(403, "forbidden")


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
