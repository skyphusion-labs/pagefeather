#!/usr/bin/env python3
"""sample-store-admin.py <dump.sql>: print user_login of wp_users ID 1 from a mysqldump.

Reads the first INSERT INTO `wp_users` and the first row of it. Prints nothing when there is none.
"""
import re, sys

def first_user(text):
    m = re.search(r"INSERT INTO `wp_users` (?:\([^)]*\) )?VALUES \((\d+),'((?:[^'\\]|\\.)*)'", text)
    return m.group(2) if m and m.group(1) == "1" else ""

if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
        print(first_user(f.read()))
