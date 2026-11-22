// node --test spikes/b2-wordpress/tests/boot-phases.test.mjs (#1022 E2)
// The perf line of a boot request splits bootWaitMs into phases, so the about 1.1 s more per reboot under
// PHP_MEMORY_REUSE (#1022 issuecomment-7069498841) can be attributed: wait (the pending offer and an instantiating
// boot), prep (the spare's take, its zero-fill, and the gate), wasm (instantiation), site and files (the mounts),
// init (the rest of boot()), and total. A reading only: Date.now() moves only at I/O on Workers, so each phase is
// the wall time between I/O points, not CPU (a synchronous step's cost lands in the next phase that ends at I/O).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootPhases } from '../boot-phases.mjs';

test('#1022 bootPhases: the phases from the boot marks, and they sum to the total', () => {
	const marks = { b0: 1000, waitDone: 1120, t0: 1150, wasm: 400, site: 200, files: 650, end: 2600, reused: true };
	const p = bootPhases(marks);
	assert.deepEqual(p, { wait: 120, prep: 30, wasm: 400, site: 200, files: 450, init: 400, total: 1600, reused: 1 });
	assert.equal(p.wait + p.prep + p.wasm + p.site + p.files + p.init, p.total);
});
test('#1022 bootPhases: a boot without reuse, and missing marks give no line (never a made-up 0)', () => {
	const p = bootPhases({ b0: 0, waitDone: 0, t0: 0, wasm: 300, site: 100, files: 400, end: 900, reused: false });
	assert.equal(p.reused, 0);
	assert.equal(p.init, 200);
	assert.equal(p.wait + p.prep + p.wasm + p.site + p.files + p.init, p.total);
	assert.equal(bootPhases(null), undefined);
	assert.equal(bootPhases({ b0: 1, waitDone: 2 }), undefined);
});
// #1022 E2 follow-up (issuecomment-7071275200): on cf759a every phase before init read 0 (no I/O there), and the
// reused boots' extra sat in init. init is split at its own I/O points: the salts' digests, the boot self-check's
// php.run (where a boot's first pack fetches happen), and the rest; and packs says what the boot fetched.
test('#1022 bootPhases: init split at its I/O points, and the packs this boot fetched', () => {
	const marks = { b0: 0, waitDone: 0, t0: 0, wasm: 0, site: 0, files: 0, salted: 40, check0: 50, check1: 950, end: 1000, reused: true,
		rc0: { rfN: 2, rfBytes: 1048576, rsN: 1, rsBytes: 2048 }, rc1: { rfN: 9, rfBytes: 8 * 1048576, rsN: 3, rsBytes: 6144 } };
	const p = bootPhases(marks);
	assert.equal(p.init, 1000);
	assert.deepEqual(p.initSplit, { salts: 40, check: 900, rest: 60 }, 'rest is init net of the salts and the check, the writes between them included');
	assert.equal(p.initSplit.salts + p.initSplit.check + p.initSplit.rest, p.init);
	assert.deepEqual(p.packs, { rfN: 7, rfKiB: 7168, rsN: 2, rsKiB: 4 });
});
test('#1022 bootPhases: marks without the init split still give the phases, with no initSplit or packs', () => {
	const p = bootPhases({ b0: 0, waitDone: 0, t0: 0, wasm: 300, site: 100, files: 400, end: 900, reused: false });
	assert.equal(p.init, 200);
	assert.equal('initSplit' in p, false);
	assert.equal('packs' in p, false);
	const q = bootPhases({ b0: 0, waitDone: 0, t0: 0, wasm: 0, site: 0, files: 0, salted: 30, end: 500, reused: false });
	assert.equal('initSplit' in q, false, 'a partial set of init marks gives no split, never a made-up one');
});
test('#1022 index.js: boot() takes the marks and returns them; the perf line carries bootPh on a boot only', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const at = src.indexOf('async function boot(origin) {');
	const boot = src.slice(at, src.indexOf('\n}\n', at) + 2); // the whole of boot(), to its closing brace
	assert.match(boot, /const tB0 = Date\.now\(\);/);
	assert.match(boot, /const tWaitDone = Date\.now\(\);/);
	assert.match(boot, /marks: \{ b0: tB0, waitDone: tWaitDone, t0, wasm: tWasm, site: tSite, files: tFiles, end: Date\.now\(\), reused: !!reuse[,} ]/); // the init split's marks follow (E2 follow-up)
	assert.match(src, /\.\.\.\(booted && bootMs \? \{ bootPh: bootPhases\(bootMs\.marks\) \} : \{\}\)/);
	assert.match(boot, /const rc0 = remoteCounters\(\);/, 'the pack counters at the boot start');
	assert.match(boot, /const tSalted = Date\.now\(\);/);
	assert.match(boot, /const tCheck0 = Date\.now\(\);/);
	assert.match(boot, /const tCheck1 = Date\.now\(\);/);
	assert.match(boot, /salted: tSalted, check0: tCheck0, check1: tCheck1, rc0, rc1: remoteCounters\(\)/);
});
