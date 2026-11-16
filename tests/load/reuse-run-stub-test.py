#!/usr/bin/env python3
"""Test of tests/load/reuse_run.py and reuse_score.py (#724 live run, #598) against a stub site. No site.

  python3 -I tests/load/reuse-run-stub-test.py

The stub answers login (the 302), the REST nonce, admin screens, REST draft posts (create and search), the Store
API product list and guest pages. Every third admin request recycles (x-runtime-recycled) and the next one boots
(bootWaitMs); the x-perf ledger depends on the stub's mode:
  off  a recycle leaves a retired memory (memLive 2, retiredMem 1) until the next boot; memReuse.taken stays 0.
  on   memLive 1 and retiredMem 0 always; each boot takes the spare (taken + 1 on that isolate).
  bad  as on, but one reading stacks, one save answers 201 and is never stored (a lost write), one refused
       streak outlasts BOOT_GATE_MAX_REFUSE_S, one admin request is slow (503 x-object-deadline: no-answer), and
       one guest page answers 500.
The driver runs all three steps per mode (small settings). Then: every request line has the fields the bar reads;
off vs on: no bar but 5 FAILS, and 5 is measured (its stub p95s are a few ms, noise); off vs bad: bar 1 is could
not measure (no logs to excuse the stacked reading), bars 2, 4 and 5 FAIL, and it lists the slow request in the #605 table with its deadline header. Then the same with Workers Logs in the wexport.py
shape: bar 2 is measured, a named refused offer excuses the stacked reading (bar 1 passes), an exceededMemory
invocation fails bar 2, and the slow row joins its front Worker and object lines by x-perf-id and the dispatcher
by path and time. Exit 0 when all pass.
"""
import json, os, subprocess, sys, tempfile, threading, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
RUN, SCORE = os.path.join(HERE, "reuse_run.py"), os.path.join(HERE, "reuse_score.py")
lock = threading.Lock()
S = {}


def reset(mode):
    S.clear(); S.update({"mode": mode, "n": 0, "boot_next": False, "retired": 0, "taken": 0, "posts": [], "lost": False, "refuse": 0, "slow": False, "stacked": False})


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, code, body=b"", headers=None):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def admin_headers(self):
        force = self.headers.get("x-runtime-recycle") == "force"
        with lock:
            S["n"] += 1; n = S["n"]; m = S["mode"]; h = {}
            if m == "bad" and S["refuse"] < 3 and n > 6:
                S["refuse"] += 1
                if S["refuse"] == 1:
                    import time; time.sleep(1.2)  # the streak spans > BOOT_GATE_MAX_REFUSE_S (1 s in this test)
                return 503, {"x-runtime-wait": "retired-resident", "x-runtime-wait-decision": str(S["refuse"]), "x-runtime-wait-mib": "100"}
            if m == "bad" and not S["slow"] and n > 12:
                S["slow"] = True
                import time; time.sleep(0.4)
                return 503, {"x-object-deadline": "no-answer", "x-write-loss": "none"}
            perf = {"wasm1MiB": 90 + n % 30, "phpMs": 50}
            if S["boot_next"]:
                S["boot_next"] = False; perf["boot"] = 1; perf["bootWaitMs"] = 300 if m == "off" else 310
                if m in ("on", "bad"):
                    S["taken"] += 1
                S["retired"] = 0
            live, ret = (1 + S["retired"], S["retired"]) if m == "off" else (1, 0)
            if m == "bad" and not S["stacked"] and n > 3:
                S["stacked"] = True; live, ret = 2, 1
            perf["mem"] = {"iso": "iso1", "rt": n, "runtimes": {"memLive": live, "retiredMem": ret, "retiredMemMiB": 100 * ret},
                           "memReuse": {"on": m != "off", "taken": S["taken"], "noGuards": 0, "kept": S["taken"], "inFlight": 0, "current": 0}}
            if n % 3 == 0 or force:
                h["x-runtime-recycled"] = "memory"; S["boot_next"] = True
                if m == "off":
                    S["retired"] = 1
            h["x-perf"] = json.dumps(perf)
            return 200, h

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/wp-login.php":
            return self.send(200, b"<form>")
        if u.path == "/wp-admin/admin-ajax.php":
            return self.send(200, b"0123456789")
        if u.path.startswith("/wp-admin/"):
            c, h = self.admin_headers(); return self.send(c, b"<html>", h)
        rr = q.get("rest_route", [""])[0]
        if rr == "/wc/store/v1/products":
            return self.send(200, [{"permalink": "http://%s/product/a/" % self.headers["Host"]}])
        if rr == "/wp/v2/posts":
            term = q.get("search", [""])[0]
            with lock:
                hits = [{"id": i, "title": {"raw": t}} for i, t in enumerate(S["posts"]) if t == term]
            return self.send(200, hits)
        with lock:
            g500 = S["mode"] == "bad" and not S.get("g500")
            if g500:
                S["g500"] = True
        return self.send(500 if g500 else 200, b"<html>guest</html>")

    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        if u.path == "/wp-login.php":
            return self.send(302, b"", {"Location": "/wp-admin/", "Set-Cookie": "wordpress_logged_in_x=1; Path=/"})
        if q.get("rest_route", [""])[0] == "/wp/v2/posts":
            c, h = self.admin_headers()
            if c != 200:
                return self.send(c, b"{}", h)
            t = json.loads(body)["title"]
            with lock:
                if S["mode"] == "bad" and not S["lost"]:
                    S["lost"] = True  # answered 201, never stored
                else:
                    S["posts"].append(t)
            return self.send(201, {"id": 1}, h)
        return self.send(404, b"")


