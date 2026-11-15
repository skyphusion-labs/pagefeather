// #582 S4 M2b: the lazy-body contract suite on the WASM engine. node --test tests/lazy-bodies.test.mjs, with
// ENGINE_JS and ENGINE_WASM naming a lean-lazy (or lean-stats-lazy) build, after npm ci and ./prepare.sh.
// The cases are engine/opcache/lazy/probe.php, the same file run-native.sh runs on a native php-cli. Boot A
// primes a file cache from the fixtures (opcache_compile_file: nothing runs). Then each mode gets a fresh
// runtime with those .bin files: lazy (bodies load at first call), eager (opcache.pagefeather_lazy_load=0) and
// compiled (OPcache off). Every case must answer the same in all three, and pass its lazy-only checks.
// Wasm only: test 12 (a body read held back by pagefeatherRead, Suspending inside the opcode handler), test 14
// (a remote read that fails once, then serves), test 16 (observers, on a stats build) and a red control (the
// lazy checks must fail on the eager runtime, so they can see a missing lazy load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { B2, boot, engineUnderTest } from './engine-contract.mjs';

const require = createRequire(join(B2, 'package.json'));
const { setPhpIniEntries } = require('@php-wasm/universal');
const LZ = join(B2, '../../engine/opcache/lazy');
const DIR = '/tmp/pf582lb', OC = '/tmp/pf582oc';
const FIXTURES = readdirSync(LZ).filter((f) => f.endsWith('.php'));
const CASES = ['plain', 'methods', 'refl', 'copy', 'fail', 'never', 'missing', 'ic', 'xref'];
const e = engineUnderTest();
const ms = (t) => new Promise((r) => setTimeout(r, t));

async function text(php, code) {
	try { const r = await php.run({ code }); return r.text + (r.errors || ''); } catch (err) { return String(err && err.message || err); }
}
async function json(php, code) {
	const t = await text(php, code);
	try { return JSON.parse(t.trim().split('\n').pop()); } catch { assert.fail('PHP printed no JSON: ' + t.slice(0, 400)); }
}
const LB = 'function lbx() { $s = @opcache_get_status(false); return is_array($s) && isset($s["pagefeather_lazy_bodies"]) ? $s["pagefeather_lazy_bodies"] : array(); } function lbd($a, $b) { $d = array(); foreach ($b as $k => $v) { if (is_int($v)) { $d[$k] = $v - ($a[$k] ?? 0); } } return $d; }';

async function runtime(mode, opts = {}) {
	const { php } = await boot(e, opts);
	php.writeFile('/tmp/pf582-blacklist.txt', '/internal/eval.php\n');
	php.mkdir(DIR);
	php.mkdir(OC); // OPcache turns the file cache off at startup when its directory does not exist
	for (const f of FIXTURES) php.writeFile(DIR + '/' + f, readFileSync(join(LZ, f), 'utf8'));
	const ini = { 'opcache.enable': mode === 'compiled' ? '0' : '1', 'opcache.blacklist_filename': '/tmp/pf582-blacklist.txt', 'opcache.file_cache': OC,
		'opcache.file_cache_only': '0', 'opcache.memory_consumption': '64', 'opcache.interned_strings_buffer': '8', 'opcache.max_accelerated_files': '4000',
		'opcache.validate_timestamps': '0', 'opcache.file_update_protection': '0' };
	if (mode === 'eager') ini['opcache.pagefeather_lazy_load'] = '0';
	await setPhpIniEntries(php, ini);
	if (opts.bins) {
		const payload = Buffer.from(JSON.stringify(opts.bins)).toString('base64');
		const w = await text(php, `<?php $n = 0; foreach (json_decode(base64_decode("${payload}"), true) as $p => $b) { @mkdir(dirname($p), 0777, true); file_put_contents($p, base64_decode($b)); $n++; } echo $n;`);
		assert.equal(w.trim(), String(Object.keys(opts.bins).length), 'the primed .bin files were not all written: ' + w.slice(0, 200));
	}
	return php;
}

