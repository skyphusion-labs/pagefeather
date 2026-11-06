#!/usr/bin/env python3
"""A stand-in for the Cloudflare containers API, for c1-rollout-test.sh only
(issue #106).

  fake-containers-api.py <port-file> <count-file> <mode>

It answers GET /applications?name=... and GET /applications/<id>/rollouts.
The application t-store has version 7. An older rollout to version 6 is
completed in every mode, so a reader that does not match the version passes
too early. Each rollouts request is counted in <count-file>. Modes:
  done-after-3  the version 7 rollout is progressing for 2 reads, then completed
  already       completed from the first read
  never         progressing for ever
  reverted      reverted
  late          no version 7 rollout for 2 reads, then pending, then completed
  bare-list     like done-after-3, but the rollouts answer is a bare list
  api-401       every request answers 401
  no-app        no application of that name
"""
import http.server, json, sys

port_file, count_file, mode = sys.argv[1:4]
n = {"rollouts": 0}
OLD = {"id": "r6", "created_at": "2026-11-06T10:00:00Z", "target_version": 6, "current_version": 5, "status": "completed",
       "progress": {"total_steps": 1, "current_step": 1, "updated_instances": 1, "total_instances": 1}}


def rollout(status):
    return {"id": "r7", "created_at": "2026-11-06T13:07:26Z", "target_version": 7, "current_version": 6, "status": status,
            "progress": {"total_steps": 1, "current_step": 1 if status == "completed" else 0,
                         "updated_instances": 1 if status == "completed" else 0, "total_instances": 1}}


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
        if mode == "api-401":
            return self.send(401, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]})
        path = self.path.split("?")[0]
        if path == "/applications":
            apps = [] if mode == "no-app" else [{"id": "app1", "name": "t-store", "version": 7}, {"id": "app2", "name": "other-store", "version": 3}]
            return self.send(200, {"success": True, "result": apps})
        if path == "/applications/app1/rollouts":
            n["rollouts"] += 1
            open(count_file, "w").write(str(n["rollouts"]))
            k = n["rollouts"]
            if mode in ("done-after-3", "bare-list"):
                rs = [rollout("progressing" if k < 3 else "completed"), OLD]
            elif mode == "already":
                rs = [rollout("completed"), OLD]
            elif mode == "never":
                rs = [rollout("progressing"), OLD]
            elif mode == "reverted":
                rs = [rollout("reverted"), OLD]
            elif mode == "late":
                rs = [OLD] if k < 3 else [rollout("pending" if k == 3 else "completed"), OLD]
            else:
                rs = []
            return self.send(200, rs if mode == "bare-list" else {"success": True, "result": rs})
        return self.send(404, {"success": False})


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
