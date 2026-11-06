#!/usr/bin/env python3
"""A stand-in for the namespace scripts API, for ns-state-test.sh (issue #35).

  fake-ns-api.py <port-file> <mode>

GET /workers/dispatch/namespaces/wp-wfp/scripts         the list
GET /workers/dispatch/namespaces/wp-wfp/scripts/<name>  one script
Modes (the list; then site-one's single GET):
  ghost        the list has site-two only; site-one answers 200, success true,
               with script id and modified null (the live readings, 2026-11-06)
  ghost-nested the same, with the list items as {"script": {"id": ...}}
  present      the list has site-one; its GET has its id
  absent       the list has site-two only; site-one answers 404 (code 10007)
  list-lags    the list still has site-one; its GET is 404 (a list that lags)
  list-500     the list answers 500
  one-500      the list has site-two only; site-one answers 500
"""
import http.server, json, sys

port_file, mode = sys.argv[1], sys.argv[2]
P = "/workers/dispatch/namespaces/wp-wfp/scripts"


def item(n):
    return {"script": {"id": n}} if mode == "ghost-nested" else {"id": n, "created_on": "2026-11-06T20:44:35Z"}


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
        path = self.path.split("?")[0]
        if path == P:
            if mode == "list-500":
                return self.send(500, {"success": False})
            names = ["site-one", "site-two"] if mode in ("present", "list-lags") else ["site-two"]
            return self.send(200, {"success": True, "result": [item(n) for n in names]})
        if path == P + "/site-one":
            if mode in ("ghost", "ghost-nested"):
                return self.send(200, {"success": True, "errors": [], "result": {"created_on": "2026-11-06T20:44:35Z", "dispatch_namespace": "wp-wfp",
                                                                               "script": {"id": None, "modified_on": None}}})
            if mode == "present":
                return self.send(200, {"success": True, "result": {"dispatch_namespace": "wp-wfp", "script": {"id": "site-one", "modified_on": "2026-11-06T20:44:35Z"}}})
            if mode == "one-500":
                return self.send(500, {"success": False})
            return self.send(404, {"success": False, "errors": [{"code": 10007, "message": "This Worker does not exist on your account."}]})
        return self.send(404, {"success": False})


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
