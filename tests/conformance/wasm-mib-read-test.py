#!/usr/bin/env python3
"""#1271: the tools that read x-wasm-mib send x-spike-token when SPIKE_TOKEN is set.
When it is not set, a blank or a 0 is not a heap size. They print
"x-wasm-mib: not readable without the token".
load.py does not send the token (that would mark the shopper request no-store).
When no row has the header, max_wasm_mib is null and the summary carries the
same line, never 0.
Offline, against 127.0.0.1. Run: python3 -I tests/conformance/wasm-mib-read-test.py
"""
import contextlib, importlib.util, io, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PHRASE = "x-wasm-mib: not readable without the token"
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:400]))
    if not ok:
        fails.append(name)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Handler(BaseHTTPRequestHandler):
    state = None

    def log_message(self, *a):
        pass

    def _note(self):
        st = self.state
        st["hits"].append((self.command, self.path.split("?", 1)[0], self.headers.get("x-spike-token")))

    def _send(self, code, body, ctype="text/html", extra=None):
        raw = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(raw)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._note()
        st = self.state
        path = self.path.split("?", 1)[0]
        if st.get("mode") == "media" and "pf-conformance/v1/throwaway" in self.path:
            return self._send(200, json.dumps({"throwaway": True, "host": "127.0.0.1"}), "application/json")
        if st.get("mode") == "media" and path == "/":
            extra = {"x-wasm-mib": st["wasm"]} if st.get("wasm") is not None else None
            return self._send(200, b"<html>ok</html>", "text/html", extra)
        if st.get("mode") == "media" and path in st.get("files", {}):
            return self._send(200, st["files"][path], "image/png")
        if st.get("mode") == "media":
            return self._send(404, b"missing", "text/plain")
        if st.get("mode") == "upload" and path == "/wp-login.php":
            return self._send(200, b"login", "text/html", {"Set-Cookie": "wordpress_logged_in_test=1; Path=/"})
        if st.get("mode") == "upload" and path == "/wp-admin/media-new.php":
            return self._send(200, '<input name="_wpnonce" value="abcdef" />')
        extra = {"x-wasm-mib": st["wasm"]} if st.get("wasm") is not None else None
        self._send(200, b"ok", "text/plain", extra)

    def do_POST(self):
        self._note()
        st = self.state
        n = int(self.headers.get("content-length") or 0)
        data = self.rfile.read(n)
        path = self.path.split("?", 1)[0]
        if st.get("mode") == "media" and "wp/v2/media" in self.path:
            st["uploads"] += 1
            base = "http://127.0.0.1:%d/wp-content/uploads/" % self.server.server_address[1]
            st["files"]["/wp-content/uploads/p.png"] = data
            st["files"]["/wp-content/uploads/p-150x150.png"] = b"\x89PNGthumb"
            body = {"id": 7, "source_url": base + "p.png", "media_details": {"sizes": {
                "thumbnail": {"source_url": base + "p-150x150.png"}, "full": {"source_url": base + "p.png"}}}}
            return self._send(201, json.dumps(body), "application/json")
        if st.get("mode") == "upload" and path == "/wp-admin/async-upload.php":
            extra = {"x-wasm-mib": st["wasm"]} if st.get("wasm") is not None else None
            return self._send(200, '{"success":true}', "application/json", extra)
        if st.get("mode") == "upload" and path == "/wp-login.php":
            return self._send(200, b"ok", "text/html", {"Set-Cookie": "wordpress_logged_in_test=1; Path=/"})
        self._send(200, b"ok")

    def do_DELETE(self):
        self._note()
        self.state["files"].clear()
        self._send(200, json.dumps({"deleted": True}), "application/json")


def serve(mode, wasm):
    state = {"mode": mode, "wasm": wasm, "hits": [], "files": {}, "uploads": 0}
    Handler.state = state
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, state


def tokens(state):
    return [t for _m, _p, t in state["hits"]]


def run_media(wasm, token):
    srv, state = serve("media", wasm)
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    out = os.path.join(os.environ.get("TMPDIR", "/tmp"), "wasm-mib-media-%d.json" % srv.server_address[1])
    env = {"PATH": os.environ.get("PATH", ""), "B": base, "WP_USERNAME": "admin", "WP_PASSWORD": "pw"}
    if token:
        env["SPIKE_TOKEN"] = token
    probe = os.path.join(ROOT, "tests", "conformance", "media_probe.py")
    import subprocess
    p = subprocess.run([sys.executable, "-I", probe, out, "--wait", "0"], env=env, capture_output=True, text=True, timeout=60)
    srv.shutdown()
    rep = json.load(open(out)) if os.path.exists(out) else {}
    if os.path.exists(out):
        os.remove(out)
    return p, rep, state


