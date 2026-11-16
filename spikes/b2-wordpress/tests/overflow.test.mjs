// overflow.mjs (#296 step (3), ruled 2026-11-15): a request that would WAIT in a busy Worker isolate
// runs on a pool Durable Object instead, before it has run. Pure decisions, plus a two-isolate
// simulation on the REAL php-lock.mjs and a fake clock: never two runs at once in one isolate or object,
// and every request runs exactly once, wherever it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overflowSettings, shouldOverflow, createPicker, overflowName, objectBusy } from '../overflow.mjs';
import { createPhpLock } from '../php-lock.mjs';

test('settings: off by default; on, always, the depth, the pool and the hint', () => {
	// The default pool is 32, the measured best (#296, 2026-11-15): pool 8 and 16 were WORSE than no overflow at 250
	// concurrent checkouts; pool 32 was the only setting with 0 exceededMemory. A bad value falls back to 32 too.
	assert.deepEqual(overflowSettings({}), { on: false, always: false, depth: 1, pool: 32, hint: 'wnam', busy: false });
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on' }).on, true);
	const a = overflowSettings({ PHP_OVERFLOW: 'always', PHP_OVERFLOW_DEPTH: '0', PHP_OVERFLOW_POOL: '32', PHP_OVERFLOW_HINT: 'enam' });
	assert.deepEqual(a, { on: true, always: true, depth: 0, pool: 32, hint: 'enam', busy: false });
	// #296 (3)(c): busy is its own flag, OFF by default (ruled 2026-11-15: pool 32 WITHOUT busy was the only setting
	// with 0 exceededMemory at 250; busy moved the queue back into the Worker). Only "on" turns it on.
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_BUSY: 'on' }).busy, true);
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_BUSY: 'yes' }).busy, false);
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'yes' }).on, false, 'only on or always turn it on');
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '0' }).pool, 32, 'a bad pool keeps the default (32)');
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '999' }).pool, 32);
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: 'x' }).pool, 32);
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '8' }).pool, 8, 'a valid value is kept');
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_DEPTH: 'x' }).depth, 1);
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_HINT: 'mars' }).hint, 'wnam', 'only a real location hint');
});

test('the decision: only when this isolate is busy and the queue is at the depth; never a spike path or an upload', () => {
	const on = overflowSettings({ PHP_OVERFLOW: 'on' });
	const u = (p) => new URL('https://s.example' + p);
	assert.equal(shouldOverflow(on, { running: 0, waiting: 0 }, u('/'), false), false, 'idle: run here');
	assert.equal(shouldOverflow(on, { running: 1, waiting: 0 }, u('/'), false), false, 'one in flight, none waiting: depth 1 not reached');
	assert.equal(shouldOverflow(on, { running: 1, waiting: 1 }, u('/'), false), true, 'busy and one waiting: overflow');
	assert.equal(shouldOverflow(on, { running: 1, waiting: 5 }, u('/_install'), false), false, 'spike and operator paths stay here');
	assert.equal(shouldOverflow(on, { running: 1, waiting: 5 }, u('/wp-admin/async-upload.php'), true), false, 'a media upload stays here');
	assert.equal(shouldOverflow(overflowSettings({}), { running: 1, waiting: 9 }, u('/'), false), false, 'off: never');
	const d0 = overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_DEPTH: '0' });
	assert.equal(shouldOverflow(d0, { running: 1, waiting: 0 }, u('/'), false), true, 'depth 0: any run in flight');
	assert.equal(shouldOverflow(d0, { running: 0, waiting: 0 }, u('/'), false), false, 'depth 0 but idle: run here, never move a request that would not wait');
	const al = overflowSettings({ PHP_OVERFLOW: 'always' });
	assert.equal(shouldOverflow(al, { running: 0, waiting: 0 }, u('/'), false), true, 'always: even an idle isolate (the functional proof)');
	assert.equal(shouldOverflow(al, { running: 0, waiting: 0 }, u('/_ping'), false), false);
});

