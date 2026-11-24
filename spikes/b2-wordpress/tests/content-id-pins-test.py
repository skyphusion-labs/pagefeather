#!/usr/bin/env python3
"""SUITE and THEME_SUITE are pin files. The content id hashes their bytes, not their paths (#1427).

The same pins at two paths are one id. Different pin bytes are different ids.
A name with no slash is the file beside tests/plugins/, as fetch.sh reads it.
A path that is not a file is refused. THEMES stays a list of slugs.
"""
import importlib.util
import os
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("content_id", Path(__file__).resolve().parents[1] / "content-id.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

fails = 0
repo = Path(__file__).resolve().parents[3]
plugins = repo / "tests" / "plugins"


def check(name, ok):
    global fails
    print(("ok   " if ok else "FAIL ") + name)
    fails += 0 if ok else 1


def tree(root):
    p = Path(root, "plugins/woocommerce/woocommerce.php")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"woo")


def cid(root, **env):
    base = {"IMPORT_CONTENT": "/x/wp-content"}
    base.update(env)
    return m.content_id(root, base)


with tempfile.TemporaryDirectory() as d:
    tree(d)
    a = Path(d, "pins-a.txt")
    b = Path(d, "pins-b.txt")
    c = Path(d, "pins-c.txt")
    same = b"slug 1.2.3 abcdef\n# a comment\n"
    a.write_bytes(same)
    b.write_bytes(same)
    c.write_bytes(b"slug 9.9.9 ffffff\n")
    id_a = cid(d, SUITE=str(a))
    id_b = cid(d, SUITE=str(b))
    id_c = cid(d, SUITE=str(c))
    check("the same SUITE bytes at two paths are one id", id_a == id_b and id_a.startswith("c"))
    check("different SUITE bytes are different ids", id_a != id_c)
    ta = Path(d, "themes-a.txt")
    tb = Path(d, "themes-b.txt")
    td = Path(d, "themes-d.txt")
    theme = b"twentytwentyone 2.7 deadbeef\n"
    ta.write_bytes(theme)
    tb.write_bytes(theme)
    td.write_bytes(b"twentytwentyone 9.0 000000\n")
    check("the same THEME_SUITE bytes at two paths are one id", cid(d, THEME_SUITE=str(ta)) == cid(d, THEME_SUITE=str(tb)))
    check("different THEME_SUITE bytes are different ids", cid(d, THEME_SUITE=str(ta)) != cid(d, THEME_SUITE=str(td)))
    # The same bytes under the other key are not the same input.
    check("SUITE and THEME_SUITE stay distinct when the file bytes match", cid(d, SUITE=str(a)) != cid(d, THEME_SUITE=str(a)))
    bare = cid(d, SUITE="gate2-build.txt")
    absolute = cid(d, SUITE=str(plugins / "gate2-build.txt"))
    check("a bare pin name and that file's absolute path are one id", bare == absolute and bare.startswith("c"))
    check("THEMES is a slug list, not a pin file", cid(d, THEMES="not-a-file astra").startswith("c"))
    missing = str(Path(d, "no-such-pins.txt"))
    refused = False
    try:
        cid(d, SUITE=missing)
    except OSError:
        refused = True
    check("a SUITE path that is not a file is refused", refused)

print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
