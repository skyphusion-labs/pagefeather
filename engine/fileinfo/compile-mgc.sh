#!/bin/bash
# Build file 5.43 (the libmagic version php-src 8.3.36 bundles) from its pinned tarball, and compile
# three magic databases from it (#582 S2b):
#   full.mgc   file 5.43's Magdir with php-magdir.patch: php-src's own database
#   trim.mgc   select.py with accepted.txt and rejection.txt: the pagefeather engine's database
#   norej.mgc  select.py with no rejection signatures: the red control of the tests
# Used by build-db.sh inside the build image and by the fileinfo-gates job on the runner (both Linux).
#   compile-mgc.sh <work-dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
w=${1:?usage: compile-mgc.sh <work-dir>}
mkdir -p "$w"; w=$(cd "$w" && pwd)
FILE_VERSION=5.43
FILE_SHA256=8c8015e91ae0e8d0321d94c78239892ef9dbc70c4ade0008c0e95894abfb1991
curl -fsSL -o "$w/file.tar.gz" "https://astron.com/pub/file/file-$FILE_VERSION.tar.gz"
echo "$FILE_SHA256  $w/file.tar.gz" | sha256sum -c - > /dev/null
tar -xzf "$w/file.tar.gz" -C "$w"
s="$w/file-$FILE_VERSION"
(cd "$s" && ./configure --quiet --disable-shared --disable-zlib --disable-bzlib --disable-xzlib --disable-zstdlib --disable-lzlib > "$w/configure.log" 2>&1 && make -s -j"$(nproc)" -C src > "$w/make.log" 2>&1)
rm -rf "$w/full" "$w/trim" "$w/norej"
cp -R "$s/magic/Magdir" "$w/full"
patch -s -p2 -d "$w/full" < "$here/php-magdir.patch"
python3 -I "$here/select.py" "$w/full" "$w/trim" "$here/accepted.txt" "$here/rejection.txt"
printf '# none: the red control\n' > "$w/norej.txt"
python3 -I "$here/select.py" "$w/full" "$w/norej" "$here/accepted.txt" "$w/norej.txt"
for d in full trim norej; do (cd "$w" && "$s/src/file" -C -m "$d"); echo "compile-mgc.sh: $d.mgc $(stat -c%s "$w/$d.mgc") bytes"; done
