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
    # THEMES, SUITE and THEME_SUITE (#457): hashed only when set, so the ids of existing builds do not move.
    check("THEMES alone is a content input", m.content_id(a, {"THEMES": "hello-elementor"}).startswith("c"))
    check("a changed THEMES gives a new id", m.content_id(a, {**env, "THEMES": "astra"}) != m.content_id(a, {**env, "THEMES": "hello-elementor"}))
    check("a changed SUITE gives a new id", m.content_id(a, {**env, "SUITE": "gate2-build.txt"}) != m.content_id(a, env))
    check("a changed THEME_SUITE gives a new id", m.content_id(a, {**env, "THEME_SUITE": "x.txt"}) != m.content_id(a, env))
    check("the new inputs, when empty, leave an existing id as it was", m.content_id(a, {**env, "THEMES": "", "SUITE": "", "THEME_SUITE": " "}) == m.content_id(a, env))

# The ids of builds made before #457 do not move (#457 hashes THEMES, SUITE and THEME_SUITE only when
# set). c634f45b1 is what content-id.py at main 3aa3847 (before #457) printed for this tree and input.
with tempfile.TemporaryDirectory() as fixed:
    tree(fixed, {"plugins/woocommerce/woocommerce.php": b"x" * 10, "themes/twentytwentyfive/style.css": b"z"})
    check("a build with none of the new inputs keeps its pre-#457 id", m.content_id(fixed, {"PLUGINS": "woocommerce"}) == "c634f45b1")
    check("  and with them set but empty", m.content_id(fixed, {"PLUGINS": "woocommerce", "THEMES": "", "SUITE": "", "THEME_SUITE": ""}) == "c634f45b1")

# The static files (#385 follow-up): build.sh moves every .js, image, most .css and the .mo/.po of
# wp-content into build/public (Workers static assets) BEFORE the id is made. An id over the PHP tree
# alone did not change when only a static file changed: measured with the ggc tree at 5c51fd5, a one-line
# edit of mu-plugins/ggc-cart.js kept build id 5c51fd5bee44-c30402182-wooprimed, so site update skipped
# it as "already at build". The public tree is hashed too.
with tempfile.TemporaryDirectory() as php, tempfile.TemporaryDirectory() as pub, tempfile.TemporaryDirectory() as pub2:
    tree(php, base)
    tree(pub, {"mu-plugins/ggc-cart.js": b"cart v1", "themes/twentytwentyfive/assets/a.css": b"c"})
    tree(pub2, {"mu-plugins/ggc-cart.js": b"cart v2", "themes/twentytwentyfive/assets/a.css": b"c"})
    env = {"IMPORT_CONTENT": "/x/wp-content", "IMPORT_MU_PLUGINS": "ggc-cart.js"}
    i1, i2 = m.content_id(php, env, pub), m.content_id(php, env, pub2)
    check("THE GGC-CART CASE: a change to only a static file (the public tree) gives a new id", i1 != i2)
    check("the same PHP and public trees give the same id", m.content_id(php, env, pub) == i1)
    check("a file moving between the trees is not the same id (the trees are labelled)", m.content_id(pub, env, php) != m.content_id(php, env, pub))
    check("no public tree (a missing dir) still gives an id", m.content_id(php, env, os.path.join(pub, "nope")).startswith("c"))

print(f"{fails} failing case(s)")
sys.exit(1 if fails else 0)
