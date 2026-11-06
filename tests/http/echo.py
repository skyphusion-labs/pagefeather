#!/usr/bin/env python3
"""A small echo server for tests/http/http_bridge_check.py (httpbin-like).

Usage: python3 tests/http/echo.py [port]   (default 8811, on 127.0.0.1)
  /anything[...]      200, JSON: method, path, args, headers, data, form, json
  /status/<n>         that status, empty body
  /redirect/<n>       302 to /redirect/<n-1>; /redirect/0 is /anything
  /delay/<s>          waits s seconds, then /anything
  /bytes/<n>          n bytes of 'a'
  /cookies/set?k=v    200 with Set-Cookie k=v
  /response-headers?K=V  200 with those headers
Every answer carries X-Echo: yes.
"""
import json, sys, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class H(BaseHTTPRequestHandler):
    # HTTP/1.1 with keep-alive: with the default HTTP/1.0 the server closes each
    # connection, and workerd reused a closed one ("Network connection lost").
    protocol_version = "HTTP/1.1"

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if not any(k.lower() == "x-echo" for k, _ in (extra or [])):
            self.send_header("X-Echo", "yes")
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _anything(self):
        u = urllib.parse.urlsplit(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        form = dict(urllib.parse.parse_qsl(data)) if "form-urlencoded" in (self.headers.get("Content-Type") or "") else {}
        try:
            js = json.loads(data) if "json" in (self.headers.get("Content-Type") or "") else None
        except ValueError:
            js = None
        out = {"method": self.command, "path": u.path, "args": dict(urllib.parse.parse_qsl(u.query)), "headers": dict(self.headers), "data": data, "form": form, "json": js}
        self._send(200, json.dumps(out).encode())

    def route(self):
        u = urllib.parse.urlsplit(self.path)
        parts = u.path.strip("/").split("/")
        if parts[0] == "anything":
            return self._anything()
        if parts[0] == "status" and len(parts) > 1:
            return self._send(int(parts[1]))
        if parts[0] == "redirect" and len(parts) > 1:
            n = int(parts[1])
            return self._send(302, extra=[("Location", "/redirect/%d" % (n - 1) if n > 1 else "/anything")])
        if parts[0] == "delay" and len(parts) > 1:
            time.sleep(float(parts[1]))
            return self._anything()
        if parts[0] == "bytes" and len(parts) > 1:
            return self._send(200, b"a" * int(parts[1]), "application/octet-stream")
        if parts[0] == "response-headers":
            return self._send(200, b"{}", extra=urllib.parse.parse_qsl(u.query))
        if parts[0] == "cookies" and len(parts) > 1 and parts[1] == "set":
            q = urllib.parse.parse_qsl(u.query)
            return self._send(200, b"{}", extra=[("Set-Cookie", "%s=%s; Path=/" % kv) for kv in q])
        return self._send(404)

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_PATCH = route

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8811
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