test('the picker: power of two choices on in-flight counts, names ovf-<i>, and counts that never go negative', () => {
	assert.equal(overflowName(3), 'ovf-3');
	// rand 0.1 -> first choice i = floor(0.1 * 8) = 0; rand 0.6 -> j = floor(0.6 * 7) = 4, which skips i
	// (j >= i) to 5. So the two choices are objects 0 and 5.
	const seq = [0.1, 0.6];
	let k = 0;
	const p = createPicker(8, () => seq[k++ % seq.length]);
	p.start(0); p.start(0);
	assert.equal(p.pick(), 5, 'object 0 holds 2 in flight, object 5 none: the less loaded wins');
	p.start(5); p.start(5); p.start(5);
	assert.equal(p.pick(), 0, 'now 0 holds 2 and 5 holds 3: object 0 wins');
	assert.deepEqual([p.inflight(0), p.inflight(5)], [2, 3]);
	for (let i = 0; i < 5; i++) p.end(5);
	assert.equal(p.inflight(5), 0, 'never below 0');
	const one = createPicker(1, Math.random);
	for (let i = 0; i < 5; i++) assert.equal(one.pick(), 0);
	// Spread: with real randomness and every pick held, no object gets far more than its share.
	const s = createPicker(8, Math.random);
	for (let i = 0; i < 64; i++) s.start(s.pick());
	const counts = Array.from({ length: 8 }, (_, i) => s.inflight(i));
	assert.ok(Math.max(...counts) <= 12, 'power of two choices keeps the max near the mean (8): ' + counts.join(','));
});

// A fake clock for the simulation (as tests/php-lock.test.mjs).
function fakeClock() {
	let t = 0, timers = [], seq = 0;
	const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
	return {
		now: () => t,
		setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + Math.max(0, ms), fn }); return id; },
		clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
		async advance(ms) {
			const end = t + ms; await flush();
			for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const n = timers[0]; if (!n || n.at > end) break; timers.shift(); t = n.at; n.fn(); await flush(); }
			t = end; await flush();
		},
	};
}

