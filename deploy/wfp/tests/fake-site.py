#!/usr/bin/env python3
"""A stand-in for a new site behind its dispatcher, for wait-site-test.sh (#35).

  fake-site.py <port-file> <count-file> <mode>

GET /_dbping answers, by mode, for the first 2 s and then as the site (b-dosql's
own 403 "forbidden" with no spike token):
  platform-404   404 with no x-wfp-error (a new workers.dev name), then the site
  not-deployed   404 x-wfp-error not-deployed (the third day one, 2026-11-06), then the site
  no-site        404 x-wfp-error no-site (a site map read that lags), then the site
  cold-503       503, then the site
  site           the site from the first request (403)
  site-200       200 from the first request
  bad-entry      500 x-wfp-error bad-entry, always
  dispatch       502 x-wfp-error dispatch, always
  cold-dispatch  502 x-wfp-error dispatch, then the site (a first cold boot, #294)
  never          404 x-wfp-error not-deployed, always
"""
import http.server, sys, time

port_file, count_file, mode = sys.argv[1:4]
t0 = time.time()
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
        early = time.time() - t0 < 2
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
        return self.send(403, "forbidden")


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
