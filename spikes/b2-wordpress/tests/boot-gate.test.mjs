// #598 part 2: the boot gate (boot-gate.mjs). node --expose-gc --test tests/boot-gate.test.mjs (after npm ci and
// ./prepare.sh: the last test boots the real vendor engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_DEFAULTS, gateSettings, expectedMiB, decide, BootRefused, bootRefusedResponse, createGateClock, withBootRefusal } from '../boot-gate.mjs';
import * as gateModule from '../boot-gate.mjs';
import { applyGate, needGc } from './require-env.mjs';

const S = { ...GATE_DEFAULTS, on: true, refused: [] };

test('the arithmetic: retired + expected must fit the budget, at the edge exactly', () => {
	// a new runtime expects 112 of a 120 budget: 8 MiB of retired memory still fits, 8.1 does not
	assert.equal(decide(8, S).boot, true);
	assert.equal(decide(8.1, S).boot, false);
	// nothing retired: it boots; a negative or bad reading is read as 0
	assert.equal(decide(0, S).boot, true);
	assert.equal(decide(-5, S).boot, true);
	assert.equal(decide(NaN, S).boot, true);
	// the 16:54Z death: a 111.4 MiB retired runtime, then the login
	const d = decide(111.4, S);
	assert.deepEqual([d.boot, d.retiredMiB, d.expectMiB, d.budgetMiB], [false, 111.4, 112, 120]);
});

test('every boot is sized as admin, whatever request boots it (#705 review, finding 5)', () => {
	// the runtime serves every later request, so a guest page that boots it is sized as the next admin screen
	assert.equal(expectedMiB(S), 112);
	assert.equal(decide(30, S).boot, false, 'a boot beside 30 MiB retired would reach 142 at the next admin screen');
	assert.equal(decide.length, 2, 'decide takes no request class');
	assert.equal('bootClass' in gateModule, false, 'the class is back');
	assert.equal('guestMiB' in GATE_DEFAULTS, false);
});

test('expected size: never below the start size of the engine', () => {
	assert.equal(expectedMiB({ ...S, adminMiB: 10, startMiB: 24 }), 24);
	assert.equal(expectedMiB(S), 112);
});

test('settings: off by default, whole numbers only, a bad value keeps the default and is named', () => {
	assert.equal(gateSettings({}).on, false);
	assert.equal(gateSettings({ BOOT_GATE: 'on' }).on, true);
	assert.equal(gateSettings({ BOOT_GATE: 'ON ' }).on, true);
	assert.equal(gateSettings({ BOOT_GATE: 'yes' }).on, false);
	const s = gateSettings({ BOOT_GATE: 'on', BOOT_GATE_BUDGET_MIB: '118', BOOT_GATE_ADMIN_MIB: 'lots', BOOT_GATE_START_MIB: '-1' });
	assert.equal(s.budgetMiB, 118);
	assert.equal(s.adminMiB, GATE_DEFAULTS.adminMiB);
	assert.equal(s.startMiB, GATE_DEFAULTS.startMiB);
	assert.deepEqual(s.refused.sort(), ['BOOT_GATE_ADMIN_MIB', 'BOOT_GATE_START_MIB']);
});

test('it never waits: no wait setting and no waiting entry point (the GC never came within 660 s, #598)', () => {
	assert.equal('waitMs' in GATE_DEFAULTS, false);
	assert.equal('gateBoot' in gateModule, false, 'a waiting gate is back');
});

test('a reused spare never causes a refusal, even one bigger than the budget (#705 review, finding 4)', () => {
	// refusing beside a spare frees nothing (the spare stays held), so the boot goes onto it
	assert.equal(decide(0, S, 121).boot, true, 'a 121 MiB spare refused every later boot');
	assert.equal(decide(0, S, 82.5).boot, true);
	// and the spare is reported apart from the retired memory; beside OTHER retired memory it is sized (second
	// review, finding 4): 8 + max(112, 118) = 126 does not fit
	assert.deepEqual([decide(8, S, 118).boot, decide(8, S, 118).spareMiB, decide(8, S, 118).retiredMiB], [false, 118, 8]);
	// no spare: the arithmetic decides
	assert.equal(decide(30, S, 0).boot, false);
});

test('a spare plus OTHER retired memory is sized, not waved through (#705 second review, finding 4)', () => {
	// a spare of 80 and a stuck retired 80: the new runtime grows to 112 on the spare, beside the 80
	assert.equal(decide(80, S, 80).boot, false, 'spare 80 plus retired 80 was waved through');
	// the edge: retired + max(expected, spare) against the budget
	assert.equal(decide(8, S, 100).boot, true, '8 + max(112, 100) = 120 fits');
	assert.equal(decide(8.1, S, 100).boot, false, '8.1 + 112 = 120.1 does not');
	assert.equal(decide(4, S, 116).boot, true, '4 + max(112, 116) = 120 fits');
	assert.equal(decide(4.1, S, 116).boot, false, '4.1 + 116 = 120.1 does not');
	// a spare alone never refuses, even one bigger than the budget (first review, finding 4)
	assert.equal(decide(0, S, 121).boot, true);
});

