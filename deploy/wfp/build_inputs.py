#!/usr/bin/env python3
"""The recorded build inputs of a deploy/wfp site (#379).

A site's build inputs (PLUGINS, IMPORT_CONTENT with IMPORT_THEMES, IMPORT_PLUGINS and
IMPORT_MU_PLUGINS, WOO_ACTIVE) used to live only in the environment of the run that built it.
On 2026-11-12 an update without them shipped the live ggc.sh without its plugins and
mu-plugins. Now a successful `site update` records them in the site's own media bucket, which
is private outside uploads/ (the Worker serves only /wp-content/uploads/ from R2), like
_snapshots/:

    _build/inputs.json          the record: the input values, the content id, the tree key
    _build/<content id>.tar.gz  the wp-content subset the build copies (themes, plugins,
                                mu-plugins named in the inputs)

`site remove` empties the bucket, so both go with the site. The S3 calls are snapshot.py's
(the key in a curl config on stdin, never in argv).

    build_inputs.py env-json <content id> <tree key> <build>    the record of this run (stdout)
    build_inputs.py get <bucket> <out.json>                    exit 0 with the record, 3 when none
    build_inputs.py put <bucket> <record.json>                 write and read back
    build_inputs.py compare <record.json>                      exit 0 when this run's inputs
                                                               equal the record, 4 when not
    build_inputs.py pack <IMPORT_CONTENT dir> <out.tar.gz>     the subset, from the run's inputs
    build_inputs.py tree-put <bucket> <key> <tar.gz>           write and read back (size)
    build_inputs.py tree-get <bucket> <key> <out dir>          into <out dir>/wp-content
    build_inputs.py exports <record.json> <wp-content dir>     the shell lines that set the inputs
"""
import io
import json
import os
import shlex
import sys
import tarfile
import time

# No __pycache__ next to snapshot.py: an untracked file there makes the tree dirty, and
# site update refuses a dirty tree (#377 tree_clean_check).
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snapshot  # noqa: E402

RECORD = "_build/inputs.json"
LISTS = ("PLUGINS", "IMPORT_THEMES", "IMPORT_PLUGINS", "IMPORT_MU_PLUGINS")
KEEP = "sqlite-database-integration"  # deploy/import/content.sh: the build copy stays


def norm(v):
    return " ".join(sorted(str(v or "").split()))


def env_inputs(env=os.environ):
    d = {k: norm(env.get(k)) for k in LISTS}
    d["WOO_ACTIVE"] = str(env.get("WOO_ACTIVE", "") or "")
    return d


