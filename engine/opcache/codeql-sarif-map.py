#!/usr/bin/env python3
"""Map CodeQL c-cpp results in the patched php-src tree onto the engine's patch files (#608).

GitHub code scanning DROPS a result whose file is not in the repository: measured on the alert
control (#616), where the local SARIF held 2 planted cpp/very-likely-overrunning-write results at
codeql-build/php-src/ext/opcache/zend_persist.c and the uploaded analysis read results=0. The C we
own is the patch, so a result on a line that a patch ADDED is moved to that line of the .patch
file, which is in the repository. A result on an upstream php-src line is not ours: it is listed
in the log and not uploaded.

  codeql-sarif-map.py <in.sarif> <out.sarif> <php-src dir> <src-prefix> <applied-patches.txt> \
      <baseline.json> [--write-baseline]

A patch can make an UNCHANGED upstream line dangerous (a changed caller, a new value flowing in),
and that result sits on an upstream line. So every upstream result is checked against the committed
baseline (engine/opcache/codeql-upstream-baseline.json: rule, file and a hash of the line text, not
the line number). A result that is not in the baseline is printed, uploaded at the header of the
last patch that touches its file (so the code_scanning rule sees it), and the exit status is 3.
A php-src bump regenerates the baseline deliberately with --write-baseline.

<src-prefix> is the php-src path as the SARIF names it, relative to the source root
(codeql-build/php-src/). applied-patches.txt holds the repo-relative patch paths in the order the
build applied them. The line map is built by replaying each patch on the pristine file
(git show HEAD:<path> in the php-src clone); the replayed text must equal the built file byte for
byte, or the map is refused (exit 1), so an offset or fuzzy apply cannot misplace an alert.
"""
import collections
import hashlib
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


def header_lines(patches):
    """{rel path: (patch, line of its diff --git header)} for the LAST patch touching each file."""
    out = {}
    for p in patches:
        for i, l in enumerate(open(p, encoding="utf-8").read().split("\n"), 1):
            if l.startswith("diff --git a/"):
                out[l.split(" b/", 1)[1]] = (p, i)
    return out


def line_key(php, rule, rel, line):
    try:
        text = open(f"{php}/{rel}", encoding="utf-8", errors="surrogateescape").read().split("\n")[line - 1]
    except (OSError, IndexError):
        fail(f"cannot read php-src/{rel}:{line} for the baseline key")
    return (rule, rel, hashlib.sha256(text.strip().encode("utf-8", "surrogateescape")).hexdigest()), text.strip()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    write = "--write-baseline" in sys.argv[1:]
    src, dst, php, prefix, applied, basefile = args[:6]
    patches = [l.strip() for l in open(applied) if l.strip()]
    if not patches:
        fail("no applied patches listed")
    maps = build_maps(php, patches)
    headers = header_lines(patches)
    if write:
        base = collections.Counter()
    else:
        b = json.load(open(basefile))
        base = collections.Counter((e["rule"], e["file"], e["line_sha256"]) for e in b["results"])
        print(f"upstream baseline: {sum(base.values())} entries ({basefile})")
    seen, new, texts = collections.Counter(), [], {}
    print(f"line maps: {len(maps)} patched files from {len(patches)} patches")
    d = json.load(open(src))
    kept = moved = dropped = 0
    def remap_new(rel):
        p, i = headers.get(rel, (patches[0], 1))
        return {"physicalLocation": {"artifactLocation": {"uri": p, "uriBaseId": "%SRCROOT%"},
                                     "region": {"startLine": i}}}

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
                rel, line = where.rsplit(":", 1)
                key, text = line_key(php, r["ruleId"], rel, int(line))
                texts[key] = text
                seen[key] += 1
                if write or seen[key] <= base[key]:
                    dropped += 1
                    print(f"upstream, in the baseline (not uploaded): {r['ruleId']} php-src/{where}")
                    continue
                new.append(f"{r['ruleId']} php-src/{where}: {text[:120]}")
                print(f"::error::NEW result on an UPSTREAM line, not in the baseline: {r['ruleId']} php-src/{where}: {text[:120]}")
                loc = remap_new(rel)
                r["locations"] = [loc]
                r["message"]["text"] = ("NEW on an upstream php-src line, not in codeql-upstream-baseline.json: "
                                        + r["message"].get("text", "") + f" (php-src {where})")
                r.pop("partialFingerprints", None)
                r.pop("relatedLocations", None)
                r.pop("codeFlows", None)
                out.append(r)
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
    print(f"results: {moved} mapped to a patch, {kept} in repo files, {dropped} upstream in the baseline, {len(new)} NEW upstream")
    if write:
        entries = [{"rule": k[0], "file": k[1], "line_sha256": k[2], "line": texts[k]}
                   for k in sorted(seen) for _ in range(seen[k])]
        json.dump({"about": "CodeQL c-cpp results on UPSTREAM php-src lines of the patched ext/opcache "
                            "(#608). Regenerate on a php-src bump: codeql-sarif-map.py ... --write-baseline.",
                   "php_ref": open(f"{php}/main/php_version.h").read().split('PHP_VERSION "')[1].split('"')[0],
                   "results": entries}, open(basefile, "w"), indent=2)
        open(basefile, "a").write("\n")
        print(f"wrote {len(entries)} baseline entries to {basefile}")
        return
    for k in base:
        if seen[k] < base[k]:
            print(f"baseline entry not seen (stale; regenerate on a php-src bump): {k[0]} {k[1]} {k[2][:12]}")
    if new:
        print(f"::error::{len(new)} NEW result(s) on upstream php-src lines; a patch may have made upstream code dangerous")
        sys.exit(3)


if __name__ == "__main__":
    main()
