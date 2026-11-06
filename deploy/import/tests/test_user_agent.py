#!/usr/bin/env python3
"""dbmove.py must send its own User-Agent (issue #31).

A deployed workers.dev site refused urllib's default User-Agent at the edge:
HTTP 403 "error code: 1010" (2026-11-06, wp-import-test). This server answers
the same way when the User-Agent starts with "Python-urllib", and records what
it got. It is a stand-in for that one check, not for the edge.
Run: python3 deploy/import/tests/test_user_agent.py
"""
import http.server
import importlib.util
import os
import threading
import unittest

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dbmove", os.path.join(here, "..", "..", "..", "spikes", "b2-wordpress", "dbmove.py"))
dbmove = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dbmove)
seen = []


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def answer(self):
        ua = self.headers.get("user-agent", "")
        seen.append(ua)
        n = int(self.headers.get("content-length") or 0)
        if n:
            self.rfile.read(n)
        body = b"error code: 1010" if ua.startswith("Python-urllib") or not ua else b'{"ok":true,"statements":1,"databaseBytes":1}'
        self.send_response(403 if body.startswith(b"error") else 200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = answer


class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_post_sends_own_user_agent(self):
        seen.clear()
        with dbmove.call("POST", self.base + "/_dbimport", b'{"end":true,"rows":0}\n') as r:
            self.assertEqual(r.status, 200)
        self.assertEqual(seen, ["wp-on-cf-import/1"])

    def test_get_sends_own_user_agent(self):
        seen.clear()
        with dbmove.call("GET", self.base + "/_dbexport") as r:
            self.assertEqual(r.status, 200)
        self.assertEqual(seen, ["wp-on-cf-import/1"])


if __name__ == "__main__":
    unittest.main()
