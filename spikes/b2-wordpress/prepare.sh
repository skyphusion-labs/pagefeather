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

# Heap views past 128 MiB (#518). In production workerd an ArrayBuffer is at most 128 MiB (2^27
# bytes, measured 2026-11-14 on a workers.dev probe), but the wasm memory grows past that (200 MiB
# grew). V8's %TypedArray%.prototype.subarray refuses a begin offset above that limit with
# "RangeError: Invalid array buffer length" (typed-array-subarray.tq step 17), so every
# HEAPU8.subarray(ptr, ...) with ptr above 128 MiB throws: the string read of js_module_onMessage
# (wp/v2 REST 500s with USE_ZEND_ALLOC=1), and the same way the FS writes and randomFill. The
# TypedArray(buffer, byteOffset, length) constructor checks only the length, so each heap view gets
# its own subarray that keeps the spec's index rules and builds the view that way.
python3 - <<'PY4'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = """		HEAPU64 = new BigUint64Array(b);
	}"""
new = """		HEAPU64 = new BigUint64Array(b);
		// Pagefeather (#518): a subarray past the 128 MiB ArrayBuffer limit of workerd.
		[HEAP8, HEAP16, HEAPU8, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64, HEAP64, HEAPU64].forEach(
			(v) => Object.defineProperty(v, 'subarray', { value: pagefeatherHeapSubarray, configurable: true, writable: true })
		);
	}
	// %TypedArray%.prototype.subarray (begin and end: ToIntegerOrInfinity, negative from the end,
	// clamped to the length), through the constructor, which has no limit on the offset (#518).
	function pagefeatherHeapSubarray(begin, end) {
		var len = this.length;
		var b = begin === undefined ? 0 : Math.trunc(Number(begin)) || 0;
		b = b < 0 ? Math.max(len + b, 0) : Math.min(b, len);
		var e = end === undefined ? len : Math.trunc(Number(end)) || 0;
		e = e < 0 ? Math.max(len + e, 0) : Math.min(e, len);
		return new this.constructor(this.buffer, this.byteOffset + b * this.BYTES_PER_ELEMENT, Math.max(e - b, 0));
	}"""
assert s.count(old) == 1, 'heap subarray patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY4

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