fails = []


def ok(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (("  (" + detail + ")") if detail and not cond else ""))
    cond or fails.append(name)


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = "http://127.0.0.1:%d" % srv.server_address[1]
tmp = tempfile.mkdtemp(prefix="reuse-run-stub.")
files = {}
for mode in ("off", "on", "bad"):
    reset(mode)
    f = os.path.join(tmp, mode + ".jsonl"); files[mode] = f
    env = dict(os.environ, B=B, ADMIN_PASSWORD="pw", SPIKE_TOKEN="tok", ARM="stub-" + mode, OUT=f,
               EDITORS="2", WINDOW_REQS="9", WINDOWS="0,0.01", GUEST_RPS="20", QUIET_S="0.2", TIMEOUT="20")
    r = subprocess.run([sys.executable, "-I", RUN, "all"], env=env, capture_output=True, text=True, timeout=300)
    ok("driver %s exits 0" % mode, r.returncode == 0, (r.stdout + r.stderr)[-300:])
rows = [json.loads(x) for x in open(files["on"]) if x.strip()]
adm = [r for r in rows if r.get("kind") in ("dashboard", "post-new", "edit", "save", "before-gap", "after-gap")]
ok("the on arm has repro, burst and quiet admin requests", {r["step"] for r in adm} == {"repro", "burst", "quiet"})
wins = {}
for r in adm:
    if r.get("window"):
        wins[r["window"]] = wins.get(r["window"], 0) + 1
ok("two windows (w00, w0.01) of WINDOW_REQS admin requests each", wins == {"w00": 9, "w0.01": 9}, str(wins))
ok("the request before the gap forces a recycle", any(r.get("kind") == "before-gap" and r.get("x-runtime-recycled") for r in adm))
ok("every admin line has a unique x-perf-id", len({r["perfId"] for r in adm}) == len(adm))
ok("admin lines carry the ledger fields", all(r.get("memLive") is not None and isinstance(r.get("memReuse"), dict) for r in adm))
ok("recycles and boots are recorded", any(r.get("x-runtime-recycled") for r in adm) and any(r.get("bootWaitMs") for r in adm))
ok("guests ran during the windows", sum(1 for r in rows if r.get("kind") == "guest") >= 2)
ok("every save is read back, none lost on the on arm", [r.get("lostWrite") for r in rows if r.get("kind") == "read-back"] and
   not any(r.get("lostWrite") for r in rows if r.get("kind") == "read-back"))
senv = dict(os.environ, BOOT_GATE_MAX_REFUSE_S="1", SLOW_S="0.3")
good = subprocess.run([sys.executable, "-I", SCORE, files["off"], files["on"]], env=senv, capture_output=True, text=True)
print(good.stdout)
# Bar 5 compares stub p95s of a few ms, which is noise; it is checked for being measured, the rest for no FAIL.
fails_good = [l for l in good.stdout.splitlines() if l.startswith("| ") and "| FAIL |" in l and not l.startswith("| 5 |")]
ok("off vs on: no bar but 5 FAILS", not fails_good, str(fails_good))
ok("off vs on: bar 5 is measured (guests on both arms)", any(l.startswith("| 5 |") and "could not measure" not in l for l in good.stdout.splitlines()))
ok("off vs on: bar 1 passes (no stacking with reuse on)", "| 1 | no stacking (on) | pass |" in good.stdout)
ok("off vs on: bar 3 passes (every recycle taken, the spare taken after the gap)", "| 3 | reuse happens (on) | pass |" in good.stdout and "after the gap: taken" in good.stdout)
ok("off vs on: bar 6 passes (boot within off + 50 ms)", "| 6 | boot cost | pass |" in good.stdout)
bad = subprocess.run([sys.executable, "-I", SCORE, files["off"], files["bad"]], env=senv, capture_output=True, text=True)
print(bad.stdout)
ok("off vs bad: exit 1", bad.returncode == 1, "exit %d" % bad.returncode)
ok("off vs bad: bar 1 is not a pass (a stacked reading, no logs to excuse it)", "| 1 | no stacking (on) | could not measure |" in bad.stdout)
ok("off vs bad: bar 2 FAILS (a lost write)", "| 2 | deaths and lost writes at or below off | FAIL |" in bad.stdout)
ok("off vs bad: bar 4 FAILS (a refusal streak past the bound)", "| 4 | the gate never stalls | FAIL |" in bad.stdout)
ok("off vs bad: bar 5 FAILS (a guest 500 the off arm did not have)", "| 5 | guests no worse | FAIL |" in bad.stdout)
ok("off vs bad: the slow request is in the #605 table with no-answer", "| no-answer |" in bad.stdout)


