#!/usr/bin/env python3
"""The content part of a b-dosql build id (issue #285).

    python3 content-id.py <wp-content dir>    prints "c<8 hex>", or nothing

build.sh names a build by its git commit. A build whose only change is its content inputs
(PLUGINS, THEMES, IMPORT_CONTENT with IMPORT_THEMES, IMPORT_PLUGINS, IMPORT_MU_PLUGINS) would get the
same id as the build before it, and site update would skip it as "already at build". So when
any content input is set, the id also carries this short hash. It covers the input values and
every file under wp-content/plugins, themes and mu-plugins (its path and the SHA-256 of its
bytes), so the same inputs give the same id, and a different plugin set or any changed file
(a plugin update, even one that keeps every file size) gives a new one. With no content
input set it prints nothing, and a plain build keeps its id.
"""
import hashlib
import os
import sys

INPUTS = ("PLUGINS", "IMPORT_THEMES", "IMPORT_PLUGINS", "IMPORT_MU_PLUGINS", "WOO")
# Added by #457. Hashed only when set, so a build with none of them keeps the id it had before.
INPUTS_IF_SET = ("THEMES", "SUITE", "THEME_SUITE")
TREES = ("plugins", "themes", "mu-plugins")


def content_id(wp_content, env, public=None):
    """public: the wp-content of build/public, where build.sh moves the static files (.js, images,
    most .css, .mo/.po) before the id is made. Hashed after the PHP tree, its paths labelled
    "public/", so a change to only a static file gives a new id too."""
    if not env.get("PLUGINS") and not env.get("IMPORT_CONTENT") and not env.get("THEMES"):
        return ""
    h = hashlib.sha256()
    # The values, not IMPORT_CONTENT's path: the same content from another directory is the
    # same build.
    for k in INPUTS:
        h.update(f"{k}={' '.join(sorted(str(env.get(k, '')).split()))}\n".encode())
    for k in INPUTS_IF_SET:
        if str(env.get(k, "") or "").strip():
            h.update(f"{k}={' '.join(sorted(str(env.get(k, '')).split()))}\n".encode())
    for label, base in (("", wp_content), ("public/", public)):
        if not base:
            continue
        for tree in TREES:
            root = os.path.join(base, tree)
            for d, dirs, files in os.walk(root):
                dirs.sort()
                for f in sorted(files):
                    p = os.path.join(d, f)
                    rel = label + os.path.relpath(p, base).replace(os.sep, "/")
                    fh = hashlib.sha256()
                    with open(p, "rb") as fp:
                        for chunk in iter(lambda: fp.read(1 << 20), b""):
                            fh.update(chunk)
                    h.update(f"{rel}\0{fh.hexdigest()}\n".encode())
    return "c" + h.hexdigest()[:8]


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit("usage: content-id.py <wp-content dir> [<public wp-content dir>]")
    print(content_id(sys.argv[1], os.environ, sys.argv[2] if len(sys.argv) == 3 else None))
