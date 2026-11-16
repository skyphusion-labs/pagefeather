// The runtime contract of the pagefeather engine (#582), as checks that run against ANY engine: today's
// @php-wasm/web-8-3 3.1.62 patched by prepare.sh, and later our own build. Each check boots the
// real loader and wasm in node and throws an AssertionError when the engine breaks the contract.
// engine-contract.test.mjs runs every check on the engine under test (they must pass), and on the
// UNPATCHED upstream 3.1.62 artifact from node_modules (each one that a patch exists for must fail).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const B2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(B2, 'package.json'));
globalThis.require ??= require; // the loader takes the node path in node and calls require
const { loadPHPRuntime, PHP, setPhpIniEntries, __private__dont_use, __private__dont__use } = require('@php-wasm/universal');
const PRIV = __private__dont__use ?? __private__dont_use;
const MiB = 1048576;
// Loader copies for this process (#612). The name carries the seat (PAGEFEATHER_SEAT)
// or the pid, so a leftover in a shared TMPDIR can be attributed. Removed on exit,
// including a failing run. It holds only copies, rewritten on every run.
function engine582Prefix() {
	const seat = (process.env.PAGEFEATHER_SEAT || '').replace(/[^A-Za-z0-9._-]/g, '');
	const who = seat ? seat + '-' + process.pid : String(process.pid);
	return 'engine582-' + who + '-';
}
const dir = mkdtempSync(join(tmpdir(), engine582Prefix()));
process.on('exit', () => { rmSync(dir, { recursive: true, force: true }); });
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

// Boot PHP from an engine. opts: env, open (pagefeatherOpen), read (pagefeatherRead), memory (pagefeatherMemory),
// reuse (pagefeatherReuse: the loader installs the reuse guards, #603), noFetch.
// Returns { php, imports, exports } (the import object the loader built, to see what it wrapped, and the instance exports).
export async function boot(e, opts = {}) {
	const loader = await loaderOf(e);
	let imports = null, exports = null;
	const realFetch = globalThis.fetch;
	if (opts.noFetch) globalThis.fetch = () => { throw new Error('the engine fetched while booting'); };
	try {
		const id = await loadPHPRuntime(loader, {
			ENV: opts.env || { USE_ZEND_ALLOC: '0' },
			instantiateWasm(imp, done) { imports = imp; const inst = new WebAssembly.Instance(e.module, imp); exports = inst.exports; done(inst, e.module); return inst.exports; },
			...(opts.open ? { pagefeatherOpen: opts.open } : {}),
			...(opts.read ? { pagefeatherRead: opts.read } : {}),
			...(opts.memory ? { pagefeatherMemory: opts.memory } : {}),
			...(opts.reuse ? { pagefeatherReuse: true } : {}),
		});
		return { php: new PHP(id), imports, exports };
	} finally { globalThis.fetch = realFetch; }
}
const run = async (php, code) => (await php.run({ code })).text;
// A run whose output must be JSON; anything else (a PHP warning, a fatal) fails as an assertion.
async function jrun(php, code) {
	const t = await run(php, code);
	try { return JSON.parse(t); } catch { assert.fail('PHP printed no JSON: ' + t.slice(0, 200)); }
}

// The wasm's sections are read by the ONE parser (engine/tools/wasm-sections.mjs, #603).
export { memoryShape, linkShape } from '../../../engine/tools/wasm-sections.mjs';
import { memoryShape, linkShape } from '../../../engine/tools/wasm-sections.mjs';
// The initial memory (pages) of the wasm, defined or imported.
export function initialPages(bytes) {
	const m = memoryShape(bytes);
	return (m.defined || m.imported || { min: null }).min;
}

const ms = (t) => new Promise((r) => setTimeout(r, t));

