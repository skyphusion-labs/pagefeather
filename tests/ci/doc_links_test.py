#!/usr/bin/env python3
"""#1305: tests for tests/ci/doc_links.py. Each case builds a small git repo, runs the check, and
asserts the exit code and the failure lines. Every failure class has a control that passes, so a
check that always fails, or always passes, is caught. Standard library only.

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
case("a fragment that names a heading passes", dict(OK, **{"README.md": "[a](docs/a.md#a)\n"}), 0, has=["1 #fragments"])
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
case("https, mailto and #fragment links are not relative files",
     dict(OK, **{"README.md": "# Top\n\n[w](https://example.com/x.md) [m](mailto:a@b.c) [h](#top)\n"}), 0, has=["0 relative links"])
case("a percent-encoded path is decoded", dict(OK, **{"docs/a b.md": "# AB\n", "README.md": "[ab](docs/a%20b.md)\n"}), 0)
case("a link in fenced code is not checked", dict(OK, **{"README.md": "```\n[x](nope.md)\n```\n"}), 0)
case("a link in inline code is not checked", dict(OK, **{"README.md": "Use `[x](nope.md)` like this.\n"}), 0)
case("a link after a closed fence is checked again", dict(OK, **{"README.md": "```\nx\n```\n[x](nope.md)\n"}), 1,
     has=["README.md:4: link to a missing file: nope.md"])

# 4. #fragments (#1377)
H = {"docs/x.md": "# X\n", "docs/h.md": "# Top\n\n## The `code` part: *big* (#12)\n\n## Twice\n\n## Twice\n\n```\n## In a fence\n```\n\n<a id=\"raw-id\"></a>\n\nSetext one\n==========\n\n## A [linked](x.md) word\n"}
case("a fragment that names no heading fails, with file:line", dict(OK, **{"README.md": "x\n[a](docs/a.md#no-such-heading)\n"}), 1,
     has=["README.md:2: #no-such-heading names no heading or anchor in docs/a.md"])
case("a heading slug drops code marks, emphasis and punctuation", dict(H, **{"README.md": "[x](docs/h.md#the-code-part-big-12)\n"}), 0)
case("a slug keeps the case rule: an upper-case fragment fails", dict(H, **{"README.md": "[x](docs/h.md#Top)\n"}), 1,
     has=["#Top names no heading"])
case("a repeated heading gets -1", dict(H, **{"README.md": "[x](docs/h.md#twice) [y](docs/h.md#twice-1)\n"}), 0)
case("a third copy of a repeated heading does not exist", dict(H, **{"README.md": "[x](docs/h.md#twice-2)\n"}), 1,
     has=["#twice-2 names no heading"])
case("a heading inside fenced code is not an anchor", dict(H, **{"README.md": "[x](docs/h.md#in-a-fence)\n"}), 1,
     has=["#in-a-fence names no heading"])
case("an HTML id is an anchor", dict(H, **{"README.md": "[x](docs/h.md#raw-id)\n"}), 0)
case("a setext heading is an anchor", dict(H, **{"README.md": "[x](docs/h.md#setext-one)\n"}), 0)
case("a link inside a heading keeps its text", dict(H, **{"README.md": "[x](docs/h.md#a-linked-word)\n"}), 0)
case("a same-page fragment is checked", {"README.md": "# Here\n\n[u](#here) [d](#gone)\n"}, 1,
     has=["README.md:3: #gone names no heading or anchor in README.md"], lacks=["#here names"])
case("a percent-encoded fragment is decoded", dict(H, **{"README.md": "[x](docs/h.md#raw%2Did)\n"}), 0)
case("a fragment on a non-Markdown file is not checked", dict(OK, **{"tool.py": "x\n", "README.md": "[t](tool.py#L1)\n"}), 0)
case("a fragment on a URL is not checked", dict(OK, **{"README.md": "[w](https://example.com/a.md#nope)\n"}), 0)
case("a stub's own fragments are not checked, its file is",
     dict(OK, **{"docs/old.md": "# Old\n\nThis page moved to [B](guide/b.md#reworded).\n"}), 0)
case("a link INTO a stub's target is still checked", dict(OK, **{"docs/old.md": "# Old\n\nThis page moved to [B](guide/b.md).\n", "README.md": "[b](docs/guide/b.md#reworded)\n"}), 1,
     has=["#reworded names no heading or anchor in docs/guide/b.md"])

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
case("the test file is not read, its fixtures are planted", dict(OK, **{"tests/ci/doc_links_test.py": "# docs/gone.md\n"}), 0)
case("the fixture skip is by exact path only", dict(OK, **{"tests/ci/other_test.py": "# docs/gone.md\n"}), 1,
     has=["tests/ci/other_test.py:1: path string names a missing file: docs/gone.md"])
case("a tree with no Markdown reads nothing and fails", {"x.txt": "hello\n"}, 1, has=["0 Markdown files"])
case("every failure is printed, with the count", dict(OK, **{"README.md": "[x](g1.md) [y](g2.md)\n", "a.sh": "# docs/g3.md\n"}), 1,
     has=["link to a missing file: g1.md", "link to a missing file: g2.md", "names a missing file: docs/g3.md", "3 failures"])

print("cases_run=%d failed=%d" % (runs, fails))
sys.exit(1 if fails or runs == 0 else 0)
