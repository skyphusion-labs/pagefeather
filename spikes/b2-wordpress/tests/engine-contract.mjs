// The runtime contract of the pagefeather engine (#582), as checks that run against ANY engine: today's
// @php-wasm/web-8-3 3.1.62 patched by prepare.sh, and later our own build. Each check boots the
// real loader and wasm in node and throws an AssertionError when the engine breaks the contract.
// engine-contract.test.mjs runs every check on the engine under test (they must pass), and on the
// UNPATCHED upstream 3.1.62 artifact from node_modules (each one that a patch exists for must fail).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const B2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(B2, 'package.json'));
globalThis.require ??= require; // the loader takes the node path in node and calls require
const { loadPHPRuntime, PHP, __private__dont_use, __private__dont__use } = require('@php-wasm/universal');
const PRIV = __private__dont__use ?? __private__dont_use;
const MiB = 1048576;
const dir = mkdtempSync(join(tmpdir(), 'engine582-'));
let seq = 0;

// An engine: the loader source, the compiled module, the wasm bytes, and what it must be.
export function engine(name, jsPath, wasmPath, expect) {
	const js = readFileSync(jsPath, 'utf8');
	const bytes = readFileSync(wasmPath);
	return { name, js, bytes, module: new WebAssembly.Module(bytes), expect };
}

// Each boot imports its own copy of the loader, so no module state is shared between boots.
async function loaderOf(e) {
	if (!e.loaderFile) { e.loaderFile = join(dir, 'loader-' + (seq++) + '.mjs'); writeFileSync(e.loaderFile, e.js); }
	return import(pathToFileURL(e.loaderFile).href + '?b=' + (seq++));
}

// Boot PHP from an engine. opts: env, open (pagefeatherOpen), read (pagefeatherRead), noFetch.
// Returns { php, imports } (the import object the loader built, to see what it wrapped).
export async function boot(e, opts = {}) {
	const loader = await loaderOf(e);
	let imports = null;
	const realFetch = globalThis.fetch;
	if (opts.noFetch) globalThis.fetch = () => { throw new Error('the engine fetched while booting'); };
	try {
		const id = await loadPHPRuntime(loader, {
			ENV: opts.env || { USE_ZEND_ALLOC: '0' },
			instantiateWasm(imp, done) { imports = imp; const inst = new WebAssembly.Instance(e.module, imp); done(inst, e.module); return inst.exports; },
			...(opts.open ? { pagefeatherOpen: opts.open } : {}),
			...(opts.read ? { pagefeatherRead: opts.read } : {}),
		});
		return { php: new PHP(id), imports };
	} finally { globalThis.fetch = realFetch; }
}
const run = async (php, code) => (await php.run({ code })).text;
// A run whose output must be JSON; anything else (a PHP warning, a fatal) fails as an assertion.
async function jrun(php, code) {
	const t = await run(php, code);
	try { return JSON.parse(t); } catch { assert.fail('PHP printed no JSON: ' + t.slice(0, 200)); }
}

