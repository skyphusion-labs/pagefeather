#!/usr/bin/env python3
"""sqlimport.py load: the CREATE preflight runs before replace=1 (issue #31).

A stand-in for /_sqlimport records each request. With a CREATE that the
preflight refuses, the load must stop with no replace=1 request at all, so
the site is not emptied. Run: python3 deploy/import/tests/test_sqlimport_client.py
"""
import http.server
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

here = os.path.dirname(os.path.abspath(__file__))
client = os.path.join(here, "..", "sqlimport.py")
seen = []
refuse = {"on": False}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"])).decode()
        seen.append(self.path)
        lines = [json.loads(l)["sql"] for l in body.splitlines() if l.strip()]
        if "preflight=1" in self.path:
            bad = next((i + 1 for i, s in enumerate(lines) if refuse["on"] and "zero" in s), None)
            o = {"ok": False, "line": bad, "error": "Invalid default value", "preflight": True} if bad else {"ok": True, "preflight": len(lines)}
        else:
            o = {"ok": True, "statements": len(lines), "dropped": 3 if "replace=1" in self.path else 0}
        b = json.dumps(o).encode()
        self.send_response(400 if o.get("ok") is False else 200)
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        fd, cls.file = tempfile.mkstemp(suffix=".jsonl")
        with os.fdopen(fd, "w") as f:
            for s in ["DROP TABLE IF EXISTS `wp_a`", "CREATE TABLE `wp_a` (`id` int)", "INSERT INTO `wp_a` VALUES (1)",
                      "DROP TABLE IF EXISTS `wp_b`", "CREATE TABLE `wp_b` (`d` datetime DEFAULT 'zero')", "INSERT INTO `wp_b` VALUES (1)"]:
                f.write(json.dumps({"sql": s}) + "\n")

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        os.unlink(cls.file)

    def load(self):
        return subprocess.run([sys.executable, client, "load", self.url, self.file, "--replace"], capture_output=True, text=True, env={**os.environ, "SPIKE_TOKEN": "t"})

    def test_preflight_first_then_replace(self):
        seen.clear(); refuse["on"] = False
        r = self.load()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(seen, ["/_sqlimport?preflight=1", "/_sqlimport?replace=1"])
        self.assertIn("preflight: 2 CREATE TABLE statements", r.stdout)

    def test_refused_create_stops_before_replace(self):
        seen.clear(); refuse["on"] = True
        r = self.load()
        self.assertEqual(r.returncode, 1)
        self.assertEqual(seen, ["/_sqlimport?preflight=1"])
        self.assertIn("PREFLIGHT REFUSED CREATE TABLE 2 of 2", r.stderr)
        self.assertIn("Nothing was dropped", r.stderr)


if __name__ == "__main__":
    unittest.main()
