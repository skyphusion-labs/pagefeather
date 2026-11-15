#!/bin/bash
# The trimmed fileinfo database of the pagefeather engine (#582 S2b). Runs inside the PHP build image,
# on Linux, after php-src is cloned and before configure (engine/patches/lean.py, edit 11):
# compile-mgc.sh builds file 5.43 and the databases; THE CONTROL requires the full one to equal
# php-src's own data_file.c byte for byte; then the trimmed one is written over ext/fileinfo/data_file.c.
#   build-db.sh <php-src dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
php=${1:?usage: build-db.sh <php-src dir>}
w=$(mktemp -d)
grep -q "MAGIC_VERSION.*543" "$php/ext/fileinfo/libmagic/magic.h" || { echo "build-db.sh: php-src libmagic is not 5.43" >&2; exit 1; }
"$here/compile-mgc.sh" "$w"
python3 -I - "$php/ext/fileinfo/data_file.c" "$w/php.mgc" <<'PY'
import re, sys
s = open(sys.argv[1]).read(); m = re.search(r"php_magic_database\[(\d+)\]", s)
b = bytes(int(x, 16) for x in re.findall(r"0x([0-9A-Fa-f]{2})", s[m.end():])); assert len(b) == int(m.group(1))
open(sys.argv[2], "wb").write(b)
PY
if cmp -s "$w/full.mgc" "$w/php.mgc"; then echo "build-db.sh: control: the full database equals php-src data_file.c ($(stat -c%s "$w/php.mgc") bytes)"
else echo "build-db.sh: control FAILED: the full database differs from php-src data_file.c" >&2; cmp "$w/full.mgc" "$w/php.mgc" >&2 || true; exit 1; fi
python3 -I - "$w/trim.mgc" "$php/ext/fileinfo/data_file.c" <<'PY'
import sys
b = open(sys.argv[1], "rb").read()
out = ["const unsigned char php_magic_database[%d] = {\n" % len(b)]
for i in range(0, len(b), 16):
    out.append("".join("0x%02X, " % x for x in b[i:i + 16]) + "\n")
out.append("};\n")
open(sys.argv[2], "w").write("".join(out))
PY
echo "build-db.sh: trimmed database $(stat -c%s "$w/trim.mgc") bytes, written to ext/fileinfo/data_file.c"
