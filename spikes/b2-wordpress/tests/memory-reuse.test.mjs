// #598 / #603: reuse of the retired runtime's memory (memory-reuse.mjs and the prepare.sh loader patch).
// node --test tests/memory-reuse.test.mjs (after npm ci and ./prepare.sh: the engine tests boot the real vendor
// engine, and the red tests boot the UNPATCHED upstream artifact).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reuseOn, createSpare, moduleImportsMemory, bootTestDelayMs, SPARE_TTL_MS, drainAndRetire } from '../memory-reuse.mjs';
import { boot, engineUnderTest, upstreamRaw, memoryShape } from './engine-contract.mjs';
import { untransformMemory } from '../../../engine/tools/wasm-sections.mjs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { B2 } from './engine-contract.mjs';

const PRIV = createRequire(join(B2, 'package.json'))('@php-wasm/universal').__private__dont__use;
const ms = (t) => new Promise((r) => setTimeout(r, t));

test('the flag: off by default, on only for "on"', () => {
	assert.equal(reuseOn({}), false);
	assert.equal(reuseOn(undefined), false);
	assert.equal(reuseOn({ PHP_MEMORY_REUSE: 'on' }), true);
	assert.equal(reuseOn({ PHP_MEMORY_REUSE: ' ON' }), true);
	assert.equal(reuseOn({ PHP_MEMORY_REUSE: '1' }), false);
});

test('#603 (C): the spare has a lifetime: dropped after its TTL with no boot', async () => {
	assert.equal(SPARE_TTL_MS, 30000);
	const sp = createSpare({ ttlMs: 30 });
	const m = new WebAssembly.Memory({ initial: 1 });
	assert.equal(sp.offer(m, { on: true, inFlight: 0, current: false }), 'kept');
	assert.equal(sp.mib > 0, true);
	await ms(60);
	assert.equal(sp.mib, 0, 'the spare outlived its TTL: memory pinned with no boot');
	assert.equal(sp.take(), null);
	assert.equal(sp.counts.expired, 1);
	// taken in time: no expiry
	const sp2 = createSpare({ ttlMs: 1000 });
	sp2.offer(m, { on: true, inFlight: 0, current: false });
	assert.equal(sp2.take(), m);
	// expire() drops it at once (the alarm calls it for a spare past its TTL)
	const sp3 = createSpare({ ttlMs: 50 });
	sp3.offer(m, { on: true, inFlight: 0, current: false });
	assert.equal(sp3.expire(Date.now() + 51), true);
	assert.equal(sp3.mib, 0);
});

test('#603 (C): a module that does not import env.memory never gets reuse (read from the module, before instantiation)', () => {
	const t = engineUnderTest();
	assert.equal(moduleImportsMemory(t.module), true);
	const raw = upstreamRaw(t.expect);
	assert.equal(moduleImportsMemory(raw.module), false, 'a module with its own memory was taken as importing one');
});

test('#603 (B): the boot test seam is off unless set, and bounded', () => {
	assert.equal(bootTestDelayMs({}), 0);
	assert.equal(bootTestDelayMs({ BOOT_TEST_DELAY_MS: '1500' }), 1500);
	assert.equal(bootTestDelayMs({ BOOT_TEST_DELAY_MS: '20000' }), 0, 'past 10000 ms is refused (0)');
	assert.equal(bootTestDelayMs({ BOOT_TEST_DELAY_MS: 'x' }), 0);
});

test('the spare: kept only with the flag on, no newer runtime and no call in flight; one at most; take zeroes it', () => {
	const sp = createSpare();
	const m = new WebAssembly.Memory({ initial: 2 });
	new Uint8Array(m.buffer).fill(7);
	assert.equal(sp.offer(m, { on: false, inFlight: 0, current: false }), 'off');
	assert.equal(sp.offer(m, { on: true, inFlight: 0, current: true }), 'newer-runtime');
	assert.equal(sp.offer(m, { on: true, inFlight: 1, current: false }), 'in-flight');
	assert.equal(sp.offer(null, { on: true, inFlight: 0, current: false }), 'no-memory');
	assert.equal(sp.mib, 0, 'nothing refused is kept');
	assert.equal(sp.take(), null);
	assert.equal(sp.offer(m, { on: true, inFlight: 0, current: false }), 'kept');
	assert.equal(sp.mib, 0.1);
	const m2 = new WebAssembly.Memory({ initial: 1 });
	assert.equal(sp.offer(m2, { on: true, inFlight: 0, current: false }), 'kept');
	assert.equal(sp.counts.replaced, 1, 'a newer spare replaces the older one');
	assert.equal(sp.take(), m2);
	assert.equal(sp.take(), null, 'taken once');
	sp.offer(m, { on: true, inFlight: 0, current: false });
	const t = sp.take();
	assert.equal(t, m);
	assert.ok(new Uint8Array(t.buffer).every((b) => b === 0), 'the spare is zeroed when taken');
});

