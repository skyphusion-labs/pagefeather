#!/usr/bin/env python3
"""Map CodeQL c-cpp results in the patched php-src tree onto the engine's patch files (#608).

GitHub code scanning DROPS a result whose file is not in the repository: measured on the alert
control (#616), where the local SARIF held 2 planted cpp/very-likely-overrunning-write results at
codeql-build/php-src/ext/opcache/zend_persist.c and the uploaded analysis read results=0. The C we
own is the patch, so a result on a line that a patch ADDED is moved to that line of the .patch
file, which is in the repository. A result on an upstream php-src line is not ours: it is listed
in the log and not uploaded.

  codeql-sarif-map.py <in.sarif> <out.sarif> <php-src dir> <src-prefix> <applied-patches.txt>

<src-prefix> is the php-src path as the SARIF names it, relative to the source root
(codeql-build/php-src/). applied-patches.txt holds the repo-relative patch paths in the order the
build applied them. The line map is built by replaying each patch on the pristine file
(git show HEAD:<path> in the php-src clone); the replayed text must equal the built file byte for
byte, or the map is refused (exit 1), so an offset or fuzzy apply cannot misplace an alert.
"""
import json
import re
import subprocess
import sys

HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def parse_patch(path):
    """Yield (target, [hunk]) with hunk = (old_start, [(kind, text, patch_line)])."""
    lines = open(path, encoding="utf-8").read().split("\n")
    files, cur, hunk = [], None, None
    for i, l in enumerate(lines, 1):
        if l.startswith("diff --git "):
            cur = None
            continue
        if l.startswith("--- "):
            continue
        if l.startswith("+++ "):
            t = l[4:].split("\t")[0]
            if not t.startswith("b/"):
                fail(f"{path}:{i}: unexpected target {t}")
            cur = (t[2:], [])
            files.append(cur)
            hunk = None
            continue
        m = HUNK.match(l)
        if m:
            if cur is None:
                fail(f"{path}:{i}: hunk before a file header")
            hunk = (int(m.group(1)), [])
            cur[1].append(hunk)
            continue
        if hunk is None or l.startswith("\\"):
            continue
        if l[:1] in (" ", "-", "+"):
            hunk[1].append((l[0], l[1:], i))
    return files


def build_maps(php, patches):
    """{rel path: [origin per line]} with origin None (upstream) or (patch, patch line)."""
    state = {}  # rel -> (text lines, origins)
    for p in patches:
        for rel, hunks in parse_patch(p):
            if rel not in state:
                r = subprocess.run(["git", "-C", php, "show", f"HEAD:{rel}"], capture_output=True, text=True)
                if r.returncode != 0:
                    fail(f"{p}: {rel} is not in the pristine php-src tree")
                text = r.stdout.split("\n")
                state[rel] = (text, [None] * len(text))
            old, org = state[rel]
            new, norg, ptr = [], [], 0
            for start, body in hunks:
                s = max(start - 1, 0)
                if s < ptr:
                    fail(f"{p}: overlapping hunks in {rel}")
                new += old[ptr:s]; norg += org[ptr:s]; ptr = s
                for kind, text, pl in body:
                    if kind in (" ", "-"):
                        if ptr >= len(old) or old[ptr] != text:
                            fail(f"{p}:{pl}: the context does not match {rel}:{ptr + 1} (an offset or fuzzy apply)")
                        if kind == " ":
                            new.append(old[ptr]); norg.append(org[ptr])
                        ptr += 1
                    else:
                        new.append(text); norg.append((p, pl))
            new += old[ptr:]; norg += org[ptr:]
            state[rel] = (new, norg)
    for rel, (text, _) in state.items():
        built = open(f"{php}/{rel}", encoding="utf-8", errors="surrogateescape").read().split("\n")
        if built != text:
            fail(f"the replayed {rel} differs from the built file; the line map would be wrong")
    return {rel: org for rel, (_, org) in state.items()}


def main():
    src, dst, php, prefix, applied = sys.argv[1:6]
    patches = [l.strip() for l in open(applied) if l.strip()]
    if not patches:
        fail("no applied patches listed")
    maps = build_maps(php, patches)
    print(f"line maps: {len(maps)} patched files from {len(patches)} patches")
    d = json.load(open(src))
    kept = moved = dropped = 0

    def remap(loc):
        """Return the mapped physicalLocation, the unchanged one, or None to drop."""
        pl = loc.get("physicalLocation", {})
        uri = pl.get("artifactLocation", {}).get("uri", "")
        if not uri.startswith(prefix):
            return loc, None
        rel = uri[len(prefix):]
        line = pl.get("region", {}).get("startLine", 0)
        org = maps.get(rel)
        o = org[line - 1] if org and 0 < line <= len(org) else None
        if o is None:
            return None, f"{rel}:{line}"
        return {"physicalLocation": {"artifactLocation": {"uri": o[0], "uriBaseId": "%SRCROOT%"},
                                     "region": {"startLine": o[1]}}}, f"{rel}:{line}"

    for run in d.get("runs", []):
        run.pop("artifacts", None)
        out = []
        for r in run.get("results", []):
            loc, where = remap(r["locations"][0])
            if loc is None:
                dropped += 1
                print(f"upstream (not uploaded): {r['ruleId']} php-src/{where}")
                continue
            if where is not None:
                moved += 1
                r["locations"] = [loc]
                r["message"]["text"] = r["message"].get("text", "") + f" (php-src {where})"
                r.pop("partialFingerprints", None)
                print(f"mapped: {r['ruleId']} php-src/{where} -> {loc['physicalLocation']['artifactLocation']['uri']}:{loc['physicalLocation']['region']['startLine']}")
            else:
                kept += 1
                for l in r["locations"]:
                    l.get("physicalLocation", {}).get("artifactLocation", {}).pop("index", None)
            # Secondary locations into php-src cannot be shown either; drop them with the flows.
            r.pop("relatedLocations", None)
            r.pop("codeFlows", None)
            out.append(r)
        run["results"] = out
    json.dump(d, open(dst, "w"))
    print(f"results: {moved} mapped to a patch, {kept} in repo files, {dropped} upstream not uploaded")


if __name__ == "__main__":
    main()
