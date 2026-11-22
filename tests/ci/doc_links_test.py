#!/usr/bin/env python3
"""#1305: tests for tests/ci/doc_links.py. Each case builds a small git repo, runs the check, and
asserts the exit code and the failure lines. Every failure class has a control that passes, so a
check that always fails, or always passes, is caught. Python 3.9, standard library only.

    python3 -I tests/ci/doc_links_test.py
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.join(HERE, "doc_links.py")
runs = fails = 0


def repo(files, untracked=None):
    d = tempfile.mkdtemp(prefix="doclinks-")
    for rel, body in files.items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(body if isinstance(body, bytes) else body.encode())
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
    subprocess.run(["git", "init", "-q", d], check=True, env=env)
    subprocess.run(["git", "-C", d, "add", "-A"], check=True, env=env)
    for rel, body in (untracked or {}).items():
        with open(os.path.join(d, rel), "w") as f:
            f.write(body)
    return d


def run(files, untracked=None):
    d = repo(files, untracked)
    r = subprocess.run([sys.executable, "-I", CHECK, d], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    subprocess.run(["rm", "-rf", d], check=True)
    return r.returncode, r.stdout.decode()


def case(name, files, rc, has=(), lacks=(), untracked=None):
    global runs, fails
    runs += 1
    got, out = run(files, untracked)
    bad = [h for h in has if h not in out] + ["(must not print) " + l for l in lacks if l in out]
    if got != rc or bad:
        fails += 1
        print("  FAIL %s: rc %s (want %s) %s\n%s" % (name, got, rc, bad, out))
    else:
        print("  ok   " + name)


OK = {"docs/a.md": "# A\n", "docs/guide/b.md": "# B\n"}

# 1. relative links
case("a relative link to a file that exists passes", dict(OK, **{"README.md": "[a](docs/a.md)\n"}), 0)
case("a relative link to a missing file fails", dict(OK, **{"README.md": "x\n[gone](docs/gone.md)\n"}), 1,
     has=["README.md:2: link to a missing file: docs/gone.md"])
case("a link resolves from the linking file's own folder", dict(OK, **{"docs/guide/c.md": "[a](../a.md) [b](b.md)\n"}), 0)
case("a link that only exists from the repo root, not from the file's folder, fails",
     dict(OK, **{"docs/guide/c.md": "[a](docs/a.md)\n"}), 1, has=["docs/guide/c.md:1: link to a missing file: docs/a.md"])
case("a fragment is not checked, the file is", dict(OK, **{"README.md": "[a](docs/a.md#no-such-heading)\n"}), 0)
case("a fragment on a missing file still fails", dict(OK, **{"README.md": "[x](docs/gone.md#h)\n"}), 1,
     has=["link to a missing file: docs/gone.md#h"])
case("an image to a missing file fails", dict(OK, **{"README.md": "![p](img/p.png)\n"}), 1,
     has=["README.md:1: link to a missing file: img/p.png"])
case("a reference definition to a missing file fails", dict(OK, **{"README.md": "[x][r]\n\n[r]: docs/gone.md\n"}), 1,
     has=["README.md:3: link to a missing file: docs/gone.md"])
case("a link to a folder that exists passes", dict(OK, **{"README.md": "[g](docs/guide/)\n"}), 0)
case("a root-absolute link resolves from the repo root", dict(OK, **{"docs/guide/c.md": "[a](/docs/a.md)\n"}), 0)
case("a link that leaves the repo fails", dict(OK, **{"README.md": "[o](../outside.md)\n"}), 1,
     has=["link to a missing file: ../outside.md"])
case("https, mailto and #fragment links are not relative",
     dict(OK, **{"README.md": "[w](https://example.com/x.md) [m](mailto:a@b.c) [h](#top)\n"}), 0)
case("a percent-encoded path is decoded", dict(OK, **{"docs/a b.md": "# AB\n", "README.md": "[ab](docs/a%20b.md)\n"}), 0)
case("a link in fenced code is not checked", dict(OK, **{"README.md": "```\n[x](nope.md)\n```\n"}), 0)
case("a link in inline code is not checked", dict(OK, **{"README.md": "Use `[x](nope.md)` like this.\n"}), 0)
case("a link after a closed fence is checked again", dict(OK, **{"README.md": "```\nx\n```\n[x](nope.md)\n"}), 1,
     has=["README.md:4: link to a missing file: nope.md"])

# 2. stubs
STUB = "# Old\n\nThis page moved to [B](guide/b.md).\n\n## H\n\nThe current text is [H](guide/b.md#h).\n"
case("a stub whose target exists passes, and is counted", dict(OK, **{"docs/old.md": STUB}), 0, has=["1 stubs"])
case("a stub whose target is missing fails", dict(OK, **{"docs/old.md": STUB.replace("guide/b.md", "guide/gone.md")}), 1,
     has=["docs/old.md:3: link to a missing file: guide/gone.md"])
case("a stub with no relative link fails", dict(OK, **{"docs/old.md": "# Old\n\nThis page moved to [B](https://example.com/b).\n"}), 1,
     has=["docs/old.md: a stub (\"This page moved to\") with no relative link to a file"])

# 3. docs/<name>.md path strings, in any tracked text file
case("a path string to a file that exists passes", dict(OK, **{"tool.py": "# see docs/a.md and docs/guide/b.md\n"}), 0)
case("a path string to a missing file fails, in a code comment", dict(OK, **{"deploy/x.sh": "#!/bin/sh\n# see docs/gone.md\n"}), 1,
     has=["deploy/x.sh:2: path string names a missing file: docs/gone.md"])
case("a path string in a Markdown code span is checked", dict(OK, **{"README.md": "Read `docs/gone.md`.\n"}), 1,
     has=["README.md:1: path string names a missing file: docs/gone.md"])
case("a path string relative to the file's own folder passes",
     dict(OK, **{"spikes/s/README.md": "See `docs/p.md`.\n", "spikes/s/docs/p.md": "# P\n"}), 0)
case("a stub counts as an existing file for a path string",
     dict(OK, **{"docs/old.md": STUB, "lib.sh": "# docs/old.md\n"}), 0)
case("a longer path is not read as a docs/ path string", dict(OK, **{"x.txt": "spikes/s/docs/gone.md and ../docs/gone.md\n"}), 0)
case("placeholders are not path strings", dict(OK, **{"x.txt": "docs/<name>.md docs/*.md\n"}), 0)
case("a binary file is skipped", dict(OK, **{"b.bin": b"\0docs/gone.md"}), 0)
case("an untracked file is not read", dict(OK, **{"README.md": "[a](docs/a.md)\n"}), 0,
     untracked={"scratch.md": "[x](gone.md) docs/gone.md\n"}, has=["3 Markdown files"])

# the instrument itself
case("a tree with no Markdown reads nothing and fails", {"x.txt": "hello\n"}, 1, has=["0 Markdown files"])
case("every failure is printed, with the count", dict(OK, **{"README.md": "[x](g1.md) [y](g2.md)\n", "a.sh": "# docs/g3.md\n"}), 1,
     has=["link to a missing file: g1.md", "link to a missing file: g2.md", "names a missing file: docs/g3.md", "3 failures"])

print("cases_run=%d failed=%d" % (runs, fails))
sys.exit(1 if fails or runs == 0 else 0)
