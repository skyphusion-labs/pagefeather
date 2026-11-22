#!/usr/bin/env python3
"""#1305: the docs link check. Python 3.9, standard library only.

    python3 -I tests/ci/doc_links.py [repo root]

It reads every file git tracks under the root, and it fails (exit 1) on any of these:

1. A relative Markdown link, in a tracked .md file, to a file or folder that does not exist.
   Inline links and images [t](x) and reference definitions [t]: x count. Links in fenced code
   and in inline code do not. A link with a scheme (https:, mailto:) or only a #fragment is not
   relative. A path that starts with / resolves from the repo root, as on GitHub.
2. A stub that does not link to a file that exists. A stub is a .md file with a line that starts
   "This page moved to [" (the shape in #1305). It must hold at least one relative link, and
   rule 1 checks that each one exists.
3. A repo path string docs/<name>.md, in ANY tracked text file (code comments included), that
   exists neither from the repo root nor from the file's own folder (spikes/b2-wordpress/README.md
   names its own docs/pdf-invoice.md). A stub counts as existing, because it is a file.

It does not check that a #fragment names a heading: a stub's new page may reword a heading later
(#1305, "Open questions").

It prints every failure as file:line, and the count of what it checked, and it exits 1 on zero
Markdown files: a check that read nothing must not pass.
"""
import os
import re
import subprocess
import sys
import urllib.parse

INLINE = re.compile(r"!?\[(?:[^\[\]]|\[[^\[\]]*\])*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)")
REFDEF = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)")
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
CODESPAN = re.compile(r"(`+)(.+?)\1")
STUB = re.compile(r"^This page moved to \[")
DOCPATH = re.compile(r"(?<![A-Za-z0-9_./-])docs/[A-Za-z0-9_./-]*?[A-Za-z0-9_-]\.md(?![A-Za-z0-9_])")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def tracked(root):
    out = subprocess.run(["git", "-C", root, "ls-files", "-z"], stdout=subprocess.PIPE, check=True).stdout
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p]


def text_of(path):
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    if b"\0" in data:
        return None
    return data.decode("utf-8", "replace")


def md_lines(text):
    """(line number, line with inline code blanked) for each line outside fenced code."""
    fence = None
    for n, line in enumerate(text.splitlines(), 1):
        m = FENCE.match(line)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                fence = None
            continue
        if m:
            fence = m.group(1)
            continue
        yield n, CODESPAN.sub(lambda c: " " * len(c.group(0)), line)


def target_path(root, md_rel, target):
    """The repo-relative path a link target names, or None if it is not a relative file link."""
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    if not target or target.startswith("#") or SCHEME.match(target) or target.startswith("//"):
        return None
    path = urllib.parse.unquote(target.split("#", 1)[0].split("?", 1)[0])
    if not path:
        return None
    if path.startswith("/"):
        return os.path.normpath(path.lstrip("/"))
    return os.path.normpath(os.path.join(os.path.dirname(md_rel), path))


def exists(root, rel):
    if rel == ".." or rel.startswith("../"):
        return False  # outside the repo
    return os.path.exists(os.path.join(root, rel))


def check(root):
    files = tracked(root)
    fails = []
    n_md = n_links = n_stubs = n_paths = 0
    for rel in files:
        full = os.path.join(root, rel)
        if os.path.islink(full):
            continue
        text = text_of(full)
        if text is None:
            continue
        if rel.endswith(".md"):
            n_md += 1
            stub = False
            stub_links = 0
            for n, line in md_lines(text):
                if STUB.match(line):
                    stub = True
                targets = [m.group(1) for m in INLINE.finditer(line)]
                m = REFDEF.match(line)
                if m:
                    targets.append(m.group(1))
                for t in targets:
                    p = target_path(root, rel, t)
                    if p is None:
                        continue
                    n_links += 1
                    stub_links += 1
                    if not exists(root, p):
                        fails.append("%s:%d: link to a missing file: %s" % (rel, n, t))
            if stub:
                n_stubs += 1
                if stub_links == 0:
                    fails.append("%s: a stub (\"This page moved to\") with no relative link to a file" % rel)
        for n, line in enumerate(text.splitlines(), 1):
            for m in DOCPATH.finditer(line):
                n_paths += 1
                here = os.path.normpath(os.path.join(os.path.dirname(rel), m.group(0)))
                if not exists(root, m.group(0)) and not exists(root, here):
                    fails.append("%s:%d: path string names a missing file: %s" % (rel, n, m.group(0)))
    for f in fails:
        print("  FAIL " + f)
    print("doc links: %d Markdown files, %d relative links, %d stubs, %d docs/*.md path strings; %d failures"
          % (n_md, n_links, n_stubs, n_paths, len(fails)))
    if n_md == 0:
        print("  no tracked Markdown file under %s: the check read nothing" % root, file=sys.stderr)
        return 1
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(check(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")))