test('a pending offer that never settles is dropped after the bound, and its timer cleared (#705 second review, finding 5)', async () => {
	const sp = createSpare();
	assert.equal('peek' in sp, false, 'spare.peek is back (finding 8: it was dead)');
	sp.setPending(new Promise(() => {})); // never settles
	const t0 = Date.now();
	assert.equal(await sp.waitPending(30), 'timeout');
	assert.ok(Date.now() - t0 >= 25);
	assert.equal(sp.pending, false, 'the dead pending offer was kept: every later boot would wait again');
	const t1 = Date.now();
	assert.equal(await sp.waitPending(30), 'none');
	assert.ok(Date.now() - t1 < 10, 'a later boot waited for nothing');
	let done;
	sp.setPending(new Promise((ok) => { done = ok; }));
	setTimeout(() => done(), 5);
	assert.equal(await sp.waitPending(1000), 'settled');
	assert.equal(sp.pending, false);
});

// What index.js releaseRuntime does, against the real loader: read the Module, exit, mark it dead, offer.
// php.exit leaves the exit handlers in flight for a microtask: the offer waits for pfOnIdle, as index.js does.
async function release(php, mem, sp) {
	const M = php[PRIV];
	try { php.exit(0); } catch { /* exited */ }
	M.pfDead = true;
	const offer = () => sp.offer(mem, { on: true, inFlight: M.pfInFlight | 0, current: false });
	if ((M.pfInFlight | 0) === 0) return offer();
	return new Promise((ok) => { M.pfOnIdle = () => { M.pfOnIdle = null; ok(offer()); }; setTimeout(() => ok('never-idle'), 1000); });
}

// Three runtimes and two recycles, the spare handed on each time. Returns each boot's memory and its answer.
async function threeRuntimes(e) {
	const sp = createSpare();
	const seen = [];
	let memory = null;
	for (let i = 0; i < 3; i++) {
		const { php, exports } = await boot(e, memory ? { memory, reuse: true } : { reuse: true });
		const mem = exports.memory; // as index.js: the instance's memory (imported or its own)
		const out = (await php.run({ code: '<?php $a = str_repeat("r", 8 * 1048576); echo "runtime ' + i + ' ", strlen($a);' })).text;
		seen.push({ mem, buffer: php[PRIV].HEAPU8.buffer, out, handed: !!memory });
		seen[i].offer = await release(php, mem, sp);
		memory = sp.take();
	}
	return seen;
}

test('two recycles with reuse: ONE memory across three runtimes, by identity, and every boot answers', async () => {
	const seen = await threeRuntimes(engineUnderTest());
	assert.deepEqual(seen.map((s) => s.offer), ['kept', 'kept', 'kept'], 'each release kept its memory');
	for (let i = 0; i < 3; i++) assert.equal(seen[i].out, 'runtime ' + i + ' 8388608', 'boot ' + i + ' answered ' + seen[i].out);
	assert.ok(seen[0].mem instanceof WebAssembly.Memory);
	assert.equal(seen[1].mem, seen[0].mem, 'the second runtime has a new memory');
	assert.equal(seen[2].mem, seen[0].mem, 'the third runtime has a new memory');
	assert.equal(seen[2].buffer, seen[2].mem.buffer, 'the runtime reads the reused memory');
});

test('goes red on the unpatched upstream artifact: it defines its own memory, so every runtime has a new one', async () => {
	const raw = upstreamRaw(engineUnderTest().expect);
	const seen = await threeRuntimes(raw);
	assert.notEqual(seen[1].buffer, seen[0].buffer, 'the unpatched engine reused a memory');
	assert.notEqual(seen[2].buffer, seen[1].buffer);
});


// A mismatched build: today's loader (it hands in the spare) with the same engine's wasm made BEFORE the transform
// (it still defines its own memory). PHP_MEMORY_REUSE=on must fail safe: the spare is an unused extra import,
// every runtime keeps its own memory, and every boot answers.
test('a pre-transform wasm under the reuse loader ignores the spare and keeps working', async () => {
	const t = engineUnderTest();
	const pre = untransformMemory(t.bytes);
	const m = memoryShape(pre);
	assert.deepEqual([m.defined && m.defined.min, m.imported], [384, null], 'the untransformed wasm does not define its memory');
	const e = { ...t, name: 'mismatch: vendor loader, pre-transform wasm', bytes: pre, module: new WebAssembly.Module(pre), loaderFile: null };
	const seen = await threeRuntimes(e);
	for (let i = 0; i < 3; i++) assert.equal(seen[i].out, 'runtime ' + i + ' 8388608', 'boot ' + i + ' answered ' + seen[i].out);
	assert.ok(seen[1].handed && seen[2].handed, 'the test handed no spare in: it proves nothing');
	assert.notEqual(seen[1].buffer, seen[0].buffer, 'a pre-transform wasm used the spare');
	assert.notEqual(seen[2].buffer, seen[1].buffer);
});

