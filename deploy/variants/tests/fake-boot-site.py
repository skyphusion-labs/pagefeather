#!/usr/bin/env python3
"""A stand-in for a starting c1 site and its replica bucket, for
c1-bootwatch-test.sh only (issue #103).

  fake-boot-site.py <port-file> <mode> <stop epoch>

One server answers both: GET /?nocache=... is the site (503 until it is up,
then 200), and GET /b?list-type=2 and GET /b/<key> are R2's S3 API on bucket
"b" (they need an AWS4 signature header, as R2 does; it is not checked). The
boot logs are store.boot-<epoch>.log; a line "appears" at a set time after
the server starts, so the log grows as a real one does. list-type=2 honours
prefix and start-after. Modes:
  growing        a log at <stop>+1, a line every 0.5 s; 200 after 3 s
  slow           a log at <stop>+1, a line every 1 s; 200 after 5 s
  stalled        a log at <stop>+1 with 3 lines, then none; never 200
  none           no boot log; never 200
  old-only       only a log at <stop>-1000 (an earlier start), still growing; never 200
  old-and-stalled  that old log, and a stalled log at <stop>+1; never 200
  r2-403         the list answers 403; 200 after 2 s
  r2-403-stuck   the list answers 403; never 200
"""
import http.server, sys, time, urllib.parse

port_file, mode, stop = sys.argv[1], sys.argv[2], int(sys.argv[3])
t0 = time.time()
up_after = {"growing": 3, "slow": 5, "r2-403": 2}.get(mode)
# key -> (line period in s, number of lines or None for no end)
logs = {}
if mode == "growing":
    logs["store.boot-%d.log" % (stop + 1)] = (0.5, None)
elif mode == "slow":
    logs["store.boot-%d.log" % (stop + 1)] = (1.0, None)
elif mode == "stalled":
    logs["store.boot-%d.log" % (stop + 1)] = (0.2, 3)
elif mode == "old-only":
    logs["store.boot-%d.log" % (stop - 1000)] = (0.5, None)
elif mode == "old-and-stalled":
    logs["store.boot-%d.log" % (stop - 1000)] = (0.5, None)
    logs["store.boot-%d.log" % (stop + 1)] = (0.2, 3)


def body_of(key):
    period, n = logs[key]
    have = int((time.time() - t0) / period) + 1
    if n is not None:
        have = min(have, n)
    return "".join("%.3f c1: step %d of %s\n" % (t0 + i * period, i + 1, key) for i in range(have)).encode()


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/":
            up = up_after is not None and time.time() - t0 >= up_after
            return self.send(200 if up else 503, b"ok" if up else b"starting")
        if not self.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256"):
            return self.send(403)
        if u.path == "/b":
            if mode.startswith("r2-403"):
                return self.send(403, b"<Error><Code>AccessDenied</Code></Error>", "application/xml")
            q = urllib.parse.parse_qs(u.query)
            pre, sa = q.get("prefix", [""])[0], q.get("start-after", [""])[0]
            keys = sorted(k for k in logs if k.startswith(pre) and k > sa)
            xml = "".join("<Contents><Key>%s</Key></Contents>" % k for k in keys)
            return self.send(200, ('<?xml version="1.0"?><ListBucketResult>%s</ListBucketResult>' % xml).encode(), "application/xml")
        if u.path.startswith("/b/"):
            k = urllib.parse.unquote(u.path[3:])
            if k in logs:
                return self.send(200, body_of(k))
            return self.send(404)
        return self.send(404)


s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
