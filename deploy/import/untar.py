#!/usr/bin/env python3
"""Extract a wp-content archive from another server, safely.

  untar.py <archive.tar[.gz|.bz2|.xz]> <out-dir>

The archive is untrusted. The script stops, and extracts nothing, if one
member is a link (symbolic or hard), a device, a FIFO, an absolute path, or a
path with "..". Only regular files and directories are made, with mode 644 or
755 (no setuid, no group or world write). <out-dir> must not exist.

The archive may have wp-content/ at its top, or the contents of wp-content.
macOS metadata is skipped: AppleDouble files ("._name", which tar on macOS
adds) and a __MACOSX/ directory. They are checked like any other member first.
The output is always <out-dir>/wp-content. The script prints JSON: files,
bytes, and the top-level entries of wp-content.
"""
import json
import os
import sys
import tarfile


def fail(msg):
    sys.exit(f"untar: {msg}")


def main(archive, out):
    if os.path.exists(out):
        fail(f"{out} exists; remove it first")
    with tarfile.open(archive, "r:*") as tar:
        members = tar.getmembers()
        names = []
        skipped = 0
        for m in members:
            name = m.name
            if name.startswith("./"):
                name = name[2:]
            if not name or name == ".":
                continue
            parts = name.split("/")
            if name.startswith("/") or ".." in parts or "\\" in name:
                fail(f"unsafe path: {m.name!r}")
            if not (m.isfile() or m.isdir()):
                fail(f"not a file or directory: {m.name!r} (links, devices and FIFOs are refused)")
            parts = [p for p in parts if p]
            # macOS metadata (AppleDouble "._x" files, __MACOSX/): not site files.
            if parts[0] == "__MACOSX" or parts[-1].startswith("._"):
                skipped += 1
                continue
            names.append((m, parts))
        # A top-level wp-content/ directory, or the contents of one.
        tops = {p[0] for _, p in names}
        strip = tops == {"wp-content"}
        dest = os.path.join(out, "wp-content")
        os.makedirs(dest)
        files = size = 0
        for m, parts in names:
            rel = parts[1:] if strip else parts
            if not rel:
                continue
            path = os.path.join(dest, *rel)
            if m.isdir():
                os.makedirs(path, exist_ok=True)
                os.chmod(path, 0o755)
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            src = tar.extractfile(m)
            with open(path, "wb") as f:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            os.chmod(path, 0o755 if m.mode & 0o111 else 0o644)
            files += 1
            size += m.size
    print(json.dumps({"files": files, "bytes": size, "skipped_macos": skipped, "top": sorted(os.listdir(dest))}))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
