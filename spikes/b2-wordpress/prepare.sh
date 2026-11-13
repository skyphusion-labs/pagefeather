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

# A Worker does not advance Date.now() while code runs (the clock moves only at
# I/O). PHP's uniqid() polls gettimeofday() until the microsecond changes, so
# a second uniqid() in one request spun until the CPU limit (measured
# 2026-11-05: wp-admin/plugins.php, themes.php, and every request with Contact
# Form 7 active used 32 s of CPU, exceededCpu; 0.1 s locally, where the clock
# moves). gettimeofday() reads emscripten_date_now(). Each read now returns at
# least 1 microsecond more than the last: still monotonic, and within
# microseconds of the real time.
python3 - <<'PY2'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = "	var _emscripten_date_now = () => Date.now();"
new = "	var dateLast = 0;\n	var _emscripten_date_now = () => { var t = Date.now(); if (t <= dateLast) t = dateLast + 0.001; dateLast = t; return t; };"
assert s.count(old) == 1, 'emscripten_date_now patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY2

# Heap growth (#394, rank 1 of Joan's admin memory profile, PR #445): Emscripten grows the PHP heap
# to max(requested, old * 1.2), retrying at 1.1 and 1.05. At 100 MiB that is a 20 MiB step for a
# request of a few KiB, and the memory grows in big stairs (92, 99, 104, 111, 133 MiB on pf394a).
# On an isolate near its limit the next 1.2x step is the one that cannot be allocated: in Joan's
# pass Z window 53 requests died with "RangeError: Invalid array buffer length", with no isolate
# reset. Grow to what was asked plus 2 MiB of slack (then 1 and 0.5 MiB if that fails), never a
# fraction of the old size. The same loader runs approach a.
python3 - <<'PY3'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = """			var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
			overGrownHeapSize = Math.min(
				overGrownHeapSize,
				requestedSize + 100663296
			);"""
new = """			// Pagefeather (#394): the need plus a small slack, not 20 percent of the old size.
			var overGrownHeapSize = requestedSize + 2097152 / cutDown;"""
assert s.count(old) == 1, 'heap growth patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY3

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
