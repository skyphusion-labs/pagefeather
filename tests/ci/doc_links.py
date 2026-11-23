#!/usr/bin/env python3
"""#1305: the docs link check. Standard library only. Checked on Python 3.9.6, 3.15.2 and CI's python3.

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
   names spikes/b2-wordpress/docs/pdf-invoice.md that way). A stub counts as existing, because it
   is a file. tests/ci/doc_links_test.py is not read: its path strings are planted fixtures.

4. A #fragment that names no anchor in its target (#1377). This covers a relative link to a tracked
   .md file, and a same-page link (#x), in a tracked .md file. An anchor is a heading's GitHub slug
   (lower case; markup, and punctuation other than - and _, removed; each space a -; a repeated
   heading gets -1, -2), or an HTML id= or name= in the target. Fenced code holds no heading. The
   fragment is percent-decoded and compared as written. A fragment on any other file (a .py#L10
   line link) is not checked. Links FROM a stub are not checked for their fragment, only for their
   file (rule 1): a stub is an old pointer, and its new page may reword a heading later (#1305,
   "Open questions").

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
HEADING = re.compile(r"^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$")
SETEXT = re.compile(r"^\s{0,3}(=+|-+)\s*$")
HTMLID = re.compile(r"""<[A-Za-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']""")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
FIXTURES = {"tests/ci/doc_links_test.py"}  # planted broken paths, by design


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


def slug(text):
    """GitHub's heading anchor: link text kept, markup dropped, lower case, spaces to -."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.strip().lower().replace("`", "").replace("*", "")
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(text):
    """Every anchor a Markdown file defines: heading slugs (repeats numbered) and HTML ids."""
    seen = {}
    out = set()
    prev = None
    fence = None
    for line in text.splitlines():
        m = FENCE.match(line)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                fence = None
            prev = None
            continue
        if m:
            fence = m.group(1)
            prev = None
            continue
        out.update(HTMLID.findall(line))
        h = HEADING.match(line)
        title = h.group(2) if h else (prev if prev is not None and SETEXT.match(line) else None)
        if title is not None:
            base = slug(title)
            n = seen.get(base, 0)
            seen[base] = n + 1
            out.add(base if n == 0 else "%s-%d" % (base, n))
            prev = None
            continue
        prev = line if line.strip() and not re.match(r"^\s{0,3}([-*+]|\d+[.)]|\||>)", line) else None
    return out


def fragment(target):
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    if "#" not in target or SCHEME.match(target) or target.startswith("//"):
        return None
    return urllib.parse.unquote(target.split("#", 1)[1])


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
    n_md = n_links = n_stubs = n_paths = n_frags = 0
    cache = {}

    def anchors_of(rel):
        if rel not in cache:
            t = text_of(os.path.join(root, rel))
            cache[rel] = anchors(t) if t is not None else set()
        return cache[rel]
    tracked_set = set(files)
    for rel in files:
        full = os.path.join(root, rel)
        if os.path.islink(full) or rel in FIXTURES:
            continue
        text = text_of(full)
        if text is None:
            continue
        if rel.endswith(".md"):
            n_md += 1
            stub = any(STUB.match(l) for _, l in md_lines(text))
            stub_links = 0
            for n, line in md_lines(text):
                targets = [m.group(1) for m in INLINE.finditer(line)]
                m = REFDEF.match(line)
                if m:
                    targets.append(m.group(1))
                for t in targets:
                    frag = fragment(t)
                    p = target_path(root, rel, t)
                    if frag and not stub:
                        doc = rel if t.lstrip("<").startswith("#") else p
                        if doc and doc.endswith(".md") and doc in tracked_set:
                            n_frags += 1
                            if frag not in anchors_of(doc):
                                fails.append("%s:%d: #%s names no heading or anchor in %s" % (rel, n, frag, doc))
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
    print("doc links: %d Markdown files, %d relative links, %d #fragments, %d stubs, %d docs/*.md path strings; %d failures"
          % (n_md, n_links, n_frags, n_stubs, n_paths, len(fails)))
    if n_md == 0:
        print("  no tracked Markdown file under %s: the check read nothing" % root, file=sys.stderr)
        return 1
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(check(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")))