test('the gate never refuses for longer than its bound (#705 second review, finding 1)', () => {
	assert.equal(GATE_DEFAULTS.maxRefuseS, 60);
	const s = { ...S, maxRefuseS: 30 };
	assert.equal(decide(80, s, 0, 29999).boot, false, 'inside the bound the arithmetic decides');
	const d = decide(80, s, 0, 30000);
	assert.deepEqual([d.boot, d.expired], [true, true], 'past the bound the boot goes (the platform reset frees what GC does not)');
	assert.equal(gateSettings({ BOOT_GATE: 'on', BOOT_GATE_MAX_REFUSE_S: '5' }).maxRefuseS, 5);
	assert.deepEqual(gateSettings({ BOOT_GATE: 'on', BOOT_GATE_MAX_REFUSE_S: '601' }).refused, ['BOOT_GATE_MAX_REFUSE_S']);
	// the clock: a streak starts at the first refusal and ends at a boot
	let t = 1000;
	const c = createGateClock(() => t);
	assert.equal(c.refusingForMs(), 0);
	c.refused(); t += 5000; c.refused(); t += 5000;
	assert.equal(c.refusingForMs(), 10000);
	c.booted();
	assert.equal(c.refusingForMs(), 0, 'a boot ends the streak');
});

test('withBootRefusal: a refused boot on any route is the known 503; anything else is rethrown (#705 second review, finding 2)', async () => {
	const r = await withBootRefusal(async () => { throw new BootRefused(decide(111.4, S)); });
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('x-runtime-wait'), 'retired-resident');
	await assert.rejects(withBootRefusal(async () => { throw new Error('other'); }), /other/);
	const ok = new Response('fine');
	assert.equal(await withBootRefusal(async () => ok), ok);
});

test('index.js: ONE conversion of a refused boot, at handle() itself, for the object and the Worker (variant a)', async () => {
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /async function handle\(req, env, url, spikeOk, maxBody, ctx\) \{\n\treturn withBootRefusal\(\(\) => handleInner\(req, env, url, spikeOk, maxBody, ctx\)\);\n\}/);
	assert.equal([...src.matchAll(/withBootRefusal\(/g)].length, 1, 'more than one conversion point');
	assert.equal([...src.matchAll(/(?<!function )handle\(req, env, url, spikeOk, maxBody, ctx\)/g)].length, 2, 'the object and the Worker call handle()');
});

test('the refusal: a typed error, and a fast known 503 that no cache keeps', async () => {
	const d = decide(111.4, S);
	const e = new BootRefused(d);
	assert.equal(e.bootRefused, d);
	const r = bootRefusedResponse(d);
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('retry-after'), '5');
	assert.equal(r.headers.get('x-runtime-wait'), 'retired-resident');
	assert.equal(r.headers.get('x-runtime-wait-mib'), '111.4');
	assert.equal(r.headers.get('cache-control'), 'no-store');
});

// #705 review, finding 6: the old form held the buffer strongly and could not fail. Here the test keeps only a
// WeakRef. The gate reads what a released runtime leaves alive: it must be alive, at full size, beside the new
// runtime BEFORE a collection, and gone after one, which proves the test holds nothing itself.
test('the signal is real: a released runtime\'s memory stays alive at full size until V8 collects it, and the test holds none of it', async (t) => {
	if (applyGate(t, needGc())) return;
	const { boot, engineUnderTest, B2 } = await import('./engine-contract.mjs');
	const { createRequire } = await import('node:module');
	const { join } = await import('node:path');
	const PRIV = createRequire(join(B2, 'package.json'))('@php-wasm/universal').__private__dont__use;
	const e = engineUnderTest();
	let ref = null, bytes = 0;
	await (async () => {
		const { php, exports } = await boot(e);
		await php.run({ code: '<?php $s = str_repeat("x", 48 * 1048576); echo strlen($s);' });
		bytes = php[PRIV].HEAPU8.buffer.byteLength;
		ref = new WeakRef(exports.memory);
		try { php.exit(0); } catch { /* released as index.js releaseRuntime does */ }
	})();
	assert.ok(bytes >= 48 * 1048576, 'the first runtime grew to ' + bytes);
	const b = (await boot(e)).php;
	await b.run({ code: '<?php echo 1;' });
	assert.equal(ref.deref() && ref.deref().buffer.byteLength, bytes, 'the released memory is gone or smaller beside the new runtime');
	// deref() keeps its target alive for the rest of this job: collect across turns, then read once
	let gone = false;
	for (let i = 0; i < 20 && !gone; i++) {
		await new Promise((ok) => setTimeout(ok, 20));
		globalThis.gc();
		await new Promise((ok) => setTimeout(ok, 0));
		gone = ref.deref() === undefined;
	}
	assert.ok(gone, 'the released memory was never collected: something holds it, and the reading above proves nothing');
	assert.ok(b, 'the second runtime stays referenced to here');
});
