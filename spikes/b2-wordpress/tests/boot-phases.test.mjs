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
test('#1022 index.js: boot() takes the marks and returns them; the perf line carries bootPh on a boot only', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const at = src.indexOf('async function boot(origin) {');
	const boot = src.slice(at, src.indexOf('\n}\n', at) + 2); // the whole of boot(), to its closing brace
	assert.match(boot, /const tB0 = Date\.now\(\);/);
	assert.match(boot, /const tWaitDone = Date\.now\(\);/);
	assert.match(boot, /marks: \{ b0: tB0, waitDone: tWaitDone, t0, wasm: tWasm, site: tSite, files: tFiles, end: Date\.now\(\), reused: !!reuse \}/);
	assert.match(src, /\.\.\.\(booted && bootMs \? \{ bootPh: bootPhases\(bootMs\.marks\) \} : \{\}\)/);
});