// The initial memory (pages) of the wasm's own memory section.
export function initialPages(bytes) {
	const leb = (i) => { let r = 0, s = 0, x; do { x = bytes[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [r, i]; };
	let i = 8;
	while (i < bytes.length) {
		const id = bytes[i++]; const [size, j] = leb(i); i = j;
		if (id === 5) { const [, k] = leb(i); return leb(k + 1)[0]; }
		i += size;
	}
	return null;
}

const ms = (t) => new Promise((r) => setTimeout(r, t));

export const checks = {
	// workerd has no import.meta.url; the Worker passes the module through instantiateWasm, so the
	// loader must never fetch the wasm (prepare.sh, first edit).
	async 'loader: no import.meta, boots through instantiateWasm with no fetch'(e) {
		assert.ok(!/import\.meta/.test(e.js), 'the loader reads import.meta');
		const { php } = await boot(e, { noFetch: true });
		assert.equal(await run(php, '<?php echo 6*7;'), '42');
	},
	// PHP version, SAPI name and the loaded extensions are EXACTLY the expected lists.
	async 'extensions: exactly the expected list'(e) {
		const { php } = await boot(e);
		const got = await jrun(php, '<?php $a = get_loaded_extensions(); sort($a); $z = get_loaded_extensions(true); sort($z); echo json_encode(array(PHP_VERSION, PHP_SAPI, $a, $z));');
		assert.deepEqual(got, [e.expect.php, e.expect.sapi, [...e.expect.extensions].sort(), [...e.expect.zendExtensions].sort()]);
	},
	// OPcache runs only under SAPIs in its own list; ours is "wasm" (prepare.sh, the SAPI patch).
	async 'opcache: compiles under SAPI wasm'(e) {
		const { php } = await boot(e);
		php.writeFile('/tmp/oc582.php', '<?php function oc582() { return 1; }');
		const got = await jrun(php, '<?php echo json_encode(array(PHP_SAPI, (bool) @opcache_get_status(false), @opcache_compile_file("/tmp/oc582.php")));');
		assert.deepEqual(got, ['wasm', true, true]);
	},
	// The module starts small and grows on demand (prepare.sh: 1024 to 384 pages).
	async 'memory: the expected initial pages'(e) {
		assert.equal(initialPages(e.bytes), e.expect.initialPages);
		const { php } = await boot(e);
		assert.ok(php[PRIV].HEAPU8.buffer.byteLength >= e.expect.initialPages * 65536);
	},
	// USE_ZEND_ALLOC=0: plain malloc, so the Zend allocator reports 0 (#547 reads it this way).
	async 'allocator: USE_ZEND_ALLOC=0 is honoured'(e, opts = {}) {
		const { php } = await boot(e, { env: opts.env || { USE_ZEND_ALLOC: '0' } });
		assert.equal(await run(php, '<?php echo memory_get_usage(true);'), '0');
	},
	// The Worker clock does not move while code runs. gettimeofday() must still move forward, or a
	// second uniqid() spins until the CPU limit (prepare.sh, the clock patch).
	async 'clock: gettimeofday moves forward with Date.now frozen'(e) {
		const { php } = await boot(e);
		const now = Date.now;
		const t = now();
		Date.now = () => t;
		let got;
		try { got = await jrun(php, '<?php $a = gettimeofday(true); $b = gettimeofday(true); echo json_encode(array($a, $b));'); }
		finally { Date.now = now; }
		assert.ok(got[1] > got[0], 'gettimeofday did not move: ' + JSON.stringify(got));
	},
	// Heap growth is the need plus a small slack, never 1.2 times the old size (#445).
	async 'heap: growth steps stay near the need'(e) {
		const grow = WebAssembly.Memory.prototype.grow;
		const steps = [];
		WebAssembly.Memory.prototype.grow = function (n) { steps.push(n); return grow.call(this, n); };
		try {
			const { php } = await boot(e);
			await run(php, '<?php $a = array(); for ($i = 0; $i < 96; $i++) $a[] = str_repeat(chr(65 + $i % 26), 1048576); echo count($a);');
		} finally { WebAssembly.Memory.prototype.grow = grow; }
		assert.ok(steps.length > 0, 'the heap never grew, so the check saw nothing');
		const worst = Math.max(...steps) * 65536;
		assert.ok(worst <= 4 * MiB, 'a growth step of ' + (worst / MiB).toFixed(1) + ' MiB for a 1 MiB need');
	},
	// Heap views past the 128 MiB ArrayBuffer limit of workerd (#518): each view has its own subarray.
	// heap-subarray.test.mjs tests its behaviour; this pins that the engine has it.
	async 'heap views: own subarray past the workerd limit'(e) {
		const { php } = await boot(e);
		const h = php[PRIV].HEAPU8;
		assert.ok(Object.hasOwn(h, 'subarray'), 'HEAPU8 has the native subarray');
	},
	// open() may pause on a promise from pagefeatherOpen (#563), and the import is Suspending ONLY
	// when the hook is set.
	async 'open hook: open() waits for the promise, and only with a hook'(e) {
		let FS = null;
		const open = (path) => path === '/tmp/late582.txt' ? ms(5).then(() => FS.writeFile(path, 'late bytes')) : null;
		const { php, imports } = await boot(e, { open });
		FS = php[PRIV].FS;
		assert.ok(imports.env.__syscall_openat instanceof WebAssembly.Suspending, 'openat is not Suspending with a hook');
		assert.equal(await run(php, '<?php echo @file_get_contents("/tmp/late582.txt");'), 'late bytes');
		const plain = await boot(e);
		assert.ok(!(plain.imports.env.__syscall_openat instanceof WebAssembly.Suspending), 'openat is Suspending with no hook');
	},
	// A rejected open promise fails the open (EIO), never opens a half file.
	async 'open hook: a rejected promise fails the open'(e) {
		const open = (path) => path === '/tmp/fail582.txt' ? Promise.reject(new Error('fetch failed')) : null;
		const { php } = await boot(e, { open });
		php.writeFile('/tmp/fail582.txt', 'present');
		assert.equal(await run(php, '<?php $f = @fopen("/tmp/fail582.txt", "r"); echo $f === false ? "failed" : "opened";'), 'failed');
	},
	// read() and mmap() may pause on a promise from pagefeatherRead (#569): fread, file_get_contents
	// (read) and readfile (mmap) see the bytes the hook put in place before it resolved.
	async 'read hook: read and mmap wait for the promise'(e) {
		const kinds = new Set();
		const want = 'real-bytes-582';
		const read = (stream, kind) => {
			if (stream.path !== '/tmp/lazy582.txt') return null;
			kinds.add(kind);
			return ms(2).then(() => { stream.node.contents = new TextEncoder().encode(want); stream.node.usedBytes = want.length; });
		};
		const { php } = await boot(e, { read });
		const reset = () => php.writeFile('/tmp/lazy582.txt', 'x'.repeat(want.length));
		reset();
		const a = await run(php, '<?php $f = fopen("/tmp/lazy582.txt", "r"); echo fread($f, 64);');
		reset();
		const b = await run(php, '<?php echo file_get_contents("/tmp/lazy582.txt");');
		reset();
		const c = await run(php, '<?php readfile("/tmp/lazy582.txt");');
		assert.deepEqual([a, b, c], [want, want, want]);
		assert.ok(kinds.has('read'), 'the hook saw no read: ' + [...kinds]);
	},
	// The exports php-wasm calls while PHP may suspend are promising (phpwasm-exports.test.mjs has
	// the full rule; this pins the two that run every request).
	async 'exports: the request entry points are promising'(e) {
		const m = /var exportPattern =\s*\/\^\(([^)]*)\)\$\//.exec(e.js);
		assert.ok(m, 'the loader has an exportPattern');
		const p = new Set(m[1].split('|'));
		for (const n of ['php_wasm_init', 'wasm_sapi_handle_request']) assert.ok(p.has(n), n + ' is not promising');
	},
};

// The engine under test: ENGINE_JS and ENGINE_WASM, or the prepared vendor/ engine; ENGINE_EXPECT
// names its expectation file (default: today's engine).
export function engineUnderTest() {
	const expectPath = process.env.ENGINE_EXPECT || join(B2, '../../engine/expect/upstream-3.1.62.json');
	return engine(process.env.ENGINE_JS ? 'ENGINE_JS' : 'vendor',
		process.env.ENGINE_JS || join(B2, 'vendor/php_8_3.js'), process.env.ENGINE_WASM || join(B2, 'vendor/php_8_3.wasm'),
		JSON.parse(readFileSync(expectPath, 'utf8')));
}

// The upstream artifact exactly as npm ships it: what every prepare.sh patch exists to change.
export function upstreamRaw(expect) {
	const d = join(B2, 'node_modules/@php-wasm/web-8-3/jspi');
	return engine('upstream-raw', join(d, 'php_8_3.js'), join(d, '8_3_36/php_8_3.wasm'), expect);
}
