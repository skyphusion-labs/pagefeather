#!/usr/bin/env python3
"""spikes/b2-wordpress/content-id.py (issue #285): a content-only change gives a new build id."""
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("content_id", Path(__file__).resolve().parents[1] / "content-id.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

fails = 0


def check(name, ok):
    global fails
    print(("ok   " if ok else "FAIL ") + name)
    fails += 0 if ok else 1


def tree(root, files):
    for rel, data in files.items():
        p = Path(root, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


base = {"plugins/woocommerce/woocommerce.php": b"x" * 10, "plugins/mcp-adapter/a.php": b"y" * 5,
        "themes/twentytwentyfive/style.css": b"z", "mu-plugins/edge-cache.php": b"e" * 3}
with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
    tree(a, base)
    tree(b, {**base, "plugins/seo-by-rank-math/rank-math.php": b"r" * 7})
    env = {"IMPORT_CONTENT": "/x/wp-content", "IMPORT_PLUGINS": "mcp-adapter woocommerce"}
    env_rm = {**env, "IMPORT_PLUGINS": "mcp-adapter seo-by-rank-math woocommerce"}
    ia, ib = m.content_id(a, env), m.content_id(b, env_rm)
    check("a content input gives c<8 hex>", len(ia) == 9 and ia.startswith("c"))
    check("the same tree and inputs give the same id", m.content_id(a, env) == ia)
    check("the same content from another directory is the same id", m.content_id(a, {**env, "IMPORT_CONTENT": "/y/wp-content"}) == ia)
    check("the input order does not matter", m.content_id(a, {**env, "IMPORT_PLUGINS": "woocommerce mcp-adapter"}) == ia)
    with tempfile.TemporaryDirectory() as c:
        tree(c, {**base, "plugins/woocommerce/woocommerce.php": b"q" * 10})
        check("a changed file of the SAME size (a same-size plugin update) gives a new id", m.content_id(c, env) != ia)
    check("adding a plugin gives a new id (the ggc-test case)", ib != ia)
    check("a changed input alone gives a new id", m.content_id(a, env_rm) != ia)
    tree(a, {"plugins/woocommerce/woocommerce.php": b"x" * 11})
    check("a changed file size (a new plugin version) gives a new id", m.content_id(a, env) != ia)
    check("no content input prints nothing (a plain build keeps its id)", m.content_id(a, {}) == "")
    check("PLUGINS alone is a content input", m.content_id(a, {"PLUGINS": "wordpress-seo"}).startswith("c"))

print(f"{fails} failing case(s)")
sys.exit(1 if fails else 0)
