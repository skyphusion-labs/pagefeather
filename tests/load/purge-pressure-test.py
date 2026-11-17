#!/usr/bin/env python3
"""tests/load/purge_pressure.py against a stub WordPress (#699; no site, no network).
The stub's guest page is a stand-in for the page cache:
  - a purge that works: a change shows DELAY s after it was made; every change is seen, at about DELAY;
  - purges that are lost: the page refreshes only when its TTL lapses (every REFRESH s), so the changes made in
    between are replaced before a guest sees them (counted), and each is visible only at the next refresh;
  - guest probes and reads never carry the operator token (it would bypass the page cache);
  - the post is deleted at the end; the password never reaches the output;
  - refusals before any write: ggc.sh, plain http off localhost; a failed login stops the run (exit 3).
  python3 -I tests/load/purge-pressure-test.py
"""
import http.server, json, os, re, subprocess, sys, threading, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
PROG = os.path.join(HERE, "purge_pressure.py")
PW = "good-pass-must-not-print"
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:300]))
    if not ok:
        fails.append(name)


class Stub:
    def __init__(self, delay, refresh=None):
        self.delay = delay
        self.refresh = refresh
        self.versions = []  # (n, time set)
        self.deleted = False
        self.guest_with_token = 0
        self.guest_hits = 0
        stub = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body=b"", headers=()):
                if isinstance(body, (dict, list)):
                    body = json.dumps(body).encode()
                elif isinstance(body, str):
                    body = body.encode()
                self.send_response(code)
                for k, v in headers:
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def logged(self):
                return "wordpress_logged_in_x=1" in (self.headers.get("Cookie") or "")

            def do_GET(self):
                p = self.path
                if p == "/wp-login.php":
                    return self.send(200, "<form>")
                if p.startswith("/wp-admin/admin-ajax.php?action=rest-nonce"):
                    return self.send(200, "0123456789" if self.logged() else "0")
                if p in ("/pp/", "/"):
                    stub.guest_hits += 1
                    if self.headers.get("x-spike-token"):
                        stub.guest_with_token += 1
                    if p == "/":
                        return self.send(200, "<html>home</html>")
                    now = time.time()
                    # Lost purges: the copy is refreshed only at each TTL boundary (every REFRESH s).
                    cut = (now // stub.refresh) * stub.refresh if stub.refresh else now - stub.delay
                    ready = [n for n, t in stub.versions if t <= cut]
                    tag = os.environ.get("STUB_TAG", "t")
                    return self.send(200, "<title>pp-%s-%d</title>" % (tag, max(ready) if ready else 0))
                self.send(404)

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n)
                p = self.path
                if p == "/wp-login.php":
                    f = urllib.parse.parse_qs(body.decode())
                    if f.get("pwd", [""])[0] == PW:
                        return self.send(302, "", [("Set-Cookie", "wordpress_logged_in_x=1; Path=/"), ("Location", "/wp-admin/")])
                    return self.send(200, "<form>ERROR</form>")
                if not self.logged():
                    return self.send(401)
                if p == "/?rest_route=/wp/v2/posts":
                    stub.versions.append((0, time.time()))
                    host = self.headers.get("Host")
                    return self.send(201, {"id": 1, "link": "http://%s/pp/" % host})
                if p == "/?rest_route=/wp/v2/posts/1":
                    t = json.loads(body).get("title", "")
                    m = re.search(r"-(\d+)$", t)
                    if m:
                        stub.versions.append((int(m.group(1)), time.time()))
                    return self.send(200, {"id": 1})
                self.send(404)

            def do_DELETE(self):
                if self.path == "/?rest_route=/wp/v2/posts/1&force=true" and self.logged():
                    stub.deleted = True
                    return self.send(200, {"deleted": True})
                self.send(404)

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()


def run(b, pw=PW, extra=None):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "B": b, "ADMIN_PASSWORD": pw, "EDIT_EVERY": "0.3",
           "PROBE_EVERY": "0.05", "BG_RPS": "5", "DURATION": "3", "COUNT_FROM": "0", "LOAD_EVERY": "1", "RUNTAG": "t",
           "STUB_TAG": "t", "SPIKE_TOKEN": "operator-token"}
    env.update(extra or {})
    os.environ["STUB_TAG"] = "t"
    p = subprocess.run([sys.executable, "-I", PROG], env=env, capture_output=True, text=True, timeout=60)
    last = (p.stdout.strip().splitlines() or [""])[-1]
    try:
        return p.returncode, json.loads(last), p.stdout + p.stderr
    except ValueError:
        return p.returncode, None, p.stdout + p.stderr


# 1. A fast cache: every change is seen, about DELAY s after it was made.
s = Stub(0.1)
rc, out, raw = run(s.url)
check("fast: the run completes (exit 0)", rc == 0 and out is not None, raw[-300:])
if out:
    w = out["window"]
    check("fast: about 9 changes in the window", 7 <= w["edits"] <= 10, w)
    check("fast: no change was replaced unseen", w["replacedUnseen"] == 0, w)
    check("fast: visible p95 is about the delay (0.1 s, plus a probe gap)", w["visibleP95"] is not None and 0.05 <= w["visibleP95"] <= 0.35, w)
    check("fast: the post was deleted at the end", out["postDeleted"] is True and s.deleted, out["postDeleted"])
    check("fast: the probe got 200s", out["codes"]["probe"].get("200", 0) > 10, out["codes"])
    check("fast: the background reads ran", out["codes"]["bg"].get("200", 0) > 5, out["codes"])
    check("fast: the load average was recorded", len(out["load"]) >= 2, out["load"])
check("guest requests NEVER carry the operator token (it would bypass the page cache)", s.guest_hits > 0 and s.guest_with_token == 0, (s.guest_hits, s.guest_with_token))
check("the password never reaches the output", PW not in raw)

# 2. Lost purges: the copy refreshes only every 1 s (its TTL), so most changes are replaced unseen.
s2 = Stub(0, refresh=1.0)
rc, out, raw = run(s2.url)
check("lost purges: the run completes", rc == 0 and out is not None, raw[-300:])
if out:
    check("lost purges: changes replaced unseen are counted", out["window"]["replacedUnseen"] >= 4, out["window"])
    check("lost purges: a change waits for the next refresh, never longer than one TTL (plus a probe gap)", out["window"]["visibleMax"] is not None and out["window"]["visibleMax"] <= 1.1, out["window"])

# 3. Refusals and stops.
rc, out, raw = run("https://ggc.sh")
check("ggc.sh is refused before any request (exit 2)", rc == 2 and out and "real site" in out.get("stopped", ""), raw[-200:])
rc, out, raw = run("http://example.invalid")
check("plain http off localhost is refused (exit 2)", rc == 2 and out and "https" in out.get("stopped", ""), raw[-200:])
s3 = Stub(0.1)
rc, out, raw = run(s3.url, pw="wrong")
check("a failed login stops the run (exit 3), nothing written", rc == 3 and out and "login failed" in out.get("stopped", "") and not s3.versions, raw[-200:])

print("%d failing" % len(fails))
sys.exit(1 if fails else 0)
