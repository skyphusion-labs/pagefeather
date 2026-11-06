#!/usr/bin/env python3
"""A stand-in for the Cloudflare containers API, for c1-rollout-test.sh only
(issue #106).

  fake-containers-api.py <port-file> <count-file> <mode>

It answers GET /applications?name=..., GET /applications/<id> and
GET /applications/<id>/rollouts.
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
  new-app       a new application: version 1, health 1 healthy, and NO rollout
                at all (measured on wp-c1-live, 2026-11-06)
  v2-empty      version 2 with an empty rollout list for 2 reads (its rollout
                is not created yet), then progressing, then completed
  stale-list    the list says version 1, the single GET /applications/app1
                says 2 (the list was stale on 2026-11-06), and the rollout
                1 -> 2 is progressing for 2 reads, then completed
  stale-list-empty  the same, but no rollout for 2 reads (a new site's second
                deploy): the list's version 1 must not count as "placed"
  replaced-then-newer  the version 2 rollout reads "replaced" for 2 reads,
                then the application is at version 3, whose rollout is
                completed (seen live on wp-c1-live, 2026-11-06)
  replaced-stuck  version 2, and its only rollout reads "replaced" for ever
  moves-at-completion  the readings of wp-c1-w92b (2026-11-06, issue #126):
                the application stays at version 2 while "2 -> 3" is
                progressing (100 % on the new version) for 7 reads and
                "1 -> 2" reads replaced; on read 8 the application is at 3
                and "2 -> 3" is completed
  follow-reverted  the same start, but "2 -> 3" is reverted
  live-shape    the shape read from the live API on 2026-11-06 (#106): the
                applications answer has result_info, the applications have no
                active_rollout_id, the rollouts are newest first, older ones
                are "replaced", and progress has a version_distribution. The
                version 7 rollout is progressing for 2 reads, then completed.
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
        if path == "/applications/app1":
            # The single GET: the CURRENT version (in the stale modes the list
            # still says 1).
            apps = self.apps()
            if not apps:
                return self.send(404, {"success": False})
            a = dict(apps[0])
            if mode in ("stale-list", "stale-list-empty", "replaced-stuck"):
                a["version"] = 2
            if mode == "replaced-then-newer":
                a["version"] = 2 if n["rollouts"] < 2 else 3
            if mode == "moves-at-completion":
                a["version"] = 2 if n["rollouts"] < 7 else 3
            if mode == "follow-reverted":
                a["version"] = 2
            return self.send(200, {"errors": [], "messages": [], "result": a, "success": True})
        if path == "/applications":
            return self.send(*self.list_answer())
        if path == "/applications/app1/rollouts":
            return self.send(*self.rollouts_answer())
        return self.send(404, {"success": False})

    def apps(self):
        return self.list_answer()[1]["result"] if mode != "no-app" else []

    def list_answer(self):
        if True:
            apps = [] if mode == "no-app" else [{"id": "app1", "name": "t-store", "version": 7}, {"id": "app2", "name": "other-store", "version": 3}]
            if mode in ("stale-list", "stale-list-empty"):
                # The list is stale: it still says version 1 (measured 2026-11-06).
                apps = [{"id": "app1", "name": "t-store", "version": 1,
                         "health": {"instances": {"active": 0, "healthy": 1, "failed": 0, "starting": 0, "scheduling": 0}}}]
                return 200, {"errors": [], "messages": [], "result": apps, "result_info": {"count": 1}, "success": True}
            if mode in ("new-app", "v2-empty"):
                v = 1 if mode == "new-app" else 2
                apps = [{"id": "app1", "name": "t-store", "version": v,
                         "health": {"instances": {"active": 0, "healthy": 1, "failed": 0, "starting": 0, "scheduling": 0}}}]
                return 200, {"errors": [], "messages": [], "result": apps, "result_info": {"count": 1}, "success": True}
            if mode == "live-shape":
                keys = {"account_id": "acc", "configuration": {}, "constraints": {}, "created_at": "2026-11-05T19:00:00Z", "durable_objects": {},
                        "health": {}, "instances": 1, "max_instances": 1, "network": {}, "rollout_active_grace_period": 0,
                        "scheduling_policy": "default", "updated_at": "2026-11-06T13:07:26Z"}
                apps = [dict(a, **keys) for a in apps]
                return 200, {"errors": [], "messages": [], "result": apps, "result_info": {"count": 2}, "success": True}
            return 200, {"success": True, "result": apps}

    def rollouts_answer(self):
        if True:
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
            elif mode == "live-shape":
                def live(v, status, created):
                    done = status in ("completed", "replaced")
                    return {"id": "r%d" % v, "created_at": created, "last_updated_at": created, "description": "", "kind": "full_auto",
                            "strategy": "rolling", "current_version": v - 1, "target_version": v, "status": status, "health": {},
                            "steps": [], "current_configuration": {}, "target_configuration": {},
                            "progress": {"total_steps": 1, "current_step": 1 if done else 0, "updated_instances": 1 if done else 0,
                                         "total_instances": 1, "version_distribution": {"target_version_instances": 1 if done else 0,
                                         "current_version_instances": 0 if done else 1, "target_version_percentage": 100 if done else 0}}}
                rs = [live(7, "progressing" if k < 3 else "completed", "2026-11-06T13:07:26Z"),
                      live(6, "replaced", "2026-11-06T12:35:41Z"), live(5, "replaced", "2026-11-06T12:31:30Z")]
            elif mode == "new-app":
                rs = []
            elif mode == "v2-empty":
                r2 = dict(rollout("progressing" if k == 3 else "completed"), target_version=2, current_version=1, id="r2")
                rs = [] if k < 3 else [r2]
            elif mode in ("stale-list", "stale-list-empty"):
                r2 = lambda st: dict(rollout(st), target_version=2, current_version=1, id="r2")
                if mode == "stale-list":
                    rs = [r2("progressing" if k < 3 else "completed")]
                else:
                    rs = [] if k < 3 else [r2("progressing" if k == 3 else "completed")]
            elif mode in ("replaced-then-newer", "replaced-stuck"):
                r2 = dict(rollout("completed"), target_version=2, current_version=1, id="r2", status="replaced")
                r3 = dict(rollout("completed"), target_version=3, current_version=2, id="r3", created_at="2026-11-06T14:40:00Z")
                rs = [r3, r2] if (mode == "replaced-then-newer" and k > 2) else [r2]
            elif mode in ("moves-at-completion", "follow-reverted"):
                r2 = dict(rollout("completed"), target_version=2, current_version=1, id="r2", status="replaced", created_at="2026-11-06T19:05:44Z")
                st = "reverted" if mode == "follow-reverted" else ("progressing" if k < 8 else "completed")
                r3 = dict(rollout(st), target_version=3, current_version=2, id="r3", created_at="2026-11-06T19:17:39Z")
                r3["progress"] = dict(r3["progress"], version_distribution={"target_version_percentage": 100})
                rs = [r3, r2]
            elif mode == "late":
                rs = [OLD] if k < 3 else [rollout("pending" if k == 3 else "completed"), OLD]
            else:
                rs = []
            return 200, (rs if mode == "bare-list" else {"success": True, "result": rs})


s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
