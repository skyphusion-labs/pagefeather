#!/usr/bin/env python3
"""opcache-check.py <opcache.zip> <woo_active 0|1>: the floor of a shipped OPcache dump (#313).

Exit 1 when the dump is far below what its build needs:
- fewer than OPCACHE_MIN_FILES files in all (default 400; e2e.sh alone compiles about 600);
- WOO_ACTIVE=1 and fewer than OPCACHE_WOO_MIN files under plugins/woocommerce/ (default 500;
  a primed store measured 1506 on 2026-11-12, an unprimed one 0).
Prints one line with the counts either way.
"""
import os, sys, zipfile

def counts(path):
    names = zipfile.ZipFile(path).namelist()
    woo = sum(1 for n in names if "/plugins/woocommerce/" in n)
    return len(names), woo

def main(argv):
    if len(argv) != 3 or argv[2] not in ("0", "1"):
        print("usage: opcache-check.py <opcache.zip> <woo_active 0|1>", file=sys.stderr); return 2
    total, woo = counts(argv[1])
    min_files = int(os.environ.get("OPCACHE_MIN_FILES") or 400)
    min_woo = int(os.environ.get("OPCACHE_WOO_MIN") or 500)
    print("opcache check: %d files, %d WooCommerce, WOO_ACTIVE=%s" % (total, woo, argv[2]))
    bad = []
    if total < min_files:
        bad.append("%d files is under the %d floor" % (total, min_files))
    if argv[2] == "1" and woo < min_woo:
        bad.append("WOO_ACTIVE=1 but only %d WooCommerce files (floor %d): the store pages were not primed" % (woo, min_woo))
    for b in bad:
        print("opcache check FAILED: " + b)
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
