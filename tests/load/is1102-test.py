#!/usr/bin/env python3
"""load.py's 1102 counter (Worker exceeded resource limits): a 5xx with 1102 counts; a 2xx or 4xx
whose body merely holds the bytes "1102" (an order id, a price) does not. No site.
  python3 tests/load/is1102-test.py [path/to/load.py]"""
import ast, os, sys
p = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "load.py")
tree = ast.parse(open(p).read())
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "is_1102")
ns = {}
exec(compile(ast.Module(body=[fn], type_ignores=[]), p, "exec"), ns)
is_1102 = ns["is_1102"]
cases = [
    ("a 503 Cloudflare 1102 page counts", {"code": 503, "body": b"<title>Worker exceeded resource limits | Error 1102</title>"}, True),
    ("a 500 with 1102 counts", {"code": 500, "body": b"error code: 1102"}, True),
    ("a 201 whose JSON holds 1102 (an id) does NOT count", {"code": 201, "body": b'{"id":1102,"status":"draft"}'}, False),
    ("a 200 with 1102 in the page does NOT count", {"code": 200, "body": b"price 11.02 order 1102"}, False),
    ("a 404 holding 1102 does NOT count", {"code": 404, "body": b"/p/1102 not found"}, False),
    ("a client exception (code EXC) does NOT count", {"code": "EXC", "body": b"1102"}, False),
    ("a 503 without 1102 does not count as 1102", {"code": 503, "body": b"busy"}, False),
]
fails = 0
for name, r, want in cases:
    got = is_1102(r)
    print(("ok   " if got == want else "FAIL ") + name)
    fails += got != want
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