def run_load(wasm):
    """One short plain-WordPress step. SPIKE_TOKEN is set so a sent token would show.
    load.py must not send it. wasm is the header value, or None for no header."""
    srv, state = serve("plain", wasm)
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    env = {"PATH": os.environ.get("PATH", ""), "B": base, "WOO": "0", "LEVELS": "1", "SECONDS": "1",
           "BUYERS": "0", "ADMINS": "0", "SETUP": "0", "CLEANUP": "0", "SPIKE_TOKEN": "t-1271"}
    script = os.path.join(ROOT, "tests", "load", "load.py")
    import subprocess
    p = subprocess.run([sys.executable, "-I", script], env=env, capture_output=True, text=True, timeout=30)
    srv.shutdown()
    lines = []
    for line in p.stdout.splitlines():
        if line.startswith("{"):
            lines.append(json.loads(line))
    steps = [row for row in lines if "users" in row and "steps" not in row]
    summary = lines[-1] if lines else {}
    return p, steps, summary, state


def run_upload(wasm, token):
    srv, state = serve("upload", wasm)
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    env = {"PATH": os.environ.get("PATH", ""), "BASE": base, "ADMIN_PASSWORD": "pw", "ADMIN_USER": "admin"}
    if token:
        env["SPIKE_TOKEN"] = token
    script = os.path.join(ROOT, "tests", "upload", "upload_ceiling.py")
    import subprocess
    p = subprocess.run([sys.executable, "-I", script], env=env, capture_output=True, text=True, timeout=30)
    srv.shutdown()
    return p, state


def break_ns():
    path = os.path.join(ROOT, "spikes", "b2-wordpress", "tests", "break.py")
    src = open(path).read().split("\nresults = []", 1)[0]
    ns = {"__name__": "break_helpers"}
    exec(compile(src, path, "exec"), ns)
    return ns


def seed_mod():
    os.environ["B"] = "http://127.0.0.1"
    os.environ.pop("SPIKE_TOKEN", None)
    return load_module("seed_wasm_mib", os.path.join(ROOT, "tests", "conformance", "seed.py"))


