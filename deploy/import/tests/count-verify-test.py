#!/usr/bin/env python3
"""Offline checks of the count-based import verify (issue #165). No real object.

  python3 deploy/import/tests/count-verify-test.py

count-check.py: a full match passes; a wrong count, a table missing on the
object, each fail (naming the table); a table only on the object is ignored.
dbmove.py counts: GETs /_dbcounts and prints the {"rows":...} form a stub serves.
Exit 0 only when all pass.
"""
import importlib.util, json, os, subprocess, sys, tempfile, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CHECK = os.path.join(ROOT, "deploy", "import", "count-check.py")
DBMOVE = os.path.join(ROOT, "spikes", "b2-wordpress", "dbmove.py")
W = tempfile.mkdtemp()
fails = 0
def ok(label, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + label)
    if not cond: fails += 1

def write(name, rows):
    p = os.path.join(W, name)
    json.dump({"rows": rows}, open(p, "w"))
    return p

def run_check(sent, do):
    return subprocess.run([sys.executable, "-I", CHECK, sent, do], capture_output=True, text=True)

sent = write("sent.json", {"wp_posts": 5, "wp_postmeta": 200, "wp_options": 50})

# match
r = run_check(sent, write("do_ok.json", {"wp_posts": 5, "wp_postmeta": 200, "wp_options": 50}))
ok("match: exit 0", r.returncode == 0)
ok("match: reports the total", "every table matches" in r.stdout and "255 rows" in r.stdout)
# extra object-only table ignored
r = run_check(sent, write("do_extra.json", {"wp_posts": 5, "wp_postmeta": 200, "wp_options": 50, "_wp_undo_x": 9}))
ok("extra object-only table is ignored", r.returncode == 0)
# wrong count
r = run_check(sent, write("do_wrong.json", {"wp_posts": 5, "wp_postmeta": 199, "wp_options": 50}))
ok("wrong count: exit 1, names the table", r.returncode == 1 and "wp_postmeta" in r.stderr)
# missing table
r = run_check(sent, write("do_missing.json", {"wp_posts": 5, "wp_options": 50}))
ok("missing table: exit 1, MISSING", r.returncode == 1 and "wp_postmeta" in r.stderr and "MISSING" in r.stderr)

# dbmove.py counts against a stub /_dbcounts
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/_dbcounts":
            b = json.dumps({"rows": {"wp_posts": 5, "wp_postmeta": 200}, "databaseBytes": 54538240}).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
        else:
            self.send_response(404); self.end_headers()

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
r = subprocess.run([sys.executable, "-I", DBMOVE, "counts", "http://127.0.0.1:%d" % port],
                   capture_output=True, text=True, env=dict(os.environ, SPIKE_TOKEN="t"))
srv.shutdown()
try:
    out = json.loads(r.stdout.strip())
except Exception:
    out = None
ok("dbmove counts: GETs /_dbcounts and prints the rows form",
   r.returncode == 0 and out is not None and out.get("rows") == {"wp_posts": 5, "wp_postmeta": 200} and out.get("databaseBytes") == 54538240)

print("%d failing check(s)" % fails)
sys.exit(fails)
