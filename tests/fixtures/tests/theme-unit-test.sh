#!/bin/bash
# The tier-1 fixture loader (#422), offline: a file that does not match its pin loads nothing, and
# the REST read-back counts what a fake WordPress reports (theme-unit-counts.py, against a local
# HTTP server with a login, a REST nonce and X-WP-Total). A stub proves the decision path; the live
# proof is the lead's real load.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); FX=$(cd "$HERE/.." && pwd)
fails=0
check() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/theme-unit-test.XXXXXX"); trap 'rm -rf "$T"' EXIT

printf 'not the fixture' | gzip -c > "$T/bad.sqlite.gz"
printf 'not the media' | gzip -c > "$T/bad.tar.gz"
out=$(THEME_UNIT_SQLITE="$T/bad.sqlite.gz" THEME_UNIT_CONTENT="$T/bad.tar.gz" "$FX/load-theme-unit.sh" nosuchsite 2>&1); rc=$?
check "a database that is not the pin loads nothing (exit 1, says so)" "$([ $rc = 1 ] && [[ "$out" == *"THEME_UNIT_SQLITE sha256"*"nothing loaded"* ]] && echo 1 || echo 0)"
check "the refusal comes before any import" "$([[ "$out" != *"import"*"site"* ]] && echo 1 || echo 0)"
out=$("$FX/load-theme-unit.sh" nosuchsite 2>&1); rc=$?
check "no files set: refused" "$([ $rc != 0 ] && [[ "$out" == *"set THEME_UNIT_SQLITE"* ]] && echo 1 || echo 0)"

python3 -I - "$FX" <<'PY'
import http.server, importlib.util, json, sys, threading
spec = importlib.util.spec_from_file_location("c", sys.argv[1] + "/theme-unit-counts.py"); C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)
TOTALS = {"/wp/v2/posts": "59", "/wp/v2/pages": "23", "/wp/v2/media": "37"}
seen = []
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        seen.append(self.path)
        if self.path.startswith("/wp-admin/admin-ajax.php"):
            ok = "wordpress_logged_in_x=1" in (self.headers.get("Cookie") or "")
            self.send_response(200); self.end_headers(); self.wfile.write(b"abcdef1234" if ok else b"0"); return
        if "rest_route=" in self.path:
            route = self.path.split("rest_route=")[1].split("&")[0]
            if self.headers.get("X-WP-Nonce") != "abcdef1234" or "status=publish,future,draft,pending,private" not in self.path and route != "/wp/v2/media":
                self.send_response(401); self.end_headers(); return
            self.send_response(200); self.send_header("X-WP-Total", TOTALS[route]); self.end_headers(); self.wfile.write(b"[]"); return
        self.send_response(200); self.end_headers(); self.wfile.write(b"login")
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = self.rfile.read(n).decode()
        if "pwd=right" in body:
            self.send_response(302); self.send_header("Set-Cookie", "wordpress_logged_in_x=1; path=/"); self.send_header("Location", "/wp-admin/"); self.end_headers()
        else:
            self.send_response(200); self.end_headers()
srv = http.server.HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
o = "http://127.0.0.1:%d" % srv.server_port
fails = 0
got = C.counts(o, "admin", "right")
print(("PASS" if got == {"posts": 59, "pages": 23, "media": 37} else "FAIL") + " the REST read-back counts every status but trash and auto-draft: %s" % got); fails += got != {"posts": 59, "pages": 23, "media": 37}
try:
    C.counts(o, "admin", "wrong"); print("FAIL a wrong password must stop the read-back"); fails += 1
except SystemExit as e:
    print(("PASS" if "login answered" in str(e) else "FAIL") + " a wrong password stops the read-back (%s)" % e); fails += "login answered" not in str(e)
srv.shutdown()
sys.exit(1 if fails else 0)
PY
[ $? = 0 ] || fails=$((fails + 1))
echo "theme-unit-test: $fails failing"
exit $((fails > 0))