# Workers Logs in the wexport.py shape (one directory per service: lines.jsonl, invocations.jsonl; lines flattened,
# t in ms, rid; front Worker and object on different rids). For the bad arm: one named refused offer (it excuses the
# one stacked reading), one exceededMemory invocation, and the slow request's lines (an object-deadline line on the
# front Worker's rid, a perf line on the object's), all carrying its x-perf-id as id; a dispatcher invocation for it.
def wexport(d, lines, inv):
    os.makedirs(d)
    with open(os.path.join(d, "lines.jsonl"), "w") as f:
        for o in lines:
            f.write(json.dumps(o) + "\n")
    with open(os.path.join(d, "invocations.jsonl"), "w") as f:
        for o in inv:
            f.write(json.dumps(o) + "\n")


brows = [json.loads(x) for x in open(files["bad"]) if x.strip()]
slow = next(r for r in brows if r.get("x-object-deadline") == "no-answer")
ms = int((slow["t"] - slow["s"]) * 1000)
ok_inv = [{"t": ms - 1000, "type": "fetch", "outcome": "ok", "status": 200, "path": "/", "wallMs": 5, "cpuMs": 1, "rid": "x0"}]
wexport(os.path.join(tmp, "L-off"), [{"t": ms, "rid": "x0", "m": "req", "w_executionModel": "stateless"}], ok_inv)
wexport(os.path.join(tmp, "L-on"), [{"t": ms, "rid": "x0", "m": "mem-reuse", "offer": "kept"}], ok_inv)
wexport(os.path.join(tmp, "L-bad"),
        [{"t": ms, "rid": "f1", "m": "object-deadline", "id": slow["perfId"], "deadlineMs": 90000, "answered": 503, "w_executionModel": "stateless"},
         {"t": ms + 10, "rid": "d1", "m": "perf", "id": slow["perfId"], "w_executionModel": "durableObject"},
         {"t": ms + 20, "rid": "d2", "m": "mem-reuse", "offer": "in-flight"}],
        [{"t": ms, "type": "fetch", "outcome": "ok", "status": 503, "path": "/wp-admin/post-new.php", "wallMs": 90012, "cpuMs": 3, "rid": "f1"},
         {"t": ms + 5, "type": "fetch", "outcome": "exceededMemory", "status": 500, "path": "/wp-admin/post-new.php", "wallMs": 400, "cpuMs": 300, "rid": "d1", "w_durableObjectId": "o1"}])
wexport(os.path.join(tmp, "D-bad"), [], [{"t": ms + 300, "type": "fetch", "outcome": "ok", "status": 503, "path": "/wp-admin/post-new.php", "wallMs": 90100, "rid": "z1"}])
g2 = subprocess.run([sys.executable, "-I", SCORE, files["off"], files["on"], "--logs-off", os.path.join(tmp, "L-off"), "--logs-on", os.path.join(tmp, "L-on")], env=senv, capture_output=True, text=True)
ok("with logs, off vs on: bar 2 is measured and passes (exceededMemory 0 and 0)", "| 2 | deaths and lost writes at or below off | pass |" in g2.stdout and "exceededMemory on 0, off 0" in g2.stdout, g2.stdout[-400:])
b2 = subprocess.run([sys.executable, "-I", SCORE, files["off"], files["bad"], "--logs-off", os.path.join(tmp, "L-off"), "--logs-on", os.path.join(tmp, "L-bad"),
                     "--disp-on", os.path.join(tmp, "D-bad")], env=senv, capture_output=True, text=True)
print(b2.stdout)
ok("with logs, off vs bad: bar 1 passes (the stacked reading matched by a named refused offer, in-flight)", "| 1 | no stacking (on) | pass |" in b2.stdout and "in-flight" in b2.stdout)
ok("with logs, off vs bad: bar 2 FAILS and counts the exceededMemory invocation", "| 2 | deaths and lost writes at or below off | FAIL |" in b2.stdout and "exceededMemory on 1, off 0" in b2.stdout)
row = next((l for l in b2.stdout.splitlines() if l.startswith("| " + slow["perfId"] + " ")), "")
ok("the slow row joins the site lines by x-perf-id across both rids", "'object-deadline': 1" in row and "'perf': 1" in row and "('exceededMemory', 400)" in row and "('ok', 90012)" in row, row)
ok("the slow row joins the dispatcher invocation by path and time", "ok 503 90100" in row, row)
ok("a log file instead of a directory is refused, loudly", subprocess.run([sys.executable, "-I", SCORE, files["off"], files["on"], "--logs-on", files["on"]], capture_output=True, text=True).returncode == 3)
srv.shutdown()
import shutil
shutil.rmtree(tmp)
print("reuse-run-stub: %d failing" % len(fails))
sys.exit(1 if fails else 0)