// #603 (#705 review, finding 1): the memory is handed on only after the JS continuations of the settled calls have
// run. The loader's order, replayed with a fake Module: the wasm call settles, the wrapper's finally drops the count
// to 0 (pfOnIdle), and only THEN does the caller's continuation run, which still reads the heap (php-wasm's ccall:
// stackRestore, UTF8ToString). A boot that zeroes the spare as soon as it is offered must not get there first.
async function handoffRace(retire) {
	const heap = new Uint8Array(16).fill(7);
	const M = { pfInFlight: 0, pfOnIdle: null, pfDead: false };
	let wasmDone;
	const wasm = new Promise((ok) => { wasmDone = ok; });
	M.pfInFlight++;
	const wrapped = wasm.finally(() => { if (--M.pfInFlight === 0 && M.pfOnIdle) M.pfOnIdle(); });
	let read = null;
	const caller = (async () => { await wrapped; read = heap[0]; })(); // the continuation that reads the heap
	const offered = retire(M).then(() => heap.fill(0)); // the next boot zeroes the spare once it is offered
	wasmDone();
	await Promise.all([caller, offered]);
	return { read, dead: M.pfDead };
}
test('the handoff waits until the JS side is done with the heap (#705 review, finding 1)', async () => {
	const r = await handoffRace((M) => drainAndRetire(M));
	assert.equal(r.read, 7, 'the caller read a heap the next boot had already zeroed');
	assert.equal(r.dead, true);
	// the red control: an offer made the moment the count reaches 0 (the old pfOnIdle offer) zeroes it first
	const early = await handoffRace((M) => new Promise((ok) => { M.pfOnIdle = () => { M.pfDead = true; ok(); }; }));
	assert.equal(early.read, 0, 'the control did not reproduce the race: this test proves nothing');
});

test('drainAndRetire: dead only once drained; a call that starts during the drain is waited for; bounded', async () => {
	const M = { pfInFlight: 1, pfOnIdle: null, pfDead: false };
	const p = drainAndRetire(M, { roundMs: 20 });
	await ms(5);
	assert.equal(M.pfDead, false, 'retired while a call was in flight');
	M.pfInFlight--; if (M.pfOnIdle) M.pfOnIdle();
	M.pfInFlight++; // a new call started in the drain (before pfDead): counted, so waited for
	await ms(10);
	assert.equal(M.pfDead, false);
	M.pfInFlight--; if (M.pfOnIdle) M.pfOnIdle();
	assert.equal(await p, 'drained');
	assert.equal(M.pfDead, true);
	// a call that never settles: bounded, dead anyway, and never handed on
	const S = { pfInFlight: 1, pfOnIdle: null, pfDead: false };
	assert.equal(await drainAndRetire(S, { rounds: 3, roundMs: 5 }), 'no-drain');
	assert.equal(S.pfDead, true);
});

// Condition 4, on the real loader: a runtime retired while a call of it is suspended drains first. The call
// finishes on its own memory, pfDead comes only after it, and only then is the memory kept.
test('a runtime retired while a call is suspended drains before its memory is handed on', async () => {
	const e = engineUnderTest();
	const { php, exports } = await boot(e, { reuse: true });
	const M = php[PRIV];
	const mem = exports.memory;
	const p = php.run({ code: '<?php usleep(150000); echo "slept";' });
	await ms(40);
	assert.ok((M.pfInFlight | 0) >= 1, 'the run is not suspended in flight: the test proves nothing');
	const sp = createSpare();
	let why = null;
	const retiring = drainAndRetire(M).then((w) => { why = w; return sp.offer(mem, { on: true, inFlight: M.pfInFlight | 0, current: false }); });
	await ms(30);
	assert.notEqual(M.pfDead, true, 'retired while its call was in flight');
	assert.equal(sp.mib, 0, 'a memory with a suspended stack became the spare');
	assert.equal((await p).text, 'slept', 'the call in flight did not finish on its own memory');
	assert.equal(await retiring, 'kept');
	assert.deepEqual([why, M.pfDead, M.pfInFlight | 0], ['drained', true, 0]);
	let refused = false;
	try { await php.run({ code: '<?php echo 1;' }); } catch { refused = true; }
	assert.ok(refused, 'a retired runtime started a new call');
});