async function simulate({ env, requests, runMs }) {
	const c = fakeClock();
	const mk = () => createPhpLock({ staleMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
	const isolates = [mk(), mk()]; // two Worker isolates, as the platform routes them
	const s = overflowSettings(env);
	const objects = Array.from({ length: s.pool }, mk);
	const picker = createPicker(s.pool, Math.random);
	const ran = new Map(); // request id -> where it ran, how many times
	const live = new Map(); let maxLive = 0;
	const job = (id, where) => () => new Promise((res) => {
		const n = (live.get(where) || 0) + 1; live.set(where, n); maxLive = Math.max(maxLive, n);
		const r = ran.get(id) || { n: 0, where: [] }; r.n++; r.where.push(where); ran.set(id, r);
		c.setTimer(() => { live.set(where, live.get(where) - 1); res(id); }, runMs);
	});
	const ps = [];
	for (let id = 0; id < requests; id++) {
		const iso = isolates[id % 2];
		const where = 'iso' + (id % 2);
		if (shouldOverflow(s, { running: iso.running, waiting: iso.waiting }, new URL('https://s.example/'), false)) {
			const o = picker.pick(); picker.start(o);
			ps.push(objects[o].run(job(id, 'obj' + o)).finally(() => picker.end(o)));
		} else ps.push(iso.run(job(id, where)));
	}
	await c.advance(requests * runMs + 10000);
	await Promise.all(ps);
	return { ran, maxLive, moved: [...ran.values()].filter((r) => r.where[0].startsWith('obj')).length };
}

test('two isolates, 40 requests at once: every request runs exactly once, never two at once anywhere', async () => {
	const r = await simulate({ env: { PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '8' }, requests: 40, runMs: 600 });
	assert.equal(r.ran.size, 40);
	assert.ok([...r.ran.values()].every((x) => x.n === 1), 'each request ran once');
	assert.equal(r.maxLive, 1, 'one run at a time per isolate and per object');
	assert.ok(r.moved > 0 && r.moved < 40, 'some moved (the busy queue), some ran in the isolates: ' + r.moved);
});

test('control: overflow off keeps all 40 in the two isolates (and they still run one at a time)', async () => {
	const r = await simulate({ env: {}, requests: 40, runMs: 600 });
	assert.equal(r.moved, 0);
	assert.ok([...r.ran.values()].every((x) => x.n === 1));
	assert.equal(r.maxLive, 1);
});

// index.js cannot be imported under node (it loads php-wasm), so these read its source (as perf-headers.test.mjs).
// Found in review on local workerd (2026-11-15, PHP_OVERFLOW=always, e2e.sh): an overflowed content change made
// the POOL OBJECT schedule its own purge, so its alarm fired, and the alarm is the object's cron driver: a cron
// run happened in a pool object. Its purge also failed ("no cache API": an object cannot purge the Worker's page
// cache). So an overflowed request hands its purge back to the front Worker.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('an overflowed request never arms the object alarm: neither the cron rearm nor a purge alarm', () => {
	// #715 review2 5: the guard is named armsCron, and the rearm happens inside the run.
	assert.match(src, /const armsCron = !url\.pathname\.startsWith\('\/_'\) && !overflowed;/, 'the cron rearm is skipped');
	assert.match(src, /if \(armsCron\) \{\n\t+lastOrigin = origin;/, 'and only armsCron arms it');
	assert.match(src, /requestPurge: overflowed \? async \(\) => 'front' : \(\) => this\.requestPurge\(\)/, 'the purge goes back to the front, not to an object alarm');
	assert.match(src, /if \(r\.headers\.get\('x-cache-purge'\) === 'front'\) schedulePurge\(ctx\);/, 'and the front Worker purges its own page cache');
	assert.match(src, /fwd\.headers\.delete\(OVERFLOW_HEADER\);\n\t+if \(target && target\.overflow\) fwd\.headers\.set\(OVERFLOW_HEADER, '1'\);/, 'a client copy of the mark is always dropped');
});

test('uploads stay in the Worker: media uploads, and any request whose declared body is over 1 MiB (the Font Library, #591)', () => {
	assert.match(src, /const ovUpload = isMediaUpload\(req, url\) \|\| Number\(req\.headers\.get\('content-length'\) \|\| 0\) > OVERFLOW_MAX_BODY;/);
	assert.match(src, /const OVERFLOW_MAX_BODY = 1024 \* 1024;/);
	assert.match(src, /shouldOverflow\(ovs, \{ running: phpLock\.running, waiting: phpLock\.waiting \}, url, ovUpload\)/);
});


// #296 (3)(c), the object-side BUSY answer (ruled 2026-11-15). (c) measured the queue MOVING INTO THE POOL:
// 507 of 699 granted waits were in objects at pool 32. Now an object that already runs or holds PHP answers
// busy BEFORE it runs anything; the Worker tries its second choice, then runs the request locally.
test('objectBusy: any run in flight or any waiter', () => {
	assert.equal(objectBusy({ running: 0, waiting: 0 }), false);
	assert.equal(objectBusy({ running: 1, waiting: 0 }), true);
	assert.equal(objectBusy({ running: 0, waiting: 1 }), true);
});

test('pickTwo: two distinct objects, the less loaded first; one object gives one choice', () => {
	const seq = [0.1, 0.6]; let k = 0;
	const p = createPicker(8, () => seq[k++ % seq.length]);
	p.start(0); p.start(0);
	assert.deepEqual(p.pickTwo(), [5, 0], 'object 5 (0 in flight) before object 0 (2 in flight)');
	const one = createPicker(1, Math.random);
	assert.deepEqual(one.pickTwo(), [0]);
});

async function simulateBusy({ env, requests, runMs }) {
	const c = fakeClock();
	const mk = () => createPhpLock({ staleMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
	const isolates = [mk(), mk()];
	const s = overflowSettings(env);
	const busy = s.busy; // the flag decides, as in index.js
	const objects = Array.from({ length: s.pool }, mk);
	const picker = createPicker(s.pool, Math.random);
	const ran = new Map(); const live = new Map(); let maxLive = 0; let maxObjWaiting = 0; let busyAnswers = 0; let local = 0;
	const job = (id, where) => () => new Promise((res) => {
		const n = (live.get(where) || 0) + 1; live.set(where, n); maxLive = Math.max(maxLive, n);
		const r = ran.get(id) || { n: 0, where: [] }; r.n++; r.where.push(where); ran.set(id, r);
		c.setTimer(() => { live.set(where, live.get(where) - 1); res(id); }, runMs);
	});
	const ps = [];
	for (let id = 0; id < requests; id++) {
		const iso = isolates[id % 2];
		if (shouldOverflow(s, { running: iso.running, waiting: iso.waiting }, new URL('https://s.example/'), false)) {
			let done = false;
			for (const o of picker.pickTwo()) {
				if (busy && objectBusy(objects[o])) { busyAnswers++; continue; } // answered before anything runs
				picker.start(o);
				ps.push(objects[o].run(job(id, 'obj' + o)).finally(() => picker.end(o)));
				maxObjWaiting = Math.max(maxObjWaiting, objects[o].waiting);
				done = true; break;
			}
			if (!done) { local++; ps.push(iso.run(job(id, 'iso' + (id % 2)))); }
		} else ps.push(iso.run(job(id, 'iso' + (id % 2))));
	}
	await c.advance(requests * runMs + 10000);
	await Promise.all(ps);
	return { ran, maxLive, maxObjWaiting, busyAnswers, local, moved: [...ran.values()].filter((r) => r.where[0].startsWith('obj')).length };
}

test('busy: an object never queues; a busy answer means the request runs exactly once elsewhere', async () => {
	const r = await simulateBusy({ env: { PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '4', PHP_OVERFLOW_BUSY: 'on' }, requests: 60, runMs: 600 });
	assert.equal(r.ran.size, 60);
	assert.ok([...r.ran.values()].every((x) => x.n === 1), 'each request ran once');
	assert.equal(r.maxLive, 1, 'never two runs at once in an isolate or an object');
	assert.equal(r.maxObjWaiting, 0, 'no object ever holds a waiter: the queue does not move into the pool');
	assert.ok(r.busyAnswers > 0 && r.local > 0, `busy answers sent some requests back to run locally (busy ${r.busyAnswers}, local ${r.local})`);
	// Control 1: the same load with the busy flag OFF (the default) queues in the objects (as (c) measured).
	const nb = await simulateBusy({ env: { PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '4' }, requests: 60, runMs: 600 });
	assert.ok(nb.maxObjWaiting > 0, 'the control must queue in an object, or this test cannot fail');
	// Control 2: overflow off moves none.
	const off = await simulateBusy({ env: { PHP_OVERFLOW_BUSY: 'on' }, requests: 60, runMs: 600 });
	assert.equal(off.moved, 0);
	assert.ok([...off.ran.values()].every((x) => x.n === 1));
});

test('index.js: the object answers busy only for an overflowed, retry-safe request, before anything runs', () => {
	assert.match(src, /const OVERFLOW_BUSY_OK_HEADER = 'x-pf-busy-ok';/);
	assert.match(src, /if \(overflowed && raw\.headers\.get\(OVERFLOW_BUSY_OK_HEADER\) === '1' && objectBusy\(\{ running: phpLock\.running, waiting: phpLock\.waiting \}\)\) \{/, 'the object checks its own lock');
	assert.match(src, /fwd\.headers\.delete\(OVERFLOW_BUSY_OK_HEADER\);\n\t+if \(target && target\.busyOk\) fwd\.headers\.set\(OVERFLOW_BUSY_OK_HEADER, '1'\);/, 'only the Worker sets it; a client copy is dropped');
	assert.match(src, /const busyOk = ovs\.busy && !turnstileRoute\(env, req\.method, url\);/, 'busy only with its flag; a Turnstile-gated request is verified once: it is never retried, so it never asks for busy');
	assert.match(src, /event: 'overflow-busy'/);
	assert.match(src, /event: 'overflow-local'/);
});
