// overflow.mjs (#296 step (3), ruled 2026-11-15): a request that would WAIT in a busy Worker isolate
// runs on a pool Durable Object instead, before it has run. Pure decisions, plus a two-isolate
// simulation on the REAL php-lock.mjs and a fake clock: never two runs at once in one isolate or object,
// and every request runs exactly once, wherever it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overflowSettings, shouldOverflow, createPicker, overflowName, objectBusy, overHeld, overflowCapResponse } from '../overflow.mjs';
import { readFileSync } from 'node:fs';
import { createPhpLock } from '../php-lock.mjs';

test('settings: off by default; on, always, the depth, the pool and the hint', () => {
	// The default pool is 32, the measured best (#296, 2026-11-15): pool 8 and 16 were WORSE than no overflow at 250
	// concurrent checkouts; pool 32 was the only setting with 0 exceededMemory. A bad value falls back to 32 too.
	assert.deepEqual(overflowSettings({}), { on: false, always: false, depth: 1, pool: 32, hint: 'wnam', busy: false, maxHeld: 0 });
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on' }).on, true);
	const a = overflowSettings({ PHP_OVERFLOW: 'always', PHP_OVERFLOW_DEPTH: '0', PHP_OVERFLOW_POOL: '32', PHP_OVERFLOW_HINT: 'enam' });
	assert.deepEqual(a, { on: true, always: true, depth: 0, pool: 32, hint: 'enam', busy: false, maxHeld: 0 });
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
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('an overflowed request never arms the object alarm: neither the cron rearm nor a purge alarm', () => {
	// #715 review2 5: the guard is named armsCron, and the rearm happens inside the run.
	assert.match(src, /const armsCron = !url\.pathname\.startsWith\('\/_'\) && !overflowed( && !aCronObjectOff\(env\))?;/, 'the cron rearm is skipped'); // #1186: and on a cron-off A build
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
	assert.match(src, /const busyOk = ovs\.busy && !turnstileRoute\(env, req\.method, url, busyFields\);/, 'busy only with its flag; a Turnstile-gated request is verified once: it is never retried, so it never asks for busy');
	assert.match(src, /event: 'overflow-busy'/);
	assert.match(src, /event: 'overflow-local'/);
});

// #714: a Worker isolate that dies holding its overflowed requests takes every one with it (3 to 5 shoppers got a 503
// after about 40 s, in both arms of #296). A cap on the overflowed requests one isolate holds bounds that, whatever the
// cause: past the cap, the next one is answered at once, retry-safe, and never ran.
// #714 measured (2026-11-16, three alternating pairs at 250 concurrent checkouts): cap 16 lost 479 requests to capped
// 503s while no cap lost 2 to one isolate death, and completion at 250 fell 6 to 19 points in every pair. Healthy isolates
// hold p95 23 to 25; the death held 23. So the default is NO cap, and the knob stays for an operator who wants one.
test('#714 settings: PHP_OVERFLOW_MAX_HELD defaults to no cap (0); a number caps; off and a bad value are no cap', () => {
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on' }).maxHeld, 0, 'the default: no cap (the #714 score)');
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_MAX_HELD: '16' }).maxHeld, 16, 'an explicit 16 still caps');
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_MAX_HELD: '8' }).maxHeld, 8);
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_MAX_HELD: 'off' }).maxHeld, 0, 'off: no cap (the measured no-cap arm)');
	for (const bad of ['0', '-1', 'x', '100000', '']) assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_MAX_HELD: bad }).maxHeld, 0, bad);
});
test('#714 the cap: at or past maxHeld held, the next overflow is refused; no cap never refuses', () => {
	assert.equal(overHeld(overflowSettings({ PHP_OVERFLOW: 'on' }), 10 ** 6), false, 'the default never refuses');
	const s = overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_MAX_HELD: '16' });
	assert.equal(overHeld(s, 15), false);
	assert.equal(overHeld(s, 16), true);
	assert.equal(overHeld(s, 40), true);
	assert.equal(overHeld(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_MAX_HELD: 'off' }), 10 ** 6), false);
});
test('#714 the at-cap answer: a fast, retry-safe 503 that never ran', async () => {
	const r = overflowCapResponse();
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('x-php-overflow'), 'capped');
	assert.equal(r.headers.get('x-write-loss'), 'none');
	assert.equal(r.headers.get('retry-after'), '5');
	assert.match(r.headers.get('cache-control') || '', /no-store/);
	assert.match(await r.text(), /try again/i);
});
test('#714 index.js: the held count wraps the forward (decremented in finally), the cap answers before forwarding, and MEM_LEDGER=on logs the held count', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const at = src.indexOf('shouldOverflow(ovs,');
	assert.ok(at > 0);
	const branch = src.slice(at, src.indexOf('overflow-local', at));
	assert.ok(/\n\t+if \(overHeld\(ovs, ovHeld\)\) \{[\s\S]{0,300}?\n\t+return overflowCapResponse\(\);/.test(branch), 'the cap is an unconditional guard that returns the at-cap answer');
	assert.ok(branch.indexOf('overHeld(ovs, ovHeld)') < branch.indexOf('toPhpObject('), 'the cap answers BEFORE anything is forwarded');
	assert.ok(/ovHeld\+\+/.test(branch) && /finally \{[^}]*ovHeld--/.test(branch), 'held is counted, and released in finally');
	assert.ok(/MEM_LEDGER === 'on'[^\n]*overflow-held/.test(branch), 'the ledger line is gated by MEM_LEDGER=on');
});