let primed = null;
async function prime() {
	if (primed) return primed;
	const php = await runtime('lazy');
	const got = await json(php, `<?php ${LB} foreach (glob("${DIR}/f_*.php") as $f) { if (!opcache_compile_file($f)) { echo json_encode(array("err" => $f)); exit; } }
		$o = array(); $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("${OC}", FilesystemIterator::SKIP_DOTS));
		foreach ($it as $p) { $o[(string) $p] = base64_encode(file_get_contents((string) $p)); } echo json_encode(array("lb" => lbx(), "bins" => $o));`);
	assert.ok(!got.err, 'prime: could not compile ' + got.err);
	assert.ok(got.lb && got.lb.dir_entries > 0, 'prime: this engine has no lazy-body directory (not a lazy-body engine): ' + JSON.stringify(got.lb));
	assert.ok(Object.keys(got.bins).length >= FIXTURES.length - 1, 'prime: only ' + Object.keys(got.bins).length + ' .bin files');
	primed = got.bins;
	return primed;
}
// Fibers abort the runtime on the wasm engines today, OPcache on or off (a gap of the engine, not of lazy bodies;
// run-native.sh covers the Fiber half of test 15). A throwaway runtime finds out, and the probe is told.
let fiberless = null;
async function noFiber() {
	if (fiberless === null) {
		const { php } = await boot(e);
		const t = await text(php, '<?php $f = new Fiber(function () { return Fiber::suspend(1); }); $f->start(); $f->resume(2); echo "fiber-ok";');
		fiberless = !t.includes('fiber-ok');
		if (fiberless) console.log('@event lazy-note ' + JSON.stringify({ fiber: 'not supported by this engine (the Fiber half of test 15 runs natively only)', got: t.slice(0, 120) }));
	}
	return fiberless;
}
const probe = async (php, c, mode) => json(php, `<?php $pf_lb_nofiber = ${(await noFiber()) ? 'true' : 'false'}; $pf_lb_case = "${c}"; $pf_lb_mode = "${mode}"; require "${DIR}/probe.php";`);

test('the probe cases answer the same lazy, eager and compiled, and pass their lazy checks (tests 1 to 11, 13)', async () => {
	const bins = await prime();
	const rt = { lazy: await runtime('lazy', { bins }), eager: await runtime('eager', { bins }), compiled: await runtime('compiled', { bins }) };
	for (const c of CASES) {
		const got = {};
		for (const m of ['lazy', 'eager', 'compiled']) got[m] = await probe(rt[m], c, m);
		assert.deepEqual(got.lazy.fail, [], c + ': lazy checks failed');
		assert.deepEqual(got.lazy.out, got.compiled.out, c + ': lazy answers differ from compiled');
		assert.deepEqual(got.eager.out, got.compiled.out, c + ': eager answers differ from compiled');
		console.log('@event lazy-case ' + JSON.stringify({ case: c, ok: true, lb: got.lazy.lb }));
	}
	for (const m of ['lazy', 'eager', 'compiled']) {
		const t = await text(rt[m], `<?php $pf_lb_case = "tcbad"; $pf_lb_mode = "${m}"; require "${DIR}/probe.php";`);
		assert.ok(/collision/.test(t) && !/NO COLLISION/.test(t), 'tcbad ' + m + ': want the trait-collision fatal, got ' + t.slice(-300));
	}
});

test('red control: the lazy checks fail on the eager runtime (they can see a missing lazy load)', async () => {
	const bins = await prime();
	const php = await runtime('eager', { bins });
	const got = await probe(php, 'plain', 'lazy');
	assert.ok(got.fail.length > 0, 'the lazy checks passed on a runtime that loads every body at once');
});

test('test 12: a body read held back by pagefeatherRead still loads (Suspending inside the opcode handler)', async () => {
	const bins = await prime();
	const h = { on: false, hits: 0 };
	const read = (stream) => (h.on && String(stream.path || '').endsWith('/f_delay.php.bin')) ? (h.hits++, ms(25)) : null;
	const php = await runtime('lazy', { bins, read });
	const a = await json(php, `<?php ${LB} $t = lbx(); require "${DIR}/f_delay.php"; echo json_encode(lbd($t, lbx()));`);
	assert.equal(a.lazy_scripts, 1, 'f_delay.php did not load lazily: ' + JSON.stringify(a));
	h.on = true;
	const b = await json(php, `<?php ${LB} require "${DIR}/f_delay.php"; $t = lbx(); $r = pf_lb_delayed(7); echo json_encode(array($r, lbd($t, lbx())));`);
	assert.equal(b[0], 'delayed:7');
	assert.ok(h.hits >= 1, 'the read hook never held a body read: the check saw nothing');
	assert.equal(b[1].body_loads, 1);
	assert.equal(b[1].body_fail, 0);
});

