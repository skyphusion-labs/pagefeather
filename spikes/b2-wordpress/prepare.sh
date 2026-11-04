#!/bin/bash
# Build vendor/php_8_3.js from the pinned @php-wasm/web-8-3 JSPI loader.
# workerd has no import.meta.url, so the first statement (two lines) that
# builds the wasm URL from it is replaced. The Worker passes the wasm module
# itself through instantiateWasm, so the file name is never fetched.
set -euo pipefail
cd "$(dirname "$0")"
src=node_modules/@php-wasm/web-8-3/jspi/php_8_3.js
mkdir -p vendor
{ echo "const dependencyFilename = 'php_8_3.wasm';"; tail -n +3 "$src"; } > vendor/php_8_3.js
head -1 vendor/php_8_3.js

# The module reserves 64 MiB (1024 pages) at start. A Worker isolate has 128 MB
# for everything, so start at 24 MiB (384 pages) and let it grow on demand.
# Its static data ends at 12.4 MiB. Both values are 2-byte LEB128, so the patch
# keeps every offset.
python3 - <<'PY'
src = 'node_modules/@php-wasm/web-8-3/jspi/8_3_36/php_8_3.wasm'
dst = 'vendor/php_8_3.wasm'
b = bytearray(open(src, 'rb').read())
def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7f) << s; s += 7
        if x < 0x80: return r, i
i = 8; done = False
while i < len(b):
    sid = b[i]; i += 1; size, i = leb(b, i); start = i
    if sid == 5:
        n, j = leb(b, i); flags = b[j]; j += 1; k = j
        initial, j = leb(b, j)
        assert initial == 1024 and j - k == 2, (initial, j - k)
        b[k:j] = bytes([0x80, 0x03])  # 384
        done = True
    i = start + size
assert done, 'memory section not found'
# OPcache runs only under the SAPIs in its own list (Apache, FPM, FastCGI,
# FrankenPHP, LiteSpeed, uWSGI). php-wasm's SAPI is "wasm", so OPcache was off
# (measured 2026-11-04: opcache_compile_file() returned false). Change the
# list entry "frankenphp" to "wasm". Only the first 5 bytes change, to
# "wasm\0", so a string that shares the tail ("php", "enphp") is not touched.
old = b'\x00frankenphp\x00'
assert b.count(old) == 1, b.count(old)
i = b.find(old)
b[i + 1:i + 6] = b'wasm\x00'
open(dst, 'wb').write(b)
print('patched initial memory: 1024 -> 384 pages; OPcache SAPI list: frankenphp -> wasm')
PY