// #714 after the #715 rebase: overflow-local logs the call id after the held-count try/finally, so the id must be
// declared OUTSIDE that try. Inside it, the line throws a ReferenceError on every both-busy fallback (block scope).
test('the call id is declared before the held-count try, so overflow-local can read it', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const decl = src.indexOf('const callId = crypto.randomUUID(); // #708: one id for this request across its choices');
	const tryAt = src.indexOf('\t\t\ttry {\n', src.indexOf('ovHeld++;'));
	const local = src.indexOf("event: 'overflow-local'");
	assert.ok(decl > 0 && tryAt > 0 && local > tryAt, 'the shape is found');
	assert.ok(decl < tryAt, 'declared before the try, in the scope overflow-local runs in');
});

test('the capped answer is never stored, at the edge either (as #715\'s shed answers)', async () => {
	const { overflowCapResponse } = await import('../overflow.mjs');
	const r = overflowCapResponse();
	assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store');
	assert.equal(r.headers.get('x-write-loss'), 'none');
	assert.equal(r.headers.get('x-php-overflow'), 'capped');
});

// #714: measured locally, the front runtime while holding overflowed requests is what exceeded memory; held
// waiters alone are cheap. While ovHeld > 0, no shopper request may boot PHP in this Worker isolate.
test('#714 held-block: overflowHeldBlocksLocal is true only when overflow is on and held > 0', async () => {
	const { overflowHeldBlocksLocal } = await import('../overflow.mjs');
	assert.equal(overflowHeldBlocksLocal(overflowSettings({ PHP_OVERFLOW: 'on' }), 1), true);
	assert.equal(overflowHeldBlocksLocal(overflowSettings({ PHP_OVERFLOW: 'always' }), 3), true);
	assert.equal(overflowHeldBlocksLocal(overflowSettings({ PHP_OVERFLOW: 'on' }), 0), false);
	assert.equal(overflowHeldBlocksLocal(overflowSettings({}), 5), false);
});
test('#714 held-block: a fast, retry-safe 503 that never ran', async () => {
	const { overflowHeldBlockResponse } = await import('../overflow.mjs');
	const r = overflowHeldBlockResponse();
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('x-php-overflow'), 'held-block');
	assert.equal(r.headers.get('x-write-loss'), 'none');
	assert.equal(r.headers.get('retry-after'), '5');
	assert.match(await r.text(), /try again/i);
});
test('#714 index.js: blocks local PHP while ovHeld > 0, before withPhp and on overflow-local', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const wp = src.indexOf('const workerRun = await withPhp(() => withRunCall(callId, () => handle(req, env, url, spikeOk, maxBody, ctx), Date.now() - lockT0)');
	assert.ok(wp > 0);
	const before = src.slice(wp - 1200, wp);
	assert.match(before, /overflowHeldBlocksLocal\(ovs, ovHeld, runtimeLive\(\)\)/); // #1177: a would-be boot only
	assert.match(before, /return overflowHeldBlockResponse\(\)/);
	assert.match(before, /event: 'overflow-held-block'/);
	const ov = src.indexOf("event: 'overflow-local'");
	assert.ok(ov > 0);
	const localCtx = src.slice(ov - 500, ov + 80);
	assert.match(localCtx, /overflowHeldBlocksLocal\(ovs, ovHeld, runtimeLive\(\)\)/);
	assert.ok(localCtx.indexOf('overflowHeldBlockResponse') < ov, 'overflow-local is guarded before the log');
});