test('test 14: a remote read that fails once: the call throws, NOTHING is installed, the next call loads', async () => {
	const bins = await prime();
	const h = { rejectOnce: false, rejected: 0 };
	const read = (stream) => {
		if (h.rejectOnce && String(stream.path || '').endsWith('/f_transient.php.bin')) { h.rejectOnce = false; h.rejected++; return Promise.reject(new Error('remote pack fetch failed')); }
		return null;
	};
	const php = await runtime('lazy', { bins, read });
	await json(php, `<?php ${LB} require "${DIR}/f_transient.php"; echo json_encode(lbx());`);
	h.rejectOnce = true;
	const a = await json(php, `<?php ${LB} require "${DIR}/f_transient.php"; $cl = Closure::fromCallable("pf_lb_transient"); $t = lbx(); $m = null;
		try { pf_lb_transient(1); } catch (Error $x) { $m = $x->getMessage(); } $d = lbd($t, lbx()); $m2 = null; echo json_encode(array($m, $d));`);
	assert.equal(h.rejected, 1, 'the hook did not fail the body read: the check saw nothing');
	assert.ok(a[0] && a[0].includes('pf_lb_transient') && a[0].includes('f_transient.php.bin'), 'want an Error naming the function and the path, got ' + a[0]);
	assert.equal(a[1].body_fail, 1);
	assert.equal(a[1].body_loads, 0, 'a failed load counted as a load');
	assert.equal(a[1].body_bytes_resident, 0, 'a failed load left bytes resident');
	assert.equal(a[1].copy_installs, 0, 'a failed load installed into a copy');
	const b = await json(php, `<?php ${LB} require "${DIR}/f_transient.php"; $t = lbx(); $r = array(pf_lb_transient(2), pf_lb_transient(3)); echo json_encode(array($r, lbd($t, lbx())));`);
	assert.deepEqual(b[0], ['transient:2', 'transient:3']);
	assert.equal(b[1].body_loads, 1, 'the call after the failure did not read the body: the failure left something installed');
	assert.equal(b[1].body_fail, 0);
});

test('test 16: observers see each call of a lazy function once, and count the real body (stats build only)', async (t) => {
	const bins = await prime();
	const php = await runtime('lazy', { bins });
	if ((await text(php, '<?php echo function_exists("pagefeather_opcache_stats") ? "yes" : "no";')).trim() !== 'yes') {
		t.skip('not a stats build (ENGINE_OPCACHE_STATS=0): runs on lean-stats-lazy');
		return;
	}
	const work = `<?php require "${DIR}/f_obs.php"; $a = pagefeather_opcache_stats(); $r = array(pf_lb_observed(3), pf_lb_observed(3), pf_lb_observed(2), pf_lb_observed_other(45)); $b = pagefeather_opcache_stats();
		echo json_encode(array($r, $b["observed_begin"] - $a["observed_begin"], $b["observed_end"] - $a["observed_end"]));`;
	const read = '<?php $s = pagefeather_opcache_stats(); echo json_encode(array($s["declared_functions"], $s["called_functions"], $s["called_body_bytes"]));';
	const lazy = await json(php, work), lazyStats = await json(php, read);
	const eager = await runtime('eager', { bins });
	const eagerRun = await json(eager, work), eagerStats = await json(eager, read);
	assert.deepEqual(lazy[0], eagerRun[0]);
	assert.deepEqual([lazy[1], lazy[2]], [4, 4], 'observer begin and end per call of a lazy function (4 calls): ' + JSON.stringify(lazy));
	assert.deepEqual([eagerRun[1], eagerRun[2]], [4, 4], 'eager: ' + JSON.stringify(eagerRun));
	assert.deepEqual(lazyStats, eagerStats, 'the stats observer counted other bodies with lazy loading (the stub, not the real opcodes?)');
});
