#!/bin/bash
# The trimmed fileinfo database of the pagefeather engine (#582 S2b). Runs inside the PHP build image,
# on Linux, after php-src is cloned: builds file 5.43 (the libmagic version php-src 8.3.36 bundles),
# proves the pipeline on the FULL database (it must equal php-src's own data_file.c, byte for byte),
# then compiles the trimmed set (select.py) and writes it over ext/fileinfo/data_file.c.
#   build-db.sh <php-src dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
php=${1:?usage: build-db.sh <php-src dir>}
w=$(mktemp -d)
FILE_VERSION=5.43
FILE_SHA256=8c8015e91ae0e8d0321d94c78239892ef9dbc70c4ade0008c0e95894abfb1991
curl -fsSL -o "$w/file.tar.gz" "https://astron.com/pub/file/file-$FILE_VERSION.tar.gz"
echo "$FILE_SHA256  $w/file.tar.gz" | sha256sum -c -
tar -xzf "$w/file.tar.gz" -C "$w"
s="$w/file-$FILE_VERSION"
grep -q "MAGIC_VERSION.*$(echo $FILE_VERSION | tr -d .)" "$php/ext/fileinfo/libmagic/magic.h" || { echo "php-src libmagic is not $FILE_VERSION" >&2; exit 1; }
(cd "$s" && ./configure --quiet --disable-shared --disable-zlib --disable-bzlib --disable-xzlib --disable-zstdlib --disable-lzlib > "$w/configure.log" 2>&1 && make -s -j"$(nproc)" -C src > "$w/make.log" 2>&1)
cp -R "$s/magic/Magdir" "$w/full"
patch -s -p2 -d "$w/full" < "$here/php-magdir.patch"
mgc2c() { python3 -I -c '
import sys
b = open(sys.argv[1], "rb").read()
out = ["const unsigned char php_magic_database[%d] = {\n" % len(b)]
for i in range(0, len(b), 16):
    out.append("".join("0x%02X, " % x for x in b[i:i + 16]) + "\n")
out.append("};\n")
open(sys.argv[2], "w").write("".join(out))' "$1" "$2"; }
c2mgc() { python3 -I -c '
import re, sys
s = open(sys.argv[1]).read(); m = re.search(r"php_magic_database\[(\d+)\]", s)
b = bytes(int(x, 16) for x in re.findall(r"0x([0-9A-Fa-f]{2})", s[m.end():])); assert len(b) == int(m.group(1))
open(sys.argv[2], "wb").write(b)' "$1" "$2"; }
# 1. The control: the full database from this pipeline equals php-src's.
(cd "$w" && "$s/src/file" -C -m full)
c2mgc "$php/ext/fileinfo/data_file.c" "$w/php.mgc"
if cmp -s "$w/full.mgc" "$w/php.mgc"; then echo "build-db.sh: control: the full database equals php-src data_file.c ($(stat -c%s "$w/php.mgc") bytes)"
else echo "build-db.sh: control FAILED: the full database differs from php-src data_file.c" >&2; cmp "$w/full.mgc" "$w/php.mgc" >&2 || true; exit 1; fi
# 2. The trimmed database.
python3 -I "$here/select.py" "$w/full" "$w/trim" "$here/accepted.txt" "$here/rejection.txt"
(cd "$w" && "$s/src/file" -C -m trim)
mgc2c "$w/trim.mgc" "$php/ext/fileinfo/data_file.c"
echo "build-db.sh: trimmed database $(stat -c%s "$w/trim.mgc") bytes, written to ext/fileinfo/data_file.c"
cp "$w/trim.mgc" "$php/ext/fileinfo/pagefeather-trim.mgc"