// #1177 (joan, cf759hl, the #1140 default): ONE admin browser's parallel wc-admin reads got 14 held-block 503s in one
// run, 0 before the pool. #714's rule refused EVERY local run while the isolate held any overflowed request, but what it
// protects against is a runtime BOOT beside held requests (memory). A request that queues on a runtime already booted
// adds no boot: it waits on the local lock, as before the pool. A cold isolate holding requests sends it to the pool.
test('#1177 held-block applies only to a would-be BOOT: a live runtime queues locally', async () => {
	const { overflowHeldBlocksLocal } = await import('../overflow.mjs');
	const on = overflowSettings({ PHP_OVERFLOW: 'on' });
	assert.equal(overflowHeldBlocksLocal(on, 1, true), false, 'held, runtime booted: run here (queue on the lock)');
	assert.equal(overflowHeldBlocksLocal(on, 1, false), true, 'held, no runtime: a boot here is the #714 case');
	assert.equal(overflowHeldBlocksLocal(on, 0, false), false);
});
test('#1177 a cold isolate holding overflowed requests sends the next request to the pool, never refuses it', async () => {
	const { overflowHeldToPool } = await import('../overflow.mjs');
	const on = overflowSettings({ PHP_OVERFLOW: 'on' });
	const u = new URL('https://s.example/wp-json/wc-admin/options');
	assert.equal(overflowHeldToPool(on, 1, false, u, false), true);
	assert.equal(overflowHeldToPool(on, 1, true, u, false), false, 'a live runtime: queue locally');
	assert.equal(overflowHeldToPool(on, 0, false, u, false), false, 'nothing held: as before');
	assert.equal(overflowHeldToPool(on, 1, false, new URL('https://s.example/_install'), false), false, 'control paths never move');
	assert.equal(overflowHeldToPool(on, 1, false, u, true), false, 'uploads never move');
	assert.equal(overflowHeldToPool(overflowSettings({}), 1, false, u, false), false);
});
test('#1177 index.js: the overflow branch also takes a cold held isolate, and both held-block checks pass the runtime state', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /\(shouldOverflow\(ovs, \{ running: phpLock\.running, waiting: phpLock\.waiting \}, url, ovUpload\) \|\| overflowHeldToPool\(ovs, ovHeld, runtimeLive\(\), url, ovUpload\)\)/);
	assert.equal((src.match(/overflowHeldBlocksLocal\(ovs, ovHeld, runtimeLive\(\)\)/g) || []).length, 2);
	assert.doesNotMatch(src, /overflowHeldBlocksLocal\(ovs, ovHeld\)/);
	assert.match(src, /function runtimeLive\(\) \{\n\treturn Boolean\(bootPromise\);\n\}/);
});
