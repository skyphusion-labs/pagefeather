#!/bin/bash
# Build vendor/php_8_3.js and vendor/php_8_3.wasm from the PHP engine engine.sh resolves (#771): by default the
# lean pagefeather engine pinned in engine.lock (#582, #592), fetched by hash; PHP_ENGINE=npm for the pinned
# @php-wasm/web-8-3 JSPI loader; or PF_ENGINE_JS and PF_ENGINE_WASM, another engine's files as given. The same
# patches apply to each, each one asserting it matched once. vendor/engine.mjs says which engine was built and its
# default recycle line (140 lean, 100 npm), for index.js.
# workerd has no import.meta.url, so the first statement (two lines) that
# builds the wasm URL from it is replaced. The Worker passes the wasm module
# itself through instantiateWasm, so the file name is never fetched.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=engine.sh
. ./engine.sh
engine_resolve || exit 2
src=${PF_ENGINE_JS:-node_modules/@php-wasm/web-8-3/jspi/php_8_3.js}
mkdir -p vendor
printf "// Written by prepare.sh (#771): the engine this build vendored, and its default recycle line in MiB.\nexport const PHP_ENGINE = '%s';\nexport const ENGINE_RECYCLE_MIB = %s;\n" "$PHP_ENGINE_RESOLVED" "$(engine_recycle_mib)" > vendor/engine.mjs
echo "engine: $PHP_ENGINE_RESOLVED (${PF_ENGINE_WASM:-the npm package}), recycle line $(engine_recycle_mib) MiB by default" >&2
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
# TypedArray(buffer, byteOffset, length) constructor does not cap the offset, so each heap view gets
# its own subarray that keeps the spec's index rules and builds the view that way. The constructor
# does cap a length argument at 128 MiB (probe v2: a 136 MiB view threw "Invalid typed array length:
# 142606336"), so a view to the end of the buffer is built with no length argument.
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
		var off = this.byteOffset + b * this.BYTES_PER_ELEMENT, n = Math.max(e - b, 0);
		// The constructor caps a LENGTH argument at the same 128 MiB, but not a length it derives
		// from the buffer: a view that reaches the end of the buffer is built without one. A longer
		// span that ends before the end cannot be a view in workerd at all, and throws as the native does.
		if (off + n * this.BYTES_PER_ELEMENT === this.buffer.byteLength) return new this.constructor(this.buffer, off);
		return new this.constructor(this.buffer, off, n);
	}"""
assert s.count(old) == 1, 'heap subarray patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY4

# PHP pauses in open() while the Worker fetches a file (#563, #394 Gate 1, Path A). Under JSPI an import
# may suspend only if the loader wraps it in WebAssembly.Suspending, and the loader picks those imports
# in JS, by name (Asyncify.instrumentWasmImports): the wasm needs no change. Two edits:
# 1. __syscall_openat is wrapped, ONLY when the runtime was given a pagefeatherOpen hook (the
#    OPCACHE_REMOTE build). Without the hook nothing is wrapped, so a default build runs as before.
# 2. ___syscall_openat asks the hook first. A promise means the bytes are not here yet: PHP waits, then
#    the open runs as usual. A rejected promise fails the open with EIO (29), never a half file.
# Measured 2026-11-14 on production workerd (#394 issuecomment-6878010968): require, require_once from an
# autoloader, require inside try and file_get_contents all paused and resumed; a copy without edit 1 failed.
python3 - <<'PY5'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = "\t\t\t\t\tlet isAsyncifyImport =\n\t\t\t\t\t\toriginal.isAsync || importPattern.test(x);\n"
new = ("\t\t\t\t\tlet isAsyncifyImport =\n\t\t\t\t\t\toriginal.isAsync || importPattern.test(x) ||\n"
       "\t\t\t\t\t\t// Pagefeather (#563): open() may pause, only when a pagefeatherOpen hook is set.\n"
       "\t\t\t\t\t\t(x === '__syscall_openat' && typeof Module['pagefeatherOpen'] == 'function');\n")
assert s.count(old) == 1, 'openat import pattern patch did not apply'
s = s.replace(old, new)
old = "\t\t\tvar mode = varargs ? syscallGetVarargI() : 0;\n\t\t\treturn FS.open(path, flags, mode).fd;\n"
new = """\t\t\tvar mode = varargs ? syscallGetVarargI() : 0;
\t\t\t// Pagefeather (#563): a promise from the hook means the file's bytes are being fetched.
\t\t\tvar pfWait = Module['pagefeatherOpen'] ? Module['pagefeatherOpen'](path) : null;
\t\t\tif (pfWait) {
\t\t\t\treturn pfWait.then(
\t\t\t\t\t() => {
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\treturn FS.open(path, flags, mode).fd;
\t\t\t\t\t\t} catch (e) {
\t\t\t\t\t\t\tif (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
\t\t\t\t\t\t\treturn -e.errno;
\t\t\t\t\t\t}
\t\t\t\t\t},
\t\t\t\t\t() => -29
\t\t\t\t);
\t\t\t}
\t\t\treturn FS.open(path, flags, mode).fd;
"""
assert s.count(old) == 1, 'openat hook patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY5

# PHP pauses in a READ while the Worker fetches a site .php (#569, #394 Gate 2, the hybrid). OPcache
# opens a source it then serves from its cache without reading it (step 3: 37,721 of 37,721
# opened-but-unread site files were .php), so a .php is fetched at its FIRST READ, not its open.
# PHP's read() goes through php-wasm's own js_fd_read import, which is ALREADY Suspending in the stock
# importPattern; WASI fd_read and _mmap_js (readfile, copy, fpassthru use mmap) are made Suspending only
# when a pagefeatherRead hook is set. Each asks the hook first: a promise means wait, a rejection
# fails the read with EIO before any byte is delivered. There is no fd_pread import in this wasm.
# Proven on production workerd (Gate 0b, #394 issuecomment-6879785529, 9 of 9 cases x3).
python3 - <<'PY6'
p = 'vendor/php_8_3.js'; s = open(p).read()
old = "(x === '__syscall_openat' && typeof Module['pagefeatherOpen'] == 'function');"
new = ("(x === '__syscall_openat' && typeof Module['pagefeatherOpen'] == 'function') ||\n"
       "\t\t\t\t\t\t// Pagefeather (#569): reads may pause, only when a pagefeatherRead hook is set.\n"
       "\t\t\t\t\t\t((x === 'fd_read' || x === '_mmap_js') && typeof Module['pagefeatherRead'] == 'function');")
assert s.count(old) == 1, 'read import pattern patch did not apply'
s = s.replace(old, new)
old = """			var stream = SYSCALLS.getStreamFromFD(fd);
			var num = doReadv(stream, iov, iovcnt);
			HEAPU32[pnum >> 2] = num;
			return 0;"""
new = """			var stream = SYSCALLS.getStreamFromFD(fd);
			// Pagefeather (#569): a .php whose pack is not held yet: wait for it, then read.
			var pfR = Module['pagefeatherRead'] ? Module['pagefeatherRead'](stream, 'read') : null;
			if (pfR) {
				return pfR.then(() => {
					try {
						var n2 = doReadv(stream, iov, iovcnt);
						HEAPU32[pnum >> 2] = n2;
						return 0;
					} catch (e) {
						if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
						return e.errno;
					}
				}, () => 29);
			}
			var num = doReadv(stream, iov, iovcnt);
			HEAPU32[pnum >> 2] = num;
			return 0;"""
assert s.count(old) == 1, 'fd_read hook patch did not apply'
s = s.replace(old, new)
old = """			var stream = SYSCALLS.getStreamFromFD(fd);
			var res = FS.mmap(stream, len, offset, prot, flags);"""
new = """			var stream = SYSCALLS.getStreamFromFD(fd);
			// Pagefeather (#569): the same for an mmap of a .php.
			var pfM = Module['pagefeatherRead'] ? Module['pagefeatherRead'](stream, 'mmap') : null;
			if (pfM) {
				return pfM.then(() => {
					try {
						var r2 = FS.mmap(stream, len, offset, prot, flags);
						HEAP32[allocated >> 2] = r2.allocated;
						HEAPU32[addr >> 2] = r2.ptr;
						return 0;
					} catch (e) {
						if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
						return -e.errno;
					}
				}, () => -29);
			}
			var res = FS.mmap(stream, len, offset, prot, flags);"""
assert s.count(old) == 1, 'mmap hook patch did not apply'
s = s.replace(old, new)
old = """			var stream;
			try {
				stream = SYSCALLS.getStreamFromFD(fd);
				HEAPU32[pnum >> 2] = doReadv(stream, iov, iovcnt);
				return 0;"""
new = """			var stream;
			try {
				stream = SYSCALLS.getStreamFromFD(fd);
				// Pagefeather (#569): js_fd_read is PHP's read(); already Suspending in the stock pattern.
				var pfJ = Module['pagefeatherRead'] ? Module['pagefeatherRead'](stream, 'read') : null;
				if (pfJ) {
					return pfJ.then(() => {
						try {
							HEAPU32[pnum >> 2] = doReadv(stream, iov, iovcnt);
							return 0;
						} catch (e2) {
							if (typeof FS == 'undefined' || !(e2.name === 'ErrnoError')) throw e2;
							return e2.errno;
						}
					}, () => 29);
				}
				HEAPU32[pnum >> 2] = doReadv(stream, iov, iovcnt);
				return 0;"""
assert s.count(old) == 1, 'js_fd_read hook patch did not apply'
s = s.replace(old, new)
open(p, 'w').write(s)
PY6

# The module reserves 64 MiB (1024 pages) at start. A Worker isolate has 128 MB
# for everything, so start at 24 MiB (384 pages) and let it grow on demand.
# Its static data ends at 12.4 MiB.
# #598 / #603: the memory is no longer DEFINED by the module but IMPORTED (env.memory, the same limits: 384
# pages at start, the module's own maximum), so a boot CAN be handed an existing memory instead of a second one:
# the memory reuse of #603, which this build does not do yet (nothing hands one in). The section-5 memory is removed and an import is appended to section 2:
# the export "memory" keeps index 0 (an imported memory takes index 0) and no function index moves (memories are
# their own index space). With the flag off the loader imports a NEW memory of these limits: the same memory,
# built by the loader instead of by the module. One transform, the npm and the lean engine alike (both define
# exactly one memory and export it, measured 2026-11-15).
python3 - <<'PY'
import os
src = os.environ.get('PF_ENGINE_WASM') or 'node_modules/@php-wasm/web-8-3/jspi/8_3_36/php_8_3.wasm'
dst = 'vendor/php_8_3.wasm'
b = bytearray(open(src, 'rb').read())
def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7f) << s; s += 7
        if x < 0x80: return r, i
def enc(n):
    out = bytearray()
    while True:
        x = n & 0x7f; n >>= 7
        out.append(x | (0x80 if n else 0))
        if not n: return bytes(out)
secs = []  # (id, payload)
i = 8
while i < len(b):
    sid = b[i]; i += 1; size, i = leb(b, i)
    secs.append((sid, bytes(b[i:i + size]))); i += size
mem = [p for sid, p in secs if sid == 5]
imp = [p for sid, p in secs if sid == 2]
assert len(imp) == 1, 'no import section'
# The ONE source of the memory limits (#705 review, finding 6): the start is START_PAGES (policy, above); the maximum
# is the module's own. Both go into the import entry here, and into the loader below, so the JS can never ask for a
# memory the import does not accept (a LinkError).
START_PAGES = 384
def import_entries(payload):
    # [(module, field, kind, limits or None, start, end)] for the import section payload
    cnt, k = leb(payload, 0); out = []
    for _ in range(cnt):
        st = k
        ml, k = leb(payload, k); mod = payload[k:k + ml].decode(); k += ml
        fl, k = leb(payload, k); fld = payload[k:k + fl].decode(); k += fl
        kind = payload[k]; k += 1; lim = None
        if kind == 0: _, k = leb(payload, k)
        elif kind == 1: k += 1; f = payload[k]; k += 1; _, k = leb(payload, k); k = leb(payload, k)[1] if f & 1 else k
        elif kind == 2:
            f = payload[k]; k += 1; mn, k = leb(payload, k); mx = None
            if f & 1: mx, k = leb(payload, k)
            lim = (f, mn, mx)
        elif kind == 3: k += 2
        elif kind == 4: k += 1; _, k = leb(payload, k)
        else: raise SystemExit('import kind %d' % kind)
        out.append((mod, fld, kind, lim, st, k))
    return out
entries = import_entries(imp[0])
mem_imports = [e for e in entries if e[2] == 2]
# Idempotent (#598): a module this transform already made (no memory section, an env.memory import with a maximum)
# passes through untouched, its limits read from that import. Anything else without a memory section is refused.
done_mem = not mem and len(mem_imports) == 1 and mem_imports[0][:2] == ('env', 'memory') and mem_imports[0][3][0] == 1
assert done_mem or (len(mem) == 1 and not mem_imports), 'memory section not found, and the module does not import env.memory as this transform makes it'
if done_mem:
    _, PAGES0, PAGES_MAX = mem_imports[0][3]
else:
    n, j = leb(mem[0], 0); flags = mem[0][j]; j += 1
    initial, j = leb(mem[0], j); maximum, j = leb(mem[0], j) if flags & 1 else (None, j)
    assert n == 1 and flags == 1 and maximum is not None and initial >= START_PAGES, (n, flags, initial, maximum)
    PAGES0, PAGES_MAX = START_PAGES, maximum
    entry = enc(3) + b'env' + enc(6) + b'memory' + bytes([0x02, 0x01]) + enc(PAGES0) + enc(PAGES_MAX)
    cnt, j = leb(imp[0], 0)
    new_imp = enc(cnt + 1) + imp[0][j:] + entry
    out = bytearray(b[:8])
    for sid, p_ in secs:
        if sid == 5:
            continue
        if sid == 2:
            p_ = new_imp
        out += bytes([sid]) + enc(len(p_)) + p_
    b = out
# OPcache runs only under the SAPIs in its own list (Apache, FPM, FastCGI,
# FrankenPHP, LiteSpeed, uWSGI). php-wasm's SAPI is "wasm", so OPcache was off
# (measured 2026-11-04: opcache_compile_file() returned false). Change the
# list entry "frankenphp" to "wasm". Only the first 5 bytes change, to
# "wasm\0", so a string that shares the tail ("php", "enphp") is not touched.
# Idempotent too: a list already patched ("\0wasm\0enphp\0") passes through.
old = b'\x00frankenphp\x00'
done_sapi = b.count(old) == 0 and b.count(b'\x00wasm\x00enphp\x00') == 1
assert done_sapi or b.count(old) == 1, b.count(old)
if not done_sapi:
    i = b.find(old)
    b[i + 1:i + 6] = b'wasm\x00'
open(dst, 'wb').write(b)
# The loader satisfies env.memory with a NEW memory of exactly those limits: what the module had, built by the
# loader instead of by the module (#598). The literal is written from PAGES0 and PAGES_MAX, never typed twice.
jp = 'vendor/php_8_3.js'; js = open(jp).read()
old = "\tfunction getWasmImports() {\n"
assert js.count(old) == 1, 'getWasmImports not found'
js = js.replace(old, old + "\t\t// Pagefeather (#598): the module imports its memory: one handed in (a reuse runtime, #603), else a new one\n"
    "\t\t// of the module's own limits (prepare.sh).\n"
    "\t\twasmImports['memory'] = (pfReuse && Module['pagefeatherMemory']) || new WebAssembly.Memory({ initial: %d, maximum: %d });\n"
    "\t\tModule['pagefeatherMemory'] = null;\n" % (PAGES0, PAGES_MAX))
# #603: the reuse guards, only for a reuse runtime (Module.pagefeatherReuse), read ONCE, at the very top of the
# loader's init, into pfReuse; every wrapper closes over it, the ones getWasmTableEntry builds lazily too (#705
# review, finding 7). Without it every wrapper is the upstream code. With it:
#   - the promising calls are counted at the wasm boundary (Module.pfInFlight; JSPI suspends only inside one), and
#     Module.pfOnIdle runs when the count returns to 0;
#   - a retired runtime (Module.pfDead) is refused by EVERY door, for EVERY new call: each promising entry, each
#     export wrapper, callUserCallback (the timers and the sleep wake). index.js sets pfDead only once the runtime
#     has drained (no call in flight and one macrotask later), so there is no call left to finish (#705 review,
#     findings 1 and 2).
old = "\tvar Module = typeof PHPLoader != 'undefined' ? PHPLoader : {};\n"
assert js.count(old) == 1, 'var Module not found'
js = js.replace(old, old + "\t// Pagefeather (#603): a reuse runtime installs the reuse guards; read once, here, before anything is wrapped.\n"
    "\tvar pfReuse = !!Module['pagefeatherReuse'];\n")
old = "\t\tmakeAsyncFunction(original) {\n\t\t\treturn WebAssembly.promising(original);\n\t\t},\n"
assert js.count(old) == 1, 'makeAsyncFunction not found'
js = js.replace(old, "\t\tmakeAsyncFunction(original) {\n"
    "\t\t\tvar pfPromising = WebAssembly.promising(original);\n"
    "\t\t\tif (!pfReuse) return pfPromising;\n"
    "\t\t\treturn (...args) => {\n"
    "\t\t\t\tif (Module['pfDead']) throw new Error('pagefeather: this PHP runtime is retired');\n"
    "\t\t\t\tModule['pfInFlight'] = (Module['pfInFlight'] || 0) + 1;\n"
    "\t\t\t\tvar pfDone = () => { if (--Module['pfInFlight'] === 0 && Module['pfOnIdle']) Module['pfOnIdle'](); };\n"
    "\t\t\t\tlet r;\n"
    "\t\t\t\ttry {\n\t\t\t\t\tr = pfPromising(...args);\n\t\t\t\t} catch (e) {\n\t\t\t\t\tpfDone();\n\t\t\t\t\tthrow e;\n\t\t\t\t}\n"
    "\t\t\t\treturn r.finally(pfDone);\n"
    "\t\t\t};\n\t\t},\n")
old = "\t\tinstrumentFunction(original) {\n\t\t\tvar wrapper = (...args) => original(...args);\n"
assert js.count(old) == 1, 'instrumentFunction not found'
js = js.replace(old, "\t\tinstrumentFunction(original) {\n"
    "\t\t\tvar wrapper = !pfReuse ? (...args) => original(...args) : (...args) => {\n"
    "\t\t\t\tif (Module['pfDead']) throw new Error('pagefeather: this PHP runtime is retired');\n"
    "\t\t\t\treturn original(...args);\n\t\t\t};\n")
old = "\tvar callUserCallback = (func) => {\n\t\tif (runtimeExited || ABORT) {\n"
assert js.count(old) == 1, 'callUserCallback not found'
js = js.replace(old, "\tvar callUserCallback = (func) => {\n\t\tif (runtimeExited || ABORT || (pfReuse && Module['pfDead'])) {\n")
open(jp, 'w').write(js)
print('%s initial memory: %d pages, imported (env.memory, max %d pages; the loader builds it); OPcache SAPI list: frankenphp -> wasm%s' % ('kept (already transformed)' if done_mem else 'patched', PAGES0, PAGES_MAX, ' (kept)' if done_sapi else ''))
PY
