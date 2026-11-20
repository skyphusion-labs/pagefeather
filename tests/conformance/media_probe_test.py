#!/usr/bin/env python3
"""media_probe.py against a stub site (no network): durable media passes; files that vanish between the reads fail
(the MEDIA=0 shape); a site without the throwaway marker is refused before any upload.
Run: python3 -I tests/conformance/media_probe_test.py"""
import json, os, subprocess, sys, tempfile, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
PROBE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media_probe.py")
fails = []
def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:300]))
    if not ok: fails.append(name)
class H(BaseHTTPRequestHandler):
    st = None
    def log_message(self, *a): pass
    def send(self, code, body=b"", ctype="application/json"):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", ctype); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        st = self.st; p = self.path.split("?")[0]; q = self.path
        if "pf-conformance/v1/throwaway" in q:
            return self.send(200, {"throwaway": st["marker"], "host": "127.0.0.1"})
        if p == "/" :
            st["page"] = True
            if st.get("vanish"): st["files"].clear()
            return self.send(200, b"<html>ok</html>", "text/html")
        if p in st["files"]:
            return self.send(200, st["files"][p], "image/png")
        self.send(404, {"code": "rest_no_route"})
    def do_POST(self):
        st = self.st; n = int(self.headers.get("content-length") or 0); data = self.rfile.read(n)
        st["uploads"] += 1
        base = "http://127.0.0.1:%d/wp-content/uploads/2026/11/" % self.server.server_address[1]
        st["files"]["/wp-content/uploads/2026/11/p.png"] = data
        st["files"]["/wp-content/uploads/2026/11/p-150x150.png"] = b"\x89PNGthumb"
        self.send(201, {"id": 7, "source_url": base + "p.png", "media_details": {"sizes": {"thumbnail": {"source_url": base + "p-150x150.png"}, "full": {"source_url": base + "p.png"}}}})
    def do_DELETE(self):
        self.st["files"].clear(); self.send(200, {"deleted": True})
def run(**st):
    state = {"marker": True, "files": {}, "uploads": 0}; state.update(st); H.st = state
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    d = tempfile.mkdtemp(prefix="media-probe-"); out = os.path.join(d, "out.json")
    env = {"PATH": os.environ.get("PATH", ""), "B": "http://127.0.0.1:%d" % srv.server_address[1], "WP_USERNAME": "admin", "WP_PASSWORD": "pw"}
    p = subprocess.run([sys.executable, "-I", PROBE, out, "--wait", "0"], env=env, capture_output=True, text=True, timeout=60)
    srv.shutdown()
    rep = json.load(open(out)) if os.path.exists(out) else None
    if os.path.exists(out): os.remove(out)
    os.rmdir(d)
    return p, rep, state
p, rep, st = run()
check("durable media: exit 0, every file 200 before and after the wait, and 404 after the delete", p.returncode == 0 and rep and rep["failed"] == [] and st["uploads"] == 1, (p.returncode, (rep or {}).get("failed"), p.stdout[-300:], p.stderr[-400:]))
p, rep, st = run(vanish=True)
check("files that vanish between the reads (the MEDIA=0 shape): exit 1, the after-wait reads fail", p.returncode == 1 and rep and all(n.startswith("after ") or n.startswith("after the delete") or n.startswith("delete") for n in rep["failed"]) and any(n.startswith("after 0 s") for n in rep["failed"]), (p.returncode, (rep or {}).get("failed")))
p, rep, st = run(marker=False)
check("no throwaway marker: refused (2) before any upload", p.returncode == 2 and st["uploads"] == 0, (p.returncode, st["uploads"]))
print("%d failing" % len(fails)); sys.exit(1 if fails else 0)