def main():
    seed = seed_mod()
    seed_src = open(os.path.join(ROOT, "tests", "conformance", "seed.py")).read()
    os.environ.pop("SPIKE_TOKEN", None)
    seed.report["rest_nonce_failures"] = []
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        seed.record_nonce_failure("admin", "pw", 500, b"err", {})
    row = seed.report["rest_nonce_failures"][-1]
    check("seed: no token and no header prints the could-not-measure line",
          row.get("x-wasm-mib") == PHRASE and PHRASE in buf.getvalue(), (row.get("x-wasm-mib"), buf.getvalue()[:200]))
    seed.report["rest_nonce_failures"] = []
    with contextlib.redirect_stdout(io.StringIO()):
        seed.record_nonce_failure("admin", "pw", 500, b"err", {"x-wasm-mib": "0", "x-pf-call": "abc"})
    row = seed.report["rest_nonce_failures"][-1]
    check("seed: no token and a 0 is not a heap size", row.get("x-wasm-mib") == PHRASE and row.get("x-pf-call") == "abc", row)
    seed.report["rest_nonce_failures"] = []
    with contextlib.redirect_stdout(io.StringIO()):
        seed.record_nonce_failure("admin", "pw", 500, b"err", {"x-wasm-mib": "121"})
    row = seed.report["rest_nonce_failures"][-1]
    check("seed: a real heap size is kept when the server sent one", row.get("x-wasm-mib") == "121", row)
    os.environ["SPIKE_TOKEN"] = "t-1271"
    seed.report["rest_nonce_failures"] = []
    with contextlib.redirect_stdout(io.StringIO()):
        seed.record_nonce_failure("admin", "pw", 500, b"err", {"x-wasm-mib": "0"})
    row = seed.report["rest_nonce_failures"][-1]
    check("seed: with the token, a 0 from the server stays a 0", row.get("x-wasm-mib") == "0", row)
    check("seed: both readers call wasm_mib_reading", seed_src.count("wasm_mib_reading(") >= 3, seed_src.count("wasm_mib_reading("))

    srv, state = serve("plain", None)
    other = "http://127.0.0.1:%d" % srv.server_address[1]
    os.environ["SPIKE_TOKEN"] = "t-1271"
    seed.B = "http://127.0.0.1:1"
    with contextlib.redirect_stdout(io.StringIO()):
        seed.req(seed.jar(), other + "/outside")
    check("seed: the token is not sent to a host that is not the site", tokens(state) == [None], tokens(state))
    srv.shutdown()
    srv, state = serve("plain", "108")
    site = "http://127.0.0.1:%d" % srv.server_address[1]
    seed.B = site
    with contextlib.redirect_stdout(io.StringIO()):
        seed.req(seed.jar(), "/")
    check("seed: the token is sent to the site when SPIKE_TOKEN is set", tokens(state) == ["t-1271"], tokens(state))
    srv.shutdown()
    os.environ.pop("SPIKE_TOKEN", None)
    srv, state = serve("plain", "108")
    seed.B = "http://127.0.0.1:%d" % srv.server_address[1]
    with contextlib.redirect_stdout(io.StringIO()):
        seed.req(seed.jar(), "/")
    check("seed: no SPIKE_TOKEN means no x-spike-token", tokens(state) == [None], tokens(state))
    srv.shutdown()

    p, rep, state = run_media(None, None)
    page = (rep or {}).get("page_between") or {}
    check("media_probe: no token, no header, the line is printed and not a blank",
          p.returncode == 0 and page.get("x-wasm-mib") == PHRASE and PHRASE in p.stdout and set(tokens(state)) == {None},
          (p.returncode, page, p.stdout[-300:], p.stderr[-200:], tokens(state)[:4]))
    p, rep, state = run_media("0", None)
    page = (rep or {}).get("page_between") or {}
    check("media_probe: no token and a 0 is the could-not-measure line",
          page.get("x-wasm-mib") == PHRASE and "x-wasm-mib=0" not in p.stdout, (page, p.stdout[-200:]))
    p, rep, state = run_media("108", "t-1271")
    page = (rep or {}).get("page_between") or {}
    sent = [t for _m, path, t in state["hits"]]
    check("media_probe: the token is sent and the heap size is kept",
          p.returncode == 0 and page.get("x-wasm-mib") == "108" and PHRASE not in p.stdout and sent and set(sent) == {"t-1271"},
          (p.returncode, page, set(sent), p.stderr[-200:]))

    p, state = run_upload(None, None)
    check("upload_ceiling: no token prints the line, not a blank",
          PHRASE in p.stdout and "x-wasm-mib=None" not in p.stdout and "x-wasm-mib=0" not in p.stdout and set(tokens(state)) == {None},
          (p.returncode, p.stdout, p.stderr[-300:], tokens(state)))
    p, state = run_upload("0", None)
    check("upload_ceiling: no token and a 0 is the could-not-measure line",
          PHRASE in p.stdout and "x-wasm-mib=0" not in p.stdout, (p.stdout, p.stderr[-200:]))
    p, state = run_upload("108", "t-1271")
    check("upload_ceiling: the token is sent and the heap size is printed",
          "x-wasm-mib=108" in p.stdout and PHRASE not in p.stdout and set(tokens(state)) == {"t-1271"},
          (p.returncode, p.stdout, p.stderr[-300:], tokens(state)))

    ns = break_ns()
    os.environ.pop("SPIKE_TOKEN", None)
    srv, state = serve("plain", "0")
    ns["B"] = "http://127.0.0.1:%d" % srv.server_address[1]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = ns["req"](ns["opener"](), "/")
    srv.shutdown()
    check("break: no token and a 0 prints the line and is not stored as 0",
          r.get("mib") == PHRASE and PHRASE in buf.getvalue() and tokens(state) == [None],
          (r.get("mib"), buf.getvalue()[:200], tokens(state)))
    os.environ["SPIKE_TOKEN"] = "t-1271"
    srv, state = serve("plain", "108")
    ns["B"] = "http://127.0.0.1:%d" % srv.server_address[1]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = ns["req"](ns["opener"](), "/")
    srv.shutdown()
    check("break: the token is sent and the heap size is kept",
          r.get("mib") == "108" and PHRASE not in buf.getvalue() and tokens(state) == ["t-1271"],
          (r.get("mib"), tokens(state), buf.getvalue()[:120]))
    os.environ.pop("SPIKE_TOKEN", None)
    srv, state = serve("plain", None)
    ns["B"] = "http://127.0.0.1:%d" % srv.server_address[1]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = ns["req"](ns["opener"](), "/")
    srv.shutdown()
    check("break: no token and no header is the could-not-measure line, not a blank",
          r.get("mib") == PHRASE and PHRASE in buf.getvalue(), (r.get("mib"), buf.getvalue()[:160]))

    p, steps, summary, state = run_load(None)
    step0 = steps[0] if steps else {}
    sum_step = (summary.get("steps") or [{}])[0]
    check("load: no header on any row gives null, not 0",
          p.returncode == 0 and step0.get("requests", 0) > 0
          and "max_wasm_mib" in step0 and step0.get("max_wasm_mib") is None
          and sum_step.get("max_wasm_mib") is None and PHRASE in json.dumps(summary)
          and set(tokens(state)) == {None},
          (p.returncode, step0.get("requests"), step0.get("max_wasm_mib"),
           PHRASE in json.dumps(summary), tokens(state)[:4], p.stderr[-300:]))

    print("%d failing" % len(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