def env_json(content_id, key, build):
    return {"v": 1, "inputs": env_inputs(), "content_id": content_id or "", "tree": key or "",
            "build": build or "", "written": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def compare(record, env=os.environ):
    """The differences between this run's inputs and the record, as (name, recorded, now)."""
    have = env_inputs(env); rec = record.get("inputs") or {}
    return [(k, rec.get(k, ""), have[k]) for k in sorted(have) if norm(rec.get(k, "")) != norm(have[k])]


def subset(src, env=os.environ):
    """The (archive name, path) pairs of the subset content.sh copies, in a stable order."""
    out = []
    for kind, var in (("themes", "IMPORT_THEMES"), ("plugins", "IMPORT_PLUGINS"), ("mu-plugins", "IMPORT_MU_PLUGINS")):
        for name in str(env.get(var) or "").split():
            if kind == "plugins" and name == KEEP:
                continue
            if "/" in name or name in (".", ".."):
                raise SystemExit("bad %s name: %r" % (kind, name))
            p = os.path.join(src, kind, name)
            if not os.path.exists(p):
                raise SystemExit("%s %s is not in %s" % (kind, name, os.path.join(src, kind)))
            out.append(("wp-content/%s/%s" % (kind, name), p))
    return out


def pack(src, outp, env=os.environ):
    parts = subset(src, env)
    if not parts:
        raise SystemExit("nothing to pack: IMPORT_THEMES, IMPORT_PLUGINS and IMPORT_MU_PLUGINS are empty")
    for _, p in parts:
        for d, dirs, files in os.walk(p):
            for n in dirs + files:
                if os.path.islink(os.path.join(d, n)):
                    raise SystemExit("a symbolic link in the content (%s); refused, as content.sh refuses it" % os.path.join(d, n))
        if os.path.islink(p):
            raise SystemExit("a symbolic link in the content (%s); refused" % p)
    with tarfile.open(outp, "w:gz") as t:
        for arc, p in parts:
            t.add(p, arcname=arc)
    return len(parts)


def safe_extract(blob, outdir):
    """Extract only regular files and directories under wp-content/, never a link or a path out."""
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
        members = t.getmembers()
        for m in members:
            n = m.name
            if not (m.isfile() or m.isdir()):
                raise SystemExit("the tree holds %s, which is not a file or a directory; refused" % n)
            if n.startswith("/") or ".." in n.split("/") or not (n == "wp-content" or n.startswith("wp-content/")):
                raise SystemExit("the tree holds a path outside wp-content/: %s; refused" % n)
        for m in members:
            t.extract(m, outdir)
    return len(members)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "env-json":
        print(json.dumps(env_json(argv[2], argv[3], argv[4]), sort_keys=True)); return 0
    if cmd == "get":
        st, body = snapshot.s3("GET", "/%s/%s" % (argv[2], RECORD))
        if st == 404:
            return 3
        if st != 200:
            print("build inputs: GET %s/%s answered %s" % (argv[2], RECORD, st), file=sys.stderr); return 1
        rec = json.loads(body)
        if rec.get("v") != 1:
            print("build inputs: unknown record version %r" % rec.get("v"), file=sys.stderr); return 1
        with open(os.open(argv[3], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
            json.dump(rec, fh, sort_keys=True)
        return 0
    if cmd == "put":
        body = open(argv[3], "rb").read(); json.loads(body)
        st, _ = snapshot.s3("PUT", "/%s/%s" % (argv[2], RECORD), body)
        gst, gb = snapshot.s3("GET", "/%s/%s" % (argv[2], RECORD))
        if st not in (200, 201) or gst != 200 or gb != body:
            print("build inputs: the record did not store (PUT %s, read back %s)" % (st, gst), file=sys.stderr); return 1
        return 0
    if cmd == "compare":
        diffs = compare(json.load(open(argv[2])))
        for k, a, b in diffs:
            print("  %s: recorded '%s', this run '%s'" % (k, a, b))
        return 4 if diffs else 0
    if cmd == "pack":
        n = pack(argv[2], argv[3]); print("packed %d part(s), %d bytes" % (n, os.path.getsize(argv[3]))); return 0
    if cmd == "tree-put":
        body = open(argv[4], "rb").read()
        st, _ = snapshot.s3("PUT", "/%s/%s" % (argv[2], argv[3]), body)
        gst, gb = snapshot.s3("GET", "/%s/%s" % (argv[2], argv[3]))
        if st not in (200, 201) or gst != 200 or len(gb) != len(body):
            print("build inputs: the tree did not store (PUT %s, read back %s, %d of %d bytes)" % (st, gst, len(gb), len(body)), file=sys.stderr); return 1
        return 0
    if cmd == "tree-get":
        st, body = snapshot.s3("GET", "/%s/%s" % (argv[2], argv[3]))
        if st != 200:
            print("build inputs: GET %s/%s answered %s" % (argv[2], argv[3], st), file=sys.stderr); return 1
        n = safe_extract(body, argv[4]); print("extracted %d entries" % n); return 0
    if cmd == "exports":
        rec = json.load(open(argv[2])); i = rec.get("inputs") or {}
        lines = ["%s=%s" % (k, shlex.quote(i.get(k, ""))) for k in LISTS + ("WOO_ACTIVE",)]
        if rec.get("tree"):
            lines.append("IMPORT_CONTENT=%s" % shlex.quote(argv[3]))
        print("\n".join(lines)); return 0
    print(__doc__, file=sys.stderr); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