// How many async exports the engine's function table holds (getWasmTableEntry builds a promising wrapper lazily only
// for those). 0 on a static engine (lean): there, no lazily built promising wrapper can exist.
export async function asyncTableEntries(e) {
	const end = '\treturn PHPLoader;\n';
	const js = e.js.slice(0, e.js.lastIndexOf(end)) + "\tModule['__pfTest'] = { table: () => wasmTable, isAsync: (f) => Asyncify.isAsyncExport(f) };\n" + e.js.slice(e.js.lastIndexOf(end));
	const { php } = await boot({ ...e, js, loaderFile: null });
	const h = php[PRIV].__pfTest; const tab = h.table();
	let n = 0;
	for (let i = 1; i < tab.length; i++) { const f = tab.get(i); if (f && h.isAsync(f)) n++; }
	return n;
}

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
	// The inheritance cache (#582 S4 M2a): classes that extend a class and use a trait from ANOTHER cached
	// file are linked at run time and stored by zend_accel_inheritance_cache_add. Their trait methods are
	// fresh copies, so that add persists their whole bodies with the same routines a script uses. M2a's
	// first patch split those bodies to a NULL region (written near address 0 of the wasm memory) and broke
	// every admin page. 40 classes x 3 trait methods: literals, a loop, try/catch and a string switch; every
	// method is called; the first run adds to the cache, the second hits it. opts.noOpcache is its mutation.
	async 'opcache: the inheritance cache links classes across cached files'(e, opts = {}) {
		const { php } = await boot(e);
		// The Worker's OPcache (index.js opcacheIni): shared memory, not file_cache_only (the default here,
		// where opcache_enabled reads false and the inheritance cache never runs).
		// The eval file is blacklisted as in the Worker (#294): php.run writes every snippet to that ONE path.
		php.writeFile('/tmp/pf582-blacklist.txt', '/internal/eval.php\n');
		await setPhpIniEntries(php, { 'opcache.blacklist_filename': '/tmp/pf582-blacklist.txt', 'opcache.file_cache_only': '0', 'opcache.memory_consumption': '48', 'opcache.interned_strings_buffer': '4', 'opcache.max_accelerated_files': '4000', 'opcache.file_update_protection': '0' });
		const N = 40;
		php.writeFile('/tmp/pf582-base.php', `<?php
class Pf582Base { public function base($x) { $s = 0; for ($i = 0; $i < $x; $i++) { $s += $i; } return "base:" . $s; } }
trait Pf582T {
	public function t1($x) { $a = array(); for ($i = 0; $i < $x; $i++) { $a[] = "t1-" . $i . "-" . static::class; } return implode(",", $a); }
	public function t2($x) { try { if ($x > 3) { throw new RuntimeException("big:" . $x); } return "small:" . str_pad((string) $x, 4, "0", STR_PAD_LEFT); } catch (RuntimeException $e) { return "caught " . $e->getMessage(); } }
	public function t3($k) { switch ($k) { case "alpha": return "A1"; case "beta": return "B2"; case "gamma": return "G3"; default: return "other:" . strtoupper($k); } }
}`);
		let kids = '<?php\n';
		for (let i = 0; i < N; i++) kids += `class Pf582K${i} extends Pf582Base { use Pf582T; public function m${i}($x) { return "k${i}:" . str_repeat("ab", ${i % 7 + 1}) . ($x * ${i + 3}); } }\n`;
		php.writeFile('/tmp/pf582-kids.php', kids);
		const want = [];
		for (let i = 0; i < N; i++) {
			const c = 'Pf582K' + i;
			want.push([`k${i}:${'ab'.repeat(i % 7 + 1)}${2 * (i + 3)}`, 'base:10', `t1-0-${c},t1-1-${c},t1-2-${c}`, 'small:0002', 'caught big:9', 'B2', 'other:DELTA'].join('|'));
		}
		const off = opts.noOpcache ? 'ini_set("opcache.enable", "0"); ' : '';
		const code = `<?php ${off}require '/tmp/pf582-base.php'; require '/tmp/pf582-kids.php'; $o = array(); for ($i = 0; $i < ${N}; $i++) { $c = "Pf582K$i"; $k = new $c; $m = "m$i"; $o[] = implode("|", array($k->$m(2), $k->base(5), $k->t1(3), $k->t2(2), $k->t2(9), $k->t3("beta"), $k->t3("delta"))); } $s = function_exists("opcache_get_status") ? opcache_get_status(false) : false; echo json_encode(array(function_exists("opcache_is_script_cached") && opcache_is_script_cached("/tmp/pf582-base.php"), function_exists("opcache_is_script_cached") && opcache_is_script_cached("/tmp/pf582-kids.php"), $o));`;
		for (const pass of ['adds to the cache', 'hits the cache']) {
			const got = await jrun(php, code);
			assert.deepEqual(got.slice(0, 2), [true, true], pass + ': both files must be in OPcache shared memory');
			assert.deepEqual(got[2], want, pass + ': every inherited and trait method answers as compiled');
		}
	},
	// The file-cache fallback (#582 S4 M2a): a script too big for OPcache's shared memory is persisted again
	// by store_script_in_file_cache, and that second calc runs with corrupted set, so it counts strings the
	// first calc had already interned (upstream's calc then over-counts, and only warns). M2a's first patch
	// split that persist and required the head to end exactly where calc said: on WordPress with
	// WooCommerce (48 MB, 765 of 2,076 scripts) every page then stopped in a silent zend_bailout. 8,000
	// generated functions at memory_consumption 8; the script must miss shared memory and still answer.
	// opts.bigShm (the script fits) is its mutation.
	async 'opcache: a script too big for shared memory takes the file-cache fallback'(e, opts = {}) {
		const { php } = await boot(e);
		php.writeFile('/tmp/pf582-blacklist.txt', '/internal/eval.php\n');
		await setPhpIniEntries(php, { 'opcache.blacklist_filename': '/tmp/pf582-blacklist.txt', 'opcache.file_cache_only': '0', 'opcache.memory_consumption': opts.bigShm ? '64' : '8', 'opcache.interned_strings_buffer': '1', 'opcache.max_accelerated_files': '4000', 'opcache.file_update_protection': '0' });
		const N = 8000;
		let src = '<?php\n';
		for (let i = 0; i < N; i++) src += `function pf582big_${i}($x) { $a = array("k${i}a" => "v${i}a", "k${i}b" => "v${i}b"); try { if ($x < 0) { throw new Exception("neg${i}"); } return "f${i}:" . $a["k${i}a"] . ($x + ${i}); } catch (Exception $e) { return $e->getMessage(); } }\n`;
		php.writeFile('/tmp/pf582-big.php', src);
		const got = await jrun(php, `<?php require "/tmp/pf582-big.php"; echo json_encode(array(pf582big_0(1), pf582big_${N - 1}(-1), pf582big_4321(10), opcache_is_script_cached("/tmp/pf582-big.php")));`);
		assert.deepEqual(got.slice(0, 3), ['f0:v0a1', `neg${N - 1}`, 'f4321:v4321a4331'], 'the functions of the fallback script answer as compiled');
		assert.equal(got[3], false, 'the script must miss shared memory (the fallback path ran)');
	},
	// A static engine has no dylink.0 section and few exports; today's MAIN_MODULE has both (#582 S2).
	async 'link: dylink section and export count as expected'(e) {
		const got = linkShape(e.bytes);
		assert.equal(got.dylink, e.expect.static.dylink, 'dylink.0 section present: ' + got.dylink);
		if (e.expect.static.maxExports != null) assert.ok(got.exports <= e.expect.static.maxExports, got.exports + ' exports, over ' + e.expect.static.maxExports);
	},
	// The module starts small and grows on demand (prepare.sh: 1024 to 384 pages).
	async 'memory: the expected initial pages'(e) {
		assert.equal(initialPages(e.bytes), e.expect.initialPages);
		const { php } = await boot(e);
		assert.ok(php[PRIV].HEAPU8.buffer.byteLength >= e.expect.initialPages * 65536);
	},
	// #598: the engine IMPORTS its memory (prepare.sh), with the limits it defined, and the loader builds it with
	// exactly those limits (one source: prepare.sh writes both, so a changed start page cannot LinkError). Each boot
	// gets a NEW memory, and the runtime runs on the memory it imported.
	async 'memory: imported (env.memory), and the loader builds it with the same limits'(e) {
		const m = memoryShape(e.bytes);
		assert.equal(m.defined, null, 'the module still defines its own memory');
		assert.ok(m.imported && m.imported.module === 'env' && m.imported.field === 'memory', 'no env.memory import');
		assert.equal(m.imported.min, e.expect.initialPages);
		const lit = /wasmImports\['memory'\] = [^\n]*?new WebAssembly\.Memory\(\{ initial: (\d+), maximum: (\d+) \}\)/.exec(e.js);
		assert.ok(lit, 'the loader does not build the imported memory');
		assert.deepEqual([Number(lit[1]), Number(lit[2])], [m.imported.min, m.imported.max], 'the loader and the import disagree on the limits');
		const a = await boot(e), b = await boot(e);
		assert.equal(await run(a.php, '<?php echo 6 * 7;'), '42');
		assert.equal(a.php[PRIV].HEAPU8.buffer, a.exports.memory.buffer, 'the runtime is not on the memory it imported');
		assert.notEqual(a.php[PRIV].HEAPU8.buffer, b.php[PRIV].HEAPU8.buffer, 'two boots share a memory');
	},
	// #603: a reuse runtime takes a memory handed to it (pagefeatherMemory) as its own, by identity.
	async 'memory: a reuse runtime runs on a memory handed to it'(e) {
		const lim = memoryShape(e.bytes).imported;
		assert.ok(lim, 'the module does not import its memory');
		const mem = new WebAssembly.Memory({ initial: lim.min, maximum: lim.max });
		const { php } = await boot(e, { memory: mem, reuse: true });
		assert.equal(await run(php, '<?php echo 6 * 7;'), '42');
		assert.equal(php[PRIV].HEAPU8.buffer, mem.buffer, 'the runtime is not using the handed-in memory');
	},
	// #603: the loader counts a reuse runtime's promising calls in flight at the wasm boundary (pfInFlight): JSPI
	// suspends only inside one. usleep suspends (emscripten_sleep).
	async 'memory: promising calls in flight are counted'(e) {
		const { php } = await boot(e, { reuse: true });
		const M = php[PRIV];
		assert.equal(M.pfInFlight | 0, 0);
		const p = php.run({ code: '<?php usleep(150000); echo "slept";' });
		await ms(40);
		assert.ok((M.pfInFlight | 0) >= 1, 'a suspended run is not counted: pfInFlight ' + M.pfInFlight);
		assert.equal((await p).text, 'slept');
		assert.equal(M.pfInFlight | 0, 0, 'a settled run is still counted');
	},
	// #603 (#705 review, finding 2): once retired (pfDead), EVERY new call is refused, even while another call of it
	// is still in flight: only started calls may finish, so a retired runtime always drains. (index.js sets pfDead
	// only after the drain; this sets it mid-call on purpose.)
	async 'memory: a retired runtime refuses every new call, even with a call in flight'(e) {
		const { php } = await boot(e, { reuse: true });
		const M = php[PRIV];
		const p = php.run({ code: '<?php usleep(150000); echo "slept";' });
		await ms(40);
		assert.ok((M.pfInFlight | 0) >= 1, 'not in flight: the check proves nothing');
		M.pfDead = true;
		let sync = false, promising = false;
		try { M._malloc(16); } catch (err) { sync = /retired/.test(String(err && err.message)); }
		try { await M.___errno_location(); } catch (err) { promising = /retired/.test(String(err && err.message)); }
		assert.ok(sync, 'a synchronous export of a retired runtime ran');
		assert.ok(promising, 'a promising export of a retired runtime ran while another call was in flight');
		// every door refuses unconditionally once retired: the promising entry too, which async table entries reach
		// without the export wrapper (getWasmTableEntry); no door keeps the old "open while in flight" rule
		const doors = (e.js.match(/if \(Module\['pfDead'\]\) throw new Error\('pagefeather: this PHP runtime is retired'\);/g) || []).length;
		assert.equal(doors, 2, doors + ' unconditional call doors (the export wrapper and the promising entry)');
		assert.ok(!/pfDead'\] && !\(Module\['pfInFlight'\] > 0\)/.test(e.js), 'a door admits new calls while one is in flight');
		p.catch(() => {});
	},
	// #603 (#705 review, finding 8): a retired runtime runs NO callback (callUserCallback: the timers and the sleep
	// wake). A suspended usleep of a runtime retired mid-sleep is never woken.
	async 'memory: a retired runtime runs no callback (its sleep wake is refused)'(e) {
		const { php } = await boot(e, { reuse: true });
		const M = php[PRIV];
		let settled = false;
		php.run({ code: '<?php usleep(60000); echo "woke";' }).then(() => { settled = true; }, () => { settled = true; });
		await ms(20);
		M.pfDead = true;
		await ms(250);
		assert.equal(settled, false, 'the sleep wake of a retired runtime ran (callUserCallback is not guarded)');
	},
	// #598: without the reuse option, the loader adds NO per-call work: nothing is counted, and a runtime marked
	// retired still runs (the guards are not installed). Red on a loader whose guards are unconditional.
	async 'memory: without reuse the loader counts and checks nothing per call'(e) {
		const { php } = await boot(e);
		const M = php[PRIV];
		const p = php.run({ code: '<?php usleep(60000); echo "slept";' });
		await ms(20);
		assert.equal(M.pfInFlight, undefined, 'a call was counted without reuse: per-call work on the hot path');
		assert.equal((await p).text, 'slept');
		M.pfDead = true;
		assert.equal(await run(php, '<?php echo 3;'), '3', 'a runtime marked retired was refused without reuse');
	},
	// #603 (#705 review, finding 7): the reuse choice is read ONCE, at the top of the loader's init: setting the option
	// after a runtime booted installs nothing, in the wrappers built at instantiation or later (getWasmTableEntry).
	async 'memory: the reuse choice is fixed at init'(e) {
		const reads = (e.js.match(/Module\['pagefeatherReuse'\]/g) || []).length;
		assert.equal(reads, 1, 'the loader reads the reuse option ' + reads + ' times, not once at init');
		const { php } = await boot(e);
		const M = php[PRIV];
		M.pagefeatherReuse = true;
		M.pfDead = true;
		assert.equal(await run(php, '<?php echo 4;'), '4', 'a later flip of the option changed a running runtime');
	},
	// #724 review, finding 6: the choice is fixed at init BEHAVIOURALLY, for the doors built later too. A test-only
	// copy of the loader (never the product file) exposes getWasmTableEntry, its mirror and the table, so a table
	// entry of an async export can be rebuilt lazily AFTER the option is flipped: it must carry no guard. And a
	// callback of a runtime booted without reuse still runs after the option is flipped and the runtime marked
	// retired (callUserCallback reads the init choice, not the Module).
	async 'memory: the reuse choice is fixed at init, for lazily built wrappers and callbacks too'(e, opts = {}) {
		const hook = "\tvar pfReuse = !!Module['pagefeatherReuse'];\n";
		const end = '\treturn PHPLoader;\n';
		assert.ok(e.js.includes(hook) && e.js.lastIndexOf(end) > 0, 'the loader shape changed: the test cannot hook it');
		const js = e.js.slice(0, e.js.lastIndexOf(end)) + "\tModule['__pfTest'] = { getWasmTableEntry, mirror: wasmTableMirror, table: () => wasmTable, isAsync: (f) => Asyncify.isAsyncExport(f) };\n" + e.js.slice(e.js.lastIndexOf(end));
		const t = { ...e, js, loaderFile: null };
		const lazyGuarded = async (reuse) => {
			const { php } = await boot(t, reuse ? { reuse: true } : {});
			const M = php[PRIV]; const h = M.__pfTest; const tab = h.table();
			let idx = -1;
			for (let i = 1; i < tab.length && idx < 0; i++) { const f = tab.get(i); if (f && h.isAsync(f)) idx = i; }
			if (idx < 0) return 'none';
			delete h.mirror[idx];
			M.pagefeatherReuse = !reuse; // flipped after init
			return /pfDead/.test(String(h.getWasmTableEntry(idx)));
		};
		// A static engine (lean) puts no async export in its table: getWasmTableEntry can then build no promising
		// wrapper at all, so that door does not exist there (the loop above proved the table holds none). The npm engine
		// has them, and there both sides are checked: the control must see the guard, the flipped boot must not.
		const control = await lazyGuarded(true);
		if (control !== 'none') {
			assert.equal(control, true, 'control: a reuse runtime\'s lazily built wrapper has no guard: the check cannot see one');
			assert.equal(await lazyGuarded(false), false, 'a wrapper built after the option was flipped read the Module, not the init choice');
		} else {
			assert.equal(await lazyGuarded(false), 'none', 'the two boots of one engine disagree on its table');
		}
		const { php } = await boot(opts.engine || e);
		const M = php[PRIV];
		const p = php.run({ code: '<?php usleep(60000); echo "woke";' });
		await ms(20);
		M.pagefeatherReuse = true;
		M.pfDead = true;
		const r = await Promise.race([p.then((x) => x.text), ms(1500).then(() => 'stuck')]);
		assert.equal(r, 'woke', 'a callback of a runtime booted without reuse was refused after the option was flipped');
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
	// Fibers (#624). wasm32 has no boost.context assembly, so the build passes
	// --disable-fiber-asm and PHP uses ucontext. The loader's getcontext (and
	// makecontext, swapcontext) is an abort stub: it prints "missing function: ${name}"
	// and abort() becomes unreachable, which kills the runtime, not just the request.
	// The probe is the one in the issue. On the lean engine (no dylink) the runtime must
	// survive it, either by running the fiber or by throwing a catchable Error
	// ("Fibers are not supported on this platform"), and the next php.run() must work.
	// The npm engine cannot be patched here. dylink marks it; the check records the
	// abort as a known gap and does not fail.
	async 'fibers: start() does not abort the runtime'(e) {
		const probe = '<?php $f = new Fiber(function ($x) { $g = Fiber::suspend("s:" . $x); return "r:" . $g; }); echo $f->start("a"); $f->resume("b"); echo $f->getReturn();';
		const caught = '<?php try { $f = new Fiber(function ($x) { $g = Fiber::suspend("s:" . $x); return "r:" . $g; }); $f->start("a"); } catch (Error $e) { echo "caught:" . get_class($e) . ":" . $e->getMessage(); }';
		const { php } = await boot(e);
		let text = null;
		let err = null;
		try { text = await run(php, probe); } catch (e) { err = e; }
		const msg = err ? String(err.message || err) : '';
		const stack = err ? String(err.stack || '') : '';
		const runtimeAbort = !!err && (err instanceof WebAssembly.RuntimeError || msg.includes('unreachable') || msg.includes('Aborted(') || msg.includes('missing function') || stack.includes('_getcontext'));
		if (e.expect.static && e.expect.static.dylink === true) {
			console.log('@event fiber-gap ' + JSON.stringify({ engine: e.name, gap: true, missing: 'getcontext', abort: runtimeAbort, detail: (err ? msg + ' ' + stack : String(text)).slice(0, 300) }));
			return;
		}
		if (err) {
			assert.ok(!runtimeAbort, 'Fiber::start aborted the runtime: ' + (msg + '\n' + stack).slice(0, 500));
			assert.match(msg, /Uncaught Error: Fibers are not supported on this platform/);
			assert.equal(await run(php, caught), 'caught:Error:Fibers are not supported on this platform');
		} else {
			assert.equal(text, 's:ar:b', 'the fiber probe did not run and did not throw: ' + String(text).slice(0, 200));
		}
		assert.equal(await run(php, '<?php echo 6*7;'), '42', 'the next php.run() after Fiber::start failed');
	},
};

// The engine under test: ENGINE_JS and ENGINE_WASM, or the prepared vendor/ engine; ENGINE_EXPECT
// names its expectation file (default: today's engine).
// #771: with no ENGINE_EXPECT, vendor/ holding the PINNED lean engine (vendor/engine.mjs says lean, the default) is
// judged by engine/expect/lean.json, as pagefeather-engine.yml judges the published build. Everything else keeps the
// default it always had, the upstream 3.1.62 file: npm, no marker (an older prepare.sh), and a custom engine (the
// engine workflow's gate jobs vendor their own arm and name ENGINE_EXPECT where the expectation matters).
export function defaultExpect(vendorEngineMjs = join(B2, 'vendor/engine.mjs')) {
	let src = '';
	try { src = readFileSync(vendorEngineMjs, 'utf8'); } catch { /* no marker */ }
	const m = src.match(/export const PHP_ENGINE = '([a-z]+)';/);
	return m && m[1] === 'lean' ? join(B2, '../../engine/expect/lean.json') : join(B2, '../../engine/expect/upstream-3.1.62.json');
}
export function engineUnderTest() {
	const expectPath = process.env.ENGINE_EXPECT || defaultExpect();
	return engine(process.env.ENGINE_JS ? 'ENGINE_JS' : 'vendor',
		process.env.ENGINE_JS || join(B2, 'vendor/php_8_3.js'), process.env.ENGINE_WASM || join(B2, 'vendor/php_8_3.wasm'),
		JSON.parse(readFileSync(expectPath, 'utf8')));
}

// The upstream artifact exactly as npm ships it: what every prepare.sh patch exists to change.
export function upstreamRaw(expect) {
	const d = join(B2, 'node_modules/@php-wasm/web-8-3/jspi');
	return engine('upstream-raw', join(d, 'php_8_3.js'), join(d, '8_3_36/php_8_3.wasm'), expect);
}
