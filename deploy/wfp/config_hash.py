#!/usr/bin/env python3
"""sha256 of a rendered user config and the sorted secret key names (#421).

  config_hash.py <rendered-config> <secrets-json>

The secrets JSON contributes its key names only, sorted. Values are not
hashed and are not printed. On any error the message is fixed text, so a
secret in the file cannot reach stderr.

No __pycache__ next to this file: an untracked file there makes the tree
dirty, and site update refuses a dirty tree.
"""
import hashlib
import json
import sys

sys.dont_write_bytecode = True


def main():
    if len(sys.argv) != 3:
        print("config hash: need the rendered config and the secrets JSON", file=sys.stderr)
        return 1
    try:
        with open(sys.argv[1], "rb") as fh:
            rendered = fh.read()
        with open(sys.argv[2], "rb") as fh:
            raw = fh.read()
        obj = json.loads(raw)
    except (OSError, ValueError):
        print("config hash: cannot read the rendered config or the secrets JSON", file=sys.stderr)
        return 1
    if not isinstance(obj, dict) or not all(isinstance(k, str) for k in obj):
        print("config hash: the secrets JSON must be an object with string keys", file=sys.stderr)
        return 1
    digest = hashlib.sha256()
    # A NUL separates the config from the names, so a config byte cannot
    # collide with a key name.
    digest.update(rendered)
    digest.update(b"\0")
    digest.update("\n".join(sorted(obj)).encode())
    sys.stdout.write(digest.hexdigest() + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
