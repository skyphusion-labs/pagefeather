#!/usr/bin/env python3
"""A stand-in for the Vectorize v2 index API, for search-index-test.sh (#330).

  fake-vectorize.py <port-file> <state.json>

state.json: {"indexes": ["<name>", ...], "create_status": 200, "delete_sticks": false}.
GET /vectorize/v2/indexes/<n> answers 200 or 404; POST /vectorize/v2/indexes makes the index
named in the body (or answers create_status when it is not 200); DELETE removes it, unless
delete_sticks. Every write is appended to <state.json>.writes.
"""
import http.server, json, sys

port_file, state_file = sys.argv[1], sys.argv[2]


def load():
    return json.load(open(state_file))


def save(s):
    json.dump(s, open(state_file, "w"))


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def name(self):
        return self.path.split("?")[0].rsplit("/", 1)[1]

    def do_GET(self):
        s = load()
        return self.send(200 if self.name() in s["indexes"] else 404, {"success": True})

    def log_write(self, extra=""):
        with open(state_file + ".writes", "a") as f:
            f.write("%s %s %s\n" % (self.command, self.path, extra))

    def do_POST(self):
        s = load()
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        self.log_write(json.dumps(body, sort_keys=True))
        if s.get("create_status", 200) != 200:
            return self.send(s["create_status"], {"success": False})
        s["indexes"].append(body["name"])
        save(s)
        return self.send(200, {"success": True, "result": {"name": body["name"]}})

    def do_DELETE(self):
        s = load()
        self.log_write()
        if not s.get("delete_sticks"):
            s["indexes"] = [i for i in s["indexes"] if i != self.name()]
            save(s)
        return self.send(200, {"success": True})


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(srv.server_port))
srv.serve_forever()
