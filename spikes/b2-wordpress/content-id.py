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

Those trees are the built wp-content. build.sh copies the engine mu-plugins (MU_PLUGINS)
into mu-plugins/ before build-id.sh computes this id, so the id covers those engine files
too (#1427). A change to one of them changes the content id. The same tree still gives the
same id.

SUITE and THEME_SUITE name pin files. The hash uses each file's bytes, not its path, so the
same pins in another directory are the same build (#1427). A name with no "/" is the file
beside tests/plugins/, as fetch.sh reads it. THEMES is a list of slugs and is hashed as
that list.
"""
import hashlib
import os
import sys

INPUTS = ("PLUGINS", "IMPORT_THEMES", "IMPORT_PLUGINS", "IMPORT_MU_PLUGINS", "WOO")
# Added by #457. Hashed only when set, so a build with none of them keeps the id it had before.
# SUITE and THEME_SUITE are pin files: their bytes, not the path (#1427).
INPUTS_IF_SET = ("THEMES", "SUITE", "THEME_SUITE")
PIN_FILES = ("SUITE", "THEME_SUITE")
TREES = ("plugins", "themes", "mu-plugins")


def plugins_dir():
    """tests/plugins, where fetch.sh reads a pin name that has no slash.

    This file lives at spikes/b2-wordpress/content-id.py. A copy of it (a test
    stand-in) has no such neighbour; pass a path that contains "/" for that.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "tests", "plugins"))


def read_pin(key, raw):
    """The bytes of a SUITE or THEME_SUITE pin file. A missing file is an error:
    the id must not pretend it hashed pins it could not read."""
    text = str(raw).strip()
    path = os.path.join(plugins_dir(), text) if "/" not in text else text
    if not os.path.isfile(path):
        raise OSError("%s names %r, which is not a pin file (%s)" % (key, raw, path))
    with open(path, "rb") as fp:
        return fp.read()


def content_id(wp_content, env, public=None):
    """public: the wp-content of build/public, where build.sh moves the static files (.js, images,
    most .css, .mo/.po) before the id is made. Hashed after the PHP tree, its paths labelled
    "public/", so a change to only a static file gives a new id too."""
    if not env.get("PLUGINS") and not env.get("IMPORT_CONTENT") and not env.get("THEMES"):
        return ""
    h = hashlib.sha256()
    # The values, not IMPORT_CONTENT's path: the same content from another directory is the
    # same build. SUITE and THEME_SUITE are pin files, so hash their bytes the same way (#1427).
    for k in INPUTS:
        h.update(f"{k}={' '.join(sorted(str(env.get(k, '')).split()))}\n".encode())
    for k in INPUTS_IF_SET:
        raw = str(env.get(k, "") or "").strip()
        if not raw:
            continue
        if k in PIN_FILES:
            digest = hashlib.sha256(read_pin(k, raw)).hexdigest()
            h.update(f"{k}\0{digest}\n".encode())
        else:
            h.update(f"{k}={' '.join(sorted(raw.split()))}\n".encode())
    # plugins, themes and mu-plugins of the built tree. build.sh has already copied the
    # engine mu-plugins (MU_PLUGINS) into mu-plugins/, so those engine files are in this id.
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
    try:
        print(content_id(sys.argv[1], os.environ, sys.argv[2] if len(sys.argv) == 3 else None))
    except OSError as err:
        sys.exit("content-id: %s" % err)
