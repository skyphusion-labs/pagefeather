#!/usr/bin/env python3
"""The only uploads a sample-store load may delete.

A deploy/wfp site's media bucket is wp-wfp-<site>-media (deploy/wfp/lib.sh
media_bucket). The Worker serves /wp-content/uploads/<path> from the key
uploads/<path> (spikes/b2-wordpress/index.js serveUpload, php/r2-uploads.php).
That prefix, in that bucket, is the only set of keys a clear may remove.

  uploads-prefix.py check <site> <bucket> <prefix>
  uploads-prefix.py vet                  keys on stdin, one per line
  uploads-prefix.py page <list.xml> <token-file>
  uploads-prefix.py wanted <0|1> <attachment rows>

check exits 2 with "refused: ..." when the prefix is empty, the bucket root,
another site's prefix, or anything other than uploads/. vet exits 2 when a
listed key could leave that prefix. wanted is the read-back rule: 0 when the
fixture ships no media files, otherwise the dump's attachment count.
"""
import re
import sys
import xml.etree.ElementTree as ET

UPLOADS = "uploads/"
SITE_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$")
BUCKET_RE = re.compile(r"^wp-wfp-([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)-media$")
OTHER_RE = re.compile(r"wp-wfp-([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)-media")
RESERVED = ("probe", "dispatch", "cacheprobe", "cacheprobe-direct", "auto")
ROOTS = ("/", ".", "./", "//")


def valid_site(site):
    if not site or site.startswith("wfp-") or site in RESERVED:
        return False
    return SITE_RE.match(site) is not None


def media_bucket(site):
    return "wp-wfp-%s-media" % site


def refuse_reason(site, bucket, prefix):
    """None when a clear may list and delete. Else a short reason."""
    if prefix is None or prefix == "":
        return "empty prefix"
    if prefix in ROOTS:
        return "root prefix"
    if not valid_site(site):
        return "bad site name"
    owned = media_bucket(site)
    if bucket != owned:
        m = BUCKET_RE.match(bucket or "")
        if m and m.group(1) != site:
            return "another site's prefix"
        return "not this site's media bucket"
    for m in OTHER_RE.finditer(prefix):
        if m.group(1) != site:
            return "another site's prefix"
    if prefix != UPLOADS:
        return "not this site's uploads prefix"
    return None


def bad_key(key):
    """True when deleting this key could hit something outside uploads/."""
    if not key.startswith(UPLOADS):
        return True
    if "\\" in key or "?" in key or "#" in key or "\x00" in key:
        return True
    if any(part in (".", "..") for part in key.split("/")):
        return True
    return False


def page_keys(path):
    """Keys and the next continuation token from one ListObjectsV2 body."""
    root = ET.parse(path).getroot()
    keys, token, truncated = [], None, False
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "Key" and el.text:
            keys.append(el.text)
        elif tag == "IsTruncated":
            truncated = (el.text or "").strip().lower() == "true"
        elif tag == "NextContinuationToken" and el.text:
            token = el.text
    if not truncated:
        token = None
    return keys, token


def wanted(ships_files, attachment_rows):
    """Upload objects a load must read back. No media files in the fixture: 0."""
    if ships_files:
        return attachment_rows
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "check":
        site = argv[2] if len(argv) > 2 else ""
        bucket = argv[3] if len(argv) > 3 else ""
        prefix = argv[4] if len(argv) > 4 else ""
        reason = refuse_reason(site, bucket, prefix)
        if reason:
            sys.stderr.write("refused: %s\n" % reason)
            return 2
        return 0
    if cmd == "vet":
        keys = [line for line in sys.stdin.read().splitlines() if line != ""]
        for key in keys:
            if bad_key(key):
                sys.stderr.write("refused: unsafe key\n")
                return 2
        for key in keys:
            sys.stdout.write(key + "\n")
        return 0
    if cmd == "page":
        keys, token = page_keys(argv[2])
        for key in keys:
            sys.stdout.write(key + "\n")
        with open(argv[3], "w") as fh:
            fh.write(token or "")
        return 0
    if cmd == "wanted":
        ships = argv[2] == "1"
        sys.stdout.write("%d\n" % wanted(ships, int(argv[3])))
        return 0
    sys.stderr.write("usage: uploads-prefix.py check|vet|page|wanted ...\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
